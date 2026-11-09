import { IGNMap, searchPlaces, fetchBuildings, fetchTerrain, toWGS84 } from "./ign.js?v=20261109d";
import { Viewer3D } from "./viewer3d.js?v=20261109d";
import {
  zipSync,
  strToU8
} from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";

const $ = selector => document.querySelector(selector);
const PAPER_MM = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297]
};
const RHINO_BASE = "https://cdn.jsdelivr.net/npm/rhino3dm@8.4.0/";

let source = "ign";
let project = null;
let sheetFiles = null;
let previewURL = null;
let buildingsReady = false;
let busy = false;
let operationNumber = 0;
let operationController = null;
let searchController = null;
let searchNumber = 0;
let searchTimer = null;
let rhinoPromise = null;
let viewer = null;
let currentStep = 1;
const completedSteps = new Set();
let operationKind = "generate";
let elapsedTimer = null;
let startedAt = 0;

// Progress: messages like "지형 높이 850 / 1681점" give a real percentage and an
// ETA from the measured rate; other stages show the moving (indeterminate) bar.
let measured = null;
let loadingOverlay = null;
const engineStateSink = { textContent: "" };  // engine state is internal; users see the step  // full-screen progress, created at the end of this file
function updateProgress(message) {
  const bar = $("#operation-progress"), fill = bar.querySelector("span");
  const m = /([\d,]+)\s*\/\s*([\d,]+)/.exec(message);
  if (!busy || !m) {
    measured = null;
    bar.classList.remove("determinate");
    fill.style.width = "";
    bar.removeAttribute("aria-valuenow");
    return;
  }
  const done = Number(m[1].replace(/,/g, "")), total = Number(m[2].replace(/,/g, ""));
  if (!(total > 0)) return;
  const now = performance.now();
  if (!measured || measured.total !== total || done < measured.done) {
    measured = { total, done, t0: now, d0: done };
  }
  measured.done = done;
  const pct = Math.min(100, Math.round(done / total * 100));
  bar.classList.add("determinate");
  fill.style.width = pct + "%";
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(pct));
  const rate = (done - measured.d0) / ((now - measured.t0) / 1000);
  const left = rate > 0 ? Math.ceil((total - done) / rate) : null;
  measured.label = `${pct}%` + (left !== null && done < total
    ? ` · 약 ${left >= 60 ? Math.floor(left / 60) + "분 " : ""}${left % 60}초 남음` : "");
}

function status(message, error = false) {
  $("#status").textContent = message;
  $("#status").dataset.error = String(error);
  updateProgress(message);
  loadingOverlay?.message(message);
  showLocalError(
    operationKind === "buildings" ? "site-error" :
      operationKind === "export" ? "export-error" : "generation-error",
    error ? message : ""
  );
}

class PythonClient {
  constructor() {
    this.worker = null;
    this.pending = null;
  }

  createWorker() {
    if (this.worker) return;
    const worker = new Worker(new URL("./worker.js?v=20261109d", import.meta.url));
    this.worker = worker;

    worker.onmessage = event => {
      if (this.worker !== worker) return;
      const message = event.data;
      if (message?.type === "progress") {
        if (this.pending) status(message.message);
        return;
      }
      if (!this.pending) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timeout);

      if (message?.ok === true) {
        engineStateSink.textContent = "준비 완료";
        pending.resolve(message.result);
      }
      else pending.reject(new Error(message?.error || "도면 계산 중 오류가 발생했습니다."));
    };

    worker.onerror = event => {
      event.preventDefault();
      this.reset(new Error(event.message || "도면 생성기를 시작하지 못했습니다. 페이지를 새로고침하세요."));
    };
    worker.onmessageerror = () => {
      this.reset(new Error("도면 계산 결과를 읽지 못했습니다. 다시 시도해 주세요."));
    };
  }

  call(cmd, args = {}, transfer = []) {
    if (this.pending) {
      return Promise.reject(new Error("이미 모형을 만드는 중입니다."));
    }
    this.createWorker();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.reset(new Error("계산 시간이 초과되었습니다. 대지 범위를 줄이거나 지형 정밀도 값을 키우세요."));
      }, 300000);
      this.pending = { resolve, reject, timeout };
      try {
        this.worker.postMessage({ cmd, args }, transfer);
      } catch (error) {
        clearTimeout(timeout);
        this.pending = null;
        reject(error);
      }
    });
  }

  reset(error = new DOMException("취소되었습니다.", "AbortError")) {
    this.worker?.terminate();
    this.worker = null;
    engineStateSink.textContent = "도면 생성기 준비 중 · 모형 생성 시 자동 시작";
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(error);
      this.pending = null;
    }
  }
}

const python = new PythonClient();
let skippedNote = "";

async function rhinoEngine() {
  if (!rhinoPromise) {
    if (typeof globalThis.rhino3dm !== "function") {
      throw new Error("3DM 파일 도구를 불러오지 못했습니다. 네트워크를 확인하세요.");
    }
    rhinoPromise = globalThis.rhino3dm({
      locateFile: filename => RHINO_BASE + filename
    }).catch(error => {
      rhinoPromise = null;
      throw error;
    });
  }
  return rhinoPromise;
}

function settings() {
  for (const id of ["scale", "thickness", "interval"]) {
    if (!$("#" + id).reportValidity()) {
      throw new Error("제작 설정을 확인하세요.");
    }
  }
  return {
    scale: Number($("#scale").value),
    thickness_mm: Number($("#thickness").value),
    interval_m: Number($("#interval").value),
    paper: $("#paper").value,
    orientation: $("#orientation").value,
    ...($("#paper").value === "custom" ? {
      paper_width_mm: Number($("#paper-width").value),
      paper_height_mm: Number($("#paper-height").value)
    } : {}),
    building_mode: $("#building-mode").value,
    building_thickness_mm: Number($("#building-thickness").value),
    floor_height_m: Number($("#floor-height").value)
  };
}

// Building board thickness only matters for laser-cut buildings.
// Show only the fields that apply: board thickness for "laser",
// floor height for the two per-floor modes.
function syncBuildingFields() {
  const mode = $("#building-mode").value;
  const board = mode === "laser", perFloor = mode.endsWith("_floor");
  $("#building-thickness-field").hidden = !board;
  $("#building-thickness").disabled = !board;
  $("#floor-height-field").hidden = !perFloor;
  $("#floor-height").disabled = !perFloor;
}
$("#building-mode").addEventListener("change", () => { syncBuildingFields(); invalidate(); });
syncBuildingFields();

// True-scale link: interval (m) = plate thickness (mm) × scale / 1000.
function linkFrom(source) {
  if (!$("#link-scale").checked) return;
  const scale = Number($("#scale").value), t = Number($("#thickness").value);
  const iv = Number($("#interval").value);
  if (!(scale > 0)) return;
  if (source === "interval" && iv > 0) {
    $("#thickness").value = +(iv * 1000 / scale).toFixed(4);
  } else if (t > 0) {
    $("#interval").value = +(t * scale / 1000).toFixed(4);
  }
  updateSettingsNotes();
}
$("#thickness").addEventListener("input", () => linkFrom("thickness"));
$("#scale").addEventListener("input", () => linkFrom("scale"));
$("#interval").addEventListener("input", () => linkFrom("interval"));
$("#link-scale").addEventListener("change", () => { linkFrom("thickness"); invalidate(); });
queueMicrotask(() => linkFrom("thickness"));  // after module init
$("#building-thickness").addEventListener("change", () => invalidate());
$("#floor-height").addEventListener("change", () => {
  // typed floor counts on buildings without a measured height follow 층고
  for (const b of ignMap.buildings) {
    if (b.manualFloors && b.measuredH == null) b.h = b.manualFloors * floorHeight();
  }
  if (buildingsReady) renderBuildingList();
  invalidate();
});

