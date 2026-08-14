// ── DOM refs ────────────────────────────────────────────
const form         = document.getElementById("askForm");
const input        = document.getElementById("askInput");
const sendBtn      = document.getElementById("sendBtn");
const messages     = document.getElementById("messages");
const chatScroll   = document.getElementById("chatScroll");
const fsOverlay    = document.getElementById("fsOverlay");
const fsContent    = document.getElementById("fsContent");
const fsClose      = document.getElementById("fsClose");
const inputDock    = document.querySelector(".input-dock");

// ── Theme toggle ─────────────────────────────────────────
const themeBtn  = document.getElementById("themeBtn");
const iconMoon  = themeBtn.querySelector(".icon-moon");
const iconSun   = themeBtn.querySelector(".icon-sun");
const brandLogo = document.getElementById("brandLogo");
const watermark = document.getElementById("chatWatermark");

const stopBtn         = document.getElementById("stopBtn");
const streamToggleBtn = document.getElementById("streamToggleBtn");
const SECTION_PROMPTS = {
  "Retail Purchases":          "Show me Retail Purchases",
  "Order History":             "Show meOrder History",
  "Reorder Frequency":         "Show me Reorder Frequency",
  "New Retailer":              "Show me New Retailer",
  "Top Accounts":              "Show me Top Accounts",
  "Top Accounts Comparison":   "Show me Accounts Comparison",
  "Custom":                    "compare all the products and give me top products name, bar chart, pie chart, line graph, scatter plot",
};

let   abortController = null;
let   streamingEnabled = true;
let currentSection = "Custom"; // default
document.getElementById("headerSectionTitle").textContent = currentSection;
// Section chat stores
const sectionChats = {};
function getSectionStore(section) {
  if (!sectionChats[section]) {
    sectionChats[section] = { nodes: [], hasStarted: false };
  }
  return sectionChats[section];
}
function setSectionPrompt(section) {
  const prompt = SECTION_PROMPTS[section] || "";
  input.value = prompt;
  input.style.height = "auto";
  if (prompt) {
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }
  sendBtn.disabled = !prompt.trim();
}
function updateStreamToggleUI() {
  if (!streamToggleBtn) return;
  const isOn = streamingEnabled;
  streamToggleBtn.classList.toggle("active", isOn);
  streamToggleBtn.querySelector(".stream-toggle-label").textContent = `Streaming: ${isOn ? "On" : "Off"}`;
  streamToggleBtn.setAttribute("aria-pressed", isOn ? "true" : "false");
}

function applyTheme(mode) {
  if (mode === "light") {
    document.body.classList.add("light");
    iconMoon.style.display = "none";
    iconSun.style.display  = "block";
    if (brandLogo) brandLogo.src = brandLogo.dataset.light;
    if (watermark) watermark.style.backgroundImage = "url('/static/images/image.png')";
  } else {
    document.body.classList.remove("light");
    iconMoon.style.display = "block";
    iconSun.style.display  = "none";
    if (brandLogo) brandLogo.src = brandLogo.dataset.dark;
    if (watermark) watermark.style.backgroundImage = "url('/static/images/forblack-removebg-preview.png')";
  }
  localStorage.setItem("theme", mode);
  
  // Update charts if they exist
  for (let id in Chart.instances) {
    Chart.instances[id].update();
  }
}

// Restore saved preference
applyTheme(localStorage.getItem("theme") || "light");
updateStreamToggleUI();

themeBtn.addEventListener("click", () => {
  applyTheme(document.body.classList.contains("light") ? "dark" : "light");
});

if (streamToggleBtn) {
  streamToggleBtn.addEventListener("click", () => {
    streamingEnabled = !streamingEnabled;
    updateStreamToggleUI();
  });
}

// ── Auto-resize textarea ─────────────────────────────────
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
  sendBtn.disabled = !input.value.trim();
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) form.requestSubmit();
  }
});

// ── Reset conversation ────────────────────────────────────
const resetBtn = document.getElementById("resetBtn");

resetBtn.addEventListener("click", () => {
  // Clear current section store too
  sectionChats[currentSection] = { nodes: [], hasStarted: false };
  messages.appendChild(welcome);
  document.getElementById("headerSectionTitle").textContent = currentSection;
  setSectionPrompt(currentSection);
  lastUserMessage = "";
});
stopBtn.addEventListener("click", () => {
  if (abortController) {
    fetch("/stop", { method: "POST" });
    abortController.abort();
  }
});

// ── Fullscreen overlay ───────────────────────────────────
function closeFullscreen() {
  fsOverlay.classList.remove("active");
  document.body.style.overflow = "";
}

fsClose.addEventListener("click", closeFullscreen);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && fsOverlay.classList.contains("active")) closeFullscreen();
});

// ── Scroll animation for floating chat bar ───────────────
let lastScrollTop = 0;
chatScroll.addEventListener("scroll", () => {
  let scrollTop = chatScroll.scrollTop;
  if (scrollTop > lastScrollTop && scrollTop > 60) {
    inputDock.classList.add("hidden");
  } else {
    inputDock.classList.remove("hidden");
  }
  lastScrollTop = Math.max(0, scrollTop);
});

input.addEventListener("focus", () => {
  inputDock.classList.remove("hidden");
});

// ── Markdown renderer ────────────────────────────────────
function isPipeSeparator(line) {
  return /^\s*\|[\s\-|:]+\|\s*$/.test(line) && line.includes("-");
}
function isPipeRow(line) {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|");
}
function isDivider(line) {
  return /^[\-\s]{4,}$/.test(line.trim()) && line.trim().startsWith("----");
}
function isTabRow(line) {
  return !isPipeRow(line) && line.includes("\t") && line.trim() !== "";
}
function parsePipeRow(line) {
  return line.split("|").slice(1, -1).map(c => c.trim());
}
function parseTabRow(line) {
  return line.split(/\t+/).map(c => c.trim());
}

