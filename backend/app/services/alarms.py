"""告警服务: 种子告警 + 实时告警 + 确认状态.

确认状态落库（`dt_alarm.acked_at`），不再只存在进程内存里:
多副本时 ack 才能在所有副本生效, 重启也不会把已确认的告警变回待处置。
内存仓库不支持持久化, 用进程内字典兜底（行为与之前一致）。
"""

from __future__ import annotations

import logging
import time
from typing import Any

log = logging.getLogger("park.alarms")

#: 已确认状态的刷新间隔: 别的副本 ack 后, 本副本最迟 1 秒内可见
ACK_REFRESH = 1.0


class AlarmService:
    def __init__(self, repo: Any, telemetry: Any) -> None:
        self._repo = repo
        self._telemetry = telemetry
        #: 本地缓存, 避免每次列告警都查库
        self._acked: dict[str, str] = {}
        self._synced_at = 0.0

    async def load(self) -> None:
        """启动时把已确认记录读进内存; 读失败不阻塞服务启动."""
        try:
            self._acked.update(await self._repo.alarm_acks())
            self._synced_at = time.monotonic()
        except Exception:  # pragma: no cover - 存储不可用时不阻塞
            log.warning("读取已确认告警失败, 从空状态开始", exc_info=True)

    async def _refresh(self) -> None:
        """定期与存储对齐.

        多副本时, ack 可能发生在任何一个副本上; 只靠自己内存里的字典会导致
        同一时刻两个副本对同一条告警给出不同状态。这里用「1 秒节流 + 落库为准」,
        比给每个 ack 都做一次广播简单, 也不会漏消息。
        """
        now = time.monotonic()
        if now - self._synced_at < ACK_REFRESH:
            return
        self._synced_at = now
        try:
            fresh = await self._repo.alarm_acks()
        except Exception:  # pragma: no cover
            return
        if fresh:
            self._acked.update(fresh)

    async def items(self, level: str | None = None, status: str | None = None) -> list[dict[str, Any]]:
        await self._refresh()
        seed = await self._repo.alarms()
        merged = list(self._telemetry.recent_events()) + list(seed)
        out = []
        for alarm in merged:
            item = dict(alarm)
            if item["id"] in self._acked:
                item["status"] = "acked"
                item["acked_at"] = self._acked[item["id"]]
            if level and item.get("level") != level:
                continue
            if status and item.get("status") != status:
                continue
            out.append(item)
        return out

    async def counts(self) -> dict[str, int]:
        items = await self.items(status="open")
        counts = {"critical": 0, "warning": 0, "info": 0}
        for item in items:
            counts[item.get("level", "info")] = counts.get(item.get("level", "info"), 0) + 1
        return counts

    async def ack(self, alarm_id: str, ts: str) -> bool:
        """确认一条告警; 告警不存在返回 False, 由路由映射成 404.

        不校验会让任意 id 都返回"确认成功", 前端把不存在的告警标成已确认后
        列表里再也找不到它, 排查时无从下手.
        """
        known = {item["id"] for item in await self.items()}
        if alarm_id not in known:
            return False
        self._acked[alarm_id] = ts
        await self._repo.set_alarm_ack(alarm_id, ts)
        self._synced_at = time.monotonic()
        return True
