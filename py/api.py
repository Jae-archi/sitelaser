"""Browser-facing SiteLaser API. No network or filesystem operations.

Public functions return JSON-serializable dictionaries.

Coordinates:
    Project XY and Z are metres in the source coordinate reference system.
    No automatic translation to a local origin is performed.
    layers[index].z is the source slicing elevation, not a display-stack Z.
    CUT rings repeat their first point. Interpret nested rings by even-odd
    containment, not by array position. ENGRAVE paths may be open.

DEM:
    {"x0": float, "y0": float, "dx": positive float,
     "nx": int >= 2, "ny": int >= 2, "z": [float, ...]}
    x0/y0 locate the southwest SAMPLE, not a pixel corner.
    z[j * nx + i] belongs to (x0 + i*dx, y0 + j*dx).
    A nested ny-by-nx z array is also accepted.
    Missing/non-finite elevations are rejected, never replaced by zero.

Geometry JSON:
    {
        "units": "Meters",
        "curves": [
            {
                "id": "optional unique ID",
                "layer": "optional layer name",
                "role": "boundary|contour|road",
                "points": [[x, y, z], ...],
                "closed": true
            }
        ],
        "meshes": [
            {
                "vertices": [[x, y, z], ...],
                "faces": [[a, b, c], [a, b, c, d], ...]
            }
        ],
        "buildings": [
            {"polygon": [[x, y], ...], "holes": [],
             "h": positive float, "base": float}
        ],
        "selection": {
            "boundary_id": "...",
            "contour_ids": ["..."],
            "contour_layers": ["..."],
            "road_ids": ["..."],
            "road_layers": ["..."],
            "lowest_point": [x, y],
            "lowest_ids": ["..."],
            "same_level_groups": [["...", "..."]],
            "contour_steps": {"...": 1}
        }
    }

Curves use explicit roles when supplied. Otherwise BOUNDARY, CONTOUR,
ROAD, and ENGRAVE layer names are recognized; other curves are contours.
A selected boundary ID overrides its role.

A terrain input uses either meshes or boundary/contour curves, not both.
Meshes must form a single-valued surface in XY: no overlapping projected
triangles and no vertical faces. Quads split along vertices 0--2.
All geometry JSON lengths, including building h/base, use "units".
Selection.lowest_point uses the same units.

DXF:
    ASCII DXF bytes, with a declared supported $INSUNITS value.
    BOUNDARY layer supplies exactly one closed perimeter.
    CONTOUR or other non-annotation curve layers supply contours.
    ROAD/ENGRAVE layers supply engraving.
    Blocks must be exploded upstream.
    Flat 2D DXF requires explicit topology selection unavailable in the
    five-field settings contract; convert it to geometry JSON with selection.

Settings:
    scale, thickness_mm, interval_m, paper, orientation.
    interval_m defaults to thickness_mm * scale / 1000.
    Explicit interval_m may differ; this implies vertical exaggeration
    when the viewer stacks plates at their physical material thickness.
"""

from __future__ import annotations

import io
import json
import math
from collections.abc import Mapping

import ezdxf
from ezdxf.path import make_path
import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

if __package__:
    from .slicing import (
        EPS,
        curve_layers,
        grid_surface,
        mesh_surface,
        number,
        paths,
        rings,
        sample_surface,
        surface_layers,
        valid_polygon,
    )
    from .sheets import render_sheets, sheet_drawings as _sheet_drawings, validate_settings
else:
    # worker.js may place these three modules directly on sys.path.
    from slicing import (
        EPS,
        curve_layers,
        grid_surface,
        mesh_surface,
        number,
        paths,
        rings,
        sample_surface,
        surface_layers,
        valid_polygon,
    )
    from sheets import render_sheets, sheet_drawings as _sheet_drawings, validate_settings


Project = dict

_UNIT_FACTORS = {
    "meters": 1.0,
    "metres": 1.0,
    "m": 1.0,
    "millimeters": 0.001,
    "millimetres": 0.001,
    "mm": 0.001,
    "centimeters": 0.01,
    "centimetres": 0.01,
    "cm": 0.01,
    "inches": 0.0254,
    "feet": 0.3048,
    "kilometers": 1000.0,
    "kilometres": 1000.0,
}
_DXF_FACTORS = {
    1: 0.0254,
    2: 0.3048,
    4: 0.001,
    5: 0.01,
    6: 1.0,
    7: 1000.0,
}
_ROLES = {
    "BOUNDARY": "boundary",
    "CONTOUR": "contour",
    "ROAD": "road",
    "ENGRAVE": "road",
}


