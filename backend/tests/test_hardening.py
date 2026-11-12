"""P0/P1 加固项回归测试.

覆盖本轮改动的四类行为:
  1. 设备详情直查与图层数据一致(不再复制整层要素);
  2. 反控/告警确认的非法输入返回 4xx 而不是 500;
  3. 视口筛选按外包框相交判定, 长线要素不会被误删;
  4. 图层目录与轻量化报告是缓存结果, 重复请求不再重算.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.services.lightweight import bbox_intersects


def test_device_detail_matches_layer_props():
    with TestClient(app) as client:
        layer = client.get("/api/layers/devices", params={"lod": 2}).json()
        sample = layer["features"][0]["properties"]

        detail = client.get(f"/api/devices/{sample['id']}").json()
        assert detail["id"] == sample["id"]
        assert detail["metric"]["value"] == sample["metric"]["value"]
        assert detail["status"] == sample["status"]


def test_unknown_device_is_404_not_500():
    with TestClient(app) as client:
        assert client.get("/api/devices/DEV-NOT-EXIST").status_code == 404
        assert (
            client.post("/api/devices/DEV-NOT-EXIST/command", json={"action": "restart"}).status_code
            == 404
        )


def test_command_payload_is_validated():
    with TestClient(app) as client:
        device_id = client.get("/api/layers/devices", params={"lod": 2}).json()["features"][0][
            "properties"
        ]["id"]

        # 未知动作在入口被拦成 422, 之前是被静默接受
        bad_action = client.post(f"/api/devices/{device_id}/command", json={"action": "explode"})
        assert bad_action.status_code == 422

        # 非数值 value 之前会抛 ValueError → 500
        bad_value = client.post(
            f"/api/devices/{device_id}/command", json={"action": "set", "value": "abc"}
        )
        assert bad_value.status_code == 422


def test_ack_unknown_alarm_is_404():
    with TestClient(app) as client:
        assert client.post("/api/alarms/ALM-NOT-EXIST/ack").status_code == 404


def test_bbox_keeps_line_crossing_viewport():
    """跨视口的长线: 顶点均值在视口外, 外包框却相交 —— 必须保留."""
    geometry = {"type": "LineString", "coordinates": [[0.0, 0.0], [10.0, 0.0]]}
    assert not (8.0 <= 5.0 <= 9.0)  # 均值判定会漏掉它
    assert bbox_intersects(geometry, (8.0, -1.0, 9.0, 1.0)) is True
    # 完全在视口外的要素仍然被剔除
    assert bbox_intersects(geometry, (20.0, 20.0, 21.0, 21.0)) is False


def test_ws_hello_payload():
    """实时通道协议: 连接即下发 hello, 前端首屏依赖它拿设备快照与 KPI."""
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws/realtime") as ws:
            hello = ws.receive_json()
    assert hello["type"] == "hello"
    assert len(hello["devices"]) > 100
    assert "overview" in hello
    assert {item["lod"] for item in hello["lods"]} == {0, 1, 2}


def test_catalog_and_report_are_cached():
    with TestClient(app) as client:
        first = client.get("/api/layers").json()
        assert app.state.layer_catalog is not None
        second = client.get("/api/layers").json()
        assert first == second

        one = client.get("/api/lightweight/report", params={"lod": 1}).json()
        assert set(app.state.lightweight_reports) == {1}
        # 只请求 LOD1 时不应连带算 LOD0/LOD2
        again = client.get("/api/lightweight/report", params={"lod": 1}).json()
        assert one == again

        full = client.get("/api/lightweight/report").json()
        assert len(full["lods"]) == 3
        assert set(app.state.lightweight_reports) == {0, 1, 2}
