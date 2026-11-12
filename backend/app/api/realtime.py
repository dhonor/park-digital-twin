"""实时通道: WebSocket.

消息协议 (前端只依赖这四种):
  hello     连接即下发, 携带园区/图层/LOD 元数据与设备快照
  telemetry 周期推送, items 为变更设备
  alarm     规则触发的新告警
  ping      心跳
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import settings
from ..domain.catalog import LODS
from ..services.telemetry import now_iso

router = APIRouter()
log = logging.getLogger("park.realtime")

#: 单副本的 WS 连接上限: 演示场景够用, 也是"连接数失控"的最后一道闸
MAX_CLIENTS = 128


def _origin_allowed(websocket: WebSocket) -> bool:
    """WS 握手来源校验.

    CORS 只约束 fetch/XHR, 对 WebSocket 无效: 不校验时任意站点都能连上这条实时流.
    放行三种情况, 覆盖本项目的全部部署形态:
      1. 不带 Origin —— 命令行/服务端客户端;
      2. 同源 —— 单端口交付 (前端由后端托管) 与反向代理;
      3. Origin 在 CORS_ORIGINS 白名单 —— 开发模式 (vite 5173)。
    """
    origin = websocket.headers.get("origin")
    if not origin:
        return True
    host = websocket.headers.get("host")
    if host and origin.rsplit("//", 1)[-1] == host:
        return True
    return origin in settings.cors_origins


@router.websocket("/ws/realtime")
async def realtime(websocket: WebSocket) -> None:
    state = websocket.app.state
    if not _origin_allowed(websocket):
        log.warning("拒绝来源未授权的 WS 连接: %s", websocket.headers.get("origin"))
        await websocket.close(code=1008)
        return
    if state.telemetry.subscriber_count >= MAX_CLIENTS:
        log.warning("WS 连接数已达上限 %d, 拒绝新连接", MAX_CLIENTS)
        await websocket.close(code=1013)  # try again later
        return

    await websocket.accept()
    telemetry = state.telemetry
    queue = telemetry.subscribe()
    try:
        park = await state.repo.park()
        await websocket.send_json(
            {
                "type": "hello",
                "ts": now_iso(),
                "park": {"id": park["id"], "name": park["name"], "center": park["center"]},
                "lods": [{"lod": lod, "key": meta["key"], "label": meta["label"]} for lod, meta in sorted(LODS.items())],
                "interval": settings.telemetry_interval,
                "devices": telemetry.snapshot(),
                "alarm_counts": await state.alarms.counts(),
                # 连接即带一份 KPI, 前端首屏不必再单独请求 /api/overview
                "overview": await state.overview.build(),
            }
        )
        while True:
            try:
                payload: dict[str, Any] = await asyncio.wait_for(queue.get(), timeout=20.0)
            except asyncio.TimeoutError:
                payload = {"type": "ping", "ts": now_iso()}
            await websocket.send_json(payload)
    except WebSocketDisconnect:
        pass
    except Exception:
        # 之前是 except Exception: pass, 连 send_json 失败都被吞掉, 线上完全看不出为什么没数据
        log.exception("WS 连接异常中断")
    finally:
        telemetry.unsubscribe(queue)