function buildTable(headers, rows) {
  const encoded = encodeURIComponent(JSON.stringify({ headers, rows }));
  let t = `<div class="paginated-table" data-table="${encoded}">`;
  t += '<div class="table-controls">';
  t += '<span class="table-rows-label">Rows per page:</span>';
  t += '<select class="table-rows-select"><option value="5">5</option><option value="10" selected>10</option><option value="20">20</option><option value="50">50</option></select>';
  t += '<button class="table-nav-btn prev-btn page-btn prev-page" type="button" title="Previous">&lsaquo;</button>';
  t += '<span class="table-page-info"></span>';
  t += '<button class="table-nav-btn next-btn page-btn next-page" type="button" title="Next">&rsaquo;</button>';
  t += '</div>';
  t += '<div class="md-table-wrap"><table class="md-table">';
  if (headers.length) {
    t += "<thead><tr>" + headers.map(h => "<th>" + inlineFormat(h) + "</th>").join("") + "</tr></thead>";
  }
  t += "<tbody></tbody></table></div>";
  t += '<div class="table-totals">'
     + '<div class="table-total-item"><span class="table-total-label">Page total:</span><span class="table-total-value page-total">0</span></div>'
     + '<div class="table-total-item"><span class="table-total-label">Grand total:</span><span class="table-total-value grand-total">0</span></div>'
     + '</div>';
  t += '</div>';
  return t;
}

function initPaginatedTables(root) {
  root.querySelectorAll(".paginated-table").forEach(wrap => {
    if (wrap.dataset.init) return;
    wrap.dataset.init = "1";
    const { rows } = JSON.parse(decodeURIComponent(wrap.dataset.table));
    const select   = wrap.querySelector(".table-rows-select");
    const prevBtn  = wrap.querySelector(".prev-btn");
    const nextBtn  = wrap.querySelector(".next-btn");
    const pageInfo = wrap.querySelector(".table-page-info");
    const tbody    = wrap.querySelector("tbody");
    const totalsEl = wrap.querySelector(".table-totals");
    const pageTotalEl = totalsEl?.querySelector(".page-total");
    const grandTotalEl = totalsEl?.querySelector(".grand-total");
    const totalCol = rows.length > 0 ? rows[0].length - 1 : -1;
    const grandTotal = totalCol >= 0 ? rows.reduce((sum, row) => sum + parseNumericValue(row[totalCol]), 0) : 0;
    let page = 0;
    let totalPages = 1;

    function updateTotals(pageRows) {
      if (!pageTotalEl || !grandTotalEl) return;
      const pageTotal = totalCol >= 0 ? pageRows.reduce((sum, row) => sum + parseNumericValue(row[totalCol]), 0) : 0;
      pageTotalEl.textContent = formatNumber(pageTotal);
      grandTotalEl.textContent = formatNumber(grandTotal);
    }

    function renderPage() {
      const perPage = parseInt(select.value);
      totalPages = Math.max(1, Math.ceil(rows.length / perPage));
      page = Math.min(page, totalPages - 1);
      const start = page * perPage;
      const pageRows = rows.slice(start, start + perPage);
      tbody.innerHTML = pageRows.map(r =>
        "<tr>" + r.map(c => "<td>" + inlineFormat(c) + "</td>").join("") + "</tr>"
      ).join("");
      pageInfo.textContent = (start + 1) + "–" + Math.min(start + perPage, rows.length) + " of " + rows.length;
      prevBtn.disabled = page === 0;
      nextBtn.disabled = page >= totalPages - 1;
      updateTotals(pageRows);
    }

    wrap.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button || !wrap.contains(button)) return;
      if (button.classList.contains("prev-btn")) {
        page = Math.max(0, page - 1);
        renderPage();
      }
      if (button.classList.contains("next-btn")) {
        page = Math.min(totalPages - 1, page + 1);
        renderPage();
      }
    });

    select.addEventListener("change", () => { page = 0; renderPage(); });
    renderPage();
  });
}

