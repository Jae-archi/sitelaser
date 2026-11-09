"""Physical ISO sheets: one terrain plate per SVG/DXF pair.

Model coordinates are metres. Output coordinates and DXF INSUNITS are mm.
No fit-to-page rescaling, clipping, tiling, or manufacturing compensation.
"""

from __future__ import annotations

import html
import io
import math
import re
from collections.abc import Mapping

import ezdxf
import shapely
from shapely.geometry import LineString

if __package__:
    from .slicing import EPS, even_odd, integer, number
else:
    from slicing import EPS, even_odd, integer, number


SIZES_MM = {
    "A0": (841, 1189),
    "A1": (594, 841),
    "A2": (420, 594),
    "A3": (297, 420),
    "A4": (210, 297),
}
MARGIN_MM = 12
FOOTER_MM = 24
SETTING_KEYS = {
    "scale", "thickness_mm", "interval_m", "paper", "orientation",
    "building_mode", "building_thickness_mm", "floor_height_m",
    "paper_width_mm", "paper_height_mm",
}


def validate_settings(settings):
    if not isinstance(settings, Mapping):
        raise ValueError("settings는 객체여야 합니다.")
    unknown = set(settings) - SETTING_KEYS
    if unknown:
        raise ValueError(f"지원하지 않는 설정: {sorted(unknown)}")
    scale = number(settings.get("scale", 500), "축척")
    thickness = number(settings.get("thickness_mm", 2), "재료 두께")
    if not 1 <= scale <= 100000:
        raise ValueError("축척은 1:1~1:100000 범위여야 합니다.")
    if thickness <= 0:
        raise ValueError("재료 두께는 양수여야 합니다.")
    interval = number(
        settings.get("interval_m", thickness * scale / 1000),
        "등고 간격",
    )
    if interval <= 0:
        raise ValueError("등고 간격은 양수여야 합니다.")
    paper = settings.get("paper", "A3")
    orientation = settings.get("orientation", "landscape")
    custom = None
    if paper == "custom":
        # user-defined sheet, e.g. a laser bed of 600 x 400 mm
        cw = number(settings.get("paper_width_mm", 600), "용지 가로")
        ch = number(settings.get("paper_height_mm", 400), "용지 세로")
        if not (50 <= cw <= 5000 and 50 <= ch <= 5000):
            raise ValueError("사용자 용지는 가로·세로 50~5000 mm 범위여야 합니다.")
        custom = (cw, ch)
    elif paper not in SIZES_MM:
        raise ValueError("용지는 A0~A4 또는 사용자 설정이어야 합니다.")
    if orientation not in {"landscape", "portrait"}:
        raise ValueError("방향은 landscape 또는 portrait여야 합니다.")
    # Buildings: "print" (STL for a 3D printer) or "laser" (stacked sheets
    # with their own board thickness, independent of the terrain plates).
    building_mode = settings.get("building_mode", "print")
    # print: one STL · print_floor: one STL per storey ·
    # laser: boards of building_thickness_mm · laser_floor: one storey = one board
    if building_mode not in {"print", "print_floor", "laser", "laser_floor"}:
        raise ValueError("지원하지 않는 건물 제작 방식입니다.")
    floor_height = number(settings.get("floor_height_m", 3), "층고")
    if not 1 <= floor_height <= 20:
        raise ValueError("층고는 1~20 m 범위여야 합니다.")
    building_thickness = number(
        settings.get("building_thickness_mm", thickness), "건물 판 두께"
    )
    if building_thickness <= 0:
        raise ValueError("건물 판 두께는 양수여야 합니다.")
    return {
        "building_mode": building_mode,
        "building_thickness_mm": building_thickness,
        "floor_height_m": floor_height,
        **({"paper_width_mm": custom[0], "paper_height_mm": custom[1]} if custom else {}),
        "scale": scale,
        "thickness_mm": thickness,
        "interval_m": interval,
        "paper": paper,
        "orientation": orientation,
    }


