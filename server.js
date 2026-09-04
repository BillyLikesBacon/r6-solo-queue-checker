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

  for (const platform of ["uplay", "xbl", "psn"]) {
    try {
      const url =
        "https://r6.stats.cc/search?displayName=" +
        encodeURIComponent(trimmed) +
        "&platform=" +
        platform;

      const { response, data } = await fetchJson(url, {
        method: "GET",
        headers: apiHeaders(),
      });

      if (response.ok && Array.isArray(data) && data.length > 0) {
        const first = data[0];
        const uuid = first.userId || first.profileId || first.id;
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
  totalToFetch = targetMatches
) {
  const matches = [];
  let before = null;

  setStatus(
    jobId,
    `${label}...`
  );

  setProgress(jobId, baseLoaded, totalToFetch);

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
      baseLoaded + loaded,
      totalToFetch
    );

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
    setStatus(
      jobId,
      "Resolving main player profile..."
    );

    const mainUuid = await resolvePlayerUuid(playerUrl);

    if (!mainUuid) {
      throw new Error(
        "Could not resolve main player profile or UUID."
      );
    }

    const totalToFetch = (1 + names.length) * targetMatches;
    let baseLoaded = 0;

    const mainMatches = await loadMatches(
      mainUuid,
      targetMatches,
      jobId,
      "Loading main player matches",
      baseLoaded,
      totalToFetch
    );

    if (!mainMatches.length) {
      throw new Error(
        "No matches were loaded for the main player."
      );
    }

    baseLoaded += targetMatches;
    setProgress(jobId, baseLoaded, totalToFetch);

    const squadMatchSets = {};

    for (const name of names) {
      setStatus(
        jobId,
        `Resolving profile for ${name}...`
      );

      const squadUuid = await resolvePlayerUuid(name);

      if (!squadUuid) {
        setStatus(
          jobId,
          `Could not resolve profile for ${name}`
        );
        squadMatchSets[name] = new Set();
        baseLoaded += targetMatches;
        setProgress(jobId, baseLoaded, totalToFetch);
        await sleep(500);
        continue;
      }

      const squadMatches = await loadMatches(
        squadUuid,
        targetMatches,
        jobId,
        `Loading matches for ${name}`,
        baseLoaded,
        totalToFetch
      );

      squadMatchSets[name] = new Set(
        squadMatches
          .filter((m) => m && m.id)
          .map((m) => m.id)
      );

      baseLoaded += targetMatches;
      setProgress(jobId, baseLoaded, totalToFetch);
    }

    const matchUrls = createMatchUrls(mainMatches, mainUuid);

    const allGroups = mainMatches.map((match) => {
      const matchId = match.id;
      const foundInMatch = [];

      for (const name of names) {
        const set = squadMatchSets[name];
        if (set && set.has(matchId)) {
          foundInMatch.push(name);
        }
      }

      return foundInMatch;
    });

    setStatus(
      jobId,
      "Calculating player frequencies..."
    );

    const result = summarize(
      allGroups,
      names,
      matchUrls
    );

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