// ── Retail DataTable renderer ────────────────────────────
function buildDataTable(headers, rows, container) {
  container.innerHTML = "";
  container.className = "datatable-wrap";

  const topBar = document.createElement("div");
  topBar.className = "dt-topbar";

  const showWrap = document.createElement("div");
  showWrap.className = "dt-show";
  showWrap.innerHTML = `<span>Show</span>
    <select class="dt-entries-select">
      <option value="5">5</option>
      <option value="10" selected>10</option>
      <option value="25">25</option>
      <option value="50">50</option>
    </select>
    <span>entries</span>`;

  const searchWrap = document.createElement("div");
  searchWrap.className = "dt-search";
  searchWrap.innerHTML = `<input class="dt-search-input" type="text" placeholder="Search data..." />`;

  topBar.appendChild(showWrap);
  topBar.appendChild(searchWrap);
  container.appendChild(topBar);

  const tableWrap = document.createElement("div");
  tableWrap.className = "dt-table-wrap";

  const table = document.createElement("table");
  table.className = "dt-table";

  const thead = document.createElement("thead");
  const sortState = headers.map(() => 0); // 0=none,1=asc,-1=desc

  function buildHeader() {
    thead.innerHTML = "<tr>" + headers.map((h, i) => `
      <th data-col="${i}">
        <div class="dt-th-inner">
          <span>${h}</span>
          <span style="font-size: 10px; color: ${sortState[i] !== 0 ? 'var(--accent-primary)' : 'var(--text-tertiary)'}">
            ${sortState[i] === 1 ? '▲' : sortState[i] === -1 ? '▼' : '↕'}
          </span>
        </div>
      </th>`).join("") + "</tr>";

    thead.querySelectorAll("th").forEach(th => {
      th.addEventListener("click", () => {
        const col = parseInt(th.dataset.col);
        sortState[col] = sortState[col] === 1 ? -1 : 1;
        sortState.forEach((_, j) => { if (j !== col) sortState[j] = 0; });
        currentPage = 0;
        renderTable();
      });
    });
  }

  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);

  const totalsWrap = document.createElement("div");
  totalsWrap.className = "dt-totals";
  totalsWrap.innerHTML = `
    <div class="dt-total-item">
      <span>Page total</span>
      <strong class="dt-page-total">0</strong>
    </div>
    <div class="dt-total-item">
      <span>Grand total</span>
      <strong class="dt-grand-total">0</strong>
    </div>
  `;
  container.appendChild(totalsWrap);

  const pageTotalEl = totalsWrap.querySelector(".dt-page-total");
  const grandTotalEl = totalsWrap.querySelector(".dt-grand-total");
  let totalColIndex = headers.findIndex(h => /total|cases|amount|profit|revenue/i.test(h));
  if (totalColIndex < 0) totalColIndex = headers.length - 1;

  const botBar = document.createElement("div");
  botBar.className = "dt-botbar";
  const pageInfo = document.createElement("span");
  pageInfo.className = "dt-page-info";
  const navWrap = document.createElement("div");
  navWrap.className = "dt-nav";

  const prevBtn = document.createElement("button");
  prevBtn.className = "dt-nav-btn";
  prevBtn.textContent = "Prev";

  const pageInput = document.createElement("input");
  pageInput.type = "number";
  pageInput.min = "1";
  pageInput.className = "dt-page-input";

  const pageLabel = document.createElement("span");
  pageLabel.className = "dt-page-label";
  pageLabel.textContent = "of 1";

  const nextBtn = document.createElement("button");
  nextBtn.className = "dt-nav-btn";
  nextBtn.textContent = "Next";

  navWrap.appendChild(prevBtn);
  navWrap.appendChild(pageInput);
  navWrap.appendChild(pageLabel);
  navWrap.appendChild(nextBtn);
  botBar.appendChild(pageInfo);
  botBar.appendChild(navWrap);
  container.appendChild(botBar);

  let currentPage = 0;
  let filteredRows = [...rows];
  let workingRows  = [...rows];

  const searchInput  = container.querySelector(".dt-search-input");
  const entriesSelect = container.querySelector(".dt-entries-select");

  function getPerPage() { return parseInt(entriesSelect.value); }

  function applyFilterSort() {
    const q = searchInput.value.toLowerCase().trim();
    filteredRows = q
      ? rows.filter(r => r.some(c => String(c).toLowerCase().includes(q)))
      : [...rows];

    const sortCol = sortState.findIndex(s => s !== 0);
    if (sortCol >= 0) {
      const dir = sortState[sortCol];
      filteredRows.sort((a, b) => {
        const av = isNaN(a[sortCol]) ? String(a[sortCol]) : parseFloat(a[sortCol]);
        const bv = isNaN(b[sortCol]) ? String(b[sortCol]) : parseFloat(b[sortCol]);
        return av < bv ? -dir : av > bv ? dir : 0;
      });
    }
    workingRows = filteredRows;
  }

  const totalCol = headers.findIndex(h => /total|cases|amount|profit|revenue/i.test(h));
  const nameCol  = headers.findIndex(h => /customer.?name|name/i.test(h));
  const prodCol  = headers.findIndex(h => /product/i.test(h));

  function renderTable() {
    buildHeader();
    applyFilterSort();
    const perPage    = getPerPage();
    const totalPages = Math.max(1, Math.ceil(workingRows.length / perPage));
    currentPage      = Math.min(currentPage, totalPages - 1);
    const start      = currentPage * perPage;
    const slice      = workingRows.slice(start, start + perPage);

    const pageTotal = slice.reduce((sum, row) => sum + parseNumericValue(row[totalColIndex]), 0);
    const grandTotal = workingRows.reduce((sum, row) => sum + parseNumericValue(row[totalColIndex]), 0);

    tbody.innerHTML = slice.map((r, ri) => {
      const cells = r.map((c, ci) => {
        let cls = "";
        if (ci === nameCol || ci === prodCol) cls = "dt-td-accent";
        const val = parseFloat(String(c).replace(/,/g, ""));
        if (ci === totalCol && !isNaN(val)) {
          cls = val < 0 ? "dt-td-neg" : "dt-td-pos";
        }
        return `<td class="${cls}">${c}</td>`;
      }).join("");
      return `<tr class="${ri % 2 === 0 ? '' : 'dt-tr-alt'}">${cells}</tr>`;
    }).join("");

    if (pageTotalEl) pageTotalEl.textContent = formatNumber(pageTotal);
    if (grandTotalEl) grandTotalEl.textContent = formatNumber(grandTotal);

    const showing = workingRows.length === 0 ? "0" : `${start + 1}–${Math.min(start + perPage, workingRows.length)}`;
    pageInfo.textContent = `Showing ${showing} of ${workingRows.length} entries`;
    pageLabel.textContent = `of ${totalPages}`;
    pageInput.value = currentPage + 1;
    prevBtn.disabled = currentPage === 0;
    nextBtn.disabled = currentPage >= totalPages - 1;
  }

  pageInput.addEventListener("change", () => {
    const total = Math.max(1, Math.ceil(workingRows.length / getPerPage()));
    const val = parseInt(pageInput.value);
    if (!isNaN(val) && val >= 1 && val <= total) {
      currentPage = val - 1;
      renderTable();
    } else {
      pageInput.value = currentPage + 1;
    }
  });

  searchInput.addEventListener("input", () => { currentPage = 0; renderTable(); });
  entriesSelect.addEventListener("change", () => { currentPage = 0; renderTable(); });
  prevBtn.addEventListener("click", () => { currentPage--; renderTable(); });
  nextBtn.addEventListener("click", () => { currentPage++; renderTable(); });

  renderTable();
}

function inlineFormat(text) {
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  return text;
}

function parseNumericValue(value) {
  const cleaned = String(value).replace(/,/g, "").trim().replace(/[^0-9.\-]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  return value % 1 === 0
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderMarkdown(text) {
  const lines = text.split("\n");
  let html = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isPipeRow(line) && i + 1 < lines.length && isPipeSeparator(lines[i + 1])) {
      const headers = parsePipeRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isPipeRow(lines[i]) && !isPipeSeparator(lines[i])) {
        rows.push(parsePipeRow(lines[i]));
        i++;
      }
      html += buildTable(headers, rows);
      continue;
    }

    if (isDivider(line)) {
      html += '<div class="md-spacer"></div>';
      i++;
      continue;
    }

    if (line.trim() === "") {
      html += '<div class="md-spacer"></div>';
      i++;
      continue;
    }

    html += "<span class=\"md-line\">" + inlineFormat(line) + "</span>";
    i++;
  }
  return html;
}

// ── Helpers ──────────────────────────────────────────────
function scrollToBottom() {
  chatScroll.scrollTop = chatScroll.scrollHeight;
}
function createRow(role) {
  const row = document.createElement("div");
  row.className = "msg-row " + role;
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "ai" ? "AI" : "You";
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  row.appendChild(avatar);
  row.appendChild(bubble);
  return { row, bubble };
}

let lastUserMessage = "";

// ── Color palette (Premium) ─────────────────────────────────
const PALETTE = [
  "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#06B6D4", "#F43F5E"
];

function getColor(idx) {
  return PALETTE[idx % PALETTE.length];
}

