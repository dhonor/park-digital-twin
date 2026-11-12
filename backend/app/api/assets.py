"""建筑与设备资产接口."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..domain.catalog import DEFAULT_LOD
from ..services import lightweight as lw
from ._query import ensure_lod, filter_bbox, parse_bbox

router = APIRouter(tags=["assets"])

DEVICE_TYPES = {
    "hvac": "暖通机组",
    "meter": "智能电表",
    "water": "远传水表",
    "env": "环境传感器",
    "camera": "安防摄像机",
    "elevator": "电梯",
    "fire": "消防探测器",
    "charge": "充电桩",
    "parking": "车位感知",
    "light": "智能照明",
}


async def _live_devices(request: Request) -> list[dict[str, Any]]:
    """设备要素 + 实时状态 (复制后合并, 不改仓库数据)."""
    fc = await request.app.state.repo.layer("devices")
    return request.app.state.telemetry.merge(list(fc.get("features", [])))


@router.get("/buildings", summary="楼栋列表")
async def list_buildings(request: Request) -> dict[str, Any]:
    details = await request.app.state.repo.building_details()
    devices = await _live_devices(request)
    alarms = await request.app.state.alarms.items(status="open")

    by_building: dict[str, dict[str, int]] = {}
    for feature in devices:
        props = feature["properties"]
        bid = props.get("building_id")
        if not bid:
            continue
        bucket = by_building.setdefault(bid, {"devices": 0, "alarm": 0})
        bucket["devices"] += 1
        if props.get("status") == "alarm":
            bucket["alarm"] += 1

    alarm_by_building: dict[str, int] = {}
    for alarm in alarms:
        bid = alarm.get("building_id")
        if bid:
            alarm_by_building[bid] = alarm_by_building.get(bid, 0) + 1

    items = []
    for bid, detail in details.items():
        items.append(
            {
                "id": bid,
                "name": detail["name"],
                "type": detail["type"],
                "type_label": detail["type_label"],
                "height": detail["height"],
                "floors": detail["floors"],
                "area_m2": detail["area_m2"],
                "gfa_m2": detail["gfa_m2"],
                "center": detail["center"],
                "energy_kwh_today": detail["energy_kwh_today"],
                "carbon_kg_today": detail["carbon_kg_today"],
                "device_count": by_building.get(bid, {}).get("devices", 0),
                # 待处置告警事件数; 设备侧的状态告警单列, 两者相加会重复计数
                "alarm_count": alarm_by_building.get(bid, 0),
                "alarm_device_count": by_building.get(bid, {}).get("alarm", 0),
            }
        )
    items.sort(key=lambda item: item["id"])
    return {"count": len(items), "items": items}


@router.get("/buildings/{building_id}", summary="楼栋详情")
async def get_building(request: Request, building_id: str) -> dict[str, Any]:
    details = await request.app.state.repo.building_details()
    detail = details.get(building_id)
    if not detail:
        raise HTTPException(status_code=404, detail=f"未知楼栋 {building_id}")

    devices = [
        feature["properties"]
        for feature in await _live_devices(request)
        if feature["properties"].get("building_id") == building_id
    ]
    alarms = [
        alarm
        for alarm in await request.app.state.alarms.items()
        if alarm.get("building_id") == building_id
    ]
    summary = {"total": len(devices), "normal": 0, "warning": 0, "alarm": 0, "offline": 0}
    for device in devices:
        status = device.get("status", "normal")
        summary[status] = summary.get(status, 0) + 1

    return {
        **detail,
        "devices": devices,
        "alarms": alarms[:10],
        "device_summary": summary,
        "live": {
            "energy_kwh_today": detail["energy_kwh_today"],
            "energy_target": detail["energy_target"],
            "load_rate": round(detail["energy_kwh_today"] / max(detail["energy_target"], 1), 3),
        },
    }


@router.get("/devices", summary="设备点位 (支持 LOD / 视口 / 过滤)")
async def list_devices(
    request: Request,
    type: str | None = Query(None, description="设备类型"),
    status: str | None = Query(None, description="normal/warning/alarm/offline"),
    building_id: str | None = Query(None),
    lod: int = Query(DEFAULT_LOD, ge=0, le=2),
    bbox: str | None = Query(None),
    limit: int | None = Query(None, ge=1, le=5000),
) -> dict[str, Any]:
    lod = ensure_lod(lod)
    box = parse_bbox(bbox)
    features = filter_bbox(await _live_devices(request), box)
    if type:
        features = [f for f in features if f["properties"].get("type") == type]
    if status:
        features = [f for f in features if f["properties"].get("status") == status]
    if building_id:
        features = [f for f in features if f["properties"].get("building_id") == building_id]
    if limit:
        features = features[:limit]

    lightened, stats = lw.lighten(
        {"type": "FeatureCollection", "name": "devices", "features": features}, "devices", lod
    )
    lightened["_lightweight"] = stats
    summary = await _device_summary(request)
    return {**lightened, "summary": summary, "types": DEVICE_TYPES}


async def _device_summary(request: Request) -> dict[str, Any]:
    counts = request.app.state.telemetry.summarize()
    total = sum(counts.values())
    return {
        "total": total,
        "by_status": counts,
        "online_rate": round((total - counts.get("offline", 0)) / total, 4) if total else 0.0,
    }


@router.get("/devices/{device_id}", summary="设备详情")
async def get_device(request: Request, device_id: str) -> dict[str, Any]:
    # 直查索引 + 单点状态: 查一台设备不必复制并线性扫描整层 200 条要素
    props = request.app.state.device_props.get(device_id)
    if props is None:
        raise HTTPException(status_code=404, detail=f"未知设备 {device_id}")
    state = request.app.state.telemetry.state(device_id)
    if not state:
        return props
    # 只覆盖实时字段, 其余属性沿用仓库原始值 (不原地改写仓库对象)
    return {
        **props,
        "status": state["status"],
        "metric": dict(state["metric"]),
        "ts": state["ts"],
    }


class CommandIn(BaseModel):
    """反控入参: 显式声明字段后, 非法 action / 非数值 value 在入口就被拦成 422."""

    action: Literal["restart", "set"] = "restart"
    metric: str | None = None
    #: 量程夹紧在 command() 里做, 这里只挡明显越界与类型错误
    value: float | None = Field(default=None, ge=-1_000_000, le=1_000_000)


@router.post("/devices/{device_id}/command", summary="设备反控 (演示通道)")
async def device_command(
    request: Request,
    device_id: str,
    payload: CommandIn | None = None,
) -> dict[str, Any]:
    telemetry = request.app.state.telemetry
    if telemetry.state(device_id) is None:
        raise HTTPException(status_code=404, detail=f"未知设备 {device_id}")
    body = payload or CommandIn()
    applied = await telemetry.command(device_id, body.action, body.metric, body.value)
    if applied is None:  # 并发下设备刚被移除, 兜一层
        raise HTTPException(status_code=404, detail=f"未知设备 {device_id}")
    return {
        "ok": True,
        "device_id": device_id,
        "channel": "mock-mqtt",
        "action": body.action,
        "applied": applied,
        "note": "演示通道: 生产环境替换为 MQTT 下发 + 设备回执",
    }
