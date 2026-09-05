// server.js
//
// Rainbow Six Match Checker — Node/Express backend.
//
// API:
//   POST /api/start
//   GET  /api/status/:jobId
//   GET  /api/result/:jobId
//
// No cookies file is required.

const express = require("express");
const crypto = require("crypto");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 5000;
const SITE_URL = "https://stats.cc";
const API_BASE = "https://r6.stats.cc/v2";

const MIN_DELAY = 1000;
const MAX_DELAY = 2000;
const MAX_RETRIES = 6;
const RATE_LIMIT_WAIT = 20000;
const ERROR_WAIT = 15000;
const DEFAULT_TARGET_MATCHES = 50;
const MAX_CONCURRENT_PLAYER_SCRAPES = 3;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const INVALID_NAMES = new Set([
  "null",
  "none",
  "undefined",
  "matches",
  "leaderboards",
  "leaderboard",
  "siege",
  "ranks",
  "operators",
  "players",
]);

const JOBS = new Map();

const { createClient } = require("@supabase/supabase-js");

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function updateJob(jobId, fields) {
  const job = JOBS.get(jobId);
  if (!job) return;

  Object.assign(job, fields);
}

function setStatus(jobId, status) {
  updateJob(jobId, { status });
}

function setProgress(jobId, current, total) {
  updateJob(jobId, {
    progress: {
      current,
      total,
    },
  });
}

function setPlayerProgress(jobId, index, current) {
  const job = JOBS.get(jobId);
  if (!job || !job.player_progress || !job.player_progress[index]) return;

  const playerProgress = [...job.player_progress];
  playerProgress[index] = {
    ...playerProgress[index],
    current,
  };

  updateJob(jobId, {
    player_progress: playerProgress,
  });
}

function cleanPlayerUrl(value) {
  let url = String(value || "").trim();

  const markdownMatch = url.match(/\]\((https?:\/\/[^)]+)\)/);

  if (markdownMatch) {
    url = markdownMatch[1];
  }

  return url.replace(/\\&/g, "&");
}

function extractPlayerUuid(playerUrl) {
  const url = cleanPlayerUrl(playerUrl);

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid player URL.");
  }

  const parts = parsed.pathname
    .split("/")
    .filter(Boolean);

  for (let i = parts.length - 1; i >= 0; i--) {
    if (UUID_PATTERN.test(parts[i])) {
      return {
        uuid: parts[i],
        url,
      };
    }
  }

  throw new Error(
    "Could not find a valid player UUID in the supplied URL."
  );
}

function cleanPlayerName(name) {
  if (typeof name !== "string") {
    return "";
  }

  let value = decodeURIComponent(name);
  value = decodeURIComponent(value);

  return value
    .replace(/\x00/g, "")
    .replace(/\\x00/g, "")
    .trim();
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function apiHeaders() {
  return {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.6",
    Origin: SITE_URL,
    Referer: `${SITE_URL}/`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/151.0.0.0 Safari/537.36",
    "X-Locale": "en",
    "X-Stats-CC-Client": "web-csr",

    // Request identifier rather than a stored cookie.
    "X-API-Key": crypto.randomUUID(),
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `API returned invalid JSON (HTTP ${response.status}).`
    );
  }

  return {
    response,
    data,
  };
}

function retryAfterSeconds(response, fallback) {
  const header = response.headers.get("retry-after");

  let seconds = Number.parseInt(header, 10);

  if (!Number.isFinite(seconds)) {
    seconds = fallback / 1000;
  }

  return seconds * 1000 + randomDelay(1000, 5000);
}

