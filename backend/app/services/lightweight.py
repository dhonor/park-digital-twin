"""数据轻量化管线.

三层轻量化手段, 均可在响应里量化:
  1. 几何: Douglas-Peucker 抽稀 + (LOD0) 包络框替代 (真实减面)
  2. 坐标: 按 LOD 做十进制量化 (直接减小 JSON 体积)
  3. 属性: 按 LOD 白名单裁剪 (GIS 数据里属性往往比几何还大)

所有函数纯 Python 实现, 不依赖 shapely/GEOS, 保证在任意机器可运行;
若后续接入 shapely, 只需替换 `_douglas_peucker` 的实现.
"""

from __future__ import annotations

import gzip
import json
import math
from typing import Any, Iterable

from ..domain.catalog import LAYERS, LayerDef, lod_meta

Feature = dict[str, Any]
Geometry = dict[str, Any]


# ------------------------------------------------------------------ 几何工具
def _seg_distance(pt: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    ax, ay = a
    bx, by = b
    px, py = pt
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _dp_keep(points: list[tuple[float, float]], tolerance: float) -> list[int]:
    """经典 DP 抽稀 (迭代实现), 返回保留下来的点下标."""
    count = len(points)
    if tolerance <= 0 or count < 3:
        return list(range(count))
    keep = [False] * count
    keep[0] = keep[-1] = True
    stack = [(0, count - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        worst, worst_idx = 0.0, -1
        for i in range(start + 1, end):
            dist = _seg_distance(points[i], points[start], points[end])
            if dist > worst:
                worst, worst_idx = dist, i
        if worst_idx > 0 and worst > tolerance:
            keep[worst_idx] = True
            stack.append((start, worst_idx))
            stack.append((worst_idx, end))
    return [i for i, flag in enumerate(keep) if flag]


def _douglas_peucker(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    return [points[i] for i in _dp_keep(points, tolerance)]


def _positions(geom: Geometry) -> list[list[float]]:
    """展平几何中的所有坐标点."""
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    out: list[list[float]] = []

    def walk(node: Any) -> None:
        if not node:
            return
        if isinstance(node[0], (int, float)):
            out.append(node)
            return
        for child in node:
            walk(child)

    if gtype == "GeometryCollection":
        for sub in geom.get("geometries", []):
            out.extend(_positions(sub))
    else:
        walk(coords)
    return out


def count_points(geom: Geometry) -> int:
    return len(_positions(geom))


def bbox_intersects(geom: Geometry, bbox: tuple[float, float, float, float]) -> bool:
    """要素外包框与视口是否相交.

    判定必须用外包框, 不能用「所有顶点坐标的均值」: 跨视口的长线要素
    (道路/管网)均值可能落在视口外, 整段被误删, 表现为画面上一段路突然消失.
    单次遍历同时求 min/max, 不做两轮.
    """
    pts = _positions(geom)
    if not pts:
        return False
    min_lon, min_lat, max_lon, max_lat = bbox
    lo_x = hi_x = float(pts[0][0])
    lo_y = hi_y = float(pts[0][1])
    for p in pts[1:]:
        x = float(p[0])
        y = float(p[1])
        if x < lo_x:
            lo_x = x
        elif x > hi_x:
            hi_x = x
        if y < lo_y:
            lo_y = y
        elif y > hi_y:
            hi_y = y
    return not (hi_x < min_lon or lo_x > max_lon or hi_y < min_lat or lo_y > max_lat)


def _simplify_line_string(coords: Iterable[list[float]], tolerance: float) -> list[list[float]]:
    """按「米」抽稀.

    关键点: 容差单位是米, 而坐标是经纬度。必须先把经度按纬度余弦压缩成近似
    等距平面, 再把米换算成度, 否则 1.5 会被当成 1.5 度 (≈166km), 楼栋会被压成一条线。
    返回值只保留 x/y —— 高程由渲染层的 height 统一控制, 省掉 1/3 的坐标体积。
    """
    pts = [(float(p[0]), float(p[1])) for p in coords]
    if len(pts) <= 2:
        return [[p[0], p[1]] for p in pts]
    lat0 = sum(p[1] for p in pts) / len(pts)
    lon_scale = math.cos(math.radians(lat0)) or 1.0
    scaled = [(p[0] * lon_scale, p[1]) for p in pts]
    tolerance_deg = tolerance / 111_320.0
    return [[pts[i][0], pts[i][1]] for i in _dp_keep(scaled, tolerance_deg)]


def _bbox_ring(coords: list[list[float]]) -> list[list[float]]:
    xs = [float(p[0]) for p in coords]
    ys = [float(p[1]) for p in coords]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    return [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]


def simplify_geometry(geom: Geometry, tolerance: float, bbox_only: bool = False) -> Geometry:
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype == "Point":
        return {"type": gtype, "coordinates": list(coords)}
    if gtype == "LineString":
        return {"type": gtype, "coordinates": _simplify_line_string(coords, tolerance)}
    if gtype == "Polygon":
        if bbox_only:
            return {"type": "Polygon", "coordinates": [_bbox_ring(coords[0])]}
        return {
            "type": gtype,
            "coordinates": [_simplify_line_string(ring, tolerance) for ring in coords],
        }
    if gtype == "MultiPolygon":
        if bbox_only:
            flat = [pt for poly in coords for pt in poly[0]]
            return {"type": "Polygon", "coordinates": [_bbox_ring(flat)]}
        return {
            "type": gtype,
            "coordinates": [
                [_simplify_line_string(ring, tolerance) for ring in poly] for poly in coords
            ],
        }
    if gtype == "MultiLineString":
        return {
            "type": gtype,
            "coordinates": [_simplify_line_string(line, tolerance) for line in coords],
        }
    return geom


def quantize_geometry(geom: Geometry, precision: int) -> Geometry:
    """坐标十进制量化: 5 位约 1.1m, 4 位约 11m, 7 位约 1cm."""
    step = 10**precision

    def rnd(node: Any) -> Any:
        if isinstance(node, list) and node and isinstance(node[0], (int, float)):
            vals = [round(float(v) * step) / step for v in node[:2]]
            if len(node) > 2:
                vals.append(round(float(node[2]), 2))
            return vals
        if isinstance(node, list):
            return [rnd(child) for child in node]
        return node

    out = {"type": geom.get("type"), "coordinates": rnd(geom.get("coordinates"))}
    if geom.get("type") == "GeometryCollection":
        out = {
            "type": "GeometryCollection",
            "geometries": [quantize_geometry(g, precision) for g in geom["geometries"]],
        }
    return out


# ------------------------------------------------------------------ 轻量化主流程
def encoded_size(obj: Any) -> int:
    return len(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def gzip_size(obj: Any) -> int:
    """线上真实传输量按 gzip 计; 属性裁剪和坐标量化同样改善压缩率."""
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return len(gzip.compress(raw, 6))


def _lighten_feature(feature: Feature, layer: LayerDef, lod: int) -> Feature:
    meta = lod_meta(lod)
    geom = simplify_geometry(
        feature.get("geometry") or {"type": "Point", "coordinates": []},
        float(meta["tolerance_m"]),
        bool(meta["bbox_only"]) and layer.geometry in ("Polygon", "MultiPolygon"),
    )
    geom = quantize_geometry(geom, int(meta["coord_precision"]))
    props = feature.get("properties") or {}
    keep = layer.attrs(lod)
    out_props = {k: props[k] for k in keep if k in props}
    out: Feature = {"type": "Feature", "geometry": geom, "properties": out_props}
    if feature.get("id") is not None:
        out["id"] = feature["id"]
    return out


def lighten(fc: dict[str, Any], layer_key: str, lod: int) -> tuple[dict[str, Any], dict[str, Any]]:
    """返回 (轻量化后的 FeatureCollection, 量化指标)."""
    layer = LAYERS[layer_key]
    features = fc.get("features") or []
    meta = lod_meta(lod)

    out_features: list[Feature] = []
    src_points = 0
    out_points = 0
    for feat in features:
        geom = feat.get("geometry") or {}
        src_points += count_points(geom)
        light = _lighten_feature(feat, layer, lod)
        out_points += count_points(light["geometry"])
        out_features.append(light)

    lightened = {
        "type": "FeatureCollection",
        "name": fc.get("name") or layer_key,
        "features": out_features,
    }
    src_bytes = encoded_size(fc)
    out_bytes = encoded_size(lightened)
    src_gzip = gzip_size(fc)
    out_gzip = gzip_size(lightened)
    stats = {
        "layer": layer_key,
        "layer_name": layer.name,
        "lod": lod,
        "lod_key": meta["key"],
        "lod_label": meta["label"],
        "viewport_hint": meta["viewport"],
        "tolerance_m": meta["tolerance_m"],
        "coord_precision": meta["coord_precision"],
        "bbox_only": meta["bbox_only"] and layer.geometry in ("Polygon", "MultiPolygon"),
        "features": len(out_features),
        "attributes_kept": list(layer.attrs(lod)),
        "points": {
            "source": src_points,
            "output": out_points,
            "reduction": round(1 - out_points / src_points, 4) if src_points else 0.0,
        },
        "bytes": {
            "source": src_bytes,
            "output": out_bytes,
            "reduction": round(1 - out_bytes / src_bytes, 4) if src_bytes else 0.0,
            "gzip_source": src_gzip,
            "gzip_output": out_gzip,
            "gzip_reduction": round(1 - out_gzip / src_gzip, 4) if src_gzip else 0.0,
            "encoding": "utf-8 json / gzip",
        },
        "pipeline": [
            "geometry: Douglas-Peucker",
            "coords: decimal quantization",
            "attrs: LOD whitelist",
        ],
    }
    return lightened, stats


def report(fc_by_layer: dict[str, dict], lod: int) -> dict[str, Any]:
    """全图层轻量化体检报告."""
    items = []
    total_src = total_out = 0
    total_src_gz = total_out_gz = 0
    total_src_pts = total_out_pts = 0
    for key, fc in fc_by_layer.items():
        _, stats = lighten(fc, key, lod)
        items.append(stats)
        total_src += stats["bytes"]["source"]
        total_out += stats["bytes"]["output"]
        total_src_gz += stats["bytes"]["gzip_source"]
        total_out_gz += stats["bytes"]["gzip_output"]
        total_src_pts += stats["points"]["source"]
        total_out_pts += stats["points"]["output"]
    return {
        "lod": lod,
        "lod_key": lod_meta(lod)["key"],
        "layers": items,
        "total": {
            "bytes_source": total_src,
            "bytes_output": total_out,
            "bytes_reduction": round(1 - total_out / total_src, 4) if total_src else 0.0,
            "gzip_source": total_src_gz,
            "gzip_output": total_out_gz,
            "gzip_reduction": round(1 - total_out_gz / total_src_gz, 4) if total_src_gz else 0.0,
            "points_source": total_src_pts,
            "points_output": total_out_pts,
            "points_reduction": round(1 - total_out_pts / total_src_pts, 4) if total_src_pts else 0.0,
        },
        "note": "指标为纯数据侧收益, 未计入首包体积; 渲染优化只在数据达标后才做",
    }
