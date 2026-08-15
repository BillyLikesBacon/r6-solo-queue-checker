"""
Rainbow Six Match Checker — web version.

Same scraping logic as the original desktop app, wrapped in a small Flask
server so it can be driven from a browser instead of a Tkinter window.
Run it locally with `python app.py` and open http://127.0.0.1:5000.
"""

import os
import re
import time
import random
import threading
import uuid
from urllib.parse import unquote, urlparse

import cloudscraper
from bs4 import BeautifulSoup
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

MIN_DELAY = 1
MAX_DELAY = 2
MAX_RETRIES = 6
RATE_LIMIT_WAIT = 20
ERROR_WAIT = 15

UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

SKIP_NAMES = {
    "null", "none", "undefined", "matches", "leaderboards",
    "leaderboard", "siege", "ranks", "operators", "players",
}

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)

# In-memory job store — fine for a single local user. Swap for redis/a
# database if this ever needs to run for multiple concurrent users.
JOBS = {}
JOBS_LOCK = threading.Lock()


def _update_job(job_id, **fields):
    with JOBS_LOCK:
        JOBS[job_id].update(fields)


def _set_status(job_id, message):
    _update_job(job_id, status=message)


def _set_progress(job_id, current, total):
    _update_job(job_id, progress={"current": current, "total": total})


def _retry_after_seconds(response, default):
    retry_after = response.headers.get("Retry-After")
    if retry_after:
        try:
            wait = int(retry_after)
        except ValueError:
            wait = default
    else:
        wait = default
    return wait + random.uniform(1, 5)


# ---------------------------------------------------------------------------
# Scraper (ported from the original desktop script)
# ---------------------------------------------------------------------------

def extract_player_uuid(player_url):
    player_url = player_url.strip()
    markdown_match = re.search(r"\]\((https?://[^)]+)\)", player_url)
    url = markdown_match.group(1) if markdown_match else player_url
    url = url.replace("\\&", "&")

    parts = [p for p in urlparse(url).path.split("/") if p]
    for part in reversed(parts):
        if UUID_PATTERN.fullmatch(part):
            return part, url

    raise RuntimeError("Could not find a valid player UUID in the supplied URL.")


def fetch_match_list(scraper, player_uuid, target_matches, job_id):
    matches = []
    before = None

    _set_status(job_id, f"Loading {target_matches} matches...")
    _set_progress(job_id, 0, target_matches)

    while len(matches) < target_matches:
        params = {"playlist": "ranked"}
        if before:
            params["before"] = before

        headers = {
            "Accept": "application/json",
            "Accept-Language": "en-US,en;q=0.6",
            "Origin": "https://stats.cc",
            "Referer": "https://stats.cc/",
            "User-Agent": BROWSER_UA,
            "X-Locale": "en",
            "X-Stats-CC-Client": "web-csr",
            "X-API-Key": str(uuid.uuid4()),
        }

        try:
            response = scraper.get(
                f"https://r6.stats.cc/v2/profiles/{player_uuid}/matches",
                params=params, headers=headers, timeout=30,
            )
        except Exception as e:
            raise RuntimeError(f"Match API request failed: {e}")

        if response.status_code == 429:
            wait = _retry_after_seconds(response, RATE_LIMIT_WAIT)
            _set_status(job_id, f"Match API rate limited • waiting {wait:.0f}s")
            time.sleep(wait)
            continue

        if response.status_code in (401, 403):
            raise RuntimeError(
                f"Stats.cc rejected the match API request with HTTP {response.status_code}."
            )

        if not response.ok:
            raise RuntimeError(
                f"Match API returned HTTP {response.status_code}: {response.text[:500]}"
            )

        try:
            page = response.json()
        except Exception:
            raise RuntimeError("Stats.cc returned invalid JSON.")

        if not page:
            break
        if not isinstance(page, list):
            raise RuntimeError("Stats.cc returned an unexpected match response.")

        matches.extend(page)
        before = page[-1].get("id")
        if not before:
            break

        loaded = min(len(matches), target_matches)
        _set_progress(job_id, loaded, target_matches)
        _set_status(job_id, f"Loading matches • {loaded} / {target_matches}")

        if len(matches) < target_matches:
            time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))

    return matches[:target_matches]


def scrape_match_page(scraper, match_url, referer):
    """Returns (names_found, None) on success, or (None, wait_seconds) on 429."""
    response = scraper.get(
        match_url, timeout=30,
        headers={
            "User-Agent": BROWSER_UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
                      "image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": referer,
        },
    )

    if response.status_code == 429:
        return None, _retry_after_seconds(response, RATE_LIMIT_WAIT)

    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    names_found = []

    for link in soup.find_all("a", href=True):
        href = link["href"]
        if not href.startswith("/siege/"):
            continue

        parts = href.strip("/").split("/")
        if len(parts) != 3 or parts[0] != "siege":
            continue

        name = unquote(unquote(parts[1]))
        name = name.replace("\x00", "").replace("\\\x00", "").strip()
        player_id = parts[2]

        if not UUID_PATTERN.fullmatch(player_id):
            continue
        if not name or name.lower() in SKIP_NAMES or "null" in name.lower():
            continue
        if link.find("p", string=re.compile(r"^\s*Level\s+\d+\s*$")) is None:
            continue
        if name not in names_found:
            names_found.append(name)

    return names_found, None