function availablePaper(config) {
  let width, height;
  if (config.paper === "custom") {
    [width, height] = [config.paper_width_mm, config.paper_height_mm];
  } else {
    const dimensions = PAPER_MM[config.paper];
    if (!dimensions) throw new Error("지원하지 않는 용지입니다.");
    [width, height] = config.orientation === "landscape"
      ? [dimensions[1], dimensions[0]] : dimensions;
  }
  // Same reserved space as the reference UI: 24 mm horizontal, 48 mm vertical.
  return [width - 24, height - 48];
}

function checkFit(bounds, config) {
  const [width, height] = availablePaper(config);
  const x = (bounds[2] - bounds[0]) * 1000 / config.scale;
  const y = (bounds[3] - bounds[1]) * 1000 / config.scale;
  return {
    fits: x <= width + 1e-6 && y <= height + 1e-6,
    text: `모형 ${x.toFixed(1)} × ${y.toFixed(1)} mm / ` +
      `용지 크기 ${width} × ${height} mm`
  };
}

function updateSettingsNotes() {
  const scale = Number($("#scale").value);
  const thickness = Number($("#thickness").value);
  const interval = Number($("#interval").value);
  const physicalHeight = thickness * scale / 1000;
  $("#stack-note").textContent =
    `지형판 1장 = 실제 높이 ${+physicalHeight.toFixed(2)} m` +
    (Math.abs(physicalHeight - interval) > 1e-6
      ? " 등고 간격과 판 두께 비례가 달라 모형의 수직 비율이 과장됩니다."
      : "");

  const bounds = project?.bounds || (source === "ign" ? ignMap.bounds : null);
  const summary = $("#model-summary");
  if (bounds && Number.isFinite(scale) && scale > 0) {
    const width = (bounds[2] - bounds[0]) * 1000 / scale;
    const height = (bounds[3] - bounds[1]) * 1000 / scale;
    const format = value => Number(value.toFixed(1)).toLocaleString("ko-KR");
    summary.textContent =
      `모형 크기 ${format(width)} × ${format(height)} mm · ` +
      (project ? `판 ${project.layers.length}장` : "지형판 수는 생성 후 표시");
  } else {
    summary.textContent =
      "대지 범위와 축척을 정하면 모형 크기가 표시됩니다.";
  }

  const note = $("#sheet-fit");
  if (!bounds || !(scale > 0)) {
    note.textContent = "대지 범위와 축척을 정하면 용지 안에 들어가는지 표시됩니다.";
    note.classList.remove("error");
    return;
  }
  const config = {
    scale, paper: $("#paper").value,
    orientation: $("#orientation").value,
    paper_width_mm: Number($("#paper-width").value),
    paper_height_mm: Number($("#paper-height").value)
  };
  const fit = checkFit(bounds, config);
  note.textContent = fit.text + (fit.fits ? "" : " · 용지보다 큽니다. 대지 범위를 줄이거나 축척 분모를 키우세요.");
  note.classList.toggle("error", !fit.fits);
}

function clearPreview() {
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = null;
  $("#plate-preview").removeAttribute("src");
  $("#plate-preview").hidden = true;
  $("#plate-empty").hidden = false;
}

function invalidate() {
  project = null;
  sheetFiles = null;
  $("#model-summary").textContent =
    "설정을 확인하고 ‘모형 만들기’를 누르세요.";
  clearPreview();
  $("#plate-select").replaceChildren();
  $("#plate-select").disabled = true;
  $("#export").disabled = true;
  $("#reset-view").disabled = true;
  $("#layer-slider").disabled = true;
  $("#layer-slider").max = "0";
  $("#layer-slider").value = "0";
  $("#layer-count").textContent = "0 / 0";
  viewer?.clear();
  for (const step of [2, 3, 4]) completedSteps.delete(step);
  if (currentStep > 2) showStep(2);
  else syncSteps();
}

function cancelSearch() {
  clearTimeout(searchTimer);
  searchController?.abort();
  searchController = null;
  searchNumber++;
}

function setBusy(value) {
  busy = value;
  loadingOverlay?.busy(value);
  $("#input-controls").disabled = value;
  $("#cancel").disabled = !value;
  $("#export").disabled = value || !project;
  ignMap.setEnabled(!value);
  $("#operation-progress").hidden = !value;
  $("#elapsed").hidden = !value;
  clearInterval(elapsedTimer);
  if (value) {
    startedAt = performance.now();
    $("#elapsed").textContent = "0초 경과";
    elapsedTimer = setInterval(() => {
      const secs = Math.floor((performance.now() - startedAt) / 1000);
      $("#elapsed").textContent = measured?.label
        ? `${measured.label} · ${secs}초 경과` : `${secs}초 경과`;
    }, 1000);
  }
  syncSteps();
}

async function operation(task, kind = "generate") {
  if (busy) return;
  operationKind = kind;
  showLocalError("generation-error", "");
  cancelSearch();
  const number = ++operationNumber;
  const controller = new AbortController();
  operationController = controller;
  setBusy(true);
  try {
    await task(controller.signal, () => {
      if (number !== operationNumber || controller.signal.aborted) {
        throw new DOMException("취소되었습니다.", "AbortError");
      }
    });
  } catch (error) {
    if (number === operationNumber) {
      status(
        error.name === "AbortError" ? "취소되었습니다." : error.message,
        error.name !== "AbortError"
      );
    }
  } finally {
    if (number === operationNumber) {
      operationController = null;
      setBusy(false);
    }
  }
}

const ignMap = new IGNMap($("#map"), {
  onRange(bounds) {
    buildingsReady = false;
    completedSteps.delete(1);  // new range: step 1 is not done any more
    $("#building-list").replaceChildren();
    $("#building-note").textContent = "대지 범위가 바뀌었습니다. 건물을 다시 불러오세요.";
    $("#radius").value = ((bounds[2] - bounds[0]) / 2).toFixed(2);
    $("#range-note").textContent =
      `한 변 길이 ${(bounds[2] - bounds[0]).toFixed(1)} m · ` +
      `중심 좌표(프랑스 표준) ${((bounds[0] + bounds[2]) / 2).toFixed(1)}, ` +
      `${((bounds[1] + bounds[3]) / 2).toFixed(1)}`;
    invalidate();
    updateSettingsNotes();
  },
  onSelection(selected) {
    $("#building-note").textContent =
      ignMap.buildings.length
        ? `건물 ${ignMap.buildings.length}개 중 ${selected.length}개 선택`
        : "이 범위에는 등록된 건물이 없습니다. 지형만 만들어집니다.";
    for (const checkbox of $("#building-list").querySelectorAll('input[type="checkbox"]')) {
      checkbox.checked = ignMap.selected.has(Number(checkbox.dataset.index));
    }
    invalidate();
  },
  onNotice(message) {
    $("#map-note").textContent = message;
  }
});

try {
  viewer = new Viewer3D($("#viewer"));
} catch (error) {
  $("#viewer").textContent = "3D 미리보기를 불러오지 못했습니다: " + error.message;
  $("#run").disabled = true;
  throw error;
}

function setMapMode(mode) {
  ignMap.setMode(mode);
  document.querySelectorAll("[data-map-mode]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.mapMode === mode));
  });
}

