"""路由层共用查询工具."""

from __future__ import annotations

from fastapi import HTTPException

from ..domain.catalog import DEFAULT_LOD, LODS
from ..services import lightweight as lw


def ensure_lod(lod: int) -> int:
    return lod if lod in LODS else DEFAULT_LOD


def parse_bbox(raw: str | None) -> tuple[float, float, float, float] | None:
    if not raw:
        return None
    try:
        parts = [float(v) for v in raw.split(",")]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="bbox 需为 minLon,minLat,maxLon,maxLat") from exc
    if len(parts) != 4:
        raise HTTPException(status_code=400, detail="bbox 需为 minLon,minLat,maxLon,maxLat")
    return parts[0], parts[1], parts[2], parts[3]


def filter_bbox(features: list[dict], bbox: tuple[float, float, float, float] | None) -> list[dict]:
    """视口筛选: 要素外包框与视口相交即保留 (语义与 PostGIS 的 && 一致)."""
    if not bbox:
        return features
    return [f for f in features if lw.bbox_intersects(f.get("geometry") or {}, bbox)]
