const runButton = document.getElementById("run-button");
const slider = document.getElementById("match-slider");
const sliderLabel = document.getElementById("match-count-label");
const statusLabel = document.getElementById("status-label");
const progressLabel = document.getElementById("progress-label");
const progressBar = document.getElementById("progress-bar");
const resultsEl = document.getElementById("results");

slider.addEventListener("input", () => {
  sliderLabel.textContent = slider.value;
});

runButton.addEventListener("click", startRun);
showEmptyResults();

async function startRun() {
  const playerUrl = document.getElementById("player-url").value.trim();
  const names = Array.from(document.querySelectorAll(".name-input"))
    .map((el) => el.value.trim())
    .filter(Boolean);
  const targetMatches = parseInt(slider.value, 10);

  if (!playerUrl) return alert("Please enter a Stats.cc player URL.");
  if (names.length === 0) return alert("Enter at least one player to check.");

  runButton.disabled = true;
  statusLabel.textContent = "Starting...";
  statusLabel.style.color = "var(--text)";
  progressLabel.textContent = `0 / ${targetMatches}`;
  progressBar.style.width = "0%";
  showEmptyResults();

  let jobId;
  try {
    const res = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_url: playerUrl, names, target_matches: targetMatches }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to start.");
    jobId = data.job_id;
  } catch (err) {
    fail(err.message);
    return;
  }

  poll(jobId);
}

function poll(jobId) {
  const interval = setInterval(async () => {
    let data;
    try {
      const res = await fetch(`/api/status/${jobId}`);
      data = await res.json();
    } catch (err) {
      clearInterval(interval);
      fail("Lost connection to the server.");
      return;
    }

    statusLabel.textContent = data.status;
    if (data.progress && data.progress.total > 0) {
      const pct = (data.progress.current / data.progress.total) * 100;
      progressBar.style.width = `${pct}%`;
      progressLabel.textContent = `${data.progress.current} / ${data.progress.total}`;
    }

    if (data.done) {
      clearInterval(interval);
      if (data.error) {
        fail(data.error);
        return;
      }
      const resultRes = await fetch(`/api/result/${jobId}`);
      const result = await resultRes.json();
      finish(result);
    }
  }, 1000);
}

function fail(message) {
  runButton.disabled = false;
  statusLabel.textContent = "Something went wrong";
  statusLabel.style.color = "var(--error)";
  alert(message);
}

function finish(result) {
  runButton.disabled = false;
  statusLabel.textContent = "Match check complete";
  statusLabel.style.color = "var(--success)";
  progressBar.style.width = "100%";
  progressLabel.textContent = `${result.total_groups} matches`;
  showResults(result);
}

function showEmptyResults() {
  resultsEl.innerHTML = `
    <div class="card empty-results">
      <h3>No results yet</h3>
      <p>Run a match check to see the results here.</p>
    </div>`;
}

function showResults(result) {
  const stats = `
    <div class="stat-cards">
      ${statCard("Matches", result.total_groups)}
      ${statCard("Matches found", result.groups_with_match, "var(--success)")}
      ${statCard("No match", result.groups_without_match)}
    </div>`;

  const freqBoxes = [];
  for (let i = 0; i < 5; i++) {
    const d = result.player_frequencies[i];
    freqBoxes.push(d ? freqBox(d, result.total_groups) : freqBox(null));
  }

  const freq = `
    <div class="card" style="padding:0;">
      <div class="freq-heading">Player frequency</div>
      <div class="freq-subheading">How often each selected player appeared in your matches</div>
      <div class="freq-grid">${freqBoxes.join("")}</div>
    </div>`;

  const groups = result.matching_groups.length
    ? result.matching_groups
        .map(
          (g) => `
        <div class="group-row">
          <span class="group-label">Match ${g.group}</span>
          <span class="group-names">${g.names.map(escapeHtml).join(", ")}</span>
        </div>`
        )
        .join("")
    : `<div class="no-matches">None of the selected players were found.</div>`;

  const groupsCard = `
    <div class="card" style="padding:0;">
      <div class="groups-heading">Matching groups</div>
      <div class="groups-list">${groups}</div>
    </div>`;

  resultsEl.innerHTML = stats + freq + groupsCard;
}

function statCard(title, value, color) {
  return `
    <div class="stat-card">
      <div class="stat-title">${title}</div>
      <div class="stat-value" style="${color ? `color:${color}` : ""}">${value}</div>
    </div>`;
}

function freqBox(data, total) {
  if (!data) {
    return `
      <div class="freq-box empty">
        <div class="freq-top"><span class="freq-name">Not used</span></div>
        <div class="freq-count">No player selected</div>
      </div>`;
  }
  return `
    <div class="freq-box">
      <div class="freq-top">
        <span class="freq-name">${escapeHtml(data.name)}</span>
        <span class="freq-pct">${data.percentage.toFixed(1)}%</span>
      </div>
      <div class="freq-count">${data.count} / ${total} matches</div>
    </div>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