for (const button of document.querySelectorAll("[data-map-mode]")) {
  button.onclick = () => setMapMode(button.dataset.mapMode);
}

function selectSource(next) {
  if (busy) return;
  cancelSearch();
  source = next;
  for (const button of document.querySelectorAll("[data-source]")) {
    const selected = button.dataset.source === source;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  $("#panel-ign").hidden = source !== "ign";
  $("#panel-file").hidden = source !== "file";
  invalidate();
  updateSettingsNotes();
  if (source === "ign") requestAnimationFrame(() => ignMap.resize());
}

for (const button of document.querySelectorAll("[data-source]")) {
  button.onclick = () => selectSource(button.dataset.source);
  button.onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "ign" :
      event.key === "End" ? "file" : source === "ign" ? "file" : "ign";
    selectSource(next);
    $("#tab-" + next).focus();
  };
}

async function performSearch() {
  cancelSearch();
  const query = $("#search").value.trim();
  $("#suggestions").replaceChildren();
  if (query.length < 3) {
    $("#search-note").textContent = "주소나 장소를 세 글자 이상 입력하세요.";
    return;
  }

  const request = searchNumber;
  const controller = new AbortController();
  searchController = controller;
  $("#search-note").textContent = "검색 중입니다.";

  try {
    const places = await searchPlaces(query, controller.signal);
    if (request !== searchNumber || busy) return;

    $("#search-note").textContent =
      places.length ? "검색 결과를 선택하세요." : "검색 결과가 없습니다.";

    for (const place of places) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = place.label;
      button.onclick = () => {
        if (busy) return;
        cancelSearch();
        $("#search").value = place.label;
        $("#suggestions").replaceChildren();
        $("#search-note").textContent = "지도에 표시했습니다. 대지 범위를 확인하세요.";
        ignMap.setCenter(...place.l93);
        ignMap.fitRange();
      };
      $("#suggestions").append(button);
    }
  } catch (error) {
    if (request === searchNumber && error.name !== "AbortError") {
      $("#search-note").textContent = "검색 오류: " + error.message;
    }
  }
}

$("#search").addEventListener("input", () => {
  cancelSearch();
  $("#suggestions").replaceChildren();
  searchTimer = setTimeout(performSearch, 450);
});
$("#search").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    performSearch();
  }
});
$("#search-button").onclick = performSearch;

$("#radius").addEventListener("change", () => {
  try {
    if (!$("#radius").reportValidity()) return;
    ignMap.setRadius(Number($("#radius").value));
  } catch (error) { status(error.message, true); }
});

$("#range-view").onclick = () => ignMap.fitRange();

function updateMapStyle() {
  ignMap.setStyle(
    $("#map-style").value,
    Number($("#photo-opacity").value) / 100
  );
}
// The photo ratio only means something when map and photo are overlaid.
$("#map-style").onchange = () => {
  $("#photo-opacity-field").hidden = $("#map-style").value !== "overlay";
  updateMapStyle();
};
$("#photo-opacity").oninput = updateMapStyle;

const floorHeight = () => Number($("#floor-height").value) || 3;

// "높이 23.6 m · 8층" — IGN floor count when known, otherwise estimated (약).
function buildingText(building, index) {
  const name = `건물 ${index + 1}${building.usage ? " · " + building.usage : ""}`;
  if (building.h === null) return `${name} · 높이 정보 없음`;
  const floors = building.floors
    ? `${building.floors}층`
    : `약 ${Math.max(1, Math.round(building.h / floorHeight()))}층`;
  const manual = building.manualFloors ? " (직접 입력)" : "";
  // IGN storey count that gives an implausible storey height is flagged.
  const doubt = !building.manualFloors && !building.floors && building.ignFloors
    ? ` · IGN ${building.ignFloors}층 (확인 필요)` : "";
  return `${name} · 높이 ${building.h.toFixed(1)} m · ${floors}${doubt}${manual}`;
}

function renderBuildingList() {
  const fragment = document.createDocumentFragment();
  ignMap.buildings.forEach((building, index) => {
    const row = document.createElement("div");
    row.className = "building-row";
    row.dataset.index = String(index);

    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.index = String(index);
    input.checked = ignMap.selected.has(index);
    input.setAttribute("aria-label", `건물 ${index + 1} 포함`);
    input.onchange = () => ignMap.toggle(index);
    const text = document.createElement("span");
    text.textContent = buildingText(building, index);
    label.append(input, text);

    // Locate: highlight on the map and zoom to it.
    const locate = document.createElement("button");
    locate.type = "button";
    locate.className = "building-locate";
    locate.textContent = "지도에서 보기 ›";
    locate.onclick = () => focusBuilding(index, true);
    row.append(label, locate);

    // Unknown or doubtful height: open the spot in Google Maps (satellite)
    // so the user can count the storeys themselves.
    if (building.h === null || (building.ignFloors && !building.floors)) {
      const ring = building.polygon.slice(0, -1);
      const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const [lon, lat] = toWGS84(cx, cy);
      const maps = document.createElement("a");
      maps.className = "building-locate";
      // q = pin on the building, t=k = satellite, z = zoom
      maps.href = `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}&t=k&z=20`;
      maps.target = "_blank";
      maps.rel = "noopener noreferrer";
      maps.textContent = "구글 지도에서 확인 ↗";
      row.append(maps);
    }

    // Missing height: let the user type the floor count; h = floors × 층고.
    if (building.h === null || building.manualFloors || (building.ignFloors && !building.floors)) {
      const wrap = document.createElement("span");
      wrap.className = "building-floors";
      const floorsInput = document.createElement("input");
      floorsInput.type = "number";
      floorsInput.min = "1"; floorsInput.max = "200"; floorsInput.step = "1";
      floorsInput.placeholder = "층수";
      floorsInput.value = building.manualFloors || "";
      floorsInput.setAttribute("aria-label", `건물 ${index + 1} 층수 입력`);
      floorsInput.onchange = () => {
        const n = Math.round(Number(floorsInput.value));
        if (building.measuredH === undefined) building.measuredH = building.h;
        if (n >= 1) {
          building.manualFloors = n;
          building.floors = n;
          // keep IGN's measured height when there is one; else floors × 층고
          building.h = building.measuredH ?? n * floorHeight();
        } else {
          building.manualFloors = null;
          building.floors = null;
          building.h = building.measuredH;
        }
        text.textContent = buildingText(building, index);
        invalidate();
      };
      const unit = document.createElement("span");
      unit.textContent = "층";
      wrap.append(floorsInput, unit);
      row.append(wrap);
    }
    fragment.append(row);
  });
  $("#building-list").replaceChildren(fragment);
  // desktop: open the third column when there is a list to show
  $("#panel-ign").classList.toggle("has-buildings", ignMap.buildings.length > 0);
}

