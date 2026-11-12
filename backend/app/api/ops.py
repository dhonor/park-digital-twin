"""运营态势接口: KPI / 能耗 / 告警."""

from __future__ import annotations

import socket
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from ..services.overview import campus_curve
from ..services.telemetry import now_iso

router = APIRouter(tags=["ops"])
CST = timezone(timedelta(hours=8))


@router.get("/overview", summary="园区综合态势 KPI")
async def overview(request: Request) -> dict[str, Any]:
    """KPI 由 OverviewService 统一组装: 静态部分启动时缓存, 动态部分按遥测快照重算.

    同一个对象也通过 WebSocket 主动推送, 多终端场景下不再各自轮询。
    """
    return await request.app.state.overview.build()


@router.get("/energy/summary", summary="能耗汇总与分项曲线")
async def energy_summary(request: Request) -> dict[str, Any]:
    """当前只有 24 小时曲线, 不接受 range 参数 —— 之前声明支持 7d 但返回的是同一份数据."""
    details = await request.app.state.repo.building_details()
    buildings = []
    for detail in details.values():
        peak = max(detail["energy_24h"]) if detail["energy_24h"] else 0
        buildings.append(
            {
                "id": detail["id"],
                "name": detail["name"],
                "type": detail["type_label"],
                "floors": detail["floors"],
                "energy_kwh_today": detail["energy_kwh_today"],
                "energy_target": detail["energy_target"],
                "intensity": round(detail["energy_kwh_today"] / max(detail["gfa_m2"], 1), 4),
                "peak_kw": peak,
                "curve": detail["energy_24h"],
            }
        )
    buildings.sort(key=lambda item: item["energy_kwh_today"], reverse=True)
    return {
        "unit": "kWh",
        "range": "24h",
        "campus_curve": campus_curve(details),
        "buildings": buildings,
        "top5": buildings[:5],
    }


@router.get("/alarms", summary="告警列表")
async def list_alarms(
    request: Request,
    level: str | None = Query(None, pattern="^(critical|warning|info)$"),
    status: str | None = Query(None, pattern="^(open|acked)$"),
) -> dict[str, Any]:
    items = await request.app.state.alarms.items(level=level, status=status)
    return {"count": len(items), "items": items, "counts": await request.app.state.alarms.counts()}


@router.post("/alarms/{alarm_id}/ack", summary="确认告警")
async def ack_alarm(request: Request, alarm_id: str) -> dict[str, Any]:
    ts = now_iso()
    if not await request.app.state.alarms.ack(alarm_id, ts):
        raise HTTPException(status_code=404, detail=f"未知告警 {alarm_id}")
    return {"ok": True, "alarm_id": alarm_id, "acked_at": ts}


@router.get("/health", summary="健康检查")
async def health(request: Request) -> dict[str, Any]:
    state = request.app.state
    return {
        "status": "ok",
        "backend": state.repo.kind,
        # 实例名: 多副本时用来确认网关轮询与排障定位
        "instance": socket.gethostname(),
        "bus": "redis" if getattr(state, "bus", None) is not None else "in-process",
        "devices_tracked": state.telemetry.device_count,
        "subscribers": state.telemetry.subscriber_count,
        "server_time": datetime.now(CST).isoformat(timespec="seconds"),
    }
