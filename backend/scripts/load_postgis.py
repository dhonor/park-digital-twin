"""把 data/*.geojson 导入 PostGIS.

用法:
    set DATABASE_URL=postgresql://park:park@localhost:5432/park_twin
    python backend/scripts/load_postgis.py

说明: 导入的是「原始要素」, LOD 轻量化在服务层实时生成,
      数据库里永远只存一份数据 —— 这是数据轻量化的第一条纪律.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
PROJECT = BACKEND.parent
sys.path.insert(0, str(BACKEND))

from app.domain.catalog import LAYERS  # noqa: E402

DSN = os.getenv("DATABASE_URL", "postgresql://park:park@localhost:5432/park_twin")
DATA = Path(os.getenv("PARK_DATA_DIR", PROJECT / "data"))


async def main() -> None:
    try:
        import asyncpg
    except ImportError:
        raise SystemExit("请先安装依赖: pip install asyncpg")

    schema = (BACKEND / "sql" / "001_schema.sql").read_text(encoding="utf-8")
    conn = await asyncpg.connect(dsn=DSN)
    try:
        await conn.execute(schema)
        print("schema ok")

        park = json.loads((DATA / "park.json").read_text(encoding="utf-8"))
        await conn.execute(
            "INSERT INTO dt_park (id, detail) VALUES ($1, $2) "
            "ON CONFLICT (id) DO UPDATE SET detail = EXCLUDED.detail",
            park["id"],
            json.dumps(park, ensure_ascii=False),
        )

        total = 0
        for key, defn in LAYERS.items():
            fc = json.loads((DATA / defn.source_file).read_text(encoding="utf-8"))
            await conn.execute("DELETE FROM dt_layer_feature WHERE layer_key = $1", key)
            rows = [
                (
                    key,
                    str(feature.get("id") or feature["properties"].get("id") or f"{key}-{i}"),
                    json.dumps(feature.get("properties") or {}, ensure_ascii=False),
                    json.dumps(feature["geometry"], ensure_ascii=False, separators=(",", ":")),
                )
                for i, feature in enumerate(fc.get("features", []))
            ]
            await conn.executemany(
                "INSERT INTO dt_layer_feature (layer_key, feat_id, props, geom) "
                "VALUES ($1, $2, $3, ST_Force3D(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))) "
                "ON CONFLICT (layer_key, feat_id) DO UPDATE SET props = EXCLUDED.props, geom = EXCLUDED.geom",
                rows,
            )
            total += len(rows)
            print(f"  {key:10s} {len(rows):5d} 要素")

        details = json.loads((DATA / "building_details.json").read_text(encoding="utf-8"))
        await conn.executemany(
            "INSERT INTO dt_building_detail (id, detail) VALUES ($1, $2) "
            "ON CONFLICT (id) DO UPDATE SET detail = EXCLUDED.detail",
            [(bid, json.dumps(detail, ensure_ascii=False)) for bid, detail in details.items()],
        )

        alarms = json.loads((DATA / "alarms.json").read_text(encoding="utf-8"))
        # asyncpg 的 timestamptz 参数必须是 datetime 对象, 传字符串会被直接拒绝。
        # 关键: 只删「源里已经不存在的告警」, 绝不 DELETE 全表 ——
        # 否则容器每次重启都会把已确认状态(acked_at)一起抹掉。
        await conn.execute(
            "DELETE FROM dt_alarm WHERE NOT (id = ANY($1::text[]))",
            [a["id"] for a in alarms],
        )
        await conn.executemany(
            "INSERT INTO dt_alarm (id, ts, detail) VALUES ($1, $2, $3) "
            "ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts, detail = EXCLUDED.detail",
            [
                (a["id"], datetime.fromisoformat(a["ts"]), json.dumps(a, ensure_ascii=False))
                for a in alarms
            ],
        )

        print(f"导入完成: {total} 要素 / {len(details)} 栋 / {len(alarms)} 条告警")
        print("启动后端时设置 DATABASE_URL 即自动切换 PostGIS 仓库")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