function focusBuilding(index, zoom) {
  ignMap.focus(index, { zoom });
  for (const row of $("#building-list").querySelectorAll(".building-row")) {
    row.classList.toggle("is-focused", row.dataset.index === String(index));
  }
  const row = $("#building-list").querySelector(`.building-row[data-index="${index}"]`);
  row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
// Clicking a building on the map shows its row in the list.
ignMap.onFocus = index => focusBuilding(index, false);

async function loadBuildings(signal) {
  if (!ignMap.bounds) throw new Error("지도에서 대지 범위를 먼저 지정하세요.");
  const buildings = await fetchBuildings([...ignMap.bounds], signal, status);
  if (signal.aborted) throw new DOMException("취소되었습니다.", "AbortError");
  ignMap.setBuildings(buildings);
  buildingsReady = true;
  renderBuildingList();
}

$("#load-buildings").onclick = () => operation(async signal => {
  await loadBuildings(signal);
  setMapMode("building");
  status(ignMap.buildings.length
    ? "건물을 불러왔습니다. 모형에 포함할 건물을 고르세요."
    : "이 범위에는 등록된 건물이 없습니다. 다음 단계로 넘어가세요.");
}, "buildings");
$("#select-all").onclick = () => ignMap.selectAll(true);
$("#select-none").onclick = () => ignMap.selectAll(false);

// Custom paper: show width/height fields only when chosen.
const syncPaper = () => {
  const custom = $("#paper").value === "custom";
  $("#paper-custom").hidden = !custom;
  $("#paper-width").disabled = $("#paper-height").disabled = !custom;
  $("#orientation").disabled = custom;
  // custom sizes are typed as width × height, so direction has no meaning
  $("#orientation").closest("div").hidden = custom;
};
$("#paper").addEventListener("change", syncPaper);
syncPaper();
for (const id of ["scale", "thickness", "interval", "paper", "orientation", "grid-step", "paper-width", "paper-height"]) {
  $("#" + id).addEventListener("input", () => {
    invalidate();
    updateSettingsNotes();
  });
}
$("#file").onchange = () => {
  invalidate();
  const file = $("#file").files[0];
  $("#file-note").textContent = file
    ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`
    : "";
  updateSettingsNotes();
};

function finitePoint(point, dimensions, name) {
  if (!Array.isArray(point) || point.length < dimensions ||
      !point.slice(0, dimensions).every(Number.isFinite)) {
    throw new Error(`${name}의 좌표 형식이 올바르지 않습니다.`);
  }
}

function validateProject(value, expectedSettings) {
  if (!value || typeof value !== "object") throw new Error("생성된 모형 데이터가 없습니다.");
  if (!Array.isArray(value.bounds) || value.bounds.length !== 4 ||
      !value.bounds.every(Number.isFinite) ||
      value.bounds[2] <= value.bounds[0] || value.bounds[3] <= value.bounds[1]) {
    throw new Error("대지 범위 데이터가 올바르지 않습니다.");
  }
  if (!Array.isArray(value.layers) || !value.layers.length ||
      !Array.isArray(value.buildings)) {
    throw new Error("지형판 또는 건물 데이터가 올바르지 않습니다.");
  }
  if (value.layers.length > 2000) {
    throw new Error("지형판이 2,000장을 넘습니다. 등고 간격(m)을 늘려 주세요.");
  }
  for (const key of Object.keys(expectedSettings)) {
    if (value.settings?.[key] !== expectedSettings[key]) {
      throw new Error(`생성된 모형 설정이 입력값과 다릅니다: ${key}`);
    }
  }

  const indices = new Set();
  const elevations = new Set();
  function line(points, minimum, name) {
    if (!Array.isArray(points) || points.length < minimum) {
      throw new Error(`${name}의 점 개수가 부족합니다.`);
    }
    points.forEach(point => finitePoint(point, 2, name));
  }

  for (const layer of value.layers) {
    if (!Number.isInteger(layer.index) || !Number.isFinite(layer.z) ||
        indices.has(layer.index) || elevations.has(layer.z) ||
        !Array.isArray(layer.cut) || !Array.isArray(layer.engrave)) {
      throw new Error("지형판 번호·높이·윤곽선 데이터가 올바르지 않습니다.");
    }
    indices.add(layer.index);
    elevations.add(layer.z);
    layer.cut.forEach(points => line(points, 3, "절단선"));
    layer.engrave.forEach(points => line(points, 2, "각인선"));
  }

  for (const building of value.buildings) {
    line(building.polygon, 3, "건물 외곽선");
    if (!Array.isArray(building.holes) ||
        !(Number.isFinite(building.h) && building.h > 0) ||
        !Number.isFinite(building.base)) {
      throw new Error("건물 높이·바닥 높이·중정 데이터가 올바르지 않습니다.");
    }
    building.holes.forEach(points => line(points, 3, "건물 중정선"));
  }
  return value;
}

function enumNumber(value) {
  return value && typeof value === "object" && "value" in value
    ? value.value : value;
}

function point3(value, factor) {
  const point = Array.isArray(value)
    ? value : [value.x, value.y, value.z];
  finitePoint(point, 3, "3DM");
  return point.slice(0, 3).map(number => number * factor);
}

function polylinePoints(polyline, factor) {
  if (Array.isArray(polyline)) return polyline.map(point => point3(point, factor));
  if (polyline && typeof polyline.get === "function" &&
      Number.isInteger(polyline.count)) {
    const result = [];
    for (let i = 0; i < polyline.count; i++) {
      result.push(point3(polyline.get(i), factor));
    }
    return result;
  }
  return null;
}

async function read3DM(buffer) {
  const rhino = await rhinoEngine();
  const file = rhino.File3dm.fromByteArray(new Uint8Array(buffer));
  if (!file) throw new Error("3DM 파일을 읽지 못했습니다.");

  try {
    const unit = enumNumber(file.settings().modelUnitSystem);
    const units = [
      ["Meters", 1], ["Millimeters", 0.001], ["Centimeters", 0.01],
      ["Kilometers", 1000], ["Inches", 0.0254], ["Feet", 0.3048]
    ];
    const match = units.find(([name]) =>
      enumNumber(rhino.UnitSystem[name]) === unit);
    if (!match) throw new Error("3DM 파일에 단위 정보가 없거나 지원하지 않는 단위입니다.");

    const factor = match[1];
    const geometry = { units: "m", curves: [], meshes: [] };
    const objects = file.objects();
    const unsupported = [];
    // Layer index -> layer NAME (BOUNDARY / CONTOUR / ROAD …). The Python
    // side recognises roles by name; passing the number broke every 3DM.
    const layerNames = new Map();
    const table = file.layers();
    for (let i = 0; i < table.count; i++) {
      const layer = table.get(i);
      try {
        const full = String(layer.fullPath || layer.name || "");
        layerNames.set(i, full.split("::").pop());
      } finally {
        layer.delete?.();
      }
    }

    for (let i = 0; i < objects.count; i++) {
      const object = objects.get(i);
      const item = object.geometry();
      const attributes = object.attributes();
      const layerIndex = layerNames.get(attributes.layerIndex) ?? String(attributes.layerIndex);

      try {
        if (item instanceof rhino.Mesh) {
          const vertices = [];
          const faces = [];
          const sourceVertices = item.vertices();
          const sourceFaces = item.faces();

          for (let j = 0; j < sourceVertices.count; j++) {
            vertices.push(point3(sourceVertices.get(j), factor));
          }
          for (let j = 0; j < sourceFaces.count; j++) {
            const face = Array.from(sourceFaces.get(j));
            if (face.length === 4 && face[2] === face[3]) face.pop();
            if (![3, 4].includes(face.length) ||
                face.some(index => !Number.isInteger(index) ||
                  index < 0 || index >= vertices.length)) {
              throw new Error(`3DM 객체 ${i + 1}의 메시 면을 읽을 수 없습니다.`);
            }
            faces.push(face);
          }
          geometry.meshes.push({ vertices, faces, layer: layerIndex });
        } else if (item instanceof rhino.Curve) {
          let points = null;
          let polyline = null;
          try {
            polyline = item.tryGetPolyline();
            points = polylinePoints(polyline, factor);
          } finally {
            polyline?.delete?.();
          }

          if (!points && item instanceof rhino.LineCurve) {
            points = [
              point3(item.pointAtStart, factor),
              point3(item.pointAtEnd, factor)
            ];
          }
          if (!points || points.length < 2) {
            unsupported.push(i + 1);
            continue;
          }

          geometry.curves.push({
            points,
            closed: Boolean(item.isClosed),
            layer: layerIndex
          });
        } else {
          unsupported.push(i + 1);
        }
      } finally {
        attributes.delete?.();
        item.delete?.();
        object.delete?.();
      }
    }

    if (unsupported.length) {
      throw new Error(
        "지원하지 않는 3DM 객체가 포함되어 있습니다: " +
        unsupported.slice(0, 20).join(", ") +
        (unsupported.length > 20 ? ` 외 ${unsupported.length - 20}개` : "") +
        ". Rhino에서 폴리라인이나 메시로 변환한 뒤 다시 올려 주세요."
      );
    }
    if (!geometry.curves.length && !geometry.meshes.length) {
      throw new Error("3DM 파일에 사용할 선이나 메시가 없습니다.");
    }
    return geometry;
  } finally {
    file.delete();
  }
}

function validateSheets(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("지형판 도면 데이터가 올바르지 않습니다.");
  }
  const names = Object.keys(files);
  if (!names.length) throw new Error("생성된 지형판 파일이 없습니다.");

  for (const name of names) {
    // plate_XX = terrain plates; building_XX = laser-cut building layers.
    if (!/^(plate|building)_\d+\.(svg|dxf)$/.test(name) || typeof files[name] !== "string") {
      throw new Error(`지형판 도면 파일이 올바르지 않습니다: ${name}`);
    }
  }
  const svgNames = names.filter(name => name.endsWith(".svg"));
  if (svgNames.filter(n => n.startsWith("plate_")).length !== project.layers.length) {
    throw new Error("생성된 도면 수와 지형판 수가 일치하지 않습니다.");
  }
  for (const name of svgNames) {
    if (!(name.replace(/\.svg$/, ".dxf") in files)) {
      throw new Error(`${name}에 해당하는 DXF 파일이 없습니다.`);
    }
  }
  if (names.filter(name => name.endsWith(".dxf")).length !== svgNames.length) {
    throw new Error("SVG 도면과 DXF 도면의 개수가 일치하지 않습니다.");
  }
  // terrain plates first, then building layers, each in number order
  const key = n => (n.startsWith("building_") ? 1000 : 0) + Number(n.match(/\d+/)[0]);
  return svgNames.sort((a, b) => key(a) - key(b));
}

function showPlate() {
  clearPreview();
  const name = $("#plate-select").value;
  if (!sheetFiles || !name) return;
  // SVG is an image resource, never injected as active inline markup.
  previewURL = URL.createObjectURL(new Blob(
    [sheetFiles[name]], { type: "image/svg+xml;charset=utf-8" }
  ));
  $("#plate-preview").src = previewURL;
  $("#plate-preview").hidden = false;
  $("#plate-empty").hidden = true;
}

$("#plate-preview").onerror = () => {
  $("#plate-preview").hidden = true;
  $("#plate-empty").hidden = false;
  $("#plate-empty").textContent = "도면 미리보기를 불러오지 못했습니다.";
};
$("#plate-select").onchange = showPlate;

function updateViewerOptions() {
  const count = Number($("#layer-slider").value);
  $("#layer-count").textContent = `${count} / ${project?.layers.length || 0}`;
  viewer.setOptions({
    plates: $("#show-plates").checked,
    buildings: $("#show-buildings").checked,
    edges: $("#show-edges").checked,
    count
  });
}
for (const id of ["show-plates", "show-buildings", "show-edges", "layer-slider"]) {
  $("#" + id).oninput = updateViewerOptions;
}
$("#reset-view").onclick = () => viewer.fit();

$("#run").onclick = () => operation(async (signal, ensureCurrent) => {
  invalidate();
  const config = settings();
  let result;

  try {
    if (source === "ign") {
      if (!ignMap.bounds) throw new Error("지도에서 대지 범위를 지정하세요.");
      if (!buildingsReady) {
        throw new Error("먼저 건물을 불러오세요.");
      }
      if (!$("#grid-step").reportValidity()) {
        throw new Error("지형 정밀도(m) 값을 확인하세요.");
      }

      const fit = checkFit(ignMap.bounds, config);
      if (!fit.fits) throw new Error(fit.text + " · 용지보다 큽니다. 대지 범위를 줄이거나 축척 분모를 키우세요.");

      status("선택한 대지의 지형 높이를 불러오는 중");
      const terrain = await fetchTerrain(
        [...ignMap.bounds],
        Number($("#grid-step").value),
        ignMap.getSelected(),
        signal,
        status
      );
      ensureCurrent();
      skippedNote = terrain.skippedNoHeight
        ? ` 높이 정보가 없는 건물 ${terrain.skippedNoHeight}개는 제외했습니다.`
        : "";
      result = await python.call("from_terrain", {
        dem: terrain.dem, buildings: terrain.buildings, settings: config
      });
    } else {
      skippedNote = "";
      const file = $("#file").files[0];
      if (!file) throw new Error("DXF 또는 3DM 파일을 선택하세요.");
      if (file.size === 0 || file.size > 100 * 1024 * 1024) {
        throw new Error("파일 크기는 0보다 크고 100 MB 이하여야 합니다.");
      }

      const extension = file.name.split(".").pop().toLowerCase();
      if (!["dxf", "3dm"].includes(extension)) {
        throw new Error("DXF 또는 3DM 파일을 선택하세요.");
      }

      status("도면 파일을 읽는 중");
      const buffer = await file.arrayBuffer();
      ensureCurrent();

      if (extension === "dxf") {
        result = await python.call(
          "from_dxf",
          { data: buffer, settings: config },
          [buffer]
        );
      } else {
        const geom_json = await read3DM(buffer);
        ensureCurrent();
        result = await python.call("from_geometry", { geom_json, settings: config });
      }
    }

    ensureCurrent();
    project = validateProject(result, config);
    const fit = checkFit(project.bounds, config);
    if (!fit.fits) throw new Error(fit.text + " · 축척을 조정하세요.");

    status("레이저 도면(SVG·DXF)을 만드는 중");
    sheetFiles = await python.call("sheets");
    ensureCurrent();
    const names = validateSheets(sheetFiles);
    const layers = [...project.layers].sort((a, b) => a.z - b.z);

    $("#plate-select").replaceChildren(...names.map((name, ordinal) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name.startsWith("building_")
        ? `건물 판 ${Number(name.match(/\d+/)[0])}`
        : `지형판 ${ordinal + 1} · 높이 ${layers[ordinal].z.toFixed(1)} m`;
      return option;
    }));
    $("#plate-select").disabled = false;

    viewer.setProject(project);
    $("#layer-slider").max = String(project.layers.length);
    $("#layer-slider").value = String(project.layers.length);
    $("#layer-slider").disabled = false;
    $("#reset-view").disabled = false;

    $("#plate-empty").textContent = "모형을 만들면 여기에 보입니다.";
    updateViewerOptions();
    showPlate();
    updateSettingsNotes();
    status(`완성했습니다. 지형판 ${project.layers.length}장, 건물 ${project.buildings.length}개.${skippedNote}`);
    completedSteps.add(1);
    completedSteps.add(2);
    showStep(3, true);
  } catch (error) {
    // Do not clear a newer operation's result after cancellation.
    if (!signal.aborted) invalidate();
    throw error;
  }
});

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

$("#export").onclick = () => operation(async (_signal, ensureCurrent) => {
  if (!project || !sheetFiles) throw new Error("먼저 모형을 만드세요.");
  // Re-render the sheets with the chosen cut/engrave colours and line width.
  status("선 색상과 굵기를 적용하는 중");
  // send the project too: a restarted worker no longer holds it
  sheetFiles = await python.call("sheets", { project, style: {
    cut_color: $("#cut-color").value,
    engrave_color: $("#engrave-color").value,
    line_width_mm: Number($("#line-width").value)
  } });
  ensureCurrent();
  status("3DM과 ZIP 파일을 준비하는 중");
  const rhino = await rhinoEngine();
  ensureCurrent();

  // Let the pending status update reach the screen before synchronous exports.
  // setTimeout, not requestAnimationFrame: rAF never fires in a background tab.
  await new Promise(resolve => setTimeout(resolve, 30));
  ensureCurrent();

  const files = {};
  for (const [name, content] of Object.entries(sheetFiles)) {
    files[name] = strToU8(content);
  }

  const mode = project.settings.building_mode || "print";
  if (mode === "print_floor") {
    Object.assign(files, viewer.exportBuildingsSTLByFloor(project.settings.floor_height_m || 3));
  } else {
    const stl = viewer.exportBuildingsSTL();
    if (stl) files["buildings.stl"] = stl;
  }
  files["model.3dm"] = viewer.export3DM(rhino);
  files["sheets_2d.3dm"] = sheets2D3dm(rhino, await python.call("sheet_drawings"));
  files["project.json"] = strToU8(JSON.stringify(project, null, 2));
  files["model-coordinates.json"] = strToU8(
    JSON.stringify(viewer.exportMetadata(), null, 2)
  );
  files["README.txt"] = strToU8([
    "SiteLaser",
    "",
    "plate_*.svg / plate_*.dxf: Python 엔진이 생성한 제작 도면.",
    "model.3dm: 전체 지형판과 건물의 적층 모형. 단위 mm, Z 위.",
    "buildings.stl: 건물만 포함. 단위 mm로 해석할 것. 건물이 없으면 생략.",
    "STL과 3DM은 동일한 조립 좌표를 사용합니다.",
    "project.json: 원본 좌표계의 Project JSON. 좌표와 높이는 m.",
    "model-coordinates.json: XY 원점, 축척, 적층 높이 대응.",
    "",
    "판의 바닥 높이 = 높이순 순번 × thickness_mm.",
    "건물 바닥 = base 이하 마지막 지형판의 윗면.",
    "건물 높이 = h × 1000 / scale.",
    "미리보기 숨김·레이어 슬라이더는 전체 모델 내보내기에 영향을 주지 않음.",
    "",
    source === "ign"
      ? "IGN 입력 XY: Lambert-93 (EPSG:2154). 출처 © IGN."
      : "파일 입력 XY: 입력 파일 좌표를 m로 정규화한 좌표.",
    "IGN DEM: 남→북, 서→동 노드 샘플; row-major 평탄 배열.",
    "IGN 건물 지면 표고: altitude_minimale_sol 우선;",
    "없으면 건물 외곽 첫 꼭짓점에서 IGN 표고를 별도 조회.",
    "누락된 건물 높이는 추정하지 않음.",
    "",
    "절단선·각인선 분류, 도면 단위, 공차와 제작 가능성은 제작 전 확인할 것."
  ].join("\n"));

  const archive = zipSync(files, { level: 6 });
  ensureCurrent();
  download(archive, "sitelaser.zip");
  status("다운로드를 시작했습니다.");
  completedSteps.add(4);
  syncSteps();
}, "export");

$("#cancel").onclick = () => {
  operationNumber++;
  operationController?.abort();
  operationController = null;
  python.reset();
  // cancelling an export keeps the finished model
  if (operationKind !== "export") invalidate();
  setBusy(false);
  status("취소했습니다.");
};

window.addEventListener("beforeunload", () => {
  clearInterval(elapsedTimer);
  operationController?.abort();
  searchController?.abort();
  python.reset();
  if (previewURL) URL.revokeObjectURL(previewURL);
  viewer.dispose();
});

updateSettingsNotes();
status("주소나 장소를 검색해 시작하세요.");
setupInterface();

function showLocalError(id, message) {
  for (const name of ["site-error", "generation-error", "export-error"]) {
    const note = $("#" + name);
    note.textContent = name === id ? message : "";
    note.hidden = !note.textContent;
  }
}

function syncSteps() {
  $("#step-count").textContent = `단계 ${currentStep}/4`;
  $("#settings-controls").disabled = busy || !completedSteps.has(1);
  $("#settings-help").textContent = completedSteps.has(1)
    ? "설정을 바꾸면 모형을 다시 만들어야 합니다."
    : "먼저 대지를 골라 주세요.";
  $("#review-controls").disabled = busy || !project || !sheetFiles;
  $("#export").disabled =
    busy || !project || !sheetFiles || !completedSteps.has(3);

  for (const button of document.querySelectorAll("[data-step]")) {
    const step = Number(button.dataset.step);
    const current = step === currentStep;
    const done = completedSteps.has(step);
    button.dataset.done = String(done && !current);
    if (current) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
    button.querySelector(".step-state").textContent =
      current ? "현재" : done ? "완료" : "대기";
    button.disabled = busy ||
      (step === 2 && !completedSteps.has(1)) ||
      (step === 3 && (!project || !sheetFiles)) ||
      (step === 4 && (!project || !sheetFiles || !completedSteps.has(3)));
  }
}

// One screen at a time: page 0 = intro, 1-4 = steps (no long scroll).
function showPage(page) {
  document.body.dataset.page = String(page);
  if (page === 0) $("#step-button-1")?.removeAttribute("aria-current");
  window.scrollTo({ top: 0, behavior: "auto" });
}

const STEP_NAMES = ["", "대지", "설정", "확인", "파일 받기"];
function showStep(step, focus = false) {
  currentStep = step;
  showPage(step);
  $("#engine-state").textContent = `단계 ${step} / 4 · ${STEP_NAMES[step]}`;
  syncSteps();
  // The scroll-reveal fade never fires for a panel that was display:none.
  $("#step-panel-" + step).classList.remove("reveal-pending");
  if (step === 1 && source === "ign") {
    // map container just became visible: let Leaflet re-measure it
    setTimeout(() => ignMap.resize(), 50);
  }
  if (step === 3) setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
  if (focus) {
    $("#step-title-" + step).focus({ preventScroll: true });
  }
}

function continueFromSite() {
  if (busy) return;
  let message = "";
  if (source === "ign") {
    if (!ignMap.bounds) message = "지도에서 대지 범위를 먼저 지정하세요.";
    else if (!buildingsReady) {
      message = "먼저 건물을 불러오세요.";
    } else if (!$("#grid-step").reportValidity()) return;
  } else {
    const file = $("#file").files[0];
    if (!file || !/\.(dxf|3dm)$/i.test(file.name)) {
      message = "DXF 또는 3DM 파일을 선택하세요.";
    } else if (file.size === 0 || file.size > 100 * 1024 * 1024) {
      message = "파일 크기는 0보다 크고 100 MB 이하여야 합니다.";
    }
  }
  showLocalError("site-error", message);
  if (message) return;
  completedSteps.add(1);
  showStep(2, true);
}

function selectView(next, focus = false) {
  for (const button of document.querySelectorAll("[data-view]")) {
    const selected = button.dataset.view === next;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    const panel = $("#view-panel-" + button.dataset.view);
    panel.setAttribute("aria-hidden", String(!selected));
    panel.inert = !selected;
  }
  if (focus) $("#view-tab-" + next).focus();
}

function setupInterface() {
  for (const button of document.querySelectorAll("[data-step]")) {
    button.onclick = () => {
      if (busy || button.disabled) return;
      const step = Number(button.dataset.step);
      if (step === 2 && currentStep === 1) continueFromSite();
      else showStep(step, true);
    };
  }
  for (const button of document.querySelectorAll("[data-go-step]")) {
    button.onclick = () => {
      if (!busy) showStep(Number(button.dataset.goStep), true);
    };
  }
  $("#site-next").onclick = continueFromSite;
  $("#review-next").onclick = () => {
    if (busy || !project || !sheetFiles) return;
    completedSteps.add(3);
    showStep(4, true);
  };
  $("#inspect-viewer").onclick = () => {
    $('.viewer-tabs [aria-selected="true"]').focus();
  };
  for (const button of document.querySelectorAll("[data-view]")) {
    button.onclick = () => selectView(button.dataset.view);
    button.onkeydown = event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "3d" :
        event.key === "End" ? "2d" : button.dataset.view === "3d" ? "2d" : "3d";
      selectView(next, true);
    };
  }
  // Invalidate only step completion; the existing listeners own project data.
  for (const id of ["file", "radius", "grid-step"]) {
    $("#" + id).addEventListener("input", () => {
      completedSteps.delete(1);
      showLocalError("site-error", "");
      syncSteps();
    });
  }
  for (const button of document.querySelectorAll("[data-source]")) {
    button.addEventListener("click", () => {
      if (!busy) {
        completedSteps.delete(1);
        showLocalError("site-error", "");
        syncSteps();
      }
    });
  }
  if ("IntersectionObserver" in window &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove("reveal-pending");
        observer.unobserve(entry.target);
      }
    }, { threshold: 0, rootMargin: "0px 0px -24px 0px" });

    for (const panel of document.querySelectorAll(".step-panel")) {
      observer.observe(panel);
      panel.classList.add("reveal-pending");
    }
    document.addEventListener("focusin", event => {
      const panel = event.target.closest(".step-panel");
      if (panel) {
        panel.classList.remove("reveal-pending");
        observer.unobserve(panel);
      }
    });
  }

  syncSteps();
  selectView("2d");  // 2D cut sheets first: that is what gets made
  // No worker init command is exposed by the supplied PythonClient.
  // Start the worker early without sending an undocumented command.
  try {
    python.createWorker();
    engineStateSink.textContent = "도면 생성기 준비 중";
  } catch (error) {
    engineStateSink.textContent =
      "도면 생성기 준비 지연 · 모형 생성 시 다시 시도합니다: " + error.message;
  }
}

// 2D plate preview: wheel/pinch zoom around the cursor, drag to pan,
// +/−/맞춤 buttons. Purely visual; the exported SVG is unchanged.
(() => {
  const stage = document.querySelector(".plate-stage");
  const img = $("#plate-preview");
  if (!stage || !img) return;
  let s = 1, x = 0, y = 0, drag = null;
  const pointers = new Map();
  let pinch = null;
  const apply = () => {
    // Resize instead of CSS scale() so the SVG is re-rasterised crisply.
    img.style.width = `${s * 100}%`;
    img.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(s * 100)}%`;
  };
  const zoomAt = (factor, cx, cy) => {
    const next = Math.min(40, Math.max(1, s * factor));
    const r = stage.getBoundingClientRect();
    const px = cx - r.left - r.width / 2, py = cy - r.top - r.height / 2;
    x = px - (px - x) * (next / s);
    y = py - (py - y) * (next / s);
    s = next;
    if (s === 1) { x = 0; y = 0; }
    apply();
  };
  const reset = () => { s = 1; x = 0; y = 0; apply(); };

  const bar = document.createElement("div");
  bar.className = "zoom-bar";
  bar.innerHTML =
    '<button type="button" data-z="out" aria-label="축소">−</button>' +
    '<span class="zoom-label" aria-live="polite">100%</span>' +
    '<button type="button" data-z="in" aria-label="확대">+</button>' +
    '<button type="button" data-z="fit">맞춤</button>';
  stage.after(bar);
  const zoomLabel = bar.querySelector(".zoom-label");
  bar.addEventListener("click", e => {
    const z = e.target.closest("button")?.dataset.z;
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (z === "in") zoomAt(1.5, cx, cy);
    if (z === "out") zoomAt(1 / 1.5, cx, cy);
    if (z === "fit") reset();
  });

  stage.addEventListener("wheel", e => {
    if (img.hidden) return;
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  }, { passive: false });

  stage.addEventListener("pointerdown", e => {
    if (img.hidden) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    stage.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
      drag = null;
    } else {
      drag = { sx: e.clientX - x, sy: e.clientY - y };
    }
  });
  stage.addEventListener("pointermove", e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt(d / pinch.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      pinch.d = d;
    } else if (drag && s > 1) {
      x = e.clientX - drag.sx; y = e.clientY - drag.sy; apply();
    }
  });
  const end = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) drag = null;
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("dblclick", reset);
  // New plate selected or regenerated → back to fit.
  img.addEventListener("load", reset);
})();