def summarize(all_groups, names):
    groups_with_match = 0
    groups_without_match = 0
    matching_groups = []

    for index, group in enumerate(all_groups, 1):
        lower = {n.strip().lower() for n in group}
        found = [n for n in names if n.strip().lower() in lower]
        if found:
            groups_with_match += 1
            matching_groups.append({"group": index, "names": found})
        else:
            groups_without_match += 1

    total_groups = len(all_groups)
    frequencies = []
    for name in names:
        lname = name.strip().lower()
        count = sum(1 for g in all_groups if lname in {n.strip().lower() for n in g})
        pct = (count / total_groups * 100) if total_groups else 0
        frequencies.append({"name": name, "count": count, "percentage": pct})

    return {
        "total_groups": total_groups,
        "groups_with_match": groups_with_match,
        "groups_without_match": groups_without_match,
        "matching_groups": matching_groups,
        "player_frequencies": frequencies,
    }


def run_scraper(job_id, player_url, names, target_matches):
    try:
        player_uuid, clean_url = extract_player_uuid(player_url)

        scraper = cloudscraper.create_scraper(
            browser={"browser": "chrome", "platform": "windows", "mobile": False}
        )

        matches = fetch_match_list(scraper, player_uuid, target_matches, job_id)
        if not matches:
            raise RuntimeError("No matches were loaded.")

        match_urls = [
            f"https://stats.cc/siege/matches/{m['id']}?originId={player_uuid}"
            for m in matches if m.get("id")
        ]

        work_dir = f"job_{job_id}"
        os.makedirs(work_dir, exist_ok=True)
        with open(os.path.join(work_dir, "extracted_matches.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(match_urls) + "\n")

        all_groups = []
        total = len(match_urls)
        _set_status(job_id, f"Scraping {total} matches...")
        _set_progress(job_id, 0, total)

        with open(os.path.join(work_dir, "leaderboard_names.txt"), "w", encoding="utf-8") as out:
            for index, match_url in enumerate(match_urls, 1):
                _set_progress(job_id, index, total)
                _set_status(job_id, f"Scraping match {index} / {total}")

                names_found = []
                success = False

                for attempt in range(1, MAX_RETRIES + 1):
                    try:
                        found, wait = scrape_match_page(scraper, match_url, clean_url)
                        if wait is not None:
                            _set_status(job_id, f"Rate limited • waiting {wait:.0f}s")
                            time.sleep(wait)
                            continue
                        names_found = found
                        success = True
                        break
                    except Exception:
                        if attempt < MAX_RETRIES:
                            _set_status(job_id, f"Retrying match {index} • attempt {attempt + 1}")
                            time.sleep(ERROR_WAIT + random.uniform(3, 8))
                        else:
                            _set_status(job_id, f"Match {index} failed")

                all_groups.append(names_found if success else [])

                out.write(f"Group {index}\n" + "-" * 40 + "\n")
                out.write("\n".join(names_found) if success else "FAILED TO SCRAPE")
                out.write("\n\n")
                out.flush()

                if index < total:
                    time.sleep(random.uniform(MIN_DELAY, MAX_DELAY))

        _set_status(job_id, "Calculating player frequencies...")
        result = summarize(all_groups, names)
        _set_status(job_id, "Complete")
        _update_job(job_id, done=True, result=result)

    except Exception as e:
        _update_job(job_id, done=True, error=str(e))


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/start", methods=["POST"])
def start():
    data = request.get_json(silent=True) or {}

    player_url = (data.get("player_url") or "").strip()
    names = [n.strip() for n in data.get("names", []) if n and n.strip()][:5]

    try:
        target_matches = int(data.get("target_matches", 50))
    except (TypeError, ValueError):
        target_matches = 50
    target_matches = max(1, min(500, target_matches))

    if not player_url:
        return jsonify({"error": "Player URL is required."}), 400
    if not names:
        return jsonify({"error": "Enter at least one player to check."}), 400

    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "Starting...",
            "progress": {"current": 0, "total": target_matches},
            "done": False,
            "error": None,
            "result": None,
        }

    threading.Thread(
        target=run_scraper,
        args=(job_id, player_url, names, target_matches),
        daemon=True,
    ).start()

    return jsonify({"job_id": job_id})


@app.route("/api/status/<job_id>")
def status(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Unknown job id."}), 404
    return jsonify({k: v for k, v in job.items() if k != "result"})


@app.route("/api/result/<job_id>")
def result(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Unknown job id."}), 404
    if not job["done"]:
        return jsonify({"error": "Job still running."}), 425
    if job["error"]:
        return jsonify({"error": job["error"]}), 500
    return jsonify(job["result"])


if __name__ == "__main__":
    # Local development only. On Render/production, gunicorn is used instead.
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