def _layout(bounds, settings):
    if len(bounds) != 4:
        raise ValueError("bounds는 [xmin, ymin, xmax, ymax]여야 합니다.")
    xmin, ymin, xmax, ymax = [number(v, "범위") for v in bounds]
    if xmax <= xmin or ymax <= ymin:
        raise ValueError("도면 범위의 폭과 높이는 양수여야 합니다.")
    if settings["paper"] == "custom":
        # custom sizes are taken as typed: width x height, no rotation
        width, height = settings["paper_width_mm"], settings["paper_height_mm"]
    else:
        short, long = SIZES_MM[settings["paper"]]
        width, height = (
            (long, short)
            if settings["orientation"] == "landscape"
            else (short, long)
        )
    usable_width = width - 2 * MARGIN_MM
    usable_height = height - 2 * MARGIN_MM - FOOTER_MM
    factor = 1000 / settings["scale"]
    draw_width = (xmax - xmin) * factor
    draw_height = (ymax - ymin) * factor
    if not math.isfinite(draw_width + draw_height):
        raise ValueError("출력 크기가 유한하지 않습니다.")
    if (
        draw_width > usable_width + 1e-8
        or draw_height > usable_height + 1e-8
    ):
        minimum = math.ceil(max(
            (xmax - xmin) * 1000 / usable_width,
            (ymax - ymin) * 1000 / usable_height,
        ))
        raise ValueError(
            f"{'사용자 용지' if settings['paper'] == 'custom' else settings['paper']}에 들어가지 않습니다. "
            f"축척을 1:{minimum} 이상으로 지정하거나 용지를 키워 주세요."
        )
    return {
        "width": width,
        "height": height,
        "factor": factor,
        "xmin": xmin,
        "ymin": ymin,
        "left": (width - draw_width) / 2,
        "bottom": MARGIN_MM + FOOTER_MM + (usable_height - draw_height) / 2,
    }


def _mm(path, layout):
    return [
        (
            layout["left"] + (x - layout["xmin"]) * layout["factor"],
            layout["bottom"] + (y - layout["ymin"]) * layout["factor"],
        )
        for x, y in path
    ]


def _validated_path(path, closed):
    if not isinstance(path, (list, tuple)) or len(path) < (4 if closed else 2):
        raise ValueError("절단선 또는 각인선의 점 수가 부족합니다.")
    result = []
    for point in path:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise ValueError("출력 경로 좌표는 [x, y]여야 합니다.")
        result.append([number(point[0], "x"), number(point[1], "y")])
    if closed and result[0] != result[-1]:
        raise ValueError("절단선이 닫혀 있지 않습니다.")
    line = LineString(result)
    if line.length <= EPS or not line.is_simple:
        raise ValueError("출력 경로가 퇴화하거나 자기 교차합니다.")
    return result


# Export line style, set per render_sheets() call (from the export screen).
DEFAULT_STYLE = {"cut_color": "#ff0000", "engrave_color": "#0000ff", "line_width_mm": 0.1}
_style = dict(DEFAULT_STYLE)
# Line geometry of every sheet from the last render (mm), for the combined
# Rhino file of all 2D drawings.
_drawings = []


def _validated_style(style):
    out = dict(DEFAULT_STYLE)
    for key in ("cut_color", "engrave_color"):
        value = (style or {}).get(key, out[key])
        if not (isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value)):
            raise ValueError("선 색상은 #RRGGBB 형식이어야 합니다.")
        out[key] = value.lower()
    width = number((style or {}).get("line_width_mm", out["line_width_mm"]), "선 굵기")
    if not 0.001 <= width <= 2:
        raise ValueError("선 굵기는 0.001~2 mm 범위여야 합니다.")
    out["line_width_mm"] = width
    return out


def _rgb(hex_color):
    return tuple(int(hex_color[i:i + 2], 16) for i in (1, 3, 5))


def _lineweight(mm):
    # DXF lineweights are fixed values in 1/100 mm; pick the nearest.
    allowed = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200]
    return min(allowed, key=lambda v: abs(v - mm * 100))


