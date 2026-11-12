"""PostGIS 仓库集成测试.

没有数据库时整组自动跳过, 不影响 CI/本地默认流程.
本地验证:

    docker compose up -d postgis
    set DATABASE_URL=postgresql://park:park@localhost:5432/park_twin
    python backend/scripts/load_postgis.py
    pytest backend/tests/test_postgis.py

这一组测的是「切库后仓库行为是否与内存仓库一致」—— 这是唯一一条
线上会用、但演示环境默认不会走到的路径, 不测就等于没实现。
"""

from __future__ import annotations

import asyncio
import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="未配置 DATABASE_URL, 跳过 PostGIS 集成测试",
)

asyncpg = pytest.importorskip("asyncpg", reason="未安装 asyncpg")


async def _open() -> "object":
    from app.repository.postgis import PostGISRepository

    repo = PostGISRepository(os.environ["DATABASE_URL"])
    try:
        await repo.connect()
    except Exception as exc:  # noqa: BLE001 - 连不上就跳过, 不让默认流程变红
        pytest.skip(f"PostGIS 不可用: {exc}")
    return repo


def _run(coro_factory):
    async def _wrap():
        repo = await _open()
        try:
            return await coro_factory(repo)
        finally:
            await repo.close()

    return asyncio.run(_wrap())


def test_postgis_park_matches_memory():
    async def case(repo):
        return await repo.park()

    park = _run(case)
    assert park["id"] == "park-yczg"
    assert park["name"] == "云创智谷"
    assert isinstance(park["boundary"][0], list)
    assert len(park["boundary"][0]) >= 3


def test_postgis_layers_keep_shape_and_3d():
    """图层要素数、几何结构必须与内存仓库一致, 且高程不能丢."""
    from app.domain.catalog import LAYERS
    from app.repository.memory import MemoryRepository

    async def case(repo):
        return {key: await repo.layer(key) for key in LAYERS}

    layers = _run(case)
    memory = MemoryRepository()

    for key, defn in LAYERS.items():
        got = layers[key]["features"]
        expected = asyncio.run(memory.layer(key))["features"]
        assert len(got) == len(expected), f"{key} 要素数不一致"
        assert got[0]["geometry"]["type"] == expected[0]["geometry"]["type"]

    device = layers["devices"]["features"][0]["geometry"]["coordinates"]
    assert len(device) == 3, "设备点位丢了高程(Z), 前端会全部贴地"
    assert device[2] > 0

    building = layers["buildings"]["features"][0]["geometry"]["coordinates"][0][0]
    assert len(building) >= 2


def test_postgis_building_details_and_alarms():
    async def case(repo):
        details = await repo.building_details()
        alarms = await repo.alarms()
        return details, alarms

    details, alarms = _run(case)

    assert len(details) == 12
    b01 = details["B01"]
    assert isinstance(b01, dict), "building_details 必须解析成 dict, 否则 /api/buildings/{id} 会 500"
    assert b01["name"] == "研发一号楼"
    assert len(b01["floor_list"]) == 12

    assert alarms and all(isinstance(item, dict) for item in alarms)
    assert {"id", "level", "status"} <= set(alarms[0])


def test_postgis_raw_layers_matches_layer_count():
    """轻量化报告依赖 raw_layers, 切库后不能少层."""

    async def case(repo):
        raw = await repo.raw_layers()
        return {key: len(fc.get("features", [])) for key, fc in raw.items()}

    counts = _run(case)
    assert set(counts) == {"boundary", "buildings", "roads", "green", "trees", "pipes", "devices"}
    assert counts["devices"] == 200
    assert counts["buildings"] == 12
