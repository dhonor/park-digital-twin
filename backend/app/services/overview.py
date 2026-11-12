"""KPI 聚合与推送.

原来每个终端每 5 秒调一次 /api/overview, 每次都要读一遍楼栋明细再求和 ——
大屏 + 一体机 + 笔记本同时在跑时, 这是纯重复劳动.

这里改成:
  * 静态部分（能耗/碳排/在园人数/占地/24h 曲线）启动时算一次, 缓存在内存;
  * 动态部分（设备状态、告警数）每次按遥测快照重算;
  * 由服务端统一按周期推给 WS 订阅者, 没有订阅者时直接跳过, 不空转。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .telemetry import now_iso

log = logging.getLogger("park.overview")

#: 电网排放因子 (kg CO2e / kWh)
CARBON_FACTOR = 0.581


def campus_curve(details: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """把各楼栋 24 小时曲线按小时累加; 数据长度异常时按 24 点截断, 不抛异常."""
    curve = [0.0] * 24
    for detail in details.values():
        for hour, value in enumerate(detail.get("energy_24h", [])[:24]):
            curve[hour] += float(value)
    return [{"hour": hour, "value": round(value, 1)} for hour, value in enumerate(curve)]


class OverviewService:
    def __init__(self, repo: Any, telemetry: Any, alarms: Any, interval: float = 5.0) -> None:
        self._repo = repo
        self._telemetry = telemetry
        self._alarms = alarms
        self._interval = interval
        self._static: dict[str, Any] | None = None
        self._task: asyncio.Task | None = None

    # ------------------------------------------------------------ 生命周期
    async def start(self) -> None:
        await self._load_static()
        self._task = asyncio.create_task(self._run(), name="park-overview")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _load_static(self) -> dict[str, Any]:
        if self._static is not None:
            return self._static
        details = await self._repo.building_details()
        park = await self._repo.park()
        self._static = {
            "energy_kwh": sum(d["energy_kwh_today"] for d in details.values()),
            "energy_target": sum(d["energy_target"] for d in details.values()),
            "carbon_kg": sum(d["carbon_kg_today"] for d in details.values()),
            "occupancy": sum(
                sum(floor.get("occupancy", 0) for floor in d.get("floor_list", []))
                for d in details.values()
            ),
            "building_count": len(details),
            "curve": campus_curve(details),
            "area_m2": park.get("area_m2", 0),
            "green_ratio": park.get("green_ratio", 0),
        }
        return self._static

    # ------------------------------------------------------------ 组装
    async def build(self) -> dict[str, Any]:
        static = await self._load_static()
        counts = self._telemetry.summarize()
        total = sum(counts.values()) or 1
        alarms = await self._alarms.counts()
        energy_today = static["energy_kwh"]

        kpi = [
            {
                "key": "devices",
                "label": "物联设备",
                "value": total,
                "unit": "台",
                "sub": f"在线率 {round((total - counts['offline']) / total * 100, 1)}%",
                "tone": "cyan",
            },
            {
                "key": "energy",
                "label": "今日用能",
                "value": round(energy_today / 1000, 2),
                "unit": "MWh",
                "sub": f"预算 {round(static['energy_target'] / 1000, 2)} MWh",
                "tone": "amber",
            },
            {
                "key": "carbon",
                "label": "碳排放",
                "value": round(static["carbon_kg"] / 1000, 2),
                "unit": "tCO₂e",
                "sub": f"因子 {CARBON_FACTOR} kg/kWh",
                "tone": "green",
            },
            {
                "key": "alarm",
                "label": "待处置告警",
                "value": alarms.get("critical", 0) + alarms.get("warning", 0),
                "unit": "条",
                "sub": f"严重 {alarms.get('critical', 0)} / 预警 {alarms.get('warning', 0)}",
                "tone": "red" if alarms.get("critical") else "slate",
            },
            {
                "key": "people",
                "label": "在园人数",
                "value": static["occupancy"],
                "unit": "人",
                "sub": f"{static['building_count']} 栋建筑统计口径",
                "tone": "violet",
            },
            {
                "key": "area",
                "label": "园区占地",
                "value": round(static["area_m2"] / 10000, 1),
                "unit": "ha",
                "sub": f"绿地率 {round(static['green_ratio'] * 100)}%",
                "tone": "slate",
            },
        ]

        return {
            "kpi": kpi,
            "device_status": counts,
            "alarm_counts": alarms,
            "energy": {
                "today_kwh": round(energy_today, 1),
                "target_kwh": round(static["energy_target"], 1),
                "carbon_kg": round(static["carbon_kg"], 1),
                "curve": static["curve"],
            },
            "updated_at": now_iso(),
        }

    # ------------------------------------------------------------ 推送循环
    async def _run(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._interval)
                if self._telemetry.subscriber_count == 0:
                    continue  # 没人在看就不算
                payload = await self.build()
                await self._telemetry.publish({"type": "overview", "ts": now_iso(), "overview": payload})
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - 推送异常不应中断服务
                log.exception("KPI 推送异常")