GRID = 1e-4  # 0.1 mm snap grid; keeps Pyodide GEOS overlays from fatal TopologyException


def _mapping(value, name):
    if not isinstance(value, Mapping):
        raise ValueError(f"{name}: 객체가 필요합니다.")
    return value


def _point(value, factor=1.0, dimensions=(2, 3)):
    if not isinstance(value, (list, tuple)) or len(value) not in dimensions:
        raise ValueError("좌표는 [x, y] 또는 [x, y, z] 배열이어야 합니다.")
    result = [number(v, "좌표") * factor for v in value]
    if not all(math.isfinite(v) for v in result):
        raise ValueError("단위 변환 후 좌표가 유한하지 않습니다.")
    return result


def _factor(units):
    key = str(units).lower()
    if key not in _UNIT_FACTORS:
        raise ValueError(f"지원하지 않거나 지정되지 않은 단위: {units}")
    return _UNIT_FACTORS[key]


def _curves(items, factor):
    result = []
    ids = set()
    for index, item in enumerate(items):
        _mapping(item, "곡선")
        ident = str(item.get("id", index))
        if ident in ids:
            raise ValueError(f"중복 곡선 ID: {ident}")
        ids.add(ident)
        layer = str(item.get("layer", ""))
        role = item.get("role", _ROLES.get(layer.upper(), "contour"))
        if role not in {"boundary", "contour", "road"}:
            raise ValueError(f"{ident}: 지원하지 않는 곡선 역할 {role}")
        points = [_point(p, factor) for p in item.get("points", [])]
        if len(points) < 2:
            raise ValueError(f"{ident}: 곡선에 점이 두 개 이상 필요합니다.")
        points = [p if len(p) == 3 else [*p, 0.0] for p in points]
        if item.get("closed", False):
            # flattened ellipses/splines end ~1e-16 off the start: snap shut
            # instead of adding a tiny reversed segment that fails is_simple
            if math.hypot(points[0][0] - points[-1][0], points[0][1] - points[-1][1]) <= EPS:
                points[-1] = points[0][:]
            else:
                points.append(points[0][:])
        line = LineString([p[:2] for p in points])
        if line.is_empty or line.length <= EPS or not line.is_simple:
            raise ValueError(f"{ident}: 퇴화하거나 자기 교차하는 곡선입니다.")
        result.append({
            "id": ident,
            "layer": layer,
            "role": role,
            "points": points,
            "line": line,
        })
    return result


def _selection(value, factor):
    value = dict(_mapping(value, "selection"))
    allowed = {
        "boundary_id", "contour_ids", "contour_layers",
        "road_ids", "road_layers", "lowest_point", "lowest_ids",
        "same_level_groups", "contour_steps",
    }
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"지원하지 않는 선택 항목: {sorted(unknown)}")
    if "boundary_id" in value:
        value["boundary_id"] = str(value["boundary_id"])
    for key in ("contour_ids", "road_ids", "lowest_ids"):
        if key in value:
            value[key] = [str(v) for v in value[key]]
    if "same_level_groups" in value:
        value["same_level_groups"] = [
            [str(v) for v in group] for group in value["same_level_groups"]
        ]
    if "contour_steps" in value:
        value["contour_steps"] = {
            str(k): v for k, v in value["contour_steps"].items()
        }
    if "lowest_point" in value:
        value["lowest_point"] = _point(
            value["lowest_point"], factor, dimensions=(2,)
        )
    return value


def _choose(curves, selection):
    byid = {c["id"]: c for c in curves}
    boundary_id = selection.get("boundary_id")
    if boundary_id is not None:
        if boundary_id not in byid:
            raise ValueError("선택한 외곽선 ID를 찾을 수 없습니다.")
        boundary = byid[boundary_id]
    else:
        candidates = [c for c in curves if c["role"] == "boundary"]
        if len(candidates) != 1:
            raise ValueError("BOUNDARY 외곽선 하나를 지정해야 합니다.")
        boundary = candidates[0]

    def chosen(key, role):
        explicit = key + "_ids" in selection or key + "_layers" in selection
        ids = set(selection.get(key + "_ids", []))
        layers = set(selection.get(key + "_layers", []))
        missing = ids - byid.keys()
        if missing:
            raise ValueError(f"{key}: 존재하지 않는 ID {sorted(missing)}")
        return [
            c for c in curves
            if c["id"] != boundary["id"]
            and (
                (c["id"] in ids or c["layer"] in layers)
                if explicit else c["role"] == role
            )
        ]

    contours = chosen("contour", "contour")
    roads = chosen("road", "road")
    if {c["id"] for c in contours} & {c["id"] for c in roads}:
        raise ValueError("같은 곡선을 등고선과 각인선으로 함께 선택할 수 없습니다.")
    return boundary, contours, roads


