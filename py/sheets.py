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
from ezdxf.enums import TextEntityAlignment
from shapely.affinity import scale
from shapely.geometry import LineString, Polygon, box
from shapely.ops import polylabel

if __package__:
    from .slicing import EPS, building_support_plan, even_odd, integer, number, paths, polygons, rings, stack_seat
else:
    from slicing import EPS, building_support_plan, even_odd, integer, number, paths, polygons, rings, stack_seat


SIZES_MM = {
    "A0": (841, 1189),
    "A1": (594, 841),
    "A2": (420, 594),
    "A3": (297, 420),
    "A4": (210, 297),
}
MARGIN_MM = 12
FOOTER_MM = 24
SITE_FOOTER_MM = 12
PAPER_MIN_MM = 50
PAPER_MAX_MM = 5000
NUMBER_HEIGHT_MM = 1.6
CAP_HEIGHT_RATIO = 0.718  # Arial/Helvetica cap height relative to the font em
SETTING_KEYS = {
    "scale", "thickness_mm", "interval_m", "paper", "orientation",
    "building_mode", "building_thickness_mm", "floor_height_m",
    "paper_width_mm", "paper_height_mm", "paper_footer",
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
    paper_footer = settings.get("paper_footer", False)
    if not isinstance(paper_footer, bool):
        raise ValueError("하단 도면 정보 추가는 켜기 또는 끄기로 설정해야 합니다.")
    custom = None
    if paper == "custom":
        # user-defined sheet, e.g. a laser bed of 600 x 400 mm
        cw = number(settings.get("paper_width_mm", 600), "용지 가로")
        ch = number(settings.get("paper_height_mm", 400), "용지 세로")
        if not (PAPER_MIN_MM <= cw <= PAPER_MAX_MM and PAPER_MIN_MM <= ch <= PAPER_MAX_MM):
            raise ValueError("사용자 용지는 가로·세로 50~5000 mm 범위여야 합니다.")
        custom = (cw, ch)
    elif paper != "site" and paper not in SIZES_MM:
        raise ValueError("용지는 A0~A4, 대지 범위에 맞춤, 사용자 설정 중 하나여야 합니다.")
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
        "paper_footer": paper_footer,
    }


def _layout(bounds, settings):
    if len(bounds) != 4:
        raise ValueError("bounds는 [xmin, ymin, xmax, ymax]여야 합니다.")
    xmin, ymin, xmax, ymax = [number(v, "범위") for v in bounds]
    if xmax <= xmin or ymax <= ymin:
        raise ValueError("도면 범위의 폭과 높이는 양수여야 합니다.")
    factor = 1000 / settings["scale"]
    draw_width = (xmax - xmin) * factor
    draw_height = (ymax - ymin) * factor
    if not math.isfinite(draw_width + draw_height):
        raise ValueError("출력 크기가 유한하지 않습니다.")
    fitted = settings["paper"] == "site"
    caption = settings["paper_footer"] and (not fitted or draw_width >= PAPER_MIN_MM)
    extra = SITE_FOOTER_MM if fitted and caption else 0
    horizontal = 0 if fitted else 2 * MARGIN_MM
    vertical = extra if fitted else 2 * MARGIN_MM + FOOTER_MM
    if fitted:
        width, height = draw_width, draw_height + extra
        if max(width, height) > PAPER_MAX_MM:
            raise ValueError("용지 한도 5,000 mm를 넘습니다. 축척 분모를 키우거나 대지 범위를 줄이세요.")
    elif settings["paper"] == "custom":
        # custom sizes are taken as typed: width x height, no rotation
        width, height = settings["paper_width_mm"], settings["paper_height_mm"]
    else:
        short, long = SIZES_MM[settings["paper"]]
        width, height = (
            (long, short)
            if settings["orientation"] == "landscape"
            else (short, long)
        )
    usable_width = width - horizontal
    usable_height = height - vertical
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
        "fitted": fitted,
        "caption": caption,
        "factor": factor,
        "xmin": xmin,
        "ymin": ymin,
        "left": (width - draw_width) / 2,
        "bottom": extra if fitted else MARGIN_MM + FOOTER_MM + (usable_height - draw_height) / 2,
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


def _svg(cut, engrave, layout, label, texts):
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
        if name == "ENGRAVE":
            for x, y, text, size, align, layer in texts:
                if layer == name:
                    parts.append(_svg_text(x, height - y, text, size, align, color))
        parts.append("</g>")
    parts.extend([
        '<g id="LABELS_NO_CUT" data-layer="LABELS_NO_CUT">',
        *(_svg_text(x, height - y, text, size, align, "#25333b")
          for x, y, text, size, align, layer in texts if layer == "LABELS_NO_CUT"),
        "</g>",
        "</svg>",
    ])
    return "\n".join(parts)


def _svg_text(x, y, text, size, align, color):
    anchor = {"left": "start", "center": "middle", "right": "end"}[align]
    return (
        f'<text x="{x:.9f}" y="{y:.9f}" font-size="{size / CAP_HEIGHT_RATIO:.6f}" '
        f'text-anchor="{anchor}" font-family="Arial, sans-serif" '
        f'fill="{color}" stroke="none">{html.escape(text)}</text>'
    )


