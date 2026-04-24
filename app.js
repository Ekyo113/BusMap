/**
 * app.js — 公車動態監控前端邏輯
 *
 * 功能：
 * 1. 啟動時從 /bus/cities 讀取城市清單，填入下拉選單
 * 2. 每 30 秒呼叫 /bus/status?city=XXX 取得公車狀態
 * 3. 依狀態優先級更新表格（incident > attention > operating > not_operating）
 * 4. 在 Leaflet 地圖上顯示各車輛 GPS 位置（彩色圓點/警示圖示）
 * 5. 倒數計時環 + 最後更新時間
 */

// ── 設定 ──────────────────────────────────
const API_BASE       = "https://busappeal.onrender.com";
// const API_BASE    = "http://localhost:8000";  // ← 本地測試用，取消此行註解
const REFRESH_SEC    = 120;   // 自動刷新間隔（秒）
const STALL_LABEL_SEC = 120; // 超過幾秒顯示靜止時間（= 2分鐘）

// ── 狀態對應 ───────────────────────────────
const STATUS_ICON = {
  incident:    "🔴",
  attention:   "🟡",
  operating:   "🟢",
  not_operating: "⚫",
};

const STATUS_LABEL = {
  incident:     "品情通報",
  attention:    "注意車輛",
  operating:    "營運中",
  not_operating: "未營運",
};

const STATUS_PRIORITY = {
  incident: 0, attention: 1, operating: 2, not_operating: 3,
};

// Leaflet 圓點顏色
const STATUS_COLOR = {
  incident:    "#f85149",
  attention:   "#e3b341",
  operating:   "#3fb950",
  not_operating: "#6e7681",
};

// ── DOM 參照 ───────────────────────────────
const citySelect      = document.getElementById("citySelect");
const btnUpdateRoute  = document.getElementById("btnUpdateRoute");
const btnUpdateStop   = document.getElementById("btnUpdateStop");
const busTableBody    = document.getElementById("busTableBody");
const lastUpdatedEl   = document.getElementById("lastUpdated");
const countdownNumEl  = document.getElementById("countdownNum");
const ringPath        = document.getElementById("ringPath");
const toastEl         = document.getElementById("toast");
const filterBtns      = document.querySelectorAll(".filter-btn");
const vendorSelect    = document.getElementById("vendorSelect");

// Stats
const statTotal     = document.getElementById("statTotal").querySelector(".stat-num");
const statIncident  = document.getElementById("statIncident").querySelector(".stat-num");
const statAttention = document.getElementById("statAttention").querySelector(".stat-num");
const statOperating = document.getElementById("statOperating").querySelector(".stat-num");
const statOffline   = document.getElementById("statOffline").querySelector(".stat-num");

// ── 狀態變數 ─────────────────────────────
let map;
let markers        = {};    // plate_number → Leaflet marker
let busData        = [];    // 最新一次 API 回傳的 buses 陣列
let currentFilter  = "all"; // 目前過濾條件
let currentVendor  = "all"; // 目前客運過濾
let countdownTimer = null;
let countdown      = REFRESH_SEC;
const CIRCUMFERENCE = 100.53; // 2π × 16（SVG 路徑周長）

// ── 初始化 ────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  await loadCities();
  await refresh();
  startCountdown();

  // 城市切換
  citySelect.addEventListener("change", async () => {
    clearMarkers();
    busData = [];
    renderTable([]);
    await refresh();
    resetCountdown();
  });

  if (btnUpdateRoute) {
    btnUpdateRoute.addEventListener("click", async () => {
      showToast("更新路線中...");
      await refresh();
      resetCountdown();
    });
  }

  if (btnUpdateStop) {
    btnUpdateStop.addEventListener("click", async () => {
      showToast("更新目前站點中...");
      await refresh();
      resetCountdown();
    });
  }

  // 表格過濾按鈕
  filterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      filterBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      renderTable(busData);
    });
  });

  if (vendorSelect) {
    vendorSelect.addEventListener("change", () => {
      currentVendor = vendorSelect.value;
      renderTable(busData);
    });
  }
});

// ── 地圖初始化 ────────────────────────────
function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true }).setView([22.9999, 120.2269], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
}

// ── 取得城市清單 ──────────────────────────
async function loadCities() {
  try {
    const res = await fetch(`${API_BASE}/bus/cities`);
    if (!res.ok) throw new Error(res.status);
    const cities = await res.json();

    citySelect.innerHTML = "";
    cities.forEach(c => {
      const opt = document.createElement("option");
      opt.value       = c.city_code;
      opt.textContent = c.city_name;
      citySelect.appendChild(opt);
    });

    // 預設選台南
    const tainan = cities.find(c => c.city_code === "Tainan");
    if (tainan) citySelect.value = "Tainan";

  } catch (e) {
    citySelect.innerHTML = "<option value='Tainan'>台南市</option><option value='Kaohsiung'>高雄市</option>";
    console.error("loadCities error:", e);
  }
}

