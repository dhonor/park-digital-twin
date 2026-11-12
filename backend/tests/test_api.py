"""接口冒烟测试: 全部走内存仓库, 不依赖数据库."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_park_and_layers():
    with TestClient(app) as client:
        park = client.get("/api/park").json()
        assert park["name"] == "云创智谷"
        assert len(park["boundary"][0]) == 5

        catalog = client.get("/api/layers").json()
        keys = {item["key"] for item in catalog["layers"]}
        assert {"buildings", "devices", "pipes"} <= keys
        assert len(catalog["lods"]) == 3


def test_layer_lod_reduces_payload():
    with TestClient(app) as client:
        lod0 = client.get("/api/layers/buildings", params={"lod": 0}).json()
        lod2 = client.get("/api/layers/buildings", params={"lod": 2}).json()
        assert lod0["_lightweight"]["bytes"]["output"] < lod2["_lightweight"]["bytes"]["output"]
        assert len(lod0["features"]) == 12
        assert "gfa_m2" not in lod0["features"][0]["properties"]


def test_devices_filters_and_summary():
    with TestClient(app) as client:
        all_devices = client.get("/api/devices", params={"lod": 2}).json()
        assert all_devices["summary"]["total"] > 100
        only_cameras = client.get("/api/devices", params={"type": "camera"}).json()
        assert all(f["properties"]["type"] == "camera" for f in only_cameras["features"])


def test_building_detail_and_command():
    with TestClient(app) as client:
        detail = client.get("/api/buildings/B01").json()
        assert detail["name"] == "研发一号楼"
        assert len(detail["floor_list"]) == 12
        assert detail["device_summary"]["total"] > 0

        device_id = detail["devices"][0]["id"]
        resp = client.post(f"/api/devices/{device_id}/command", json={"action": "restart"}).json()
        assert resp["ok"] is True


def test_overview_and_alarms():
    with TestClient(app) as client:
        overview = client.get("/api/overview").json()
        assert len(overview["kpi"]) >= 5
        assert len(overview["energy"]["curve"]) == 24

        alarms = client.get("/api/alarms").json()
        assert alarms["count"] >= 1
        alarm_id = alarms["items"][0]["id"]
        assert client.post(f"/api/alarms/{alarm_id}/ack").json()["ok"] is True


def test_device_layer_carries_live_state():
    """设备图层必须叠加实时状态, 否则首屏点位颜色与顶部 KPI 对不上.

    用反控把某个设备的值改掉, 再拉图层 —— 只有合并过遥测才能看到新值。
    """
    with TestClient(app) as client:
        layer = client.get("/api/layers/devices", params={"lod": 2}).json()
        sample = layer["features"][0]["properties"]
        metric = sample["metric"]
        target = round(metric["min"] + (metric["max"] - metric["min"]) * 0.5, 2)

        resp = client.post(
            f"/api/devices/{sample['id']}/command",
            json={"action": "set", "value": target},
        )
        assert resp.json()["ok"] is True

        fresh = client.get("/api/layers/devices", params={"lod": 2}).json()["features"]
        hit = next(f["properties"] for f in fresh if f["properties"]["id"] == sample["id"])
        assert hit["metric"]["value"] == target


def test_telemetry_merge_does_not_touch_repository():
    """实时值合并必须返回新对象: 原地改会污染仓库缓存, 让轻量化指标每次都变."""
    from app.services.telemetry import TelemetryService

    service = TelemetryService(repo=None)
    service._state["DEV-X"] = {"status": "alarm", "metric": {"value": 9.9}, "ts": "t"}

    feature = {"type": "Feature", "properties": {"id": "DEV-X", "status": "normal"}}
    merged = service.merge([feature])

    assert merged[0]["properties"]["status"] == "alarm"
    assert feature["properties"]["status"] == "normal"


def test_energy_summary_reports_single_range():
    """之前声明支持 7d 却返回同一份 24h 数据, 现在如实只报 24h."""
    with TestClient(app) as client:
        data = client.get("/api/energy/summary", params={"range": "7d"}).json()
        assert data["range"] == "24h"
        assert len(data["campus_curve"]) == 24


def test_buildings_split_alarm_counts():
    """待处置告警(事件) 与 告警设备(状态) 要分开计数, 相加会重复."""
    with TestClient(app) as client:
        items = client.get("/api/buildings").json()["items"]
        first = items[0]
        assert isinstance(first["alarm_count"], int)
        assert isinstance(first["alarm_device_count"], int)


def test_alarm_ack_writes_through_repository():
    """确认状态必须经过仓库, 否则换副本/重启就丢.

    这里用「新建一个 AlarmService 再读」来模拟另一个副本, 不依赖 Redis/PG。
    """
    import asyncio

    from app.repository.memory import MemoryRepository
    from app.services.alarms import AlarmService
    from app.services.telemetry import TelemetryService

    repo = MemoryRepository()

    async def case():
        service = AlarmService(repo, TelemetryService(repo))
        await service.load()
        target = (await service.items())[0]["id"]
        assert target not in await repo.alarm_acks()

        await service.ack(target, "2026-11-10T12:00:00+08:00")

        # 另一个实例（等价于另一个副本 / 重启后）应当能看到这条确认
        other = AlarmService(repo, TelemetryService(repo))
        await other.load()
        return next(item for item in await other.items() if item["id"] == target)

    assert asyncio.run(case())["status"] == "acked"


def test_runtime_alarm_shared_to_other_replicas():
    """运行期告警由 leader 生成, 其他副本靠广播补齐, 否则两副本列表条数不同."""
    from app.services.telemetry import TelemetryService

    follower = TelemetryService(repo=None)
    event = {
        "id": "ALM-RT-9001",
        "level": "critical",
        "title": "x",
        "device_id": "DEV-X",
        "status": "open",
        "ts": "2026-11-10T12:00:00+08:00",
    }

    follower._deliver({"type": "alarm", "ts": event["ts"], "alarm": event})
    follower._deliver({"type": "alarm", "ts": event["ts"], "alarm": event})  # 重复广播不应重复入列

    assert [item["id"] for item in follower.recent_events()] == ["ALM-RT-9001"]


def test_lightweight_report():
    with TestClient(app) as client:
        report = client.get("/api/lightweight/report").json()
        assert len(report["lods"]) == 3
        for item in report["lods"]:
            assert item["total"]["bytes_output"] <= item["total"]["bytes_source"]
