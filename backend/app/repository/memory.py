"""内存仓库: 直接读取 data/*.geojson.

用于零依赖启动与演示; 与 PostGIS 仓库保持同一接口.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..domain.catalog import LAYERS
from ..config import settings
from ..services import lightweight


class MemoryRepository:
    kind = "memory"

    def __init__(self, data_dir: Path | None = None) -> None:
        self.data_dir = Path(data_dir or settings.data_dir)
        self._park = self._read_json("park.json")
        self._details = self._read_json("building_details.json")
        self._alarms = self._read_json("alarms.json")
        #: 演示环境下确认状态只存进程内（文件是只读的, 不落盘）
        self._alarm_acks: dict[str, str] = {}
        self._layers: dict[str, dict[str, Any]] = {}
        for key, defn in LAYERS.items():
            self._layers[key] = self._read_json(defn.source_file)

    # ------------------------------------------------------------ 内部
    def _read_json(self, name: str) -> Any:
        path = self.data_dir / name
        if not path.exists():
            raise RuntimeError(
                f"缺少数据文件 {path}. 请先执行: python tools/gen_demo_data.py"
            )
        return json.loads(path.read_text(encoding="utf-8"))

    # ------------------------------------------------------------ 接口
    async def park(self) -> dict[str, Any]:
        return self._park

    async def layer(
        self, key: str, bbox: tuple[float, float, float, float] | None = None
    ) -> dict[str, Any]:
        fc = self._layers[key]
        if not bbox:
            return fc
        # 视口增量拉取: 复用与 PostGIS `&&` 相同的判定, 两种仓库行为保持一致
        features = [
            f for f in fc.get("features", []) if lightweight.bbox_intersects(f.get("geometry") or {}, bbox)
        ]
        return {"type": "FeatureCollection", "name": key, "features": features}

    async def raw_layers(self) -> dict[str, dict[str, Any]]:
        return self._layers

    async def building_details(self) -> dict[str, dict[str, Any]]:
        return self._details

    async def alarms(self) -> list[dict[str, Any]]:
        return list(self._alarms)

    async def alarm_acks(self) -> dict[str, str]:
        return dict(self._alarm_acks)

    async def set_alarm_ack(self, alarm_id: str, ts: str) -> None:
        self._alarm_acks[alarm_id] = ts

    async def close(self) -> None:
        return None