def _svg(cut, engrave, layout, label):
    width, height = layout["width"], layout["height"]
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{width}mm" height="{height}mm" '
        f'viewBox="0 0 {width} {height}" role="img" '
        f'aria-label="{html.escape(label, quote=True)}">',
    ]
    # Only CUT and ENGRAVE groups contain manufacturing paths.
    for name, color, paths in (
        ("CUT", _style["cut_color"], cut),
        ("ENGRAVE", _style["engrave_color"], engrave),
    ):
        parts.append(
            f'<g id="{name}" data-layer="{name}" fill="none" '
            f'stroke="{color}" stroke-width="{_style["line_width_mm"]:g}">'
        )
        for path in paths:
            points = " ".join(
                f"{x:.9f},{height - y:.9f}" for x, y in path
            )
            parts.append(f'<polyline points="{points}"/>')
        parts.append("</g>")
    parts.extend([
        '<g id="LABELS_NO_CUT" data-layer="LABELS_NO_CUT">',
        f'<text x="{MARGIN_MM}" y="{height - 10}" '
        'font-size="3.5" font-family="sans-serif" fill="#25333b">'
        f"{html.escape(label)}</text>",
        "</g>",
        "</svg>",
    ])
    return "\n".join(parts)


def _dxf(cut, engrave, label):
    doc = ezdxf.new("R2010")
    doc.units = 4
    doc.header["$MEASUREMENT"] = 1
    lw = _lineweight(_style["line_width_mm"])
    doc.header["$LWDISPLAY"] = 1
    for name, key in (("CUT", "cut_color"), ("ENGRAVE", "engrave_color")):
        layer = doc.layers.new(name, dxfattribs={"lineweight": lw})
        layer.rgb = _rgb(_style[key])  # true colour, as the laser software expects
    doc.layers.new("LABELS_NO_CUT", dxfattribs={"color": 7})
    model = doc.modelspace()
    for name, paths in (("CUT", cut), ("ENGRAVE", engrave)):
        for points in paths:
            closed = points[0] == points[-1]
            model.add_lwpolyline(
                points[:-1] if closed else points,
                close=closed,
                dxfattribs={"layer": name},
            )
    model.add_text(label, dxfattribs={
        "layer": "LABELS_NO_CUT",
        "height": 3.5,
        "insert": (MARGIN_MM, 10),
    })
    stream = io.StringIO()
    doc.write(stream)
    return stream.getvalue()


def render_sheets(project, style=None):
    global _style
    _style = _validated_style(style)
    _drawings.clear()
    if not isinstance(project, Mapping):
        raise ValueError("project는 객체여야 합니다.")
    settings = validate_settings(project["settings"])
    layout = _layout(project["bounds"], settings)
    layers = project.get("layers", [])
    if not layers:
        raise ValueError("출력할 판재가 없습니다.")
    bounds = tuple(number(v, "범위") for v in project["bounds"])
    output = {}
    previous_geometry = None
    previous_z = None
    for position, layer in enumerate(layers):
        index = integer(layer["index"], "층 인덱스")
        if index != position:
            raise ValueError("층 인덱스는 0부터 연속이어야 합니다.")
        z = number(layer["z"], "층 고도")
        if previous_z is not None and z <= previous_z:
            raise ValueError("층 고도는 오름차순이어야 합니다.")

        cut = [_validated_path(p, True) for p in layer["cut"]]
        engrave = [_validated_path(p, False) for p in layer["engrave"]]
        geometry = even_odd(cut)
        xmin, ymin, xmax, ymax = geometry.bounds
        tol = max(EPS, 1e-4)  # even_odd snap-rounds to a 1e-4 m grid
        if (
            xmin < bounds[0] - tol or ymin < bounds[1] - tol
            or xmax > bounds[2] + tol or ymax > bounds[3] + tol
        ):
            raise ValueError("절단선이 Project 범위 밖입니다.")
        if previous_geometry is not None:
            extra = shapely.difference(geometry, previous_geometry, grid_size=1e-4)
            if extra.area > max(1e-6, previous_geometry.area * 1e-8):
                raise ValueError("누적 판재의 포함 관계가 잘못되었습니다.")
        # Real IGN footprints and contours often run past a plate edge:
        # clip engrave lines to the plate instead of rejecting the project.
        clipped = []
        # Once per plate. 1e-4 m, not EPS (1e-8): a 1e-8 buffer at Lambert-93
        # magnitudes (~7e6 m) is below float precision and makes GEOS throw.
        plate_zone = geometry.buffer(1e-4)
        for path in engrave:
            line = LineString(path)
            if plate_zone.covers(line):
                clipped.append(path)
                continue
            part = shapely.intersection(line, geometry, grid_size=1e-4)
            for piece in getattr(part, "geoms", [part]):
                if piece.geom_type == "LineString" and piece.length > EPS:
                    clipped.append([list(c[:2]) for c in piece.coords])
        engrave = clipped

        cut_mm = [_mm(path, layout) for path in cut]
        engrave_mm = [_mm(path, layout) for path in engrave]
        label = (
            f"L{index:02d} | z={z:g} m | "
            f"1:{settings['scale']:g} | "
            f"t={settings['thickness_mm']:g} mm | print 100%"
        )
        name = f"plate_{index + 1:02d}"
        output[name + ".svg"] = _svg(cut_mm, engrave_mm, layout, label)
        _drawings.append({"name": name, "width": layout["width"], "height": layout["height"],
                          "cut": cut_mm, "engrave": engrave_mm, "label": label})
        output[name + ".dxf"] = _dxf(cut_mm, engrave_mm, label)
        previous_geometry = geometry
        previous_z = z
    if settings["building_mode"] in {"laser", "laser_floor"}:
        output.update(_building_sheets(project.get("buildings", []), layout, settings))
    return output


