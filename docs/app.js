const elements = Object.fromEntries([
  "package-select", "status", "dashboard", "package-title", "package-name", "package-group", "npm-link",
  "metric-total", "metric-growth", "metric-latest", "metric-versions", "latest-date", "release-note", "chart", "chart-caption",
  "legend", "snapshot-rows", "caveat-list",
].map((id) => [id, document.getElementById(id)]));

const number = new Intl.NumberFormat("en-GB");
const percent = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const palette = ["#ff5a5f", "#ff9f43", "#ffd166", "#68d391", "#5cc8ff", "#a78bfa", "#f472b6", "#7f8aa3"];
let data;

function setText(element, value) {
  element.textContent = value;
}

function clear(element) {
  element.replaceChildren();
}

function formatDate(value) {
  return date.format(new Date(value));
}

function growth(current, previous) {
  if (!previous || previous.total === 0 || current.total == null) return null;
  return (current.total - previous.total) / previous.total;
}

function topVersions(snapshots, limit = 7) {
  const totals = new Map();
  for (const snapshot of snapshots) {
    for (const [version, downloads] of Object.entries(snapshot.downloadsByVersion ?? {})) {
      totals.set(version, (totals.get(version) ?? 0) + downloads);
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([version]) => version);
}

function versionRows(snapshot, versions) {
  const rows = versions.map((version) => ({ version, downloads: snapshot.downloadsByVersion[version] ?? 0 }));
  const shown = rows.reduce((sum, item) => sum + item.downloads, 0);
  const other = Math.max(0, snapshot.total - shown);
  if (other > 0) rows.push({ version: "Other", downloads: other });
  return rows;
}

function renderChart(snapshots) {
  clear(elements.chart);
  clear(elements.legend);
  const successful = snapshots.filter((snapshot) => snapshot.status === "ok");
  if (!successful.length) {
    setText(elements["chart-caption"], "No successful snapshots are available.");
    return;
  }

  const versions = topVersions(successful);
  const legendVersions = [...versions, "Other"];
  const colors = new Map(legendVersions.map((version, index) => [version, palette[index % palette.length]]));
  const max = Math.max(...successful.map((snapshot) => snapshot.total), 1);
  const width = 900;
  const height = 310;
  const margin = { top: 16, right: 20, bottom: 50, left: 70 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const slot = plotWidth / successful.length;
  const barWidth = Math.min(70, slot * 0.64);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  for (let i = 0; i <= 4; i += 1) {
    const value = max * i / 4;
    const y = margin.top + plotHeight - plotHeight * i / 4;
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", margin.left);
    line.setAttribute("x2", width - margin.right);
    line.setAttribute("y1", y);
    line.setAttribute("y2", y);
    line.setAttribute("stroke", "#323b4d");
    svg.append(line);
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", margin.left - 10);
    label.setAttribute("y", y + 4);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("fill", "#aab2c2");
    label.setAttribute("font-size", "12");
    label.textContent = number.format(Math.round(value));
    svg.append(label);
  }

  successful.forEach((snapshot, index) => {
    const x = margin.left + slot * index + (slot - barWidth) / 2;
    let consumed = 0;
    for (const item of versionRows(snapshot, versions)) {
      const segmentHeight = plotHeight * item.downloads / max;
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", margin.top + plotHeight - consumed - segmentHeight);
      rect.setAttribute("width", barWidth);
      rect.setAttribute("height", Math.max(0, segmentHeight));
      rect.setAttribute("fill", colors.get(item.version));
      const title = document.createElementNS(ns, "title");
      title.textContent = `${formatDate(snapshot.collectedAt)} · ${item.version}: ${number.format(item.downloads)}`;
      rect.append(title);
      svg.append(rect);
      consumed += segmentHeight;
    }
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", x + barWidth / 2);
    label.setAttribute("y", height - 22);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "#aab2c2");
    label.setAttribute("font-size", "12");
    label.textContent = new Date(snapshot.collectedAt).toISOString().slice(5, 10);
    svg.append(label);
  });
  elements.chart.append(svg);

  for (const version of legendVersions) {
    if (version === "Other" && !successful.some((snapshot) => versionRows(snapshot, versions).some((item) => item.version === "Other"))) continue;
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.backgroundColor = colors.get(version);
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, document.createTextNode(version));
    elements.legend.append(item);
  }
  setText(elements["chart-caption"], `${successful.length} successful rolling seven-day snapshot${successful.length === 1 ? "" : "s"}. Exact calendar-week boundaries are not provided by npm.`);
}