// ── Chart detection ──────────────────────────────────────
const CHART_KEYWORDS = ["chart", "graph", "plot", "visualize", "visualise"];
const CHART_TYPE_MAP = {
  bar:     ["bar chart", "bar graph", "column chart"],
  line:    ["line chart", "line graph", "trend", "over time"],
  pie:     ["pie chart", "pie graph", "breakdown", "distribution", "proportion"],
  scatter: ["scatter", "scatter plot", "scatter chart"],
};

function detectChartRequest(userMessage) {
  const msg = userMessage.toLowerCase();
  if (!CHART_KEYWORDS.some(k => msg.includes(k))) return null;
  const found = [];
  for (const [type, phrases] of Object.entries(CHART_TYPE_MAP)) {
    if (phrases.some(p => msg.includes(p))) found.push(type);
  }
  return found.length === 0 ? ["bar"] : found;
}

function extractTableFromMarkdown(text) {
  const lines = text.split("\n").filter(l => l.trim());
  const headerLine = lines.find(l => isPipeRow(l));
  if (!headerLine) return null;
  const headerIdx = lines.indexOf(headerLine);
  const headers = parsePipeRow(headerLine);
  const dataLines = lines.slice(headerIdx + 2).filter(l => isPipeRow(l) && !isPipeSeparator(l));
  const rows = dataLines.map(l => parsePipeRow(l));
  return { headers, rows };
}

// ── Chart theme helper ───────────────────────────────────
function chartTheme() {
  const light = document.body.classList.contains("light");
  return {
    tickColor:       light ? "#9CA3AF" : "#71717A",
    gridColor:       light ? "rgba(0, 0, 0, 0.05)" : "rgba(255, 255, 255, 0.05)",
    borderColor:     light ? "rgba(0, 0, 0, 0.1)"  : "rgba(255, 255, 255, 0.1)",
    legendColor:     light ? "#4B5563" : "#A1A1A9",
    tooltipBg:       light ? "rgba(255, 255, 255, 0.95)" : "rgba(31, 33, 40, 0.95)",
    tooltipTitle:    light ? "#111827" : "#EDEDED",
    tooltipBody:     light ? "#4B5563" : "#A1A1A9",
    tooltipBorder:   light ? "rgba(0, 0, 0, 0.1)"  : "rgba(255, 255, 255, 0.1)",
  };
}

// ── Chart renderer ───────────────────────────────────────
function renderChart(tableData, chartType, fullscreen = false) {
  const { headers, rows } = tableData;
  const labels    = rows.map(r => r[0]);
  const rowColors = labels.map((_, i) => getColor(i));
  const datasets  = [];
  const isScatter = chartType === "scatter";
  const isLine    = chartType === "line";

  for (let col = 1; col < headers.length; col++) {
    const values = rows.map(r => {
      const v = parseFloat((r[col] || "0").replace(/,/g, ""));
      return isNaN(v) ? 0 : v;
    });

    const datasetColor = getColor(col - 1);
    const scatterData  = values.map((v, idx) => ({ x: labels[idx], y: v }));
    const isPie        = chartType === "pie";
    const isBar        = chartType === "bar";

    if (isScatter && headers.length === 2) {
      values.forEach((value, idx) => {
        datasets.push({
          label: labels[idx],
          data: [{ x: labels[idx], y: value }],
          borderWidth: 2,
          borderColor: rowColors[idx],
          backgroundColor: rowColors[idx],
          pointRadius: 7,
          pointHoverRadius: 9,
          pointBackgroundColor: rowColors[idx],
          pointBorderColor: document.body.classList.contains("light") ? "#FFF" : "#1F2128",
          pointBorderWidth: 1.5,
          showLine: false,
          tension: 0,
          fill: false,
        });
      });
      break;
    }

    datasets.push({
      label: headers[col],
      data: isScatter ? scatterData : values,
      borderWidth: isPie || isBar ? 0 : 2,
      borderColor: isPie ? "transparent" : datasetColor,
      backgroundColor: isPie || isBar
        ? rowColors.map((c, idx) => idx === 0 ? c : getColor(idx))
        : isLine ? `${datasetColor}22` : datasetColor,
      pointRadius: isScatter ? 6 : isLine ? 3 : 0,
      pointHoverRadius: 9,
      pointBackgroundColor: datasetColor,
      pointBorderColor: document.body.classList.contains("light") ? "#FFF" : "#1F2128",
      pointBorderWidth: 1.5,
      tension: 0.3, 
      fill: isLine,
      borderRadius: isBar ? 6 : 0,
      borderSkipped: isBar ? "bottom" : undefined,
      hoverOffset: isPie ? 4 : 0,
      cutout: isPie ? "65%" : undefined,
      barPercentage: isBar ? 0.7 : undefined,
      categoryPercentage: isBar ? 0.8 : undefined,
    });
  }

  const t = chartTheme();
  const wrapper = document.createElement("div");
  wrapper.className = "chart-wrapper";
  if (fullscreen) wrapper.style.flex = "1";

  const canvas = document.createElement("canvas");
  canvas.style.maxHeight = fullscreen ? "none" : "320px";
  canvas.style.height = "100%";
  wrapper.appendChild(canvas);

  const commonScales = {
    x: {
      ...(isScatter || isLine ? { type: "category", labels } : {}),
      ticks: {
        color: t.tickColor,
        font: { family: "Inter, sans-serif", size: 12, weight: "400" },
        maxRotation: 45,
        callback: chartType === "bar" ? () => "" : undefined,
      },
      grid: { color: t.gridColor, drawBorder: false },
      border: { display: false },
    },
    y: {
      ticks: {
        color: t.tickColor,
        font: { family: "Inter, sans-serif", size: 12, weight: "400" },
      },
      grid: { color: t.gridColor, drawBorder: false },
      border: { display: false },
    },
  };

  new Chart(canvas, {
    type: chartType === "scatter" ? "scatter" : chartType,
    data: chartType === "scatter" ? { datasets } : { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: t.legendColor,
            font: { family: "Inter, sans-serif", size: 12, weight: "500" },
            padding: 16,
            usePointStyle: true,
            boxWidth: 8,
          },
        },
        tooltip: {
          backgroundColor: t.tooltipBg,
          titleColor: t.tooltipTitle,
          bodyColor: t.tooltipBody,
          borderColor: t.tooltipBorder,
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          boxPadding: 6,
          usePointStyle: true,
          titleFont: { family: "Inter", size: 13, weight: "600" },
          bodyFont: { family: "Inter", size: 13, weight: "400" },
        },
      },
      scales: chartType === "pie" ? {} : commonScales,
    },
  });

  return wrapper;
}