// Intro screen first; "시작하기" opens step 1.
showPage(0);
$("#start").addEventListener("click", () => showStep(1, true));
$("#brand-home")?.addEventListener("click", event => { event.preventDefault(); showPage(0); });


// ---------------------------------------------------------------------
// Full-screen loading: one big overall percentage and a plain-language
// stage name instead of engine messages. Each stage owns a slice of
// 0-100 %; measured messages ("850 / 1681") fill their slice exactly,
// the others creep toward the end of their slice so it never looks frozen.
loadingOverlay = (() => {
  const el = document.createElement("div");
  el.className = "loading-overlay";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "처리 중");
  el.innerHTML =
    '<div class="loading-box">' +
    '<p class="loading-percent" aria-live="polite">0%</p>' +
    '<div class="loading-track"><span></span></div>' +
    '<p class="loading-stage">준비 중</p>' +
    '<p class="loading-eta"></p>' +
    '<button type="button" class="loading-cancel">취소</button>' +
    '</div>';
  document.body.append(el);
  const pctEl = el.querySelector(".loading-percent");
  const fill = el.querySelector(".loading-track span");
  const stageEl = el.querySelector(".loading-stage");
  const etaEl = el.querySelector(".loading-eta");
  el.querySelector(".loading-cancel").onclick = () => $("#cancel").click();

  // [test, label, from %, to %] per operation kind
  const STAGES = {
    generate: [
      [/표고|DEM|높이를? 조회|지형 높이|지형 데이터/, "지형 높이를 불러오는 중", 3, 65],
      [/Python|numpy|DXF 라이브러리|모듈|엔진|실행 환경/, "계산 준비 중", 65, 78],
      [/파일을? 읽|해석|불러온 파일/, "도면 파일을 읽는 중", 65, 80],
      [/SVG|DXF를|도면/, "제작 도면을 만드는 중", 90, 99],
      [/지형판|계산|생성/, "지형판을 계산하는 중", 78, 90]
    ],
    buildings: [[/./, "건물 정보를 불러오는 중", 5, 95]],
    export: [
      [/선 색상|굵기/, "도면 선을 정리하는 중", 5, 45],
      [/3DM|ZIP|압축/, "파일을 묶는 중", 45, 98]
    ]
  };
  let shown = 0, target = 0, cap = 0, timer = null, active = false;
  const render = () => {
    pctEl.textContent = Math.floor(shown) + "%";
    fill.style.width = shown + "%";
  };
  const tick = () => {
    // ease toward the measured target, and creep toward the stage cap
    if (target > shown) shown += Math.max(0.4, (target - shown) * 0.25);
    else if (shown < cap - 0.5) shown += (cap - shown) * 0.02;
    shown = Math.min(shown, 99);
    render();
  };
  return {
    busy(value) {
      active = value;
      clearInterval(timer);
      if (value) {
        shown = 0; target = 0; cap = 8; etaEl.textContent = "";
        stageEl.textContent = "준비 중";
        render();
        el.hidden = false;
        document.body.classList.add("is-loading");
        for (const node of document.querySelectorAll("body > header, body > main")) node.inert = true;
        el.querySelector(".loading-cancel").focus();
        timer = setInterval(tick, 200);
      } else {
        shown = 100; render();
        setTimeout(() => {
          if (active) return;
          el.hidden = true;
          document.body.classList.remove("is-loading");
          for (const node of document.querySelectorAll("body > header, body > main")) node.inert = false;
        }, 250);
      }
    },
    message(message) {
      if (!active) return;
      const list = STAGES[operationKind] || STAGES.generate;
      const stage = list.find(([test]) => test.test(message));
      if (!stage) return;
      const [, label, from, to] = stage;
      stageEl.textContent = label;
      const m = /([\d,]+)\s*\/\s*([\d,]+)/.exec(message);
      if (m) {
        const done = Number(m[1].replace(/,/g, "")), total = Number(m[2].replace(/,/g, ""));
        if (total > 0) target = Math.max(target, from + (to - from) * Math.min(1, done / total));
        etaEl.textContent = measured?.label?.split(" · ").slice(1).join(" · ") || "";
      } else {
        target = Math.max(target, from);
        etaEl.textContent = "";
      }
      cap = Math.max(cap, to);
    }
  };
})();


