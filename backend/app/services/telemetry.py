"""实时遥测模拟 + 事件广播.

真实项目里这一段是 IoT 接入层 (MQTT/HTTP 上报 -> 规则引擎);
这里用可控的模拟器替代, 但对外接口 (订阅/推送/快照) 与生产一致,
后续把 `_tick` 换成消息队列消费者即可, 前端零改动.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

log = logging.getLogger("park.telemetry")

CST = timezone(timedelta(hours=8))
STATUS_FLIP = 0.08


def now_iso() -> str:
    return datetime.now(CST).isoformat(timespec="seconds")


class TelemetryService:
    #: 同一设备同一指标在该窗口内不重复产生告警, 否则一台设备抖动一次就刷一条
    ALARM_COOLDOWN = 300.0
    #: 运行时告警的保留时长, 过期自动归档 —— 否则告警墙只增不减
    EVENT_TTL = 1800.0

    def __init__(self, repo: Any, interval: float = 2.0, bus: Any | None = None) -> None:
        self._repo = repo
        self._interval = interval
        self._bus = bus
        #: 选主令牌: 每个进程一个, 只有持锁的副本推进模拟器
        self._token = f"telemetry-{uuid.uuid4().hex[:8]}"
        self._state: dict[str, dict[str, Any]] = {}
        self._subscribers: set[asyncio.Queue] = set()
        self._task: asyncio.Task | None = None
        self._fanout: asyncio.Task | None = None
        self._rng = random.Random(20261110)
        self._seq = 0
        self._events: list[dict[str, Any]] = []
        self._lookup: dict[str, dict[str, Any]] = {}
        self._last_alarm: dict[tuple[str, str], float] = {}

    # ------------------------------------------------------------ 生命周期
    async def start(self) -> None:
        fc = await self._repo.layer("devices")
        seed: dict[str, dict[str, Any]] = {}
        for feature in fc.get("features", []):
            props = feature.get("properties", {})
            seed[props["id"]] = {
                "status": props.get("status", "normal"),
                "metric": dict(props.get("metric") or {}),
                "ts": now_iso(),
            }

        if self._bus is not None:
            # 已有状态以 Redis 为准: 否则每次重启都会把设备状态打回种子值
            existing = await self._bus.state_load()
            if existing:
                self._state = existing
            else:
                self._state = seed
                await self._bus.state_save(seed)
            self._fanout = asyncio.create_task(self._fanout_loop(), name="park-fanout")
        else:
            self._state = seed

        self._task = asyncio.create_task(self._run(), name="park-telemetry")
        log.info(
            "遥测已启动, 设备 %d 台, 周期 %.1fs, %s",
            len(self._state),
            self._interval,
            "Redis 总线" if self._bus else "单进程",
        )

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self._fanout:
            self._fanout.cancel()
            try:
                await self._fanout
            except asyncio.CancelledError:
                pass
            self._fanout = None
        if self._bus is not None:
            await self._bus.release_lease(self._token)

    async def _fanout_loop(self) -> None:
        """把 Redis 上的事件转给本进程的 WS 订阅者, 并同步设备状态.

        订阅必须能自愈: `listen()` 在连接断开会正常结束迭代, 一旦退出循环,
        这个副本就永久不再广播 —— 对外表现为实时数据"冻住", 且日志里什么都没有.
        因此这里用指数退避重连, 单次断线不影响服务可用性.
        """
        backoff = 1.0
        while True:
            try:
                async for payload in self._bus.listen():
                    backoff = 1.0
                    self._deliver(payload)
                # 迭代正常结束 = 连接已关闭, 当成一次断线而不是"订阅完成"
                raise ConnectionError("Redis 订阅结束")
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - 依赖真实 Redis 断线才能触发
                log.exception("Redis 事件订阅中断, %.1fs 后重连", backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    # ------------------------------------------------------------ 状态读写
    @property
    def device_count(self) -> int:
        return len(self._state)

    def snapshot(self) -> list[dict[str, Any]]:
        return [
            {"id": did, "status": st["status"], "metric": st["metric"], "ts": st["ts"]}
            for did, st in self._state.items()
        ]

    def state(self, device_id: str) -> dict[str, Any] | None:
        """单台设备的实时状态.

        查一台设备不必复制整张表: 缺 key 返回 None, 由路由映射成 404,
        而不是让 KeyError 冒成 500.
        """
        return self._state.get(device_id)

    def merge(self, features: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """返回叠加实时值后的**新**要素列表.

        必须复制而不是原地改: 内存仓库把内部对象直接交给调用方, 原地写属性会污染仓库缓存,
        表现为「轻量化报告每次算出来的体积都不一样」「设备图层状态随接口调用顺序变化」。
        """
        out: list[dict[str, Any]] = []
        for feature in features:
            props = feature.get("properties") or {}
            state = self._state.get(props.get("id"))
            if not state:
                out.append(feature)
                continue
            out.append(
                {
                    **feature,
                    "properties": {
                        **props,
                        "status": state["status"],
                        "metric": dict(state["metric"]),
                        "ts": state["ts"],
                    },
                }
            )
        return out

    def summarize(self) -> dict[str, int]:
        counts = {"normal": 0, "warning": 0, "alarm": 0, "offline": 0}
        for st in self._state.values():
            counts[st["status"]] = counts.get(st["status"], 0) + 1
        return counts

    async def command(self, device_id: str, action: str, metric: str | None, value: float | None) -> dict | None:
        """下发反控; 设备不存在返回 None (路由据此回 404)."""
        state = self._state.get(device_id)
        if state is None:
            return None
        applied: dict[str, Any] = {"action": action}
        if action == "restart":
            state["status"] = "normal"
            state["ts"] = now_iso()
            applied["status"] = "normal"
        elif value is not None:
            m = state["metric"]
            m["value"] = round(max(float(m.get("min", 0)), min(float(m.get("max", 100)), value)), 2)
            state["status"] = "normal" if m["value"] < float(m.get("max", 100)) * 0.94 else "warning"
            state["ts"] = now_iso()
            applied.update({"metric": metric or m.get("key"), "value": m["value"], "status": state["status"]})

        if self._bus is not None:
            # 反控结果要落到 Redis 并广播, 否则只有处理该请求的副本知道设备被改了
            await self._bus.state_save({device_id: state})
            await self.publish(
                {
                    "type": "telemetry",
                    "ts": state["ts"],
                    "items": [
                        {
                            "id": device_id,
                            "status": state["status"],
                            "value": state["metric"].get("value"),
                            "metric": state["metric"].get("key"),
                            "unit": state["metric"].get("unit"),
                        }
                    ],
                }
            )
        return applied

    # ------------------------------------------------------------ 事件订阅
    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    async def publish(self, payload: dict[str, Any]) -> None:
        """发一条事件: 配了 Redis 就上总线, 否则直接进本地队列."""
        if self._bus is not None:
            await self._bus.publish(payload)
        else:
            self._deliver(payload)

    def _deliver(self, payload: dict[str, Any]) -> None:
        """本地扇出 + 用事件里的实时值刷新本副本的状态副本."""
        if payload.get("type") == "alarm":
            # 运行期告警只在 leader 内存里生成; 其他副本靠这条广播补齐,
            # 否则同一时刻两个副本 /api/alarms 返回的条数不一样
            alarm = payload.get("alarm")
            if alarm and not any(event["id"] == alarm["id"] for event in self._events):
                self._prune_events()
                self._events.append(alarm)
                if len(self._events) > 100:
                    self._events = self._events[-100:]

        if payload.get("type") == "telemetry":
            for item in payload.get("items", []):
                state = self._state.get(item.get("id"))
                if state is None:
                    continue
                state["status"] = item.get("status", state["status"])
                state["ts"] = payload.get("ts", state.get("ts"))
                metric = state.get("metric") or {}
                if item.get("value") is not None:
                    metric["value"] = item["value"]
                state["metric"] = metric

        for queue in list(self._subscribers):
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                self._subscribers.discard(queue)

    def recent_events(self, limit: int = 20) -> list[dict[str, Any]]:
        return self._events[-limit:][::-1]

    def _prune_events(self) -> None:
        if not self._events:
            return
        cutoff = datetime.now(CST) - timedelta(seconds=self.EVENT_TTL)
        self._events = [event for event in self._events if datetime.fromisoformat(event["ts"]) >= cutoff]

    # ------------------------------------------------------------ 模拟循环
    async def _run(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._interval)
                if self._bus is not None:
                    # 只有持租约的副本推进模拟器; 其余副本靠广播同步状态,
                    # 否则两个副本各跑各的随机游走, 同一台设备在两处会显示不同值
                    if not await self._bus.acquire_lease(self._token, int(self._interval * 2000)):
                        continue
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - 演示循环不应中断
                log.exception("遥测模拟异常")

    async def _tick(self) -> None:
        if not self._state:
            return
        ids = self._rng.sample(list(self._state), k=min(10, len(self._state)))
        items = []
        for did in ids:
            state = self._state[did]
            metric = state["metric"]
            lo = float(metric.get("min", 0))
            hi = float(metric.get("max", 100))
            span = max(hi - lo, 0.001)
            value = float(metric.get("value", lo))
            roll = self._rng.random()

            # 状态机: 大部分时间在正常区间小幅波动, 少量滑入预警/告警。
            # 避免"指标贴着上限就报警"的误报设计 —— 那会让大屏变成告警墙。
            if state["status"] == "offline" and roll > 0.35:
                status = "offline"
                value = 0.0
            elif roll < 0.012:
                status = "alarm"
                value = round(hi * self._rng.uniform(1.01, 1.08), 2)
            elif roll < 0.055:
                status = "warning"
                value = round(hi * self._rng.uniform(0.9, 0.98), 2)
            else:
                status = "normal"
                value = round(min(hi * 0.92, max(lo, value + self._rng.uniform(-0.05, 0.05) * span)), 2)

            metric["value"] = value
            state["status"] = status
            state["ts"] = now_iso()
            items.append(
                {
                    "id": did,
                    "status": status,
                    "value": value,
                    "metric": metric.get("key"),
                    "unit": metric.get("unit"),
                }
            )

        await self.publish({"type": "telemetry", "ts": now_iso(), "items": items})
        if self._bus is not None:
            await self._bus.state_save({item["id"]: self._state[item["id"]] for item in items})
        await self._emit_alarm([item for item in items if item["status"] == "alarm"])

    async def _emit_alarm(self, candidates: list[dict[str, Any]]) -> None:
        """按「设备 + 指标」做冷却, 一次 tick 最多产出一条告警."""
        if not candidates:
            return

        now = time.monotonic()
        if len(self._last_alarm) > 400:
            cutoff = now - self.ALARM_COOLDOWN
            self._last_alarm = {k: v for k, v in self._last_alarm.items() if v > cutoff}

        for target in candidates:
            key = (target["id"], str(target.get("metric")))
            last = self._last_alarm.get(key)
            if last is not None and now - last < self.ALARM_COOLDOWN:
                continue

            self._last_alarm[key] = now
            self._seq += 1
            props = self._device_props(target["id"])
            event = {
                "id": f"ALM-RT-{self._seq:04d}",
                "level": "critical",
                "title": f"{props.get('name', target['id'])} 指标越限",
                "device_id": target["id"],
                "device_name": props.get("name", target["id"]),
                "building_id": props.get("building_id"),
                "metric": target["metric"],
                "value": target["value"],
                "threshold": props.get("metric", {}).get("max"),
                "unit": target["unit"],
                "ts": now_iso(),
                "status": "open",
                "hint": "实时规则引擎触发",
            }
            self._prune_events()
            self._events.append(event)
            if len(self._events) > 100:
                self._events = self._events[-100:]
            await self.publish({"type": "alarm", "ts": now_iso(), "alarm": event})
            return

    def _device_props(self, device_id: str) -> dict[str, Any]:
        return self._lookup.get(device_id, {})

    def bind_lookup(self, lookup: dict[str, dict[str, Any]]) -> None:
        """注入设备台账, 用于告警文案与阈值展示."""
        self._lookup = lookup