function chartLabel(type) {
  return type === "bar"     ? "Bar Chart"
       : type === "line"    ? "Line Chart"
       : type === "pie"     ? "Pie Chart"
       : type === "scatter" ? "Scatter Chart"
       : "";
}

function updateStatus(text) {
  const el = document.getElementById("statusText");
  if (el) el.textContent = text;
}

function makeSummaryEl(text) {
  const el = document.createElement("div");
  el.className = "summary-block";
  el.textContent = text.trim();
  return el;
}

function finalizeBubble(bubble, fullText, summaryText) {
  const renderedHTML = renderMarkdown(fullText);
  bubble.innerHTML   = renderedHTML;

  const chartTypes = detectChartRequest(lastUserMessage);
  const tableData  = extractTableFromMarkdown(fullText);
  const hasCharts  = chartTypes && tableData && tableData.rows.length > 0;

  if (tableData && tableData.rows.length > 0) {
    bubble.innerHTML = "";
    const dtContainer = document.createElement("div");
    bubble.appendChild(dtContainer);
    buildDataTable(tableData.headers, tableData.rows, dtContainer);
    if (summaryText && summaryText.trim()) {
      bubble.appendChild(makeSummaryEl(summaryText));
    }
  } else {
    if (summaryText && summaryText.trim()) {
      bubble.appendChild(makeSummaryEl(summaryText));
    }
  }

  if (hasCharts) {
    const chartsRow = document.createElement("div");
    chartsRow.className = "charts-row";
    chartTypes.forEach(type => {
      const chartBlock = document.createElement("div");
      chartBlock.className = "chart-block";

      const lbl = document.createElement("div");
      lbl.className   = "chart-label";
      lbl.textContent = chartLabel(type);
      
      const maxBtn = document.createElement("button");
      maxBtn.className = "chart-maximize-btn";
      maxBtn.title     = "Fullscreen";
      maxBtn.innerHTML = `⛶ Expand`;
      
      const headerRow = document.createElement("div");
      headerRow.style.display = "flex";
      headerRow.style.justifyContent = "space-between";
      headerRow.appendChild(lbl);
      headerRow.appendChild(maxBtn);

      chartBlock.appendChild(headerRow);
      chartBlock.appendChild(renderChart(tableData, type, false));

      maxBtn.addEventListener("click", () => {
        fsContent.innerHTML = "";
        const fsLbl = document.createElement("div");
        fsLbl.className   = "chart-label";
        fsLbl.textContent = chartLabel(type);
        fsContent.appendChild(fsLbl);
        fsContent.appendChild(renderChart(tableData, type, true));
        fsOverlay.classList.add("active");
        document.body.style.overflow = "hidden";
      });

      chartsRow.appendChild(chartBlock);
    });
    bubble.appendChild(chartsRow);
  }
  
  initPaginatedTables(bubble);
}

// ── Loading state ────────────────────────────────────────
function setLoading(loading) {
  sendBtn.disabled = loading;
  sendBtn.classList.toggle("loading", loading);
  input.disabled   = loading;
  stopBtn.style.display = loading ? "flex" : "none";
}

// ── Submit ───────────────────────────────────────────────
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  inputDock.classList.remove("hidden");

  lastUserMessage = message;
  appendUserMessage(message);

  input.value        = "";
  input.style.height = "auto";
  sendBtn.disabled   = true;
  setSectionPrompt(currentSection);
  input.focus();

  setLoading(true);
  const typingRow = appendTyping();

  const { row, bubble } = createRow("ai");
  bubble.classList.add("md-content");

  try {
    abortController = new AbortController();
    stopBtn.disabled = !streamingEnabled;

    const res = await fetch("/chat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, stream: streamingEnabled, section: currentSection }),
      signal:  abortController.signal,
    });

    if (!res.ok) throw new Error("Request failed");

    if (!streamingEnabled) {
      const data = await res.json();
      typingRow.remove();
      finalizeBubble(bubble, data.response || "", "");
      messages.appendChild(row);
      scrollToBottom();
      return;
    }

    typingRow.remove();
    bubble.innerHTML = `<div class="status-text" id="statusText">Connecting...</div><div class="stream-content"></div>`;
    let streamContent = bubble.querySelector(".stream-content");
    let summaryContainer = null;
    messages.appendChild(row);
    scrollToBottom();

    let fullText    = "";
    let summaryText = "";
    let inSummary   = false;
    let inTable     = false;
    let tableChunks = [];

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const chunk = line.slice(6);
        if (chunk === "[DONE]" || chunk === "[INTERRUPTED]") break;

        if (chunk.startsWith("__STATUS__")) {
          const statusTxt = chunk.replace(/__STATUS__/g, "");
          updateStatus(statusTxt);
          let statusEl = document.getElementById("statusText");
          if (!statusEl && streamContent) {
            statusEl = document.createElement("div");
            statusEl.className = "status-text";
            statusEl.id = "statusText";
            statusEl.textContent = statusTxt;
            bubble.insertBefore(statusEl, bubble.firstChild);
          }
          continue;
        }

        if (chunk === "__TABLE_START__") {
          inTable = true;
          const statusEl = document.getElementById("statusText");
          if (statusEl) statusEl.textContent = "Loading table data…";
          continue;
        }
        if (chunk === "__TABLE_END__") {
          inTable = false;
          const escapedTable = tableChunks.join("");
          fullText += escapedTable.replace(/\\n/g, "\n");
          tableChunks = [];
          const statusEl = document.getElementById("statusText");
          if (statusEl) statusEl.remove();
          
          finalizeBubble(bubble, fullText, "");
          streamContent = null; 
          continue;
        }

        if (chunk === "__SUMMARY__") {
          inSummary = true;
          continue;
        }

        if (inTable) {
          tableChunks.push(chunk);
        } else if (inSummary) {
          summaryText += chunk.replace(/\\n/g, "\n");
          if (!summaryContainer) {
            summaryContainer = document.createElement("div");
            summaryContainer.className = "summary-block";
            bubble.appendChild(summaryContainer);
          }
          summaryContainer.innerHTML = renderMarkdown(summaryText);
        } else {
          fullText += chunk.replace(/\\n/g, "\n");
          if (streamContent) {
            streamContent.innerHTML = renderMarkdown(fullText);
          }
        }
        scrollToBottom();
      }
    }

    finalizeBubble(bubble, fullText, summaryText);
    scrollToBottom();

  } catch (err) {
    if (err.name === "AbortError") {
      typingRow.remove();
      document.getElementById("statusText")?.remove();
      bubble.innerHTML = "User stopped the execution.";
      if (!row.parentNode) messages.appendChild(row);
      scrollToBottom();
      return;
    }
    typingRow.remove();
    if (!row.parentNode) messages.appendChild(row);
    bubble.classList.add("error-text");
    bubble.textContent = "Could not reach the server.";
  } finally {
    setLoading(false);
    stopBtn.disabled = true;
    abortController = null;
    sendBtn.disabled = !input.value.trim();
    scrollToBottom();
  }
});