async function resolvePlayerUuid(identifier) {
  if (!identifier || typeof identifier !== "string") {
    return null;
  }

  const trimmed = identifier.trim();
  if (!trimmed) return null;

  if (isUuid(trimmed)) {
    return trimmed;
  }

  try {
    const { uuid } = extractPlayerUuid(trimmed);
    if (uuid) return uuid;
  } catch {
    // Not a URL containing a UUID
  }

  for (const platform of ["pc", "xbox", "playstation"]) {
    try {
      const url =
        "https://r6.stats.cc/v2/profiles/search?username=" +
        encodeURIComponent(trimmed) +
        "&platform=" +
        platform +
        "&include_aliases=true&limit=10";

      const { response, data } = await fetchJson(url, {
        method: "GET",
        headers: apiHeaders(),
      });

      if (response.ok && Array.isArray(data) && data.length > 0) {
        // Try exact case-insensitive match first
        for (const item of data) {
          const profile = item.profile || item;
          const uuid = profile.id || profile.user_id || profile.userId;
          const uname = profile.username || profile.displayName || profile.name;
          if (isUuid(uuid) && uname && uname.toLowerCase() === trimmed.toLowerCase()) {
            return uuid;
          }
        }
        // Fallback to first profile returned
        const first = data[0].profile || data[0];
        const uuid = first.id || first.user_id || first.userId;
        if (isUuid(uuid)) {
          return uuid;
        }
      }
    } catch {
      // Ignore and try next platform
    }
  }

  return null;
}

async function loadMatches(
  playerUuid,
  targetMatches,
  jobId,
  label = "Loading matches",
  baseLoaded = 0,
  totalToFetch = targetMatches,
  onProgress = null
) {
  const matches = [];
  let before = null;

  const reportProgress = (loaded) => {
    if (onProgress) {
      onProgress(loaded);
      return;
    }

    setProgress(jobId, baseLoaded + loaded, totalToFetch);
  };

  setStatus(
    jobId,
    `${label}...`
  );

  reportProgress(0);

  while (matches.length < targetMatches) {
    const params = new URLSearchParams();

    params.set("playlist", "ranked");

    if (before) {
      params.set("before", before);
    }

    const url =
      `${API_BASE}/profiles/${encodeURIComponent(playerUuid)}/matches` +
      `?${params.toString()}`;

    let result;

    try {
      result = await fetchJson(url, {
        method: "GET",
        headers: apiHeaders(),
      });
    } catch (error) {
      throw new Error(
        `Match API request failed: ${error.message}`
      );
    }

    const { response, data } = result;

    if (response.status === 429) {
      const wait = retryAfterSeconds(
        response,
        RATE_LIMIT_WAIT
      );

      setStatus(
        jobId,
        `Match API rate limited - waiting ${Math.ceil(
          wait / 1000
        )}s`
      );

      await sleep(wait);
      continue;
    }

    if (
      response.status === 401 ||
      response.status === 403
    ) {
      throw new Error(
        `Stats.cc rejected the match API request with HTTP ${response.status}.`
      );
    }

    if (!response.ok) {
      throw new Error(
        `Match API returned HTTP ${response.status}: ` +
        `${JSON.stringify(data).slice(0, 500)}`
      );
    }

    if (!data) {
      break;
    }

    if (!Array.isArray(data)) {
      throw new Error(
        "Stats.cc returned an unexpected match response."
      );
    }

    if (data.length === 0) {
      break;
    }

    matches.push(...data);

    before = data[data.length - 1]?.id;

    if (!before) {
      break;
    }

    const loaded = Math.min(
      matches.length,
      targetMatches
    );

    reportProgress(loaded);

    setStatus(
      jobId,
      `${label} - ${loaded} / ${targetMatches}`
    );

    if (matches.length < targetMatches) {
      await sleep(
        randomDelay(MIN_DELAY, MAX_DELAY)
      );
    }
  }

  return matches.slice(0, targetMatches);
}

function createMatchUrls(matches, playerUuid) {
  return matches
    .filter((match) => match && match.id)
    .map(
      (match) =>
        `${SITE_URL}/siege/matches/${match.id}` +
        `?originId=${playerUuid}`
    );
}

function buildPairKey(a, b) {
  // Consistent key regardless of argument order
  return [a, b].sort().join(" <> ");
}

