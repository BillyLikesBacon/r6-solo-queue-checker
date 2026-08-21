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

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

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

async function loadMatches(
  playerUuid,
  targetMatches,
  jobId
) {
  const matches = [];
  let before = null;

  setStatus(
    jobId,
    `Loading ${targetMatches} matches...`
  );

  setProgress(jobId, 0, targetMatches);

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

    setProgress(
      jobId,
      loaded,
      targetMatches
    );

    setStatus(
      jobId,
      `Loading matches - ${loaded} / ${targetMatches}`
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

function extractMatchId(matchUrl) {
  let parsed;

  try {
    parsed = new URL(matchUrl);
  } catch {
    throw new Error(
      `Invalid match URL: ${matchUrl}`
    );
  }

  const parts = parsed.pathname
    .split("/")
    .filter(Boolean);

  for (let i = 0; i < parts.length; i++) {
    if (
      parts[i].toLowerCase() === "matches" &&
      parts[i + 1] &&
      isUuid(parts[i + 1])
    ) {
      return parts[i + 1];
    }
  }

  throw new Error(
    `Could not extract match UUID from URL: ${matchUrl}`
  );
}

function extractPlayersFromJson(data) {
  const namesFound = [];

  function addName(value) {
    if (typeof value !== "string") {
      return;
    }

    const name = cleanPlayerName(value);

    if (!name) {
      return;
    }

    const lower = name.toLowerCase();

    if (INVALID_NAMES.has(lower)) {
      return;
    }

    if (lower.includes("null")) {
      return;
    }

    if (!namesFound.includes(name)) {
      namesFound.push(name);
    }
  }

  const nameKeys = [
    "name",
    "username",
    "userName",
    "nickname",
    "displayName",
    "display_name",
    "playerName",
    "player_name",
    "gamertag",
    "gameName",
    "game_name",
    "label",
  ];

  const idKeys = [
    "id",
    "uuid",
    "playerId",
    "player_id",
    "profileId",
    "profile_id",
    "userId",
    "user_id",
  ];

  function inspectObject(object) {
    if (
      !object ||
      typeof object !== "object" ||
      Array.isArray(object)
    ) {
      return;
    }

    let hasPlayerId = false;

    for (const key of idKeys) {
      if (isUuid(object[key])) {
        hasPlayerId = true;
        break;
      }
    }

    if (hasPlayerId) {
      for (const key of nameKeys) {
        if (typeof object[key] === "string") {
          addName(object[key]);
          break;
        }
      }
    }

    if (
      object.player &&
      typeof object.player === "object"
    ) {
      inspectObject(object.player);
    }
  }

  function walk(value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }

      return;
    }

    if (
      !value ||
      typeof value !== "object"
    ) {
      return;
    }

    inspectObject(value);

    for (const child of Object.values(value)) {
      walk(child);
    }
  }

  walk(data);

  return namesFound;
}

async function getMatchData(matchId) {
  const url =
    `${API_BASE}/matches/${encodeURIComponent(matchId)}`;

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      const { response, data } =
        await fetchJson(url, {
          method: "GET",
          headers: apiHeaders(),
        });

      if (response.status === 429) {
        const wait = retryAfterSeconds(
          response,
          RATE_LIMIT_WAIT
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
          `Match API returned HTTP ${response.status}.`
        );
      }

      return data;
    } catch (error) {
      if (attempt >= MAX_RETRIES) {
        throw error;
      }

      await sleep(
        ERROR_WAIT +
        randomDelay(3000, 8000)
      );
    }
  }

  return null;
}

