"""PostGIS 仓库 (演进阶段).

启用条件: .env 里配置 DATABASE_URL=postgresql://...
数据由 backend/scripts/load_postgis.py 导入, 表结构见 backend/sql/001_schema.sql.

设计取舍: 统一把各图层收敛到一张 `dt_layer_feature` 表 (几何 + jsonb 属性),
园区级数据量下比"一层一表"更好维护, 也便于统一做 ST_Simplify 与索引优化;
真正出现性能瓶颈时再按图层拆表或切矢量瓦片 (见 docs/02-演进路线.md).
"""

from __future__ import annotations

import json
from typing import Any

from ..domain.catalog import LAYERS
from ..repository.base import Repository


class PostGISRepository:
    kind = "postgis"

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: Any = None

    async def connect(self) -> None:
        try:
            import asyncpg  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "使用 PostGIS 仓库需要安装依赖: pip install asyncpg"
            ) from exc
        self._pool = await asyncpg.create_pool(dsn=self._dsn, min_size=1, max_size=8)

    async def _fetchval(self, sql: str, *args: Any) -> Any:
        assert self._pool is not None, "PostGIS 连接池未初始化"
        async with self._pool.acquire() as conn:
            return await conn.fetchval(sql, *args)

    async def _fetch(self, sql: str, *args: Any) -> list[Any]:
        assert self._pool is not None, "PostGIS 连接池未初始化"
        async with self._pool.acquire() as conn:
            return await conn.fetch(sql, *args)

    # ------------------------------------------------------------ 接口
    async def park(self) -> dict[str, Any]:
        row = await self._fetchval("SELECT detail FROM dt_park WHERE id = $1", "park-yczg")
        if not row:
            raise RuntimeError("dt_park 为空, 请先执行导入脚本")
        return json.loads(row)

    async def layer(
        self, key: str, bbox: tuple[float, float, float, float] | None = None
    ) -> dict[str, Any]:
        if key not in LAYERS:
            raise KeyError(key)
        # 视口条件在 SQL 里下推: 有 GIST 索引时只取相交的要素, 不必整层搬回 Python 过滤.
        # 这里**不做** ST_Simplify: 轻量化降幅必须由服务层对同一份原始数据实测得出,
        # 提前在库里抽稀会让「降幅指标」失真, 也无法在不同 LOD 间复用同一份缓存.
        where = "f.layer_key = $1::text"
        args: list[Any] = [key]
        if bbox:
            where += " AND f.geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)"
            args.extend(bbox)
        # $1 同时出现在 jsonb_build_object 与 WHERE 中时必须显式转型,
        # 否则 Postgres 推断不出参数类型 (AmbiguousParameterError)
        row = await self._fetchval(
            f"""
            SELECT jsonb_build_object(
                     'type', 'FeatureCollection',
                     'name', $1::text,
                     'features', coalesce(jsonb_agg(
                        jsonb_build_object(
                          'type', 'Feature',
                          'id', f.feat_id,
                          'geometry', ST_AsGeoJSON(f.geom)::jsonb,
                          'properties', f.props
                        ) ORDER BY f.feat_id
                     ), '[]'::jsonb))
            FROM dt_layer_feature f
            WHERE {where}
            """,
            *args,
        )
        return json.loads(row or '{"type":"FeatureCollection","features":[]}')

    async def raw_layers(self) -> dict[str, dict[str, Any]]:
        """七层一次取回: 之前是 7 次串行往返 (N+1)."""
        rows = await self._fetch(
            """
            SELECT f.layer_key AS key,
                   coalesce(jsonb_agg(
                       jsonb_build_object(
                         'type', 'Feature',
                         'id', f.feat_id,
                         'geometry', ST_AsGeoJSON(f.geom)::jsonb,
                         'properties', f.props
                       ) ORDER BY f.feat_id
                   ), '[]'::jsonb) AS features
            FROM dt_layer_feature f
            GROUP BY f.layer_key
            """
        )
        out: dict[str, dict[str, Any]] = {}
        for row in rows:
            key = row["key"]
            if key not in LAYERS:
                continue
            features = row["features"]
            # jsonb 列在 asyncpg 里是字符串, 不解码会让下游拿到 str 而不是 list
            if isinstance(features, str):
                features = json.loads(features)
            out[key] = {"type": "FeatureCollection", "name": key, "features": features}
        for key in LAYERS:  # 库里可能还没导入某些图层, 键集合要与接口约定保持一致
            out.setdefault(key, {"type": "FeatureCollection", "name": key, "features": []})
        return out

    async def building_details(self) -> dict[str, dict[str, Any]]:
        assert self._pool is not None, "PostGIS 连接池未初始化"
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("SELECT id, detail FROM dt_building_detail")
        # jsonb 列取回来是字符串, 不解析会让 /api/buildings/{id} 直接 500
        return {
            row["id"]: (json.loads(row["detail"]) if isinstance(row["detail"], str) else row["detail"])
            for row in rows
        }

    async def alarms(self) -> list[dict[str, Any]]:
        assert self._pool is not None, "PostGIS 连接池未初始化"
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("SELECT detail FROM dt_alarm ORDER BY ts DESC LIMIT 200")
        return [
            json.loads(row["detail"]) if isinstance(row["detail"], str) else row["detail"]
            for row in rows
        ]

    async def alarm_acks(self) -> dict[str, str]:
        assert self._pool is not None, "PostGIS 连接池未初始化"
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT id, acked_at FROM dt_alarm WHERE acked_at IS NOT NULL"
            )
        return {
            row["id"]: row["acked_at"].isoformat(timespec="seconds")
            for row in rows
        }

    async def set_alarm_ack(self, alarm_id: str, ts: str) -> None:
        assert self._pool is not None, "PostGIS 连接池未初始化"
        from datetime import datetime

        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE dt_alarm SET acked_at = $2 WHERE id = $1",
                alarm_id,
                datetime.fromisoformat(ts),
            )

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None