// Build a matchId → outcome map from the main player's already-loaded match
// list.  Each match object from /profiles/:uuid/matches includes a
// player_summary field with the requesting player's outcome ('win'/'loss').
function buildOutcomeMap(matches) {
  const map = new Map();
  for (const match of matches) {
    if (match && match.id && match.player_summary) {
      const outcome = match.player_summary.outcome;
      if (outcome === "win" || outcome === "loss") {
        map.set(match.id, outcome);
      }
    }
  }
  return map;
}

// Derive per-squad-member win/loss counts from the pre-built outcome map.
// Returns a Map keyed by squad-member name → { wins, losses }.
function buildWinLossFromOutcomeMap(playerData, mainPlayer, outcomeMap) {
  const result = new Map();
  for (const sp of playerData.slice(1)) {
    let wins = 0;
    let losses = 0;
    for (const id of sp.matchSet) {
      if (!mainPlayer.matchSet.has(id)) continue;
      const outcome = outcomeMap.get(id);
      if (outcome === "win") wins++;
      else if (outcome === "loss") losses++;
    }
    result.set(sp.name, { wins, losses });
  }
  return result;
}

function calculatePairwiseFrequencies(allPlayers) {
  const pairs = [];

  for (let i = 0; i < allPlayers.length; i++) {
    for (let j = i + 1; j < allPlayers.length; j++) {
      const a = allPlayers[i];
      const b = allPlayers[j];
      const setA = a.matchSet;
      const setB = b.matchSet;

      let sharedCount = 0;
      for (const id of setA) {
        if (setB.has(id)) sharedCount++;
      }

      const total = Math.max(setA.size, setB.size);

      pairs.push({
        players: [a.name, b.name],
        count: sharedCount,
        total,
        percentage: total > 0 ? (sharedCount / total) * 100 : 0,
      });
    }
  }

  return pairs;
}

