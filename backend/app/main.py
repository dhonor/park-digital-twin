"""园区级数字孪生底座 API.

架构要点 (见 docs/01-架构决策.md):
  1. 引擎按场景选: 园区级 -> CesiumJS, 不强上 Three.js 自建地球
  2. 数据轻量化优先: 所有图层走 LOD 管线, 响应自带压缩指标
  3. 后端开源栈起步: 内存仓库可直接跑, 配 DATABASE_URL 即切 PostGIS
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.router import router as api_router
from .config import settings
from .repository.memory import MemoryRepository
from .services.alarms import AlarmService
from .services.cache import build_cache
from .services.overview import OverviewService
from .services.telemetry import TelemetryService

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s | %(message)s"
)
log = logging.getLogger("park")


async def _build_repository():
    if settings.database_url:
        from .repository.postgis import PostGISRepository

        repo = PostGISRepository(settings.database_url)
        await repo.connect()
        log.info("仓库: PostGIS")
        return repo
    log.info("仓库: 内存 (data/*.geojson), 配置 DATABASE_URL 可切换 PostGIS")
    return MemoryRepository()


@asynccontextmanager
async def lifespan(app: FastAPI):
    repo = await _build_repository()

    # Redis 总线是可选的: 配了才能多副本, 没配就是单进程（行为与之前完全一致）
    bus = None
    if settings.redis_url:
        from .services.bus import RedisBus

        bus = RedisBus(settings.redis_url)
        await bus.connect()
    else:
        log.info("未配置 REDIS_URL, 运行在单进程模式（缓存/广播/状态都在进程内）")

    devices = await repo.layer("devices")
    lookup = {f["properties"]["id"]: f["properties"] for f in devices.get("features", [])}

    telemetry = TelemetryService(repo, settings.telemetry_interval, bus=bus)
    telemetry.bind_lookup(lookup)
    await telemetry.start()

    alarms = AlarmService(repo, telemetry)
    await alarms.load()

    app.state.repo = repo
    app.state.bus = bus
    app.state.cache = build_cache(settings.cache_ttl, bus)
    app.state.telemetry = telemetry
    app.state.alarms = alarms
    #: 设备静态属性索引: /api/devices/{id} 直查, 不再复制整层要素
    app.state.device_props = lookup
    #: 图层目录与轻量化体检报告都是「数据只读 + 计算昂贵」, 算一次缓存住
    app.state.layer_catalog = None
    app.state.lightweight_reports = {}
    app.state.lightweight_lock = asyncio.Lock()
    app.state.overview = OverviewService(repo, telemetry, alarms)
    await app.state.overview.start()
    log.info("服务就绪: %s", settings.app_name)
    try:
        yield
    finally:
        await app.state.overview.stop()
        await telemetry.stop()
        await repo.close()
        if bus is not None:
            await bus.close()


app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    description="园区级数字孪生: 轻量数据 + Cesium 场景 + 实时遥测",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins) or ["*"],
    # 本服务不用 Cookie/凭据; 而 allow_origins=["*"] 与 allow_credentials=True 是非法组合,
    # 浏览器会直接拒绝带凭据的请求, 这里显式关掉
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 传输压缩放在最外层: 前端产物里 Cesium 运行时未压缩 4.2MB, gzip 后约 1.1MB,
# 这是首屏最大的一笔单项收益; 接口里的图层 GeoJSON 同样受益。
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)


@app.middleware("http")
async def cache_policy(request: Request, call_next):
    """静态资源缓存策略.

    * `/assets/*` 文件名带构建哈希, 可以一年 immutable, 二次访问直接命中本地缓存;
    * `/tiles/*` 演示瓦片不带哈希, 给 1 小时, 换倾斜摄影成果后能自然刷新;
    * 入口 HTML 必须每次回源, 否则新版前端要等缓存过期才会被用户看到。
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path.startswith("/tiles/"):
        response.headers["Cache-Control"] = "public, max-age=3600"
    elif path in ("/", "/index.html"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.middleware("http")
async def no_store_api(request: Request, call_next):
    """接口响应禁止缓存.

    连续切 LOD / 快速点选时, 浏览器若回放上一份 JSON, 会出现「数据看着不对」且无法复现。
    轻量化缓存放在服务端 (services/cache.py), 不交给浏览器。
    """
    response = await call_next(request)
    if request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


app.include_router(api_router, prefix="/api")


@app.get("/api", include_in_schema=False)
async def api_root() -> JSONResponse:
    return JSONResponse(
        {
            "name": settings.app_name,
            "version": settings.version,
            "docs": "/docs",
            "backend": settings.backend_kind,
            "api": [
                "/api/park",
                "/api/layers",
                "/api/layers/{key}?lod=0|1|2",
                "/api/lightweight/report",
                "/api/buildings",
                "/api/buildings/{id}",
                "/api/devices",
                "/api/overview",
                "/api/energy/summary",
                "/api/alarms",
                "/api/ws/realtime",
            ],
        }
    )


# 三维瓦片单独挂载: 换倾斜摄影成果只替换目录内容, 前端与接口都不动
if settings.tileset_dir.exists():
    app.mount("/tiles", StaticFiles(directory=str(settings.tileset_dir)), name="tiles")
    log.info("已挂载三维瓦片: %s", settings.tileset_dir)

# 生产形态: 前端构建产物由后端一并托管, 单端口交付 (必须最后挂载, 它是 catch-all)
if settings.frontend_dist.exists():
    app.mount("/", StaticFiles(directory=str(settings.frontend_dist), html=True), name="web")
    log.info("已挂载前端构建产物: %s", settings.frontend_dist)