def _dxf(cut, engrave, texts):
    doc = ezdxf.new("R2010")
    doc.units = 4
    doc.header["$MEASUREMENT"] = 1
    lw = _lineweight(_style["line_width_mm"])
    doc.header["$LWDISPLAY"] = 1
    for name, key in (("CUT", "cut_color"), ("ENGRAVE", "engrave_color")):
        layer = doc.layers.new(name, dxfattribs={"lineweight": lw})
        layer.rgb = _rgb(_style[key])  # true colour, as the laser software expects
    doc.layers.new("LABELS_NO_CUT", dxfattribs={"color": 7})
    doc.styles.new("SiteLaser", dxfattribs={"font": "Arial.ttf"})
    model = doc.modelspace()
    for name, paths in (("CUT", cut), ("ENGRAVE", engrave)):
        for points in paths:
            closed = points[0] == points[-1]
            model.add_lwpolyline(
                points[:-1] if closed else points,
                close=closed,
                dxfattribs={"layer": name},
            )
    for x, y, text, size, align, layer in texts:
        anchor = TextEntityAlignment[align.upper()]
        model.add_text(text, dxfattribs={"layer": layer, "height": size, "style": "SiteLaser"}).set_placement(
            (x, y), align=anchor
        )
    stream = io.StringIO()
    doc.write(stream)
    return stream.getvalue()


def _save_sheet(output, name, thickness, cut, engrave, layout, label, numbers, checks=()):
    texts = list(numbers)
    if layout["caption"]:
        inset, baseline = (4, 4) if layout["fitted"] else (MARGIN_MM, 10)
        size = min(3.5, (layout["width"] - 2 * inset) / len(label))
        texts.insert(0, (layout["width"] - inset, baseline, label, size, "right", "LABELS_NO_CUT"))
    output[name + ".svg"] = _svg(cut, engrave, layout, label, texts)
    output[name + ".dxf"] = _dxf(cut, engrave, texts)
    _drawings.append({
        "name": name, "thickness_mm": thickness, "width": layout["width"],
        "height": layout["height"], "cut": cut, "engrave": engrave,
        "texts": texts, "cap_height_ratio": CAP_HEIGHT_RATIO, "placement_checks": list(checks),
    })


def _number_mark(polygon, text, layout, *, fit=False):
    """Keep the entire engraving inside the part, including around courtyards."""
    height = NUMBER_HEIGHT_MM / layout["factor"]
    center = polygon.representative_point()

    def fits(point, size):
        half_width = size * len(text) / 2
        half_height = size * .75
        return polygon.covers(box(point.x - half_width, point.y - half_height,
                                  point.x + half_width, point.y + half_height))

    if not fits(center, height):
        if not fit:
            return None
        # Find space in the proportions of the label, including in long,
        # thin footprints and in wings that surround a courtyard.
        origin = (polygon.bounds[0], polygon.bounds[1])
        normalized = scale(polygon, 1 / len(text), 1 / 1.5, origin=origin)
        pole = polylabel(normalized, tolerance=max(height / 32, 1e-4))
        center = scale(pole, len(text), 1.5, origin=origin)
        low, high = 0, height
        for _ in range(16):
            middle = (low + high) / 2
            if fits(center, middle):
                low = middle
            else:
                high = middle
        height = low
    size_mm = math.floor(height * layout["factor"] * 1000 + EPS) / 1000
    if size_mm <= 0:
        return None
    height = size_mm / layout["factor"]
    y = center.y - height / 2
    x_mm, y_mm = _mm([(center.x, y)], layout)[0]
    return (x_mm, y_mm, text, size_mm, "center", "ENGRAVE")


def _terrain_numbers(footprints, surfaces, layout):
    numbers = [[] for _ in surfaces]
    checks = [[] for _ in surfaces]
    surface_edges = [surface.boundary for surface in surfaces]
    for number, footprint in enumerate(footprints, 1):
        for index, surface in enumerate(surfaces):
            clipped = shapely.intersection(footprint, surface, grid_size=1e-4)
            # Exclude fragments with no building edge inside the visible
            # surface. A terrain cut or step alone isn't a building outline.
            visible = [
                part for part in shapely.get_parts(clipped)
                if part.geom_type == "Polygon" and not part.is_empty
                and shapely.difference(part.boundary, surface_edges[index], grid_size=1e-4).length > EPS
            ]
            if not visible:
                continue
            marks = [_number_mark(part, f"B{number}", layout, fit=True) for part in visible]
            mark = max((mark for mark in marks if mark), key=lambda item: item[3], default=None)
            if mark is None:
                checks[index].append(f"B{number}: 각인 윤곽이 너무 작아 번호를 넣을 수 없음")
                continue
            numbers[index].append(mark)
            if mark[3] < .6:
                checks[index].append(f"B{number}: 작은 번호 ({mark[3]:g} mm), 가공 크기 확인")
    return numbers, checks