async function scrapeMatchPages(
  matchUrls,
  jobId
) {
  const allGroups = [];

  const total = matchUrls.length;

  setStatus(
    jobId,
    `Loading match player data...`
  );

  setProgress(jobId, 0, total);

  for (
    let index = 0;
    index < matchUrls.length;
    index++
  ) {
    const matchNumber = index + 1;
    const matchUrl = matchUrls[index];

    setProgress(
      jobId,
      matchNumber,
      total
    );

    setStatus(
      jobId,
      `checking match ${matchNumber} / ${total}`
    );

    const matchId =
      extractMatchId(matchUrl);

    let namesFound = [];
    let success = false;

    for (
      let attempt = 1;
      attempt <= MAX_RETRIES;
      attempt++
    ) {
      try {
        const data =
          await getMatchData(matchId);

        namesFound =
          extractPlayersFromJson(data);

        success = true;
        break;
      } catch (error) {
        if (attempt >= MAX_RETRIES) {
          setStatus(
            jobId,
            `Match ${matchNumber} failed`
          );
          break;
        }

        setStatus(
          jobId,
          `Retrying match ${matchNumber} - ` +
          `attempt ${attempt + 1}`
        );

        await sleep(
          ERROR_WAIT +
          randomDelay(3000, 8000)
        );
      }
    }

    allGroups.push(
      success ? namesFound : []
    );

    if (index < matchUrls.length - 1) {
      await sleep(
        randomDelay(
          MIN_DELAY,
          MAX_DELAY
        )
      );
    }
  }

  return allGroups;
}

function normalizeNames(names) {
  return names
    .map((name) =>
      decodeURIComponent(
        String(name).trim()
      ).toLowerCase()
    )
    .filter(Boolean);
}

function calculateFrequencies(
  groups,
  names
) {
  const totalGroups = groups.length;

  return names.map((name) => {
    const target =
      name.trim().toLowerCase();

    let count = 0;

    for (const group of groups) {
      const lowerNames =
        new Set(
          group.map((value) =>
            value.trim().toLowerCase()
          )
        );

      if (lowerNames.has(target)) {
        count++;
      }
    }

    return {
      name,
      count,
      percentage:
        totalGroups > 0
          ? (count / totalGroups) * 100
          : 0,
    };
  });
}

function summarize(
  groups,
  names,
  matchUrls
) {
  let groupsWithMatch = 0;
  let groupsWithoutMatch = 0;

  const matchingGroups = [];

  for (
    let index = 0;
    index < groups.length;
    index++
  ) {
    const group = groups[index];

    const groupNames = new Set(
      group.map((name) =>
        name.trim().toLowerCase()
      )
    );

    const foundNames = names.filter(
      (name) =>
        groupNames.has(
          name.trim().toLowerCase()
        )
    );

    if (foundNames.length) {
      groupsWithMatch++;

      matchingGroups.push({
        group: index + 1,
        names: foundNames,
      });
    } else {
      groupsWithoutMatch++;
    }
  }

  return {
    match_urls: matchUrls,
    groups,
    total_groups: groups.length,
    groups_with_match: groupsWithMatch,
    groups_without_match: groupsWithoutMatch,
    matching_groups: matchingGroups,
    player_frequencies:
      calculateFrequencies(
        groups,
        names
      ),
  };
}

async function runScraper(
  jobId,
  playerUrl,
  names,
  targetMatches
) {
  try {
    const {
      uuid: playerUuid,
    } = extractPlayerUuid(playerUrl);

    setStatus(
      jobId,
      "Creating HTTP session..."
    );

    const matches =
      await loadMatches(
        playerUuid,
        targetMatches,
        jobId
      );

    if (!matches.length) {
      throw new Error(
        "No matches were loaded."
      );
    }

    const matchUrls =
      createMatchUrls(
        matches,
        playerUuid
      );

    setStatus(
      jobId,
      `Loaded ${matchUrls.length} match URLs`
    );

    const allGroups =
      await scrapeMatchPages(
        matchUrls,
        jobId
      );

    setStatus(
      jobId,
      "Calculating player frequencies..."
    );

    const result =
      summarize(
        allGroups,
        names,
        matchUrls
      );

    updateJob(jobId, {
      status: "Complete",
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
        const message = String(req.body.message || "").trim();

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

        const { error } = await supabase
            .from("feedback")
            .insert({
                message
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

  try {
    extractPlayerUuid(playerUrl);
  } catch (error) {
    return res.status(400).json({
      error: error.message,
    });
  }

  const jobId =
    crypto.randomUUID();

  JOBS.set(jobId, {
    status: "Starting...",
    progress: {
      current: 0,
      total: targetMatches,
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