def _building_sheets(buildings, layout, settings):
    """Laser sheets for buildings: building i gets ceil(h_model / t) layers.

    Sheet k holds the footprint of every building taller than k layers, in
    site position (same layout as the terrain plates) with its number
    engraved, so pieces can be glued in place on the plates.
    """
    scale = settings["scale"]
    per_floor = settings["building_mode"] == "laser_floor"
    fh = settings["floor_height_m"]
    # one storey = one board: board thickness is the floor height at scale
    t = fh * 1000.0 / scale if per_floor else settings["building_thickness_mm"]
    layers = []
    for number_, b in enumerate(buildings, start=1):
        if per_floor:
            n = max(1, round(float(b["h"]) / fh))
        else:
            h_mm = float(b["h"]) * 1000.0 / scale
            n = max(1, math.ceil(h_mm / t - 1e-6))
        layers.append((number_, b, n))
    if not layers:
        return {}
    out = {}
    for k in range(max(n for _, _, n in layers)):
        cut, labels = [], []
        for number_, b, n in layers:
            if n <= k:
                continue
            rings = [b["polygon"], *b.get("holes", [])]
            cut.extend(_mm([list(p[:2]) for p in ring], layout) for ring in rings)
            ring = b["polygon"]
            cx = sum(p[0] for p in ring[:-1]) / max(1, len(ring) - 1)
            cy = sum(p[1] for p in ring[:-1]) / max(1, len(ring) - 1)
            labels.append((_mm([[cx, cy]], layout)[0], f"B{number_}"))
        label = (
            f"BUILDINGS {'FLOOR' if per_floor else 'L'}{k + 1:02d} | 1:{scale:g} | t={t:.3g} mm | "
            "glue on terrain | print 100%"
        )
        name = f"building_{k + 1:02d}"
        svg = _svg(cut, [], layout, label)
        _drawings.append({"name": name, "width": layout["width"], "height": layout["height"],
                          "cut": cut, "engrave": [], "label": label})
        marks = "".join(
            f'<text x="{x:.3f}" y="{layout["height"] - y:.3f}" font-size="1.6" '
            f'text-anchor="middle" font-family="sans-serif" fill="#285cd2">{txt}</text>'
            for (x, y), txt in labels
        )
        out[name + ".svg"] = svg.replace(
            '<g id="LABELS_NO_CUT" data-layer="LABELS_NO_CUT">',
            '<g id="LABELS_NO_CUT" data-layer="LABELS_NO_CUT">' + marks, 1,
        )
        out[name + ".dxf"] = _dxf(cut, [], label)
    return out


def sheet_drawings():
    """Copy of the last render's sheet geometry (mm), in output order."""
    return [dict(d, style=dict(_style)) for d in _drawings]
