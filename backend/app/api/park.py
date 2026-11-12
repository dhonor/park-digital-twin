"""园区元数据 / 图层 / 轻量化体检接口."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from ..config import settings
from ..domain.catalog import DEFAULT_LOD, LAYERS, LODS
from ..services import lightweight as lw
from ._query import ensure_lod, parse_bbox

router = APIRouter(tags=["park"])


@router.get("/park", summary="园区元数据")
async def get_park(request: Request) -> dict[str, Any]:
    park = await request.app.state.repo.park()
    return {
        **park,
        "backend": request.app.state.repo.kind,
        "capabilities": {
            "layer_lod": [LODS[k]["key"] for k in sorted(LODS)],
            "vector_tiles": False,
            "ogc_services": bool(settings.geoserver_url),
            "realtime_transport": "websocket",
        },
    }


@router.get("/tileset", summary="三维外壳瓦片元数据")
async def get_tileset() -> dict[str, Any]:
    """返回 3D Tiles 外壳的可用性与来源.

    前端据此决定「三维模型 / 矢量体块」两种表现, 拿不到就自动退回矢量体块.
    """
    index = settings.tileset_dir / "tileset.json"
    if not index.exists():
        return {
            "available": False,
            "url": None,
            "note": "未找到三维瓦片, 使用矢量体块渲染",
            "swap": "把 3D Tiles 产物放进 data/tileset/, 或设置 TILESET_DIR",
        }

    asset: dict[str, Any] = {}
    tiles = 0
    try:
        doc = json.loads(index.read_text(encoding="utf-8"))
        asset = doc.get("asset", {})
        tiles = 1 + len(doc.get("root", {}).get("children", []))
    except (OSError, ValueError):
        pass

    extras = asset.get("extras", {}) or {}
    return {
        "available": True,
        "url": "/tiles/tileset.json",
        "format": f"3D Tiles {asset.get('version', '1.1')} · glb",
        "tile_count": tiles,
        "up_axis": extras.get("gltfUpAxis", "Y"),
        "source": extras.get("source", "unknown"),
        "generator": asset.get("generator"),
        "note": extras.get("note", ""),
        "swap": "把倾斜摄影切片产物按同样的目录结构放进 data/tileset/, 前端零改动",
    }


@router.get("/layers", summary="图层目录")
async def list_layers(request: Request) -> dict[str, Any]:
    """图层目录只与原始数据有关, 算一次缓存住.

    `source_bytes` 需要对每个图层做一次整层 json.dumps: 7 层 × 每次请求,
    PostGIS 下还等于每次把 7 层全量拉回来, 只为报一个字节数.
    """
    state = request.app.state
    if state.layer_catalog is None:
        state.layer_catalog = await _build_catalog(state.repo)
    return state.layer_catalog


async def _build_catalog(repo) -> dict[str, Any]:
    items = []
    for key, defn in LAYERS.items():
        fc = await repo.layer(key)
        items.append(
            {
                "key": key,
                "name": defn.name,
                "name_en": defn.name_en,
                "geometry": defn.geometry,
                "default_visible": defn.default_visible,
                "note": defn.note,
                "feature_count": len(fc.get("features", [])),
                "source_bytes": lw.encoded_size(fc),
                "attributes": {str(lod): list(defn.attrs(lod)) for lod in sorted(LODS)},
            }
        )
    return {
        "default_lod": settings.default_lod,
        "lods": [{"lod": lod, **meta} for lod, meta in sorted(LODS.items())],
        "layers": items,
    }


@router.get("/layers/{key}", summary="按 LOD 拉取轻量化图层")
async def get_layer(
    request: Request,
    key: str,
    lod: int = Query(DEFAULT_LOD, ge=0, le=2, description="0 概览 / 1 标准 / 2 精细"),
    bbox: str | None = Query(None, description="minLon,minLat,maxLon,maxLat"),
    limit: int | None = Query(None, ge=1, le=5000),
) -> dict[str, Any]:
    if key not in LAYERS:
        raise HTTPException(status_code=404, detail=f"未知图层 {key}")
    lod = ensure_lod(lod)
    box = parse_bbox(bbox)
    cache_key = f"layer:{key}:{lod}:{bbox}:{limit}"
    layer_cache = request.app.state.cache
    if key != "devices":  # 设备层有实时值, 不缓存
        cached = await layer_cache.get(cache_key)
        if cached is not None:
            return cached

    repo = request.app.state.repo
    # 视口筛选下推到仓库: PostGIS 走 GIST 索引, 内存实现退化成本地过滤, 行为一致
    fc = await repo.layer(key, bbox=box)
    features = list(fc.get("features", []))
    if key == "devices":
        # 设备图层必须叠实时状态: 否则首屏点位颜色(文件里的旧状态)与顶部 KPI(实时)对不上
        features = request.app.state.telemetry.merge(features)
    if limit:
        features = features[:limit]
    narrowed = {"type": "FeatureCollection", "name": key, "features": features}
    lightened, stats = lw.lighten(narrowed, key, lod)
    lightened["_lightweight"] = stats
    lightened["_meta"] = {
        "layer": key,
        "lod": lod,
        "bbox": list(box) if box else None,
        "cached": False,
        "source": repo.kind,
    }
    if key != "devices":
        await layer_cache.set(cache_key, lightened)
    return lightened


@router.get("/lightweight/report", summary="数据轻量化体检报告")
async def lightweight_report(request: Request, lod: int | None = Query(None, ge=0, le=2)) -> dict[str, Any]:
    """全图层抽稀 + 序列化 + gzip 是纯 CPU 的重计算, 按 LOD 算一次缓存住.

    直接在 `async def` 里跑会阻塞事件循环: 7 层 × 3 LOD 的 DP 抽稀与 gzip 期间,
    WS 推送与心跳都停摆, 多终端同时打开驾驶舱时会明显"卡一下".
    因此放进线程池, 并把结果留在 app.state 供后续请求复用 (原始数据只读).
    """
    state = request.app.state
    targets = [lod] if lod is not None else sorted(LODS)
    cached: dict[int, dict[str, Any]] = state.lightweight_reports
    if any(one not in cached for one in targets):
        async with state.lightweight_lock:
            missing = [one for one in targets if one not in cached]
            if missing:
                raw = await repo_raw(state.repo)
                cached.update(await asyncio.to_thread(_reports_sync, raw, missing))
    return {
        "policy": {
            "principle": "数据轻量化优先于渲染优化",
            "stages": [
                "几何抽稀 (Douglas-Peucker)",
                "坐标量化 (按 LOD 保留小数位)",
                "属性白名单裁剪",
                "按视口 bbox 增量拉取",
            ],
            "note": "同一份数据不做多套模型: 用 LOD 描述视图精度, 而不是用更多模型描述同一物体",
        },
        "lods": [cached[one] for one in targets],
    }


def _reports_sync(raw: dict[str, dict], lods: list[int]) -> dict[int, dict[str, Any]]:
    """线程池里执行: 一次拿到的原始数据可被多个 LOD 复用, 不重复读仓库."""
    return {one: lw.report(raw, one) for one in lods}


async def repo_raw(repo) -> dict[str, dict]:
    return await repo.raw_layers()