function appendUserMessage(text) {
  const { row, bubble } = createRow("user");
  bubble.textContent = text;
  messages.appendChild(row);
  scrollToBottom();
}

function appendTyping() {
  const { row, bubble } = createRow("ai");
  bubble.innerHTML = `<div class="typing-indicator">
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
  </div>`;
  messages.appendChild(row);
  scrollToBottom();
  return row;
}
// -- Sidebar Logic -----------------------------------------
const sidebarToggle = document.getElementById("sidebarToggle");
const sidebar = document.getElementById("sidebar");
const sidebarItems = document.querySelectorAll(".sidebar-item");

if (sidebarToggle && sidebar) {
  sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("active");
    document.body.classList.toggle("sidebar-open");
  });
}

sidebarItems.forEach(item => {
  item.addEventListener("click", () => {
    if (item.dataset.option === currentSection) {
      if (window.innerWidth <= 768) {
        sidebar.classList.remove("active");
        document.body.classList.remove("sidebar-open");
      }
      return;
    }

    // Save current section's nodes
    const prevStore = getSectionStore(currentSection);
    prevStore.nodes = Array.from(messages.children);

    // Switch section
    sidebarItems.forEach(el => el.classList.remove("active"));
    item.classList.add("active");
    currentSection = item.dataset.option;
    document.getElementById("headerSectionTitle").textContent = currentSection;
    setSectionPrompt(currentSection);

    // Restore new section's nodes or show fresh welcome
    messages.innerHTML = "";
    const newStore = getSectionStore(currentSection);
    if (newStore.nodes.length > 0) {
      newStore.nodes.forEach(n => messages.appendChild(n));
    }

    scrollToBottom();

    if (window.innerWidth <= 768) {
      sidebar.classList.remove("active");
      document.body.classList.remove("sidebar-open");
    }
  });
});

// ── Auth Logic ──────────────────────────────────────────
(function () {
  const authOverlay = document.getElementById("authOverlay");
  if (!authOverlay) return;

  // ── Check if already logged in ─────────────────────────
  fetch("/auth/check")
    .then(r => r.json())
    .then(d => {
      if (d.logged_in) {
        authOverlay.style.display = "none";
        document.getElementById("logoutBtn").style.display = "flex";
      } else {
        // only start camera if not logged in
        initAuthWebcam("authLoginVideo", "authLoginCanvas", "authLoginStatus").then(wc => {
          authWebcams.login = wc;
        });
      }
    })
    .catch(() => {
      // if check fails, start camera anyway (assume not logged in)
      initAuthWebcam("authLoginVideo", "authLoginCanvas", "authLoginStatus").then(wc => {
        authWebcams.login = wc;
      });
    });

  // ── Theme-aware logo ───────────────────────────────────
  const authLogo = document.getElementById("authLogo");
  function syncAuthLogo() {
    if (!authLogo) return;
    authLogo.src = document.body.classList.contains("light")
      ? authLogo.dataset.light
      : authLogo.dataset.dark;
  }
  syncAuthLogo();
  themeBtn.addEventListener("click", syncAuthLogo);

  // ── Animated particle canvas ───────────────────────────
  const canvas = document.getElementById("authParticles");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    let W, H, particles;

    function resize() {
      W = canvas.width  = authOverlay.offsetWidth;
      H = canvas.height = authOverlay.offsetHeight;
    }

    function mkParticle() {
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.5 + 0.3,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        a: Math.random() * 0.5 + 0.1,
      };
    }

    function initParticles() {
      resize();
      particles = Array.from({ length: 80 }, mkParticle);
    }

    function drawParticles() {
      ctx.clearRect(0, 0, W, H);
      const isLight = document.body.classList.contains("light");
      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = W;
        if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H;
        if (p.y > H) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = isLight
          ? `rgba(37,99,235,${p.a * 0.4})`
          : `rgba(99,160,255,${p.a * 0.6})`;
        ctx.fill();
      });
      requestAnimationFrame(drawParticles);
    }

    initParticles();
    drawParticles();
    window.addEventListener("resize", initParticles);
  }

let faceLandmarker = null;
const FACE_OVAL = [9,337,296,331,283,250,388,355,453,322,360,
                   287,396,364,378,377,399,376,151,147,175,148,
                   149,135,171,57,131,92,233,126,161,20,53,102,66,108];

async function loadMediaPipe() {
  if (faceLandmarker) return;
  const { FaceLandmarker, FilesetResolver } = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs"
  );
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
  });
}