function renderTable(snapshots) {
  clear(elements["snapshot-rows"]);
  snapshots.slice().reverse().forEach((snapshot, reverseIndex) => {
    const chronologicalIndex = snapshots.length - reverseIndex - 1;
    const previous = [...snapshots.slice(0, chronologicalIndex)].reverse().find((item) => item.status === "ok");
    const row = document.createElement("tr");
    const collected = document.createElement("th");
    collected.scope = "row";
    collected.textContent = formatDate(snapshot.collectedAt);
    row.append(collected);
    if (snapshot.status !== "ok") {
      const failed = document.createElement("td");
      failed.colSpan = 4;
      failed.textContent = `Collection failed: ${snapshot.error ?? "Unknown error"}`;
      failed.className = "negative";
      row.append(failed);
    } else {
      const ranked = Object.entries(snapshot.downloadsByVersion).sort((a, b) => b[1] - a[1]);
      const latestDownloads = snapshot.downloadsByVersion[snapshot.latestVersion] ?? 0;
      const delta = growth(snapshot, previous);
      const values = [
        number.format(snapshot.total),
        ranked[0] ? `${ranked[0][0]} (${number.format(ranked[0][1])})` : "—",
        snapshot.total ? percent.format(latestDownloads / snapshot.total) : "—",
        delta == null ? "—" : `${delta >= 0 ? "+" : ""}${percent.format(delta)}`,
      ];
      values.forEach((value, index) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        if (index === 3 && delta != null) cell.className = delta >= 0 ? "positive" : "negative";
        row.append(cell);
      });
    }
    elements["snapshot-rows"].append(row);
  });
}

function renderPackage(packageData) {
  const successful = packageData.snapshots.filter((snapshot) => snapshot.status === "ok");
  const latest = successful.at(-1);
  const previous = successful.at(-2);
  setText(elements["package-title"], packageData.label ?? packageData.name);
  setText(elements["package-name"], packageData.name);
  setText(elements["package-group"], packageData.group ?? "npm package");
  elements["npm-link"].href = `https://www.npmjs.com/package/${packageData.name}`;
  setText(elements["latest-date"], latest ? `Collected ${formatDate(latest.collectedAt)}` : "No successful collection");

  if (latest) {
    const delta = growth(latest, previous);
    const latestDownloads = latest.downloadsByVersion[latest.latestVersion] ?? 0;
    const releasedAt = latest.releases?.[latest.latestVersion];
    setText(elements["release-note"], latest.latestVersion
      ? `Latest ${latest.latestVersion}${releasedAt ? ` · released ${formatDate(releasedAt)}` : ""}`
      : "Latest release unavailable");
    setText(elements["metric-total"], number.format(latest.total));
    setText(elements["metric-growth"], delta == null ? "First snapshot" : `${delta >= 0 ? "+" : ""}${percent.format(delta)}`);
    elements["metric-growth"].className = delta == null ? "" : delta >= 0 ? "positive" : "negative";
    setText(elements["metric-latest"], latest.total ? percent.format(latestDownloads / latest.total) : "—");
    setText(elements["metric-versions"], number.format(Object.keys(latest.downloadsByVersion).length));
  } else {
    ["metric-total", "metric-growth", "metric-latest", "metric-versions"].forEach((id) => setText(elements[id], "—"));
    setText(elements["release-note"], "No successful collection yet");
  }

  renderChart(packageData.snapshots);
  renderTable(packageData.snapshots);
  elements.dashboard.hidden = false;
  elements.status.hidden = true;
}

function selectPackage(name, updateUrl = true) {
  const selected = data.packages.find((item) => item.name === name) ?? data.packages[0];
  elements["package-select"].value = selected.name;
  renderPackage(selected);
  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set("package", selected.name);
    history.replaceState(null, "", url);
  }
}

async function start() {
  try {
    const response = await fetch("data/dashboard.json");
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    data = await response.json();
    if (!data.packages?.length) throw new Error("No packages are configured.");
    for (const item of data.packages) {
      const option = document.createElement("option");
      option.value = item.name;
      option.textContent = `${item.label ?? item.name} · ${item.name}`;
      elements["package-select"].append(option);
    }
    clear(elements["caveat-list"]);
    for (const caveat of data.caveats ?? []) {
      const item = document.createElement("li");
      item.textContent = caveat;
      elements["caveat-list"].append(item);
    }
    const requested = new URL(location.href).searchParams.get("package");
    selectPackage(requested, false);
    elements["package-select"].addEventListener("change", (event) => selectPackage(event.target.value));
  } catch (error) {
    elements.status.classList.add("error");
    setText(elements.status, `Could not load dashboard data: ${error.message}`);
  }
}

start();