def _exposed_engraving(paths, surface):
    """Clip marks to the exposed face, including the next plate's outline."""
    shapely.prepare(surface)
    for path in paths:
        line = LineString(path)
        if surface.covers(line):
            yield path
            continue
        clipped = shapely.intersection(line, surface, grid_size=1e-4)
        for piece in shapely.get_parts(clipped):
            if piece.geom_type == "LineString" and piece.length > EPS:
                yield list(piece.coords)


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
    terrain = []
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
            if extra.area > max(1e-6, geometry.length * 1e-4):  # snap slivers only
                raise ValueError("누적 판재의 포함 관계가 잘못되었습니다.")
        cut_mm = [_mm(path, layout) for path in cut]
        label = (
            f"L{index + 1:02d} | z={z:g} m | "
            f"1:{settings['scale']:g} | "
            f"t={settings['thickness_mm']:g} mm | print 100%"
        )
        terrain.append((z, geometry, cut_mm, engrave, label))
        previous_geometry = geometry
        previous_z = z

    buildings = project.get("buildings", [])
    plates = [sheet[1] for sheet in terrain]
    elevations = [sheet[0] for sheet in terrain]
    surfaces = [
        shapely.difference(lower, upper, grid_size=1e-4)
        for lower, upper in zip(plates, plates[1:])
    ] + [plates[-1]]
    footprints = [Polygon(b["polygon"], b.get("holes", [])) for b in buildings]
    numbers, checks = _terrain_numbers(footprints, surfaces, layout)
    for b_num, (b, footprint) in enumerate(zip(buildings, footprints), 1):
        base = b.get("base", elevations[0])
        seat = stack_seat(base, elevations)
        for upper_idx in range(seat + 1, len(plates)):
            if shapely.intersection(footprint, plates[upper_idx], grid_size=1e-4).area > 0:
                checks[seat].append(f"B{b_num}: 윗 지형판과 몸체가 겹침")
                break
    for index, (_, _, cut, engrave, label) in enumerate(terrain):
        engrave_mm = [_mm(path, layout) for path in _exposed_engraving(engrave, surfaces[index])]
        _save_sheet(output, f"plate_{index + 1:02d}", settings["thickness_mm"],
                    cut, engrave_mm, layout, label, numbers[index], checks[index])
    if settings["building_mode"] in {"laser", "laser_floor"}:
        output.update(_building_sheets(buildings, layout, settings))
    _support_sheets(output, buildings, footprints, plates, elevations, bounds, layout, settings)
    return output


def _support_sheets(output, buildings, footprints, plates, elevations, bounds, layout, settings):
    """Fill unoccupied slabs up to each building's seating height."""
    by_layer = {}
    for number, (b, footprint) in enumerate(zip(buildings, footprints), 1):
        base = b.get("base", elevations[0])
        seat = stack_seat(base, elevations)
        _, levels = building_support_plan(footprint, plates, seat=seat)
        for ordinal, support in enumerate(levels, 1):
            text = f"B{number}-{ordinal}" if len(levels) > 1 else f"B{number}"
            parts = polygons(even_odd(support["cut"]))
            by_layer.setdefault(support["layer"], []).extend((piece, text) for piece in parts)

    frame = box(*bounds).boundary
    thickness = settings["thickness_mm"]
    for index, parts in sorted(by_layer.items()):
        cut = [_mm(ring, layout) for piece, _ in parts for ring in rings(piece)]
        cut_edges = shapely.unary_union([piece.boundary for piece, _ in parts], grid_size=1e-4)
        guide = shapely.difference(frame, cut_edges, grid_size=1e-4)
        engrave = [_mm(path, layout) for path in paths(guide)]
        labels = []
        checks = []
        for piece, text in parts:
            mark = _number_mark(piece, text, layout, fit=True)
            if mark:
                labels.append(mark)
            if mark is None or mark[3] < .6:
                checks.append(f"{text}: 받침 번호를 새길 공간이 좁음")
        name = f"support_{index + 1:02d}"
        label = f"BUILDING SUPPORTS | L{index + 1:02d} | t={thickness:g} mm | 1:{settings['scale']:g}"
        _save_sheet(output, name, thickness, cut, engrave, layout, label, labels, checks)


def _building_sheets(buildings, layout, settings):
    """Laser sheets for buildings: building i gets ceil(h_model / t) layers.

    Sheet k holds the footprint of every building taller than k layers, in
    site position. Numbers go on covered layers, so roof faces stay clean.
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
            if k < n - 1:
                mark = _number_mark(Polygon(b["polygon"], b.get("holes", [])), f"B{number_}", layout)
                if mark:
                    labels.append(mark)
        label = (
            f"BUILDINGS {'FLOOR' if per_floor else 'L'}{k + 1:02d} | 1:{scale:g} | t={t:g} mm | "
            "glue on terrain | print 100%"
        )
        _save_sheet(out, f"building_{k + 1:02d}", t, cut, [], layout, label, labels)
    return out


def sheet_drawings():
    """Copy of the last render's sheet geometry (mm), in output order."""
    return [dict(d, style=dict(_style)) for d in _drawings]