// One Rhino file with every 2D drawing laid out side by side (mm):
// a parent layer per sheet with CUT / ENGRAVE / BORDER sub-layers.
function sheets2D3dm(rhino, drawings) {
  const file = new rhino.File3dm();
  file.settings().modelUnitSystem = rhino.UnitSystem.Millimeters;
  const hex = h => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16), a: 255 });
  const addLayer = (name, color, parentId) => {
    const layer = new rhino.Layer();
    layer.name = name;
    layer.color = color;
    if (parentId) layer.parentLayerId = parentId;
    const index = file.layers().add(layer);
    const added = file.layers().get(index);
    const id = added.id;
    added.delete?.();
    layer.delete?.();
    return { index, id };
  };
  const polyline = (points, dx, dy) => {
    const pl = new rhino.Polyline(points.length);
    try {
      for (const [x, y] of points) pl.add(x + dx, y + dy, 0);
      return pl.toPolylineCurve();
    } finally {
      pl.delete?.();
    }
  };
  const GAP = 50, PER_ROW = 4;
  let x = 0, y = 0, rowHeight = 0;
  drawings.forEach((d, i) => {
    if (i && i % PER_ROW === 0) { x = 0; y -= rowHeight + GAP; rowHeight = 0; }
    const style = d.style || {};
    const parent = addLayer(d.name, { r: 0, g: 0, b: 0, a: 255 });
    const layers = {
      CUT: addLayer("CUT", hex(style.cut_color || "#ff0000"), parent.id),
      ENGRAVE: addLayer("ENGRAVE", hex(style.engrave_color || "#0000ff"), parent.id),
      BORDER: addLayer("BORDER", { r: 160, g: 160, b: 160, a: 255 }, parent.id)
    };
    const add = (geometry, layer) => {
      const attributes = new rhino.ObjectAttributes();
      try {
        attributes.layerIndex = layer.index;
        file.objects().add(geometry, attributes);
      } finally {
        attributes.delete?.();
        geometry.delete?.();
      }
    };
    for (const path of d.cut) add(polyline(path, x, y), layers.CUT);
    for (const path of d.engrave) add(polyline(path, x, y), layers.ENGRAVE);
    const w = d.width, h = d.height;
    add(polyline([[0, 0], [w, 0], [w, h], [0, h], [0, 0]], x, y), layers.BORDER);
    add(new rhino.TextDot(d.label, [x + 12, y + 10, 0]), layers.BORDER);
    for (const [mx, my, text] of d.marks || []) {
      add(new rhino.TextDot(text, [x + mx, y + my, 0]), layers.BORDER);
    }
    x += w + GAP;
    rowHeight = Math.max(rowHeight, h);
  });
  try {
    return file.toByteArray();
  } finally {
    file.delete?.();  // free the WASM document after writing
  }
}

// Desktop layout: keep the map on the left and put every other IGN control
// in one side column that scrolls on its own (ids unchanged).
(() => {
  const panel = $("#panel-ign"), map = $("#map");
  if (!panel || !map) return;
  const side = document.createElement("div");
  side.className = "ign-side";
  for (const child of [...panel.children]) if (child !== map) side.append(child);
  panel.append(side);
  // Third column for the building list (shown once buildings are loaded).
  const list = document.createElement("div");
  list.className = "ign-list";
  for (const id of ["building-note", "building-list"]) {
    const el = $("#" + id);
    if (el) list.append(el);
  }
  panel.append(list);
})();

// One navigation row per step, same place on every screen:
// "‹ 이전 · …" (text) on the left, the main "다음 / 만들기 / 받기" pill on the right.
(() => {
  const NEXT = { 1: "#site-next", 2: "#run", 3: "#review-next", 4: "#export" };
  for (const step of [1, 2, 3, 4]) {
    const panel = $("#step-panel-" + step);
    const next = $(NEXT[step]);
    if (!panel || !next) continue;
    const back = panel.querySelector(`button[data-go-step="${step - 1}"]`);
    const nav = document.createElement("div");
    nav.className = "step-nav";
    if (back) { back.classList.add("back"); nav.append(back); }
    next.classList.add("next");
    next.classList.remove("full-width", "secondary-action");
    nav.append(next);
    panel.append(nav);
    // drop the now-empty old action rows
    for (const row of panel.querySelectorAll(".section-actions")) {
      if (!row.querySelector("button")) row.remove();
    }
  }
})();


// Step 4: show the chosen colours/width as hex codes and in a small preview.
(() => {
  const sync = () => {
    const cut = $("#cut-color").value, eng = $("#engrave-color").value;
    const w = Math.max(0.5, Math.min(6, Number($("#line-width").value) * 10 || 1));
    $("#cut-color-value").textContent = cut;
    $("#engrave-color-value").textContent = eng;
    $("#preview-cut").setAttribute("stroke", cut);
    $("#preview-engrave").setAttribute("stroke", eng);
    for (const id of ["#preview-cut", "#preview-engrave"]) $(id).setAttribute("stroke-width", w);
  };
  for (const id of ["#cut-color", "#engrave-color", "#line-width"]) $(id).addEventListener("input", sync);
  sync();
})();


// Skip link: from the intro it opens step 1 instead of jumping to a hidden panel.
document.querySelector(".skip-link")?.addEventListener("click", event => {
  if (document.body.dataset.page === "0") { event.preventDefault(); showStep(1, true); }
});