// ── 主要刷新函式 ──────────────────────────
async function refresh() {
  const city = citySelect.value || "Tainan";
  try {
    const res = await fetch(`${API_BASE}/bus/status?city=${city}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    busData = data.buses || [];
    updateVendorSelect(busData);

    // 取得選取城市的中心座標並移動地圖
    updateMapCenter(city);

    renderTable(busData);
    updateMap(busData);
    updateStats(busData);
    updateLastUpdated(data.updated_at);

  } catch (e) {
    showToast("⚠️ 資料取得失敗，請確認後端是否正常運作");
    console.error("refresh error:", e);
  }
}

// ── 移動地圖中心 ──────────────────────────
function updateMapCenter(cityCode) {
  const centers = {
    Tainan:    [22.9999, 120.2269],
    Kaohsiung: [22.6273, 120.3014],
    Taipei:    [25.0330, 121.5654],
    NewTaipei: [25.0120, 121.4650],
    Taichung:  [24.1477, 120.6736],
    Taoyuan:   [24.9936, 121.3010],
    Hsinchu:   [24.8066, 120.9686],
    Keelung:   [25.1276, 121.7392],
    Chiayi:    [23.4800, 120.4490],
  };
  const center = centers[cityCode] || [23.5, 121.0];
  map.flyTo(center, 12, { duration: 1.2 });
}

// ── 更新客運選單 ──────────────────────────
function updateVendorSelect(buses) {
  if (!vendorSelect) return;
  const vendors = new Set(buses.map(b => b.vendor_name).filter(v => v));
  const options = ["<option value='all'>所有客運</option>"];
  
  const selected = vendorSelect.value;
  
  Array.from(vendors).sort().forEach(v => {
    options.push(`<option value="${escHtml(v)}">${escHtml(v)}</option>`);
  });
  
  vendorSelect.innerHTML = options.join("");
  
  if (vendors.has(selected) || selected === "all") {
    vendorSelect.value = selected;
  } else {
    vendorSelect.value = "all";
    currentVendor = "all";
  }
}

// ── 渲染表格 ──────────────────────────────
function renderTable(buses) {
  let filtered = buses;
  if (currentVendor !== "all") {
    filtered = filtered.filter(b => b.vendor_name === currentVendor);
  }
  if (currentFilter !== "all") {
    filtered = filtered.filter(b => b.status === currentFilter);
  }

  if (filtered.length === 0) {
    busTableBody.innerHTML = `<tr><td colspan="5" class="loading-row">沒有符合條件的車輛</td></tr>`;
    return;
  }

  busTableBody.innerHTML = filtered.map(b => {
    const rowClass  = b.status === "incident"  ? "row-incident"
                    : b.status === "attention" ? "row-attention"
                    : "";

    const descCell = b.has_incident
      ? `<span class="incident-badge">⚠ ${escHtml(b.incident_description || "")}</span>`
      : b.status === "attention"
      ? `<span class="stall-badge">⏸ 靜止 ${formatStall(b.stalled_seconds)}</span>`
      : `<span style="color:var(--text-muted)">${escHtml(b.current_stop || "---")}</span>`;

    return `
      <tr class="${rowClass}" data-plate="${escHtml(b.plate_number)}" onclick="focusBus('${escHtml(b.plate_number)}')">
        <td class="status-icon">${STATUS_ICON[b.status] || "⚫"}</td>
        <td class="plate-text">${escHtml(b.plate_number)}</td>
        <td>${escHtml(b.route_name || "---")}</td>
        <td style="color:var(--text-secondary);font-size:12px">${escHtml(b.current_stop || "---")}</td>
        <td>${descCell}</td>
      </tr>`;
  }).join("");
}

// ── 更新地圖標記 ──────────────────────────
function updateMap(buses) {
  const activePlates = new Set();

  buses.forEach(b => {
    // 優先使用目前 GPS，若無則使用最後一次紀錄的 GPS
    const lat = b.lat || b.last_lat;
    const lon = b.lon || b.last_lon;
    if (!lat || !lon) return;

    activePlates.add(b.plate_number);

    const color = STATUS_COLOR[b.status] || "#6e7681";
    const pulseClass = b.status === "attention" ? "pulse-attention"
                     : b.status === "incident"  ? "pulse-incident"
                     : "";

    // 自訂像素公車 + 車牌圖示
    const icon = L.divIcon({
      className: `bus-marker-div ${pulseClass}`,
      html: `<div class="bus-icon-wrapper ${b.status}">
               <div class="bus-plate">${escHtml(b.plate_number)}</div>
               <div class="bus-emoji">🚍</div>
               ${b.status === "incident" ? `<div class="bus-alert">!</div>` : ""}
             </div>`,
      iconSize: [60, 50],
      iconAnchor: [30, 45], // 讓 emoji 底部對準座標
      popupAnchor: [0, -40]
    });

    const popupHtml = buildPopup(b);

    if (markers[b.plate_number]) {
      markers[b.plate_number].setLatLng([lat, lon]);
      markers[b.plate_number].setIcon(icon);
      markers[b.plate_number].getPopup()?.setContent(popupHtml);
    } else {
      const m = L.marker([lat, lon], { icon })
        .addTo(map)
        .bindPopup(popupHtml);
      markers[b.plate_number] = m;
    }
  });

  // 移除不在清單中的標記
  Object.keys(markers).forEach(plate => {
    if (!activePlates.has(plate)) {
      map.removeLayer(markers[plate]);
      delete markers[plate];
    }
  });
}

function buildPopup(b) {
  const statusColor = {
    incident: "popup-status-incident",
    attention: "popup-status-attention",
    operating: "popup-status-operating",
  };
  const cls = statusColor[b.status] || "";

  // 格式化時間：如果是字串可以轉 Date
  let lastTimeHtml = "";
  if (b.status === "not_operating" && b.last_gps_time) {
    try {
      const d = new Date(b.last_gps_time);
      const timeStr = `${d.getFullYear()}/${(d.getMonth()+1).toString().padStart(2,"0")}/${d.getDate().toString().padStart(2,"0")} ${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`;
      lastTimeHtml = `<div class="popup-row" style="margin-top:6px;font-size:12px;color:var(--text-muted)">最後紀錄：${timeStr}</div>`;
    } catch {
      // ignore
    }
  }

  const lat = b.lat || b.last_lat;
  const lon = b.lon || b.last_lon;

  return `
    <div class="popup-plate">${escHtml(b.plate_number)}</div>
    <div class="popup-row">狀態：<span class="${cls}">${STATUS_ICON[b.status]} ${STATUS_LABEL[b.status] || ""}</span></div>
    <div class="popup-row">路線：<span>${escHtml(b.route_name || "---")}</span></div>
    <div class="popup-row">站點：<span>${escHtml(b.current_stop || "---")}</span></div>
    ${b.stalled_seconds > STALL_LABEL_SEC
      ? `<div class="popup-row">靜止：<span style="color:var(--attention-color)">${formatStall(b.stalled_seconds)}</span></div>`
      : ""}
    ${b.has_incident
      ? `<div class="popup-row" style="margin-top:6px">⚠ <span style="color:var(--incident-color)">${escHtml(b.incident_description || "")}</span></div>`
      : ""}
    ${lastTimeHtml}
    <div class="popup-row" style="margin-top:6px;font-size:11px;color:var(--text-muted)">
      GPS: ${lat?.toFixed(5) || "未知"}, ${lon?.toFixed(5) || "未知"}
    </div>`;
}

// ── 點擊表格列 → 地圖聚焦 ────────────────
function focusBus(plate) {
  const m = markers[plate];
  if (m) {
    map.flyTo(m.getLatLng(), 15, { duration: 0.8 });
    m.openPopup();
  }
}

// ── 清除所有地圖標記 ──────────────────────
function clearMarkers() {
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};
}

// ── 更新統計列 ────────────────────────────
function updateStats(buses) {
  const counts = { total: buses.length, incident: 0, attention: 0, operating: 0, not_operating: 0 };
  buses.forEach(b => { if (counts[b.status] !== undefined) counts[b.status]++; });
  statTotal.textContent     = counts.total;
  statIncident.textContent  = counts.incident;
  statAttention.textContent = counts.attention;
  statOperating.textContent = counts.operating;
  statOffline.textContent   = counts.not_operating;
}

// ── 更新時間顯示 ──────────────────────────
function updateLastUpdated(isoStr) {
  try {
    const d = new Date(isoStr);
    lastUpdatedEl.textContent = `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}:${d.getSeconds().toString().padStart(2,"0")} 更新`;
  } catch {
    lastUpdatedEl.textContent = "剛剛更新";
  }
}

// ── 倒數計時器 ────────────────────────────
function startCountdown() {
  countdown = REFRESH_SEC;
  countdownTimer = setInterval(async () => {
    countdown--;
    updateRing(countdown);
    if (countdown <= 0) {
      countdown = REFRESH_SEC;
      const options = Array.from(citySelect.options);
      if (options.length > 1) {
        const currentIndex = options.findIndex(opt => opt.value === citySelect.value);
        const nextIndex = (currentIndex + 1) % options.length;
        citySelect.value = options[nextIndex].value;
        
        clearMarkers();
        busData = [];
        renderTable([]);
      }
      await refresh();
    }
  }, 1000);
}

function resetCountdown() {
  clearInterval(countdownTimer);
  startCountdown();
}

function updateRing(sec) {
  countdownNumEl.textContent = sec;
  const offset = CIRCUMFERENCE * (1 - sec / REFRESH_SEC);
  ringPath.style.strokeDashoffset = offset;
}

// ── Toast 通知 ────────────────────────────
let toastTimer;
function showToast(msg, duration = 3500) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("visible");
    toastEl.classList.add("hidden");
  }, duration);
}

// ── 工具函式 ──────────────────────────────
function escHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
}

function formatStall(sec) {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}