def _buildings(items, factor, base_at, base_plate=None):
    """Normalise buildings: repair slightly invalid IGN footprints, cut them
    to the bottom plate first, THEN sample each piece's base elevation (so a
    building straddling the site edge never samples outside the terrain)."""
    result = []
    for item in items:
        _mapping(item, "건물")
        shell = [_point(p, factor, (2,)) for p in item.get("polygon", [])]
        holes = [
            [_point(p, factor, (2,)) for p in ring]
            for ring in item.get("holes", [])
        ]
        try:
            polygon = Polygon(shell, holes)
        except (TypeError, ValueError) as exc:
            raise ValueError("건물 외곽선 좌표가 올바르지 않습니다.") from exc
        if not polygon.is_valid:
            polygon = shapely.make_valid(polygon)
        if polygon.is_empty or polygon.area <= EPS * EPS:
            continue
        height = number(item.get("h"), "건물 높이") * factor
        if not math.isfinite(height) or height <= 0:
            raise ValueError("건물 높이는 양수여야 합니다.")
        area = polygon.area
        if base_plate is not None:
            polygon = shapely.intersection(polygon, base_plate, grid_size=GRID)
        pieces = [g for g in getattr(polygon, "geoms", [polygon])
                  if g.geom_type == "Polygon" and g.area > area * 0.01]
        for piece in pieces:
            if item.get("base") is None:
                p = piece.representative_point()
                base = number(base_at(p.x, p.y), "건물 바닥 고도")
            else:
                base = number(item["base"], "건물 바닥 고도") * factor
            if not math.isfinite(base):
                raise ValueError("건물 바닥 고도가 유한하지 않습니다.")
            result.append({
                "polygon": [list(p[:2]) for p in piece.exterior.coords],
                "holes": [[list(p[:2]) for p in r.coords] for r in piece.interiors],
                "h": height,
                **({"floors": int(item["floors"])} if item.get("floors") else {}),
                "base": base,
            })
    return result


def _clip_buildings(buildings, base):
    """Cut building footprints at the bottom plate's outline.

    Buildings that cross the site edge would overhang the physical model;
    keep only the part over the plate. A footprint split into several parts
    becomes several buildings with the same height and base.
    """
    result = []
    for building in buildings:
        footprint = Polygon(building["polygon"], building["holes"])
        if not footprint.is_valid:
            footprint = shapely.make_valid(footprint)
        part = shapely.intersection(footprint, base, grid_size=GRID)
        for piece in getattr(part, "geoms", [part]):
            # drop slivers: fragments under 1% of the original footprint
            if piece.geom_type != "Polygon" or piece.area <= footprint.area * 0.01:
                continue
            result.append({
                **building,
                "polygon": [list(c[:2]) for c in piece.exterior.coords],
                "holes": [[list(c[:2]) for c in ring.coords] for ring in piece.interiors],
            })
    return result


def _project(layer_geometries, buildings, settings, road_lines=()):
    if not layer_geometries:
        raise ValueError("생성된 판재가 없습니다.")
    base = layer_geometries[0][1]
    buildings = _clip_buildings(buildings, base)
    marks = list(road_lines)
    for building in buildings:
        polygon = Polygon(building["polygon"], building["holes"])
        marks.append(polygon.boundary)
    marking = shapely.unary_union(marks, grid_size=GRID) if marks else None

    layers = []
    previous = None
    for index, (z, geometry) in enumerate(layer_geometries):
        if geometry.is_empty or not geometry.is_valid or geometry.area <= 0:
            raise ValueError("유효하지 않은 판재 형상입니다.")
        if previous is not None:
            excess = shapely.difference(geometry, previous, grid_size=GRID).area
            # tolerance = outline length x snap grid (hairline slivers only)
            if excess > max(1e-6, geometry.length * GRID):
                raise ValueError("상부 판재가 하부 판재 밖으로 벗어납니다.")
        engraving = []
        # Engrave where the next plate sits (its outline) so it can be glued
        # in place, plus building footprints.
        marks_here = [] if marking is None else [marking]
        if index + 1 < len(layer_geometries):
            marks_here.append(layer_geometries[index + 1][1].boundary)
        if marks_here:
            local = shapely.unary_union(marks_here, grid_size=GRID)
            clipped = shapely.difference(
                shapely.intersection(local, geometry, grid_size=GRID),
                geometry.boundary, grid_size=GRID)
            engraving = paths(clipped)
        layers.append({
            "index": index,
            "z": float(z),
            "cut": rings(geometry),
            "engrave": engraving,
        })
        previous = geometry

    result = {
        "bounds": [float(v) for v in base.bounds],
        "layers": layers,
        "buildings": buildings,
        "settings": dict(settings),
    }
    # Also catches numeric overflow before a value crosses the worker bridge.
    json.dumps(result, allow_nan=False)
    return result