async function runScraper(
  jobId,
  playerUrl,
  names,
  targetMatches
) {
  try {
    // All players: main player + squad members
    const allPlayerDefs = [
      { label: "main player", input: playerUrl, isMain: true },
      ...names.map((n) => ({ label: n, input: n, isMain: false })),
    ];

    const totalToFetch = allPlayerDefs.length * targetMatches;

    updateJob(jobId, {
      player_progress: allPlayerDefs.map((def) => ({
        name: def.isMain ? def.input : def.label,
        current: 0,
        total: targetMatches,
      })),
    });

    setStatus(jobId, "Resolving player profiles...");

    const playerData = new Array(allPlayerDefs.length); // { name, uuid, matchSet }
    const playerProgress = new Array(allPlayerDefs.length).fill(0);

    const reportPlayerProgress = (index, loaded) => {
      playerProgress[index] = loaded;
      setPlayerProgress(jobId, index, loaded);
      const completed = playerProgress.reduce((sum, value) => sum + value, 0);
      setProgress(jobId, completed, totalToFetch);
    };

    let nextPlayerIndex = 0;

    async function scrapeNextPlayer() {
      while (nextPlayerIndex < allPlayerDefs.length) {
        const index = nextPlayerIndex++;
        const def = allPlayerDefs[index];

        setStatus(
          jobId,
          def.isMain
            ? "Resolving main player profile..."
            : `Resolving profile for ${def.label}...`
        );

        const uuid = await resolvePlayerUuid(def.input);

        if (!uuid) {
          setStatus(jobId, `Could not resolve profile for ${def.label}`);
          playerData[index] = {
            name: def.label,
            uuid: null,
            matchSet: new Set(),
            matches: [],
          };
          reportPlayerProgress(index, targetMatches);
          continue;
        }

        const matches = await loadMatches(
          uuid,
          targetMatches,
          jobId,
          def.isMain
            ? "Loading main player matches"
            : `Loading matches for ${def.label}`,
          0,
          totalToFetch,
          (loaded) => reportPlayerProgress(index, loaded)
        );

        playerData[index] = {
          name: def.isMain ? def.input : def.label,
          uuid,
          matchSet: new Set(matches.filter((m) => m && m.id).map((m) => m.id)),
          matches,
        };

        reportPlayerProgress(index, targetMatches);
      }
    }

    const workerCount = Math.min(
      MAX_CONCURRENT_PLAYER_SCRAPES,
      allPlayerDefs.length
    );

    await Promise.all(
      Array.from({ length: workerCount }, () => scrapeNextPlayer())
    );

    const mainPlayer = playerData[0];

    if (!mainPlayer || mainPlayer.matchSet.size === 0) {
      throw new Error("No matches were loaded for the main player.");
    }

    setStatus(jobId, "Calculating pairwise frequencies...");

    const pairFrequencies = calculatePairwiseFrequencies(playerData);

    // Individual frequency vs main player (for backwards compat with frontend)
    const mainMatchSet = mainPlayer.matchSet;
    const playerFrequencies = playerData.slice(1).map((p) => {
      let count = 0;
      for (const id of mainMatchSet) {
        if (p.matchSet.has(id)) count++;
      }
      const total = mainMatchSet.size;
      return {
        name: p.name,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0,
      };
    });

    // Build outcome map from main player's already-loaded match data — no
    // extra requests needed, each match object includes player_summary.outcome.
    const outcomeMap = buildOutcomeMap(mainPlayer.matches);
    const winLossMap = buildWinLossFromOutcomeMap(playerData, mainPlayer, outcomeMap);

    // Attach wins/losses/win_percentage to each player_frequency entry
    for (const entry of playerFrequencies) {
      const wl = winLossMap.get(entry.name) || { wins: 0, losses: 0 };
      entry.wins = wl.wins;
      entry.losses = wl.losses;
      const decided = wl.wins + wl.losses;
      entry.win_percentage = decided > 0 ? (wl.wins / decided) * 100 : null;
    }

    // Attach wins/losses/win_percentage to each pair_frequency entry
    // (only pairs that include the main player get win/loss data — squad-only
    // pairs don't have a clear "win" reference player so we leave them null)
    for (const pair of pairFrequencies) {
      const mainName = mainPlayer.name;
      if (pair.players.includes(mainName)) {
        const otherName = pair.players.find((n) => n !== mainName);
        const wl = winLossMap.get(otherName) || { wins: 0, losses: 0 };
        pair.wins = wl.wins;
        pair.losses = wl.losses;
        const decided = wl.wins + wl.losses;
        pair.win_percentage = decided > 0 ? (wl.wins / decided) * 100 : null;
      } else {
        pair.wins = null;
        pair.losses = null;
        pair.win_percentage = null;
      }
    }

    const matchUrls = createMatchUrls(mainPlayer.matches, mainPlayer.uuid);

    const result = {
      match_urls: matchUrls,
      total_groups: mainPlayer.matchSet.size,
      main_player: mainPlayer.name,
      player_frequencies: playerFrequencies,
      pair_frequencies: pairFrequencies,
    };

    updateJob(jobId, {
      status: "Complete",
      progress: {
        current: totalToFetch,
        total: totalToFetch,
      },
      done: true,
      error: null,
      result,
    });
  } catch (error) {
    updateJob(jobId, {
      status: "Failed",
      done: true,
      error: error.message,
      result: null,
    });
  }
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

const path = require("path");

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

app.post("/api/feedback", async (req, res) => {
  try {
    const message =
      String(req.body.message || "").trim();

    const deviceInfo =
      req.body.device_info || {};

    if (!message) {
      return res.status(400).json({
        error: "Feedback cannot be empty."
      });
    }

    if (message.length > 2000) {
      return res.status(400).json({
        error: "Feedback is too long."
      });
    }

    if (!supabase) {
      return res.status(500).json({
        error: "Feedback submission is not configured."
      });
    }

    const { error } = await supabase
      .from("feedback")
      .insert({
        message: message,
        device_info: deviceInfo
      });

    if (error) {
      console.error("Supabase error:", error);

      return res.status(500).json({
        error: "Failed to save feedback."
      });
    }

    res.json({
      success: true
    });

  } catch (error) {
    console.error("Feedback error:", error);

    res.status(500).json({
      error: "Failed to submit feedback."
    });
  }
});

app.get("/api/search-players", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query || query.length < 2) {
    return res.json([]);
  }

  try {
    const results = [];
    const seenNames = new Set();

    for (const platform of ["pc", "xbox", "playstation"]) {
      try {
        const url =
          "https://r6.stats.cc/v2/profiles/search?username=" +
          encodeURIComponent(query) +
          "&platform=" +
          platform +
          "&include_aliases=true&limit=10";

        const { response, data } = await fetchJson(url, {
          method: "GET",
          headers: apiHeaders(),
        });

        if (response.ok && Array.isArray(data)) {
          for (const item of data) {
            const profile = item.profile || item;
            const name = profile.username || profile.displayName || profile.name;
            const uuid = profile.id || profile.user_id || profile.userId;

            if (name && !seenNames.has(name.toLowerCase())) {
              seenNames.add(name.toLowerCase());
              results.push({
                name,
                uuid: uuid || null,
                platform: profile.platform || platform,
                level: profile.level || null,
              });
            }
          }
        }
      } catch {
        // Continue to next platform if error
      }

      if (results.length >= 10) break;
    }

    return res.json(results.slice(0, 10));
  } catch (error) {
    console.error("Player search error:", error);
    return res.status(500).json({
      error: "Failed to search players."
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

app.post("/api/start", (req, res) => {
  const data = req.body || {};

  const playerUrl =
    String(data.player_url || "").trim();

  const names = Array.isArray(data.names)
    ? data.names
      .map((name) =>
        String(name || "").trim()
      )
      .filter(Boolean)
      .slice(0, 5)
    : [];

  let targetMatches =
    Number.parseInt(
      data.target_matches,
      10
    );

  if (!Number.isFinite(targetMatches)) {
    targetMatches =
      DEFAULT_TARGET_MATCHES;
  }

  targetMatches = Math.max(
    1,
    Math.min(500, targetMatches)
  );

  if (!playerUrl) {
    return res.status(400).json({
      error: "Player URL is required.",
    });
  }

  if (!names.length) {
    return res.status(400).json({
      error:
        "Enter at least one player to check.",
    });
  }

  const jobId = crypto.randomUUID();
  const totalToFetch = (1 + names.length) * targetMatches;

  JOBS.set(jobId, {
    status: "Starting...",
    player_progress: [
      { name: playerUrl, current: 0, total: targetMatches },
      ...names.map((name) => ({
        name,
        current: 0,
        total: targetMatches,
      })),
    ],
    progress: {
      current: 0,
      total: totalToFetch,
    },
    done: false,
    error: null,
    result: null,
  });

  runScraper(
    jobId,
    playerUrl,
    names,
    targetMatches
  );

  return res.json({
    job_id: jobId,
  });
});

app.get(
  "/api/status/:jobId",
  (req, res) => {
    const job =
      JOBS.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        error: "Unknown job id.",
      });
    }

    return res.json({
      status: job.status,
      player_progress: job.player_progress,
      progress: job.progress,
      done: job.done,
      error: job.error,
    });
  }
);

app.get(
  "/api/result/:jobId",
  (req, res) => {
    const job =
      JOBS.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        error: "Unknown job id.",
      });
    }

    if (!job.done) {
      return res.status(425).json({
        error: "Job still running.",
      });
    }

    if (job.error) {
      return res.status(500).json({
        error: job.error,
      });
    }

    return res.json(job.result);
  }
);

// Remove old jobs periodically.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;

  for (const [jobId, job] of JOBS) {
    if (
      job.createdAt &&
      job.createdAt < cutoff
    ) {
      JOBS.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Rainbow Six Match Checker running on port ${PORT}`);
});