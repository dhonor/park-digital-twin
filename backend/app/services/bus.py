"""Redis 总线: 缓存 / 事件广播 / 设备状态 / 选主租约.

未配置 `REDIS_URL` 时整个模块不参与, 服务保持单进程行为（零外部依赖）。
配置之后, API 才能安全地扩到多副本:

| 能力 | 单机 | 多副本 |
| --- | --- | --- |
| 轻量化缓存 | 进程内 TTL | Redis, 键空间不变 |
| 实时事件 | 进程内队列扇出 | Pub/Sub 扇出, 任意副本的 WS 客户端看到同一条流 |
| 设备状态 | 进程内字典 | Redis Hash, 各副本 merge 结果一致 |
| 模拟器推进 | 每个进程都跑 | 租约选主, 只有一个副本推进 |

选主用 `SET NX PX` 实现, 而不是引入 etcd/zk —— 单园区场景要的是「别两个进程同时改状态」,
不是强一致的分布式协调。
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # 仅类型检查期需要; 运行时在 connect() 里按需导入
    import redis.asyncio as aioredis

log = logging.getLogger("park.bus")

EVENTS_CHANNEL = "park:events"
STATE_KEY = "park:telemetry:state"
LEASE_KEY = "park:telemetry:leader"

#: 只在自己持有时释放, 避免误删新 leader 的锁
_RELEASE_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""

#: 续期同样要 CAS: 先 GET 再 PEXPIRE 的空隙里租约可能已过期并被别人抢到
_RENEW_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
"""


class RedisBus:
    def __init__(self, url: str) -> None:
        self._url: str = url
        self._client: aioredis.Redis | None = None

    @property
    def _conn(self) -> aioredis.Redis:
        """取连接; 未连接就调用属于编程错误, 直接抛出而不是让下游炸在别处."""
        if self._client is None:
            raise RuntimeError("Redis 尚未连接: 请先 await connect()")
        return self._client

    # ------------------------------------------------------------ 生命周期
    async def connect(self) -> None:
        try:
            from redis.asyncio import Redis as RedisClient  # 依赖仅在启用 Redis 时才真正需要
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "启用多副本需要安装依赖: pip install -r backend/requirements.txt（含 redis）"
            ) from exc

        client = RedisClient.from_url(self._url, decode_responses=True, health_check_interval=30)
        try:
            await client.ping()
        except Exception:
            # 握手失败时把刚建出来的连接池关掉, 否则上层重试会一直堆积连接
            await client.aclose()
            raise
        self._client = client
        log.info("已连接 Redis: %s", self._url.split("@")[-1])

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ------------------------------------------------------------ 缓存
    async def cache_get(self, key: str) -> Any | None:
        raw = await self._conn.get(key)
        return json.loads(raw) if raw else None

    async def cache_set(self, key: str, value: Any, ttl: float) -> None:
        await self._conn.set(key, json.dumps(value, ensure_ascii=False), ex=max(int(ttl), 1))

    # ------------------------------------------------------------ 广播
    async def publish(self, payload: dict[str, Any]) -> None:
        await self._conn.publish(EVENTS_CHANNEL, json.dumps(payload, ensure_ascii=False))

    async def listen(self) -> AsyncIterator[dict[str, Any]]:
        pubsub = self._conn.pubsub()
        await pubsub.subscribe(EVENTS_CHANNEL)
        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                try:
                    yield json.loads(message["data"])
                except (TypeError, ValueError):
                    continue
        finally:
            await pubsub.unsubscribe(EVENTS_CHANNEL)
            await pubsub.aclose()

    # ------------------------------------------------------------ 设备状态
    async def state_load(self) -> dict[str, dict[str, Any]]:
        raw = await self._conn.hgetall(STATE_KEY)
        out: dict[str, dict[str, Any]] = {}
        for raw_key, raw_value in raw.items():
            # hgetall 的键值类型是 bytes | str: 客户端类型不看 decode_responses,
            # 这里自己解码, 免得改了这个开关就静默丢数据
            key = raw_key.decode() if isinstance(raw_key, bytes) else raw_key
            text = raw_value.decode() if isinstance(raw_value, bytes) else raw_value
            try:
                out[key] = json.loads(text)
            except (TypeError, ValueError):
                continue
        return out

    async def state_save(self, items: dict[str, dict[str, Any]]) -> None:
        if not items:
            return
        await self._conn.hset(
            STATE_KEY,
            mapping={key: json.dumps(value, ensure_ascii=False) for key, value in items.items()},
        )

    # ------------------------------------------------------------ 选主租约
    async def acquire_lease(self, token: str, ttl_ms: int) -> bool:
        """拿到（或续期）租约才算 leader; 非 leader 直接跳过本轮."""
        if await self._conn.set(LEASE_KEY, token, nx=True, px=ttl_ms):
            return True
        # 续期必须 CAS: 若 GET 与 PEXPIRE 之间租约到期并被别的副本抢走,
        # 无条件 PEXPIRE 会把新 leader 的租约续长, 结果是两边都以为自己是主
        return bool(await self._conn.eval(_RENEW_SCRIPT, 1, LEASE_KEY, token, ttl_ms))

    async def release_lease(self, token: str) -> None:
        try:
            await self._conn.eval(_RELEASE_SCRIPT, 1, LEASE_KEY, token)
        except Exception:  # pragma: no cover - 关停阶段 Redis 已断也无需报错
            pass
