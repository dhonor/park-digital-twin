"""运行配置.

默认零外部依赖启动 (内存仓库 + JSON 种子数据);
配置 DATABASE_URL 后自动切换到 PostGIS 仓库, 无需改代码.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv(path: Path) -> None:
    """极简 .env 解析, 避免为一个功能引入 python-dotenv."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(Path(__file__).resolve().parents[1] / ".env")


def _env_tuple(name: str, default: str) -> tuple[str, ...]:
    raw = os.getenv(name, default)
    return tuple(item.strip() for item in raw.split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    app_name: str = "园区级数字孪生底座 API"
    version: str = "0.1.0"
    data_dir: Path = Path(os.getenv("PARK_DATA_DIR", str(PROJECT_ROOT / "data")))
    # 空字符串 => 使用内存仓库 (内存仓库直接读 data/*.geojson)
    database_url: str = os.getenv("DATABASE_URL", "")
    geoserver_url: str = os.getenv("GEOSERVER_URL", "")
    cors_origins: tuple[str, ...] = _env_tuple(
        "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    )
    telemetry_interval: float = float(os.getenv("TELEMETRY_INTERVAL", "2.0"))
    cache_ttl: float = float(os.getenv("CACHE_TTL_SECONDS", "30"))
    # 空字符串 => 单进程（缓存/广播/设备状态都在进程内）; 配置后支持多副本
    redis_url: str = os.getenv("REDIS_URL", "")
    default_lod: int = int(os.getenv("DEFAULT_LOD", "1"))
    frontend_dist: Path = Path(
        os.getenv("FRONTEND_DIST", str(PROJECT_ROOT / "frontend" / "dist"))
    )
    # 三维瓦片目录 (3D Tiles): 默认读 data/tileset, 换成倾斜摄影产物时只改这里或 TILESET_DIR
    tileset_dir: Path = Path(os.getenv("TILESET_DIR", str(PROJECT_ROOT / "data" / "tileset")))

    @property
    def backend_kind(self) -> str:
        return "postgis" if self.database_url else "memory"


settings = Settings()
