"""Pure geometry and terrain slicing for CPython and Pyodide.

No repair-by-buffer, smoothing, hull construction, or no-data filling.
Geometry that cannot be interpreted safely raises ValueError.
"""

from __future__ import annotations

import math
from collections import defaultdict, deque

import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import nearest_points, polygonize, snap, unary_union


EPS = 1e-8
CONTOUR_TOLERANCE = 0.001
MAX_LAYERS = 512
MAX_TRIANGLES = 40000
MAX_SLICE_WORK = 4000000


def number(value, name):
    if isinstance(value, bool):
        raise ValueError(f"{name}: 유한한 숫자가 필요합니다.")
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name}: 유한한 숫자가 필요합니다.") from exc
    if not math.isfinite(result):
        raise ValueError(f"{name}: 유한한 숫자가 필요합니다.")
    return result


def integer(value, name, minimum=0):
    result = number(value, name)
    if not result.is_integer() or result < minimum:
        raise ValueError(f"{name}: {minimum} 이상의 정수가 필요합니다.")
    return int(result)


def polygons(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    if hasattr(geometry, "geoms"):
        return [
            polygon
            for child in geometry.geoms
            for polygon in polygons(child)
        ]
    return []


def lines(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type in {"LineString", "LinearRing"}:
        return [LineString(geometry.coords)]
    if hasattr(geometry, "geoms"):
        return [line for child in geometry.geoms for line in lines(child)]
    return []


def _coordinates(sequence):
    result = [[float(x), float(y)] for x, y in sequence]
    if result and result[0] == result[-1]:
        body = result[:-1]
        start = min(range(len(body)), key=lambda i: (body[i][0], body[i][1]))
        body = body[start:] + body[:start]
        return body + [body[0][:]]
    return result


def rings(geometry):
    result = []
    for polygon in sorted(polygons(geometry), key=lambda p: (*p.bounds, -p.area)):
        polygon = orient(polygon, sign=1.0)
        result.append(_coordinates(polygon.exterior.coords))
        for hole in sorted(polygon.interiors, key=lambda r: r.bounds):
            result.append(_coordinates(hole.coords))
    return result


def paths(geometry):
    return [
        _coordinates(line.coords)
        for line in sorted(lines(geometry), key=lambda line: line.bounds)
        if line.length > EPS
    ]


def valid_polygon(shell, holes=()):
    try:
        polygon = Polygon(shell, holes)
    except (TypeError, ValueError) as exc:
        raise ValueError("유효한 다각형 좌표가 필요합니다.") from exc
    if (
        polygon.is_empty
        or not polygon.is_valid
        or polygon.area <= EPS * EPS
        or not all(math.isfinite(v) for v in polygon.bounds)
    ):
        raise ValueError("자기 교차·퇴화·잘못된 구멍을 가진 다각형입니다.")
    return polygon


def even_odd(ring_list):
    """Recover polygons and holes from the contract's flat ring list."""
    if not ring_list:
        raise ValueError("절단 링이 없습니다.")
    pieces = []
    for ring in ring_list:
        if len(ring) < 4 or ring[0] != ring[-1]:
            raise ValueError("절단 링은 닫혀 있어야 합니다.")
        # Snap to a 0.1 mm grid up front so every later overlay sees
        # consistent coordinates (near-collinear DEM contour points crash
        # Pyodide's GEOS with an uncatchable TopologyException).
        # Round in Python (not GEOS set_precision, which itself runs an
        # overlay and can hit the same fatal exception), drop repeats.
        snapped = []
        for x, y, *_ in ring:
            pt = (round(x / 1e-4) * 1e-4, round(y / 1e-4) * 1e-4)
            if not snapped or snapped[-1] != pt:
                snapped.append(pt)
        if len(snapped) < 4:
            continue
        piece = Polygon(snapped)
        if not piece.is_valid:
            piece = shapely.make_valid(piece)
            polys = [g for g in getattr(piece, "geoms", [piece]) if g.geom_type == "Polygon"]
            if len(polys) != 1:
                continue
            piece = polys[0]
        if piece.is_empty or piece.area <= EPS * EPS:
            continue
        pieces.append(piece)
    if not pieces:
        raise ValueError("유효한 절단 링이 없습니다.")
    for i, a in enumerate(pieces):
        for b in pieces[:i]:
            if a.equals(b):
                raise ValueError("중복 절단 링입니다.")
            touch = shapely.intersection(a.boundary, b.boundary, grid_size=1e-4)
            # Contours from real DEMs can meet the site edge at a single
            # vertex; that is fine. Shared segments or crossings are not.
            if not touch.is_empty and touch.geom_type not in ("Point", "MultiPoint"):
                raise ValueError("절단 링끼리 접하거나 교차합니다.")
    # Snap-rounded overlay (grid 0.1 mm real) is robust when rings touch at a
    # vertex. Pyodide's GEOS otherwise throws a fatal TopologyException that
    # kills the worker instead of raising a Python error.
    result = Polygon()
    for piece in pieces:
        result = shapely.symmetric_difference(result, piece, grid_size=1e-4)
    if not result.is_valid:
        result = shapely.make_valid(result)
    if result.is_empty or not result.is_valid:
        raise ValueError("유효하지 않은 절단 링 구성입니다.")
    return result


def _triangle(vertices):
    if len(vertices) != 3:
        raise ValueError("삼각형에 꼭짓점 세 개가 필요합니다.")
    triangle = tuple(
        tuple(number(value, "메시 좌표") for value in vertex)
        for vertex in vertices
    )
    if any(len(vertex) != 3 for vertex in triangle):
        raise ValueError("메시 꼭짓점은 [x, y, z]여야 합니다.")
    footprint = Polygon([p[:2] for p in triangle])
    if not footprint.is_valid or footprint.area <= EPS * EPS:
        raise ValueError("수직이거나 XY 면적이 없는 지형 삼각형입니다.")
    return triangle


def grid_surface(dem):
    nx = integer(dem.get("nx"), "nx", 2)
    ny = integer(dem.get("ny"), "ny", 2)
    if 2 * (nx - 1) * (ny - 1) > MAX_TRIANGLES:
        raise ValueError("DEM 격자가 너무 큽니다. 해상도를 낮춰 주세요.")
    x0 = number(dem.get("x0"), "x0")
    y0 = number(dem.get("y0"), "y0")
    dx = number(dem.get("dx"), "dx")
    if dx <= 0:
        raise ValueError("dx는 양수여야 합니다.")
    values = dem.get("z")
    if not isinstance(values, (list, tuple)):
        raise ValueError("DEM z는 배열이어야 합니다.")
    if values and isinstance(values[0], (list, tuple)):
        if len(values) != ny or any(len(row) != nx for row in values):
            raise ValueError("DEM 행·열 크기가 nx/ny와 다릅니다.")
        values = [value for row in values for value in row]
    if len(values) != nx * ny:
        raise ValueError("DEM 표본 수가 nx * ny와 다릅니다.")
    z = [number(value, "DEM 고도") for value in values]

    def vertex(i, j):
        return (x0 + i * dx, y0 + j * dx, z[j * nx + i])

    triangles = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = vertex(i, j)
            b = vertex(i + 1, j)
            c = vertex(i + 1, j + 1)
            d = vertex(i, j + 1)
            triangles.append(_triangle((a, b, c)))
            triangles.append(_triangle((a, c, d)))
    return triangles


def mesh_surface(meshes, factor):
    triangles = []
    for mesh in meshes:
        vertices = []
        for point in mesh.get("vertices", []):
            if len(point) != 3:
                raise ValueError("메시 꼭짓점은 [x, y, z]여야 합니다.")
            vertices.append(tuple(number(v, "메시 좌표") * factor for v in point))
        for face in mesh.get("faces", []):
            if len(face) not in (3, 4):
                raise ValueError("메시 면은 삼각형 또는 사각형이어야 합니다.")
            indices = [integer(i, "메시 인덱스") for i in face]
            # Rhino encodes a triangle as a quad whose last two indices match.
            if len(indices) == 4 and indices[2] == indices[3]:
                indices.pop()
            if any(i >= len(vertices) for i in indices):
                raise ValueError("메시 면 인덱스가 꼭짓점 범위를 벗어납니다.")
            if len(set(indices)) != len(indices):
                raise ValueError("메시 면에 중복 꼭짓점이 있습니다.")
            parts = [indices[:3]]
            if len(indices) == 4:
                quad = Polygon([vertices[i][:2] for i in indices])
                if not quad.is_valid or quad.area <= EPS * EPS:
                    raise ValueError("사각 메시 면의 XY 투영이 유효하지 않습니다.")
                parts.append([indices[0], indices[2], indices[3]])
                projected = [
                    Polygon([vertices[i][:2] for i in part]) for part in parts
                ]
                if abs(sum(p.area for p in projected) - quad.area) > max(
                    EPS * EPS, quad.area * 1e-10
                ):
                    raise ValueError("사각 면의 0–2 대각선이 면 밖으로 나갑니다.")
            for part in parts:
                triangles.append(_triangle([vertices[i] for i in part]))
                if len(triangles) > MAX_TRIANGLES:
                    raise ValueError("메시가 너무 큽니다. 면 수를 줄여 주세요.")
    if not triangles:
        raise ValueError("지형 메시 면이 없습니다.")

    footprints = [Polygon([v[:2] for v in t]) for t in triangles]
    footprint = unary_union(footprints)
    total_area = sum(p.area for p in footprints)
    if total_area - footprint.area > max(EPS * EPS, total_area * 1e-10):
        raise ValueError("XY에서 겹치는 메시 면이 있어 단일 지형으로 볼 수 없습니다.")

    # Shared vertices must agree in elevation.
    elevations = {}
    for triangle in triangles:
        for x, y, z in triangle:
            previous = elevations.setdefault((x, y), z)
            if abs(previous - z) > EPS:
                raise ValueError("같은 XY 꼭짓점에 서로 다른 고도가 있습니다.")
    return triangles


def sample_surface(triangles, x, y):
    point = Point(x, y)
    candidates = []
    for a, b, c in triangles:
        footprint = Polygon([a[:2], b[:2], c[:2]])
        if not footprint.covers(point):
            continue
        denominator = (
            (b[1] - c[1]) * (a[0] - c[0])
            + (c[0] - b[0]) * (a[1] - c[1])
        )
        u = (
            (b[1] - c[1]) * (x - c[0])
            + (c[0] - b[0]) * (y - c[1])
        ) / denominator
        v = (
            (c[1] - a[1]) * (x - c[0])
            + (a[0] - c[0]) * (y - c[1])
        ) / denominator
        candidates.append(u * a[2] + v * b[2] + (1 - u - v) * c[2])
    if not candidates:
        raise ValueError("건물 기준점이 지형 표본 범위 밖입니다.")
    if max(candidates) - min(candidates) > EPS:
        raise ValueError("접합부의 메시 고도가 일치하지 않습니다.")
    return sum(candidates) / len(candidates)


def _above(triangle, level):
    """Clip one linearly interpolated triangle to z >= level."""
    output = []
    for a, b in zip(triangle, triangle[1:] + triangle[:1]):
        inside_a = a[2] >= level
        inside_b = b[2] >= level
        if inside_a:
            output.append(a[:2])
        if inside_a != inside_b:
            # Order the edge canonically so adjacent faces calculate the
            # identical intersection in the same floating-point direction.
            p, q = sorted((a, b))
            t = (level - p[2]) / (q[2] - p[2])
            output.append((
                p[0] + t * (q[0] - p[0]),
                p[1] + t * (q[1] - p[1]),
            ))
    if len(set(output)) < 3:
        return None
    polygon = Polygon(output)
    if polygon.area <= EPS * EPS:
        return None
    if not polygon.is_valid:
        raise ValueError("삼각형 절단 결과가 유효하지 않습니다.")
    return polygon


def _levels(zmin, zmax, interval):
    if interval <= 0 or not math.isfinite(interval):
        raise ValueError("등고 간격은 유한한 양수여야 합니다.")
    span = (zmax - zmin) / interval
    if not math.isfinite(span) or span >= MAX_LAYERS:
        raise ValueError(f"판재 수가 {MAX_LAYERS}장을 초과합니다.")
    count = int(math.floor(span + 1e-10)) + 1
    if count > MAX_LAYERS:
        raise ValueError(f"판재 수가 {MAX_LAYERS}장을 초과합니다.")
    return [zmin + i * interval for i in range(count)]


def surface_layers(triangles, interval):
    if not triangles:
        raise ValueError("지형 삼각형이 없습니다.")
    zmin = min(v[2] for triangle in triangles for v in triangle)
    zmax = max(v[2] for triangle in triangles for v in triangle)
    levels = _levels(zmin, zmax, interval)
    if len(triangles) * len(levels) > MAX_SLICE_WORK:
        raise ValueError("절단 연산량이 큽니다. 격자 해상도나 판재 수를 줄여 주세요.")
    bounds = [
        (min(v[2] for v in t), max(v[2] for v in t)) for t in triangles
    ]
    result = []
    for level in levels:
        pieces = []
        for triangle, (low, high) in zip(triangles, bounds):
            if high < level:
                continue
            polygon = (
                Polygon([v[:2] for v in triangle])
                if low >= level else _above(triangle, level)
            )
            if polygon is not None:
                pieces.append(polygon)
        if not pieces:
            # A peak that reduces to a point has no physical cutting area.
            continue
        geometry = unary_union(pieces)
        if not geometry.is_valid:
            raise ValueError("지형 절단 결과의 위상이 유효하지 않습니다.")
        result.append((level, geometry))
    return result


def _horizontal(feature):
    values = [point[2] for point in feature["points"]]
    if max(values) - min(values) > CONTOUR_TOLERANCE:
        raise ValueError(f'{feature["id"]}: 등고선의 Z가 일정하지 않습니다.')
    return sum(values) / len(values)


def _distances(adjacency, root):
    result = {root: 0}
    queue = deque([root])
    while queue:
        current = queue.popleft()
        for neighbor in sorted(adjacency[current]):
            if neighbor not in result:
                result[neighbor] = result[current] + 1
                queue.append(neighbor)
    return result


def _topology_layers(boundary, contours, selection, interval, z0):
    """Port TerrainLaser's cell adjacency and same-level grouping."""
    tolerance = CONTOUR_TOLERANCE
    clipped = {}
    aliases = {}
    for feature in contours:
        ident = feature["id"]
        coordinates = list(feature["line"].coords)
        for index in (0, -1):
            point = Point(coordinates[index])
            if point.distance(boundary.boundary) <= tolerance:
                coordinates[index] = nearest_points(
                    point, boundary.boundary
                )[1].coords[0]
        line = LineString(coordinates).intersection(boundary)
        if line.is_empty or line.length <= tolerance:
            raise ValueError(f"{ident}: 외곽 내부에 유효한 등고선이 없습니다.")
        duplicate = next(
            (key for key, existing in clipped.items() if line.equals(existing)),
            None,
        )
        if duplicate is not None:
            aliases[ident] = duplicate
        else:
            clipped[ident] = line

    entries = list(clipped.items())
    for i, (aid, a) in enumerate(entries):
        for bid, b in entries[:i]:
            if a.crosses(b) or a.intersection(b).length > tolerance:
                raise ValueError(f"교차하거나 부분 중복하는 등고선: {aid}, {bid}")

    if not clipped:
        return [(z0, boundary)]

    perimeter = snap(boundary.boundary, unary_union(list(clipped.values())), tolerance)
    boundary = valid_polygon(perimeter.coords)
    network = unary_union([perimeter, *clipped.values()])
    cells = [
        p for p in polygonize(network)
        if boundary.covers(p.representative_point())
        and p.area > tolerance * tolerance
    ]
    cells.sort(key=lambda p: (p.centroid.x, p.centroid.y))
    if abs(sum(p.area for p in cells) - boundary.area) > max(
        tolerance * boundary.length, boundary.area * 1e-7
    ):
        raise ValueError("분할 면적이 외곽 면적과 일치하지 않습니다.")
    if len(cells) < 2:
        raise ValueError("등고선이 영역을 분할하지 못합니다.")

    adjacency = defaultdict(set)
    edge_cells = defaultdict(list)
    buffers = {ident: line.buffer(tolerance / 10) for ident, line in entries}
    for i, a in enumerate(cells):
        for j, b in enumerate(cells[:i]):
            shared = a.boundary.intersection(b.boundary)
            if shared.length <= tolerance:
                continue
            sources = [
                ident for ident, buffer in buffers.items()
                if shared.intersection(buffer).length > tolerance
            ]
            if not sources:
                raise ValueError("출처가 없는 분할 경계입니다.")
            adjacency[i].add(j)
            adjacency[j].add(i)
            for ident in sources:
                edge_cells[ident].append((i, j))
    unused = set(clipped) - edge_cells.keys()
    if unused:
        raise ValueError(f"영역을 분할하지 못한 등고선: {sorted(unused)}")

    def resolve(ident):
        return aliases.get(ident, ident)

    if "lowest_point" in selection:
        seed = Point(selection["lowest_point"])
        possible = [i for i, p in enumerate(cells) if p.contains(seed)]
    else:
        lowids = [resolve(v) for v in selection.get("lowest_ids", [])]
        if not lowids:
            raise ValueError(
                "2D 등고선에는 selection.lowest_point 또는 lowest_ids가 필요합니다."
            )
        if set(lowids) - edge_cells.keys():
            raise ValueError("최저 기준선 ID가 등고선 목록에 없습니다.")
        sets = [
            {i for pair in edge_cells[ident] for i in pair} for ident in lowids
        ]
        possible = sorted(set.intersection(*sets))
    if len(possible) != 1:
        raise ValueError("최저 영역을 하나로 결정할 수 없습니다.")
    low = possible[0]
    initial = _distances(adjacency, low)
    if len(initial) != len(cells):
        raise ValueError("연결되지 않은 지형 영역이 있습니다.")

    parent = list(range(len(cells)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def merge(a, b):
        parent[find(a)] = find(b)

    for group in selection.get("same_level_groups", []):
        group = list(dict.fromkeys(resolve(v) for v in group))
        if len(group) < 2 or any(v not in edge_cells for v in group):
            raise ValueError("같은 높이 묶음에는 유효한 등고선 두 개 이상이 필요합니다.")
        subgraph = defaultdict(set)
        for ident in group:
            for a, b in edge_cells[ident]:
                subgraph[a].add(b)
                subgraph[b].add(a)
        visited = set()
        anchors = None
        orientation = None
        while len(visited) < len(subgraph):
            start = min(set(subgraph) - visited)
            colors = {start: 0}
            queue = deque([start])
            while queue:
                a = queue.popleft()
                for b in sorted(subgraph[a]):
                    if b in colors:
                        if colors[b] == colors[a]:
                            raise ValueError("같은 높이 묶음에 모순이 있습니다.")
                    else:
                        colors[b] = 1 - colors[a]
                        queue.append(b)
            sides = [
                [i for i, color in colors.items() if color == value]
                for value in (0, 1)
            ]
            values = [
                sum(initial[i] for i in side) / len(side) for side in sides
            ]
            if anchors is None:
                anchors = [sides[0][0], sides[1][0]]
                orientation = values
            else:
                if values[0] == values[1] or orientation[0] == orientation[1]:
                    raise ValueError("분리된 같은 높이 묶음의 방향이 불명확합니다.")
                if (values[0] < values[1]) != (orientation[0] < orientation[1]):
                    sides.reverse()
            for value in (0, 1):
                for i in sides[value]:
                    merge(i, anchors[value])
            visited.update(colors)

    quotient = defaultdict(set)
    for a, neighbors in adjacency.items():
        for b in neighbors:
            x, y = find(a), find(b)
            if x == y:
                raise ValueError("같은 높이 묶음이 등고선 양쪽을 합칩니다.")
            quotient[x].add(y)
    heights = _distances(quotient, find(low))
    levels = [heights[find(i)] for i in range(len(cells))]
    for pairs in edge_cells.values():
        if any(abs(levels[a] - levels[b]) != 1 for a, b in pairs):
            raise ValueError("등고선 양쪽의 높이 순서가 모순됩니다.")
    for ident, step in selection.get("contour_steps", {}).items():
        ident = resolve(ident)
        if (
            ident not in edge_cells
            or isinstance(step, bool)
            or not isinstance(step, int)
            or step < 1
        ):
            raise ValueError("contour_steps에는 등고선 ID와 양의 정수가 필요합니다.")
        if any(
            sorted((levels[a], levels[b])) != [step - 1, step]
            for a, b in edge_cells[ident]
        ):
            raise ValueError(f"{ident}: 지정한 층 번호와 계산 순서가 다릅니다.")

    if max(levels) + 1 > MAX_LAYERS:
        raise ValueError("판재 수가 제한을 초과합니다.")
    return [
        (
            z0 + step * interval,
            shapely.unary_union([p for p, level in zip(cells, levels) if level >= step], grid_size=1e-4),
        )
        for step in range(max(levels) + 1)
    ]


def curve_layers(boundary_feature, contours, selection, interval):
    line = boundary_feature["line"]
    if not line.is_ring:
        raise ValueError("외곽선은 자기 교차 없는 폐곡선이어야 합니다.")
    boundary = valid_polygon(line.coords)
    z0 = _horizontal(boundary_feature)
    elevations = [_horizontal(c) for c in contours]
    topology_keys = {
        "lowest_point", "lowest_ids", "same_level_groups", "contour_steps"
    }
    has_topology = bool(topology_keys & selection.keys())
    flat = all(abs(z - z0) <= CONTOUR_TOLERANCE for z in elevations)

    if not contours:
        if has_topology:
            raise ValueError("등고선 없이 위상 선택을 지정했습니다.")
        return [(z0, boundary)]
    if flat:
        return _topology_layers(boundary, contours, selection, interval, z0)
    if has_topology:
        raise ValueError("Z 등고선과 2D 위상 순서 지정을 혼용할 수 없습니다.")
    if any(z <= z0 + CONTOUR_TOLERANCE for z in elevations):
        raise ValueError("고도 등고선은 외곽선보다 높아야 합니다.")

    # Elevated closed contours explicitly describe uphill stepped regions.
    # An open contour or depression requires the topology/surface route.
    groups = []
    for z, feature in sorted(
        zip(elevations, contours), key=lambda item: (item[0], item[1]["id"])
    ):
        if not feature["line"].is_ring:
            raise ValueError("고도 기반 모드의 등고선은 폐곡선이어야 합니다.")
        polygon = valid_polygon(feature["line"].coords)
        if not boundary.covers(polygon):
            raise ValueError("고도 등고선이 외곽선 밖으로 벗어납니다.")
        if groups and abs(z - groups[-1][0]) <= CONTOUR_TOLERANCE:
            groups[-1][1].append(polygon)
        else:
            groups.append([z, [polygon]])

    sources = [(z0, boundary)]
    for z, pieces in groups:
        for i, a in enumerate(pieces):
            for b in pieces[:i]:
                if a.intersects(b):
                    raise ValueError("같은 고도의 폐곡선이 겹치거나 접합니다.")
        region = unary_union(pieces)
        if not sources[-1][1].covers(region):
            raise ValueError(
                "고도가 높아질수록 영역이 포함되지 않습니다. "
                "골짜기·복합 지형은 메시 또는 2D 위상 모드로 입력해 주세요."
            )
        sources.append((z, region))

    result = []
    source_index = 0
    for level in _levels(z0, sources[-1][0], interval):
        while (
            source_index + 1 < len(sources)
            and sources[source_index + 1][0] <= level + EPS
        ):
            source_index += 1
        result.append((level, sources[source_index][1]))
    return result
