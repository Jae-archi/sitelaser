const L = globalThis.L;
const proj4 = globalThis.proj4;

if (!L || !proj4) {
  throw new Error("Leaflet 또는 좌표 변환 라이브러리를 불러오지 못했습니다.");
}

proj4.defs(
  "EPSG:2154",
  "+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 " +
  "+x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs"
);

const GEOCODE = "https://data.geopf.fr/geocodage/search";
const WFS = "https://data.geopf.fr/wfs";
const ELEVATION =
  "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json";

export const toL93 = (lon, lat) =>
  proj4("EPSG:4326", "EPSG:2154", [lon, lat]);

export const toWGS84 = (x, y) =>
  proj4("EPSG:2154", "EPSG:4326", [x, y]);

const abortError = () => new DOMException("취소되었습니다.", "AbortError");

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const cancel = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

// Geocoding, WFS and elevation requests share a serial throttle.
// The map's WMTS requests remain managed by Leaflet.
let requestQueue = Promise.resolve();
let lastRequest = 0;

function requestJSON(endpoint, params, signal) {
  const task = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      checkAbort(signal);
      await sleep(Math.max(0, 1100 - (Date.now() - lastRequest)), signal);

      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(() => controller.abort(), 30000);
      lastRequest = Date.now();

      try {
        const url = new URL(endpoint);
        url.search = new URLSearchParams(params).toString();
        const response = await fetch(url, {
          mode: "cors",
          signal: controller.signal
        });

        if (!response.ok) {
          const error = new Error(`IGN 요청 실패: HTTP ${response.status}`);
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        return await response.json();
      } catch (error) {
        checkAbort(signal);
        const retryable =
          error.retryable || error.name === "AbortError" ||
          error instanceof TypeError;
        if (!retryable || attempt === 2) {
          throw new Error(
            error.name === "AbortError"
              ? "IGN 응답 시간이 초과되었습니다."
              : error.message
          );
        }
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
      }
      await sleep(2000 * (attempt + 1), signal);
    }
  };

  const result = requestQueue.then(task);
  requestQueue = result.catch(() => {});
  return result;
}

function mainland(lon, lat) {
  return Number.isFinite(lon) && Number.isFinite(lat) &&
    lon >= -6 && lon <= 10 && lat >= 41 && lat <= 52;
}

