"""仓库抽象.

仓库只负责「取原始数据」, 轻量化在服务层统一处理,
这样内存实现与 PostGIS 实现的行为完全一致.
"""

from __future__ import annotations

from typing import Any, Protocol


class Repository(Protocol):
    kind: str

    async def park(self) -> dict[str, Any]: ...

    async def layer(
        self, key: str, bbox: tuple[float, float, float, float] | None = None
    ) -> dict[str, Any]: ...

    async def raw_layers(self) -> dict[str, dict[str, Any]]: ...

    async def building_details(self) -> dict[str, dict[str, Any]]: ...

    async def alarms(self) -> list[dict[str, Any]]: ...

    async def close(self) -> None: ...