def from_dxf(data: bytes, settings) -> Project:
    cfg = validate_settings(settings)
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise ValueError("DXF 입력은 bytes여야 합니다.")
    data = bytes(data)
    if not data:
        raise ValueError("빈 DXF 입력입니다.")
    if data.startswith(b"AutoCAD Binary DXF"):
        raise ValueError("바이너리 DXF는 ASCII DXF로 변환해 주세요.")
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    # Windows CAD exports use CRLF; ezdxf.read on a StringIO with CRLF finds no entities.
    data = data.replace(b"\r\n", b"\n")

    # First pass discovers version/codepage without guessing a legacy encoding.
    probe = ezdxf.read(io.StringIO(data.decode("latin1")))
    encoding = "utf-8" if probe.dxfversion >= "AC1021" else probe.encoding
    doc = ezdxf.read(io.StringIO(data.decode(encoding, errors="strict")))

    factor = _DXF_FACTORS.get(int(doc.units))
    if factor is None:
        raise ValueError("DXF $INSUNITS에 지원되는 실제 단위를 지정해 주세요.")

    supported = {
        "LINE", "LWPOLYLINE", "POLYLINE",
        "ARC", "CIRCLE", "ELLIPSE", "SPLINE",
    }
    annotations = {"TEXT", "MTEXT", "POINT", "DIMENSION", "LEADER"}
    curves = []
    for entity in doc.modelspace():
        kind = entity.dxftype()
        if kind in annotations:
            continue
        if kind not in supported:
            raise ValueError(
                f"{entity.dxf.handle}: 지원하지 않는 DXF 개체 {kind}. "
                "블록·면 객체는 먼저 변환해 주세요."
            )
        path = make_path(entity)
        if path.has_sub_paths:
            raise ValueError("하나의 개체에 여러 경로가 있습니다. 먼저 분해해 주세요.")
        points = [
            [float(p.x) * factor, float(p.y) * factor, float(p.z) * factor]
            for p in path.flattening(0.00025 / factor)
        ]
        curves.append({
            "id": str(entity.dxf.handle),
            "layer": str(entity.dxf.layer),
            "points": points,
            "closed": bool(path.is_closed),
        })

    return from_geometry({"units": "Meters", "curves": curves}, cfg)


def from_geometry(geom_json, settings) -> Project:
    if isinstance(geom_json, str):
        geom_json = json.loads(geom_json)
    geom = _mapping(geom_json, "geom_json")
    cfg = validate_settings(settings)
    factor = _factor(geom.get("units", "Meters"))
    curves = _curves(geom.get("curves", []), factor)
    selection = _selection(geom.get("selection", {}), factor)
    meshes = geom.get("meshes", [])

    if meshes:
        if selection or any(c["role"] != "road" for c in curves):
            raise ValueError("메시 지형과 등고선 지형을 동시에 지정할 수 없습니다.")
        triangles = mesh_surface(meshes, factor)
        layers = surface_layers(triangles, cfg["interval_m"])
        base_at = lambda x, y: sample_surface(triangles, x, y)
        roads = [c["line"] for c in curves]
    else:
        boundary, contours, road_features = _choose(curves, selection)
        layers = curve_layers(boundary, contours, selection, cfg["interval_m"])
        roads = [c["line"] for c in road_features]

        def base_at(x, y):
            point = Point(x, y)
            candidates = [z for z, shape in layers if shape.covers(point)]
            if not candidates:
                raise ValueError("건물 기준점이 지형 범위 밖입니다.")
            return max(candidates)

    buildings = _buildings(geom.get("buildings", []), factor, base_at,
                           layers[0][1] if layers else None)
    return _project(layers, buildings, cfg, roads)


def from_terrain(dem, buildings, settings) -> Project:
    cfg = validate_settings(settings)
    triangles = grid_surface(_mapping(dem, "DEM"))
    layers = surface_layers(triangles, cfg["interval_m"])
    normalized = _buildings(
        buildings or [],
        1.0,
        lambda x, y: sample_surface(triangles, x, y),
        layers[0][1] if layers else None,
    )
    return _project(layers, normalized, cfg)


def sheets(project, style=None):
    return render_sheets(project, style)


def sheet_drawings():
    """Line geometry (mm) of the sheets from the last sheets() call."""
    return _sheet_drawings()