async function initAuthWebcam(videoId, canvasId, statusId) {
  const video    = document.getElementById(videoId);
  const canvas   = document.getElementById(canvasId);
  const statusEl = document.getElementById(statusId);
  if (!video || !canvas || !statusEl) return null;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" }
    });
    video.srcObject = stream;

    return new Promise((resolve) => {
      video.addEventListener("loadedmetadata", async () => {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.style.display = "block";
        statusEl.textContent = "Loading face detection...";

        await loadMediaPipe();
        statusEl.textContent = "✓ Camera ready";

        const ctx = canvas.getContext("2d");
        let active = true;
        function loop() {
          if (!active) return;
          requestAnimationFrame(loop);
          if (!faceLandmarker) return;
          const now    = performance.now();
          const result = faceLandmarker.detectForVideo(video, now);

          ctx.save();
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(video, 0, 0);
          ctx.restore();

          if (!result.faceLandmarks?.length) {
            statusEl.textContent = "No face detected";
            return;
          }
          const lm = result.faceLandmarks[0];
          const W = canvas.width, H = canvas.height;
          const xs  = FACE_OVAL.map(i => lm[i].x * W);
          const ys  = FACE_OVAL.map(i => lm[i].y * H);
          const pad = 10;
          const x1  = Math.max(0, Math.min(...xs) - pad);
          const y1  = Math.max(0, Math.min(...ys) - pad);
          const x2  = Math.min(W, Math.max(...xs) + pad);
          const y2  = Math.min(H, Math.max(...ys) + pad);

          ctx.strokeStyle = "#00ff00";
          ctx.lineWidth   = 2;
          ctx.strokeRect(W - x2, y1, x2 - x1, y2 - y1);
          statusEl.textContent = "✓ Face detected";
        }
        loop();
        resolve({ video, canvas, statusEl, stop: () => { active = false; } });
      }, { once: true });
    });
  } catch (err) {
    statusEl.textContent = "❌ Camera access denied";
    return null;
  }
}

  // Store webcam references
  const authWebcams = {
    login: null,
    register: null
  };

  // ── Tab switching ──────────────────────────────────────
  const tabLogin    = document.getElementById("tabLogin");
  const tabRegister = document.getElementById("tabRegister");
  const panelLogin  = document.getElementById("panelLogin");
  const panelReg    = document.getElementById("panelRegister");
  const indicator   = document.getElementById("authTabIndicator");

  function switchTab(tab) {
    if (tab === "login") {
      tabLogin.classList.add("active");    tabLogin.setAttribute("aria-selected", "true");
      tabRegister.classList.remove("active"); tabRegister.setAttribute("aria-selected", "false");
      panelLogin.classList.add("active");  panelReg.classList.remove("active");
      if (indicator) indicator.classList.remove("right");
      // Initialize login webcam
      if (!authWebcams.login) {
        initAuthWebcam("authLoginVideo", "authLoginCanvas", "authLoginStatus").then(wc => {
          authWebcams.login = wc;
        });
      }
    } else {
      tabRegister.classList.add("active"); tabRegister.setAttribute("aria-selected", "true");
      tabLogin.classList.remove("active"); tabLogin.setAttribute("aria-selected", "false");
      panelReg.classList.add("active");    panelLogin.classList.remove("active");
      if (indicator) indicator.classList.add("right");
      // Initialize register webcam
      if (!authWebcams.register) {
        initAuthWebcam("authRegVideo", "authRegCanvas", "authRegStatus").then(wc => {
          authWebcams.register = wc;
        });
      }
    }
    // clear errors on switch
    document.getElementById("loginError").textContent    = "";
    document.getElementById("registerError").textContent = "";
  }

  tabLogin?.addEventListener("click", () => switchTab("login"));
  tabRegister?.addEventListener("click", () => switchTab("register"));
  document.getElementById("goRegister")?.addEventListener("click", () => switchTab("register"));
  document.getElementById("goLogin")?.addEventListener("click", () => switchTab("login"));

  // ── Show / hide password toggles ───────────────────────
  document.querySelectorAll(".auth-eye-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const inp = document.getElementById(btn.dataset.target);
      if (!inp) return;
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      btn.querySelector(".eye-open").style.display  = show ? "none"  : "";
      btn.querySelector(".eye-closed").style.display = show ? ""     : "none";
    });
  });

  // ── Password strength meter ─────────────────────────────
  const regPasswordInput = document.getElementById("regPassword");
  const pwdBars  = [0,1,2,3].map(i => document.getElementById("pwdBar" + i));
  const pwdLabel = document.getElementById("pwdLabel");

  function scorePassword(pw) {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 8)  score++;
    if (pw.length >= 12) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    return Math.min(4, Math.ceil(score * 4 / 5));
  }

  const STRENGTH = ["", "Weak", "Fair", "Good", "Strong"];
  const STRENGTH_CLASS = ["", "weak", "fair", "good", "strong"];

  function updateStrength() {
    const score = scorePassword(regPasswordInput.value);
    pwdBars.forEach((bar, i) => {
      bar.className = "pwd-bar" + (i < score ? " " + STRENGTH_CLASS[score] : "");
    });
    if (pwdLabel) {
      pwdLabel.textContent = score > 0 ? STRENGTH[score] : "";
      pwdLabel.style.color = score <= 1 ? "#EF4444" : score === 2 ? "#F59E0B" : score === 3 ? "#10B981" : "#3B82F6";
    }
  }

  regPasswordInput?.addEventListener("input", updateStrength);

  // ── Helper: set button loading state ───────────────────
  function setBtnLoading(btn, loading) {
    btn.classList.toggle("loading", loading);
    btn.disabled = loading;
  }

  // ── Capture face from webcam as base64 ─────────────────
  function captureWebcamFrame(wc) {
    if (!wc || !wc.video || !wc.canvas) return null;
    const ctx = wc.canvas.getContext("2d");
    ctx.drawImage(wc.video, 0, 0, wc.canvas.width, wc.canvas.height);
    const dataUrl = wc.canvas.toDataURL("image/jpeg", 0.9);
    return dataUrl.split(",")[1]; // return base64 only
  }

  async function captureMultipleFrames(wc, count = 5, delayMs = 400) {
    const crops = [];
    for (let i = 0; i < count; i++) {
      crops.push(captureWebcamFrame(wc));
      if (i < count - 1) await new Promise(r => setTimeout(r, delayMs));
    }
    return crops;
  }

  // ── Login with face verification ────────────────────────
  const loginBtn = document.getElementById("loginBtn");
  const loginContinueBtn = document.getElementById("loginContinueBtn");
  const loginError = document.getElementById("loginError");
  const loginCredentialsStep = document.getElementById("loginCredentialsStep");
  const loginFaceStep = document.getElementById("loginFaceStep");

  function showLoginStep(step) {
    const isFace = step === "face";
    if (loginCredentialsStep) loginCredentialsStep.style.display = isFace ? "none" : "block";
    if (loginFaceStep) loginFaceStep.style.display = isFace ? "block" : "none";
    if (!isFace) {
      loginError.textContent = "";
    }
  }

  async function doNormalLogin() {
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    loginError.textContent = "";

    if (!email || !password) {
      loginError.textContent = "Please enter your email and password.";
      return;
    }

    setBtnLoading(loginContinueBtn, true);
    try {
      const res = await fetch("/face/login/basic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (data.status === "auth_success") {
        showLoginStep("face");
        document.getElementById("authLoginStatus").textContent = "Camera ready — verify your face";
        if (!authWebcams.login) {
          initAuthWebcam("authLoginVideo", "authLoginCanvas", "authLoginStatus").then(wc => {
            authWebcams.login = wc;
          });
        }
        return;
      }

      loginError.textContent = data.error || "Invalid email or password.";
    } catch (err) {
      loginError.textContent = "Server error: " + err.message;
    } finally {
      setBtnLoading(loginContinueBtn, false);
    }
  }

  async function doLogin() {
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const loginStatus = document.getElementById("authLoginStatus");
    loginError.textContent = "";

    if (!email || !password) {
      loginError.textContent = "Please enter your email and password first.";
      showLoginStep("credentials");
      return;
    }

    const crop = captureWebcamFrame(authWebcams.login);
    if (!crop) {
      loginError.textContent = "Could not capture face. Check camera.";
      return;
    }

    setBtnLoading(loginBtn, true);
    loginStatus.textContent = "Verifying face...";

    try {
      const loginRes = await fetch("/face/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, crop }),
      });
      const loginData = await loginRes.json();

      if (loginData.status === "auth_failed") {
        loginError.textContent = "Invalid email or password.";
        showLoginStep("credentials");
        return;
      }
      if (loginData.status === "face_too_small") {
        loginError.textContent = "⚠️ Move closer to the camera.";
        return;
      }
      if (loginData.status === "face_mismatch") {
        loginError.textContent = "Face does not match this email address.";
        return;
      }
      if (loginData.status === "login_success") {
        loginStatus.textContent = `✓ Welcome, ${loginData.name}!`;

        setTimeout(() => {
          authOverlay.style.display = "none";
          document.getElementById("logoutBtn").style.display = "flex";
          if (authWebcams.login?.stop)    authWebcams.login.stop();
          if (authWebcams.register?.stop) authWebcams.register.stop();
          document.querySelectorAll(".auth-video").forEach(v => {
            if (v.srcObject) {
              v.srcObject.getTracks().forEach(t => t.stop());
              v.srcObject = null;
            }
          });
        }, 1000);
        return;
      }

      loginError.textContent = loginData.error || "Login failed.";

    } catch (err) {
      loginError.textContent = "Server error: " + err.message;
    } finally {
      setBtnLoading(loginBtn, false);
    }
  }

  loginContinueBtn?.addEventListener("click", doNormalLogin);
  loginBtn?.addEventListener("click", doLogin);

  // Allow Enter key inside login panel
  panelLogin?.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (loginFaceStep && loginFaceStep.style.display !== "none") {
        doLogin();
      } else {
        doNormalLogin();
      }
    }
  });

  // ── Register with face enrollment ──────────────────────
  const registerBtn  = document.getElementById("registerBtn");
  const registerError = document.getElementById("registerError");

  async function doRegister() {
    const name            = document.getElementById("regName").value.trim();
    const email           = document.getElementById("regEmail").value.trim();
    const password        = document.getElementById("regPassword").value;
    const confirmPassword = document.getElementById("regConfirmPassword").value;
    registerError.textContent = "";

    if (!name || !email || !password || !confirmPassword) {
      registerError.textContent = "Please fill in all fields.";
      return;
    }
    if (password !== confirmPassword) {
      registerError.textContent = "Passwords do not match.";
      return;
    }
    if (password.length < 8) {
      registerError.textContent = "Password must be at least 8 characters.";
      return;
    }

    registerError.textContent = "";
    document.getElementById("authRegStatus").textContent = "Capturing face... stay still";
    const crops = await captureMultipleFrames(authWebcams.register, 5, 400);
    document.getElementById("authRegStatus").textContent = "✓ Face captured";

    if (!crops || crops.length === 0 || crops.every(crop => !crop)) {
      registerError.textContent = "Could not capture face. Check camera.";
      return;
    }

    setBtnLoading(registerBtn, true);
    try {
      const res = await fetch("/face/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, crops }),
      });
      const data = await res.json();
      
     if (data.status === "registered") {
      authOverlay.style.display = "none";
      registerError.textContent = "";
      document.getElementById("logoutBtn").style.display = "flex";
      // stop register
      if (authWebcams.login?.stop)    authWebcams.login.stop();
      if (authWebcams.register?.stop) authWebcams.register.stop();

      document.querySelectorAll(".auth-video").forEach(v => {
        if (v.srcObject) {
          v.srcObject.getTracks().forEach(t => t.stop());
          v.srcObject = null;
        }
      });
    } else if (data.status === "email_exists") {
        registerError.textContent = "Email already registered.";
      } else {
        registerError.textContent = data.error || "Registration failed.";
      }
    } catch (err) {
      registerError.textContent = "Server error: " + err.message;
    } finally {
      setBtnLoading(registerBtn, false);
    }
  }

  registerBtn?.addEventListener("click", doRegister);

  // Allow Enter key inside register panel
  panelReg?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); doRegister(); }
  });

  // ── Logout handler ──────────────────────────────────────
  const logoutBtn = document.getElementById("logoutBtn");
  logoutBtn?.addEventListener("click", async () => {
    try {
      await fetch("/logout", { method: "POST" });
    } catch(e) {}
    
    // hide logout button
    logoutBtn.style.display = "none";

    // reset chat
    messages.innerHTML = "";
    // reset section stores
    Object.keys(sectionChats).forEach(k => delete sectionChats[k]);

    // reset login form
    document.getElementById("loginEmail").value = "";
    document.getElementById("loginPassword").value = "";
    document.getElementById("loginError").textContent = "";
    document.getElementById("authLoginStatus").textContent = "Loading camera...";
    showLoginStep("credentials");

    // show auth overlay again
    authOverlay.style.display = "flex";

    // reset webcam state completely
    authWebcams.login = null;
    authWebcams.register = null;

    // reset canvas display so initAuthWebcam shows it again
    const loginCanvas = document.getElementById("authLoginCanvas");
    if (loginCanvas) {
      loginCanvas.style.display = "none";
      loginCanvas.width = 0;
      loginCanvas.height = 0;
    }

    // reset video element
    const loginVideo = document.getElementById("authLoginVideo");
    if (loginVideo) {
      loginVideo.srcObject = null;
    }

    // reset status text
    document.getElementById("authLoginStatus").textContent = "Loading camera...";

    // restart webcam fresh
    setTimeout(() => {
      initAuthWebcam("authLoginVideo", "authLoginCanvas", "authLoginStatus").then(wc => {
        authWebcams.login = wc;
      });
    }, 300); // small delay to let DOM settle
  });
})();