export async function searchPlaces(query, signal) {
  const q = query.trim();
  if (q.length < 3) return [];
  // index=address,poi: addresses AND named places (schools, buildings, sites).
  const data = await requestJSON(
    GEOCODE, { q, index: "address,poi", limit: 8 }, signal
  );
  if (!Array.isArray(data.features)) {
    throw new Error("주소 검색 응답 형식이 올바르지 않습니다.");
  }
  return data.features.flatMap(feature => {
    const coordinates = feature.geometry?.coordinates;
    if (feature.geometry?.type !== "Point" || !coordinates) return [];
    const [lon, lat] = coordinates;
    if (!mainland(lon, lat)) return [];
    const p = feature.properties || {};
    const city = [p.postcode, p.city].flat().filter(Boolean)[0];
    const label = p._type === "poi"
      ? `${[p.toponym, p.name].flat().filter(Boolean)[0] || p.label} · 장소${city ? " · " + city : ""}`
      : (p.label || `${lat}, ${lon}`);
    return [{
      label,
      lon,
      lat,
      l93: toL93(lon, lat)
    }];
  });
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ring2D(ring) {
  if (!Array.isArray(ring) || ring.length < 4) {
    throw new Error("IGN 건물 외곽선이 올바르지 않습니다.");
  }
  return ring.map(point => {
    if (!Array.isArray(point) ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      throw new Error("IGN 건물 좌표가 올바르지 않습니다.");
    }
    return [point[0], point[1]];
  });
}

export async function fetchBuildings(bounds, signal, progress = () => {}) {
  const result = [];
  const seen = new Set();
  let previousPage = null;

  for (let start = 0; start < 20000; start += 1000) {
    const data = await requestJSON(WFS, {
      SERVICE: "WFS",
      VERSION: "2.0.0",
      REQUEST: "GetFeature",
      TYPENAMES: "BDTOPO_V3:batiment",
      SRSNAME: "EPSG:2154",
      OUTPUTFORMAT: "application/json",
      BBOX: `${bounds.join(",")},urn:ogc:def:crs:EPSG::2154`,
      COUNT: 1000,
      STARTINDEX: start
    }, signal);

    if (!Array.isArray(data.features)) {
      throw new Error("IGN 건물 응답 형식이 올바르지 않습니다.");
    }

    const signature = JSON.stringify(
      data.features.map(feature => feature.id || feature.geometry)
    );
    if (data.features.length && signature === previousPage) {
      throw new Error("IGN 건물 페이지가 반복됩니다. 범위를 줄여 다시 조회하세요.");
    }
    previousPage = signature;

    for (const feature of data.features) {
      const geometry = feature.geometry;
      if (!geometry) continue;
      if (!["Polygon", "MultiPolygon"].includes(geometry.type)) {
        throw new Error(`지원하지 않는 IGN 건물 형식: ${geometry.type}`);
      }

      const properties = feature.properties || {};
      const polygons = geometry.type === "Polygon"
        ? [geometry.coordinates] : geometry.coordinates;

      const id = String(feature.id || properties.cleabs ||
        JSON.stringify(geometry.coordinates));

      for (let part = 0; part < polygons.length; part++) {
        const key = `${id}:${part}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const rings = polygons[part];
        const h = numeric(properties.hauteur);
        const base = numeric(properties.altitude_minimale_sol);
        const floors = numeric(properties.nombre_d_etages);
        result.push({
          id: key,
          polygon: ring2D(rings[0]),
          holes: rings.slice(1).map(ring2D),
          h: h !== null && h > 0 ? h : null,
          base: base !== null && base > -999 ? base : null,
          // BD TOPO: floor count (often missing) and main use, for the list
          floors: floors !== null && floors > 0 ? Math.round(floors) : null,
          usage: properties.usage_1 || properties.nature || ""
        });
      }
    }

    progress(`건물 ${result.length}개를 조회했습니다.`);
    const matched = numeric(data.numberMatched);
    if (data.features.length < 1000 ||
        (matched !== null && start + data.features.length >= matched)) {
      return result;
    }
  }
  throw new Error("건물 조회 한도를 넘었습니다. 범위를 줄여주세요.");
}

async function sampleElevations(points, signal, progress = () => {}) {
  const result = [];

  for (let offset = 0; offset < points.length; offset += 50) {
    checkAbort(signal);
    const chunk = points.slice(offset, offset + 50);
    const coordinates = chunk.map(([x, y]) => toWGS84(x, y));

    if (coordinates.some(([lon, lat]) => !mainland(lon, lat))) {
      throw new Error("표고 조회 범위가 프랑스 본토 지원 범위를 벗어났습니다.");
    }

    const data = await requestJSON(ELEVATION, {
      resource: "ign_rge_alti_wld",
      lon: coordinates.map(p => p[0].toFixed(8)).join("|"),
      lat: coordinates.map(p => p[1].toFixed(8)).join("|"),
      zonly: "true"
    }, signal);

    if (!Array.isArray(data.elevations) ||
        data.elevations.length !== chunk.length) {
      throw new Error("표고 응답 개수가 요청한 샘플 수와 다릅니다.");
    }

    for (const item of data.elevations) {
      const z = numeric(typeof item === "object" && item !== null ? item.z : item);
      if (z === null || z <= -999) {
        throw new Error("표고가 없는 지점이 있습니다. 범위를 조정하세요.");
      }
      result.push(z);
    }
    progress(`표고 ${result.length} / ${points.length}점을 조회했습니다.`);
  }
  return result;
}

export async function fetchTerrain(
  bounds, requestedStep, buildings, signal, progress = () => {}
) {
  const [xmin, ymin, xmax, ymax] = bounds;
  const width = xmax - xmin;
  if (!(width > 0) || Math.abs(width - (ymax - ymin)) > 0.001) {
    throw new Error("정사각형 범위가 필요합니다.");
  }
  if (!(requestedStep >= 1 && requestedStep <= 100)) {
    throw new Error("표고 샘플 간격은 1~100 m로 입력하세요.");
  }
  const n = Math.ceil(width / requestedStep) + 1;
  if (n * n > 10000) {
    throw new Error(
      `표고 샘플이 ${n * n}개입니다. 10,000개 이하가 되도록 간격을 늘리세요.`
    );
  }
  // IGN BD TOPO often lacks a height for small structures: skip them, don't block.
  const skippedNoHeight = buildings.filter(building => !(building.h > 0)).length;
  buildings = buildings.filter(building => building.h > 0);
  if (skippedNoHeight) {
    progress(`높이 정보가 없는 건물 ${skippedNoHeight}개는 제외했습니다.`);
  }

  const dx = width / (n - 1);
  const points = [];
  // Contract: node samples; flat row-major z; rows increase south -> north.
  for (let row = 0; row < n; row++) {
    for (let column = 0; column < n; column++) {
      points.push([xmin + column * dx, ymin + row * dx]);
    }
  }

  const z = await sampleElevations(points, signal, progress);
  const outputBuildings = buildings.map(building => ({
    polygon: building.polygon,
    holes: building.holes,
    h: building.h,
    base: building.base
  }));

  const missing = outputBuildings
    .map((building, index) => building.base === null ? index : -1)
    .filter(index => index >= 0);

  if (missing.length) {
    progress(`지면 표고가 없는 건물 ${missing.length}개의 기준 표고를 조회합니다.`);
    const bases = await sampleElevations(
      missing.map(index => outputBuildings[index].polygon[0]),
      signal,
      progress
    );
    missing.forEach((index, i) => { outputBuildings[index].base = bases[i]; });
  }

  return {
    dem: { x0: xmin, y0: ymin, dx, nx: n, ny: n, z },
    buildings: outputBuildings,
    skippedNoHeight
  };
}

function leafletPoint(point) {
  const [lon, lat] = toWGS84(point[0], point[1]);
  return [lat, lon];
}

function squareRing(bounds) {
  const [a, b, c, d] = bounds;
  return [[a, b], [c, b], [c, d], [a, d]];
}

export class IGNMap {
  constructor(element, { onRange, onSelection, onNotice }) {
    this.element = element;
    this.onRange = onRange;
    this.onSelection = onSelection;
    this.onNotice = onNotice;
    this.mode = "pan";
    this.enabled = true;
    this.bounds = null;
    this.radius = 200;
    this.buildings = [];
    this.selected = new Set();

    this.map = L.map(element, { preferCanvas: true })
      .setView([48.8566, 2.3522], 15);

    const wmts = (layer, format) =>
      "https://data.geopf.fr/wmts?" +
      "SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0" +
      `&LAYER=${layer}&STYLE=normal&FORMAT=${encodeURIComponent(format)}` +
      "&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";

    const options = {
      maxZoom: 20,
      maxNativeZoom: 19,
      attribution: "© IGN"
    };
    this.plan = L.tileLayer(
      wmts("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "image/png"), options
    ).addTo(this.map);
    this.photo = L.tileLayer(
      wmts("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg"), options
    );

    for (const layer of [this.plan, this.photo]) {
      layer.on("tileerror", () => {
        this.onNotice("지도 타일을 불러오지 못했습니다. 연결 상태를 확인하세요.");
      });
    }

    this.buildingGroup = L.layerGroup().addTo(this.map);
    this.range = L.polygon([], {
      color: "#cc3a2e",
      weight: 2,
      fillOpacity: 0.06,
      interactive: false
    }).addTo(this.map);

    this.map.on("click", event => {
      if (!this.enabled || this.mode !== "point") return;
      this.setCenter(...toL93(event.latlng.lng, event.latlng.lat));
    });

    const pointFromEvent = event => {
      const box = element.getBoundingClientRect();
      const p = this.map.containerPointToLatLng([
        event.clientX - box.left,
        event.clientY - box.top
      ]);
      return toL93(p.lng, p.lat);
    };

    element.addEventListener("pointerdown", event => {
      if (!this.enabled || this.mode !== "draw" ||
          event.button !== 0 || event.target.closest(".leaflet-control")) return;
      event.preventDefault();
      this.drag = { id: event.pointerId, start: pointFromEvent(event) };
      element.setPointerCapture(event.pointerId);
    });

    element.addEventListener("pointermove", event => {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      this.drag.bounds = this.drawBounds(this.drag.start, pointFromEvent(event));
      this.range.setLatLngs(squareRing(this.drag.bounds).map(leafletPoint));
    });

    element.addEventListener("pointerup", event => {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      const bounds = this.drawBounds(this.drag.start, pointFromEvent(event));
      this.drag = null;
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      const side = bounds[2] - bounds[0];
      if (side < 40 || side > 5000) {
        this.renderRange();
        this.onNotice("범위 한 변은 40~5,000 m로 그려주세요.");
        return;
      }
      this.setBounds(bounds);
    });

    element.addEventListener("pointercancel", () => {
      this.drag = null;
      this.renderRange();
    });
    element.addEventListener("lostpointercapture", () => {
      if (!this.drag) return;
      this.drag = null;
      this.renderRange();
    });
    this.setMode("pan");
  }

  drawBounds(start, end) {
    const side = Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]));
    const x = start[0] + (end[0] < start[0] ? -side : 0);
    const y = start[1] + (end[1] < start[1] ? -side : 0);
    return [x, y, x + side, y + side];
  }

  setEnabled(value) {
    this.enabled = value;
    this.drag = null;
    this.renderRange();
    this.updateInteractions();
  }

  updateInteractions() {
    const navigation = this.enabled && this.mode !== "draw";
    for (const name of [
      "dragging", "touchZoom", "doubleClickZoom",
      "scrollWheelZoom", "boxZoom", "keyboard"
    ]) {
      this.map[name]?.[navigation ? "enable" : "disable"]();
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.element.dataset.mode = mode;
    this.updateInteractions();
  }

  setStyle(style, opacity) {
    if (this.map.hasLayer(this.plan)) this.map.removeLayer(this.plan);
    if (this.map.hasLayer(this.photo)) this.map.removeLayer(this.photo);
    if (style !== "photo") this.plan.addTo(this.map);
    if (style !== "plan") {
      this.photo.setOpacity(style === "overlay" ? opacity : 1).addTo(this.map);
    }
  }

  setRadius(radius) {
    if (!(radius >= 20 && radius <= 2500)) {
      throw new Error("반경은 20~2,500 m로 입력하세요.");
    }
    this.radius = radius;
    if (this.bounds) {
      const [a, b, c, d] = this.bounds;
      this.setBounds([
        (a + c) / 2 - radius, (b + d) / 2 - radius,
        (a + c) / 2 + radius, (b + d) / 2 + radius
      ]);
    }
  }

  setCenter(x, y) {
    const [lon, lat] = toWGS84(x, y);
    if (!mainland(lon, lat)) {
      this.onNotice("프랑스 본토의 위치를 선택하세요.");
      return;
    }
    if (this.marker) this.map.removeLayer(this.marker);
    this.marker = L.circleMarker([lat, lon], {
      radius: 6, color: "#fff", weight: 2,
      fillColor: "#d52e2e", fillOpacity: 1
    }).addTo(this.map);
    const r = this.radius;
    this.setBounds([x - r, y - r, x + r, y + r]);
  }

  setBounds(bounds) {
    if (squareRing(bounds).some(point => !mainland(...toWGS84(...point)))) {
      this.renderRange();
      this.onNotice("프랑스 본토 지원 범위 안에서 선택하세요.");
      return;
    }
    this.bounds = bounds;
    this.radius = (bounds[2] - bounds[0]) / 2;
    this.clearBuildings();
    this.renderRange();
    this.onRange([...bounds]);
  }

  renderRange() {
    this.range.setLatLngs(
      this.bounds ? squareRing(this.bounds).map(leafletPoint) : []
    );
  }

  fitRange() {
    if (this.bounds) this.map.fitBounds(this.range.getBounds(), { padding: [20, 20] });
  }

  resize() { this.map.invalidateSize(); }

  clearBuildings() {
    this.focused = null;
    this.buildingGroup.clearLayers();
    this.buildings = [];
    this.polygons = [];
    this.selected.clear();
  }

  setBuildings(buildings) {
    this.clearBuildings();
    this.buildings = buildings;
    this.selected = new Set(buildings.map((_, index) => index));
    this.polygons = buildings.map((building, index) => {
      const polygon = L.polygon(
        [building.polygon, ...building.holes]
          .map(ring => ring.map(leafletPoint)),
        { weight: 1, bubblingMouseEvents: false }
      ).addTo(this.buildingGroup);
      polygon.on("click", () => {
        this.onFocus?.(index);  // show which list row this is, in any mode
        if (!this.enabled || this.mode !== "building") return;
        this.toggle(index);
      });
      return polygon;
    });
    this.refreshSelection();
  }

  toggle(index) {
    if (this.selected.has(index)) this.selected.delete(index);
    else this.selected.add(index);
    this.refreshSelection();
  }

  selectAll(value) {
    this.selected = new Set(value ? this.buildings.map((_, index) => index) : []);
    this.refreshSelection();
  }

  refreshSelection() {
    this.polygons?.forEach((polygon, index) => polygon.setStyle({
      color: index === this.focused ? "#1d1d1f"
        : this.selected.has(index) ? "#b52727" : "#62737a",
      weight: index === this.focused ? 4 : 1,
      fillColor: this.selected.has(index) ? "#e04a3a" : "#9faeb3",
      fillOpacity: this.selected.has(index) ? 0.45 : 0.15
    }));
    this.onSelection(this.getSelected());
  }

  // Highlight one building (thick dark outline) and bring it into view.
  focus(index, { zoom = true } = {}) {
    const polygon = this.polygons?.[index];
    if (!polygon) return;
    this.focused = index;
    this.refreshSelection();
    polygon.bringToFront();
    if (zoom) {
      this.map.flyToBounds(polygon.getBounds(), {
        maxZoom: 19, padding: [60, 60], duration: 0.4
      });
    }
  }

  getSelected() {
    return this.buildings.filter((_, index) => this.selected.has(index));
  }
}
