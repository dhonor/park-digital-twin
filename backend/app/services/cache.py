"""轻量化结果缓存.

同一 LOD + 同一图层的响应会被大屏反复拉取, 缓存掉重复的抽稀与序列化。
两种后端, **键空间完全一致**（`layer:{key}:{lod}:{bbox}:{limit}`）:

* `MemoryCache` —— 进程内 TTL + LRU 淘汰, 单机默认;
* `RedisCache`  —— 多副本共享, 命中率不被副本数除。

接口是 async 的: 内存实现内部是纯计算, 但调用方（路由）必须统一写法,
否则切换后端时要改一遍业务代码。
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any


class MemoryCache:
    def __init__(self, ttl: float = 30.0, max_items: int = 512) -> None:
        self._ttl = ttl
        self._max = max_items
        #: OrderedDict 按访问顺序维护, 淘汰时直接 popitem(last=False) 取最久未使用项
        self._store: OrderedDict[str, tuple[float, Any]] = OrderedDict()

    async def get(self, key: str) -> Any | None:
        item = self._store.get(key)
        if not item:
            return None
        expires_at, value = item
        if expires_at < time.monotonic():
            self._store.pop(key, None)
            return None
        self._store.move_to_end(key)
        return value

    async def set(self, key: str, value: Any) -> None:
        # 之前用 min(...) 遍历全表找"最早过期": 每次写入都是 O(n), 且不是真的 LRU
        self._store[key] = (time.monotonic() + self._ttl, value)
        self._store.move_to_end(key)
        while len(self._store) > self._max:
            self._store.popitem(last=False)

    async def clear(self) -> None:
        self._store.clear()


class RedisCache:
    def __init__(self, bus: Any, ttl: float = 30.0) -> None:
        self._bus = bus
        self._ttl = ttl

    async def get(self, key: str) -> Any | None:
        return await self._bus.cache_get(key)

    async def set(self, key: str, value: Any) -> None:
        await self._bus.cache_set(key, value, self._ttl)

    async def clear(self) -> None:
        # Redis 侧按 TTL 自然过期, 不做全量 flush（多租户时 flush 会误伤）
        return None


def build_cache(ttl: float, bus: Any | None = None) -> MemoryCache | RedisCache:
    return RedisCache(bus, ttl) if bus is not None else MemoryCache(ttl)
