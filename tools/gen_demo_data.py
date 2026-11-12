"""园区数字孪生演示数据生成器.

生成一套「可复现」的园区级数据: 边界 / 建筑体块 / 路网 / 绿地水系 /
综合管网 / 物联设备点位 / 楼栋明细 / 能耗曲线 / 告警种子.

设计要点: 数据本身即轻量 (GeoJSON + 点/线/面), 不含 BIM/CAD 原始模型,
后续所有渲染优化都建立在"数据已减面"的前提上.

用法: python tools/gen_demo_data.py
"""

from __future__ import annotations

import json
import math
import random
from collections.abc import Mapping
from pathlib import Path
from typing import TypedDict

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

# 园区锚点: 杭州城西某科创园 (虚构园区, 坐标为演示用)
LON0, LAT0 = 120.0755, 30.2791
GROUND = 8.0  # 园区基准标高 (米), 用于 Cesium 拉伸
M_PER_DEG_LAT = 111_320.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))

PARK_W, PARK_H = 760.0, 620.0  # 园区范围 (米)

rng = random.Random(20261110)


# ---------------------------------------------------------------- 数据结构
# 生成器全程只产出「字典 -> JSON」, 用 TypedDict 把字段形状固化:
# 类型检查器能查到每个字段, 运行时仍是普通 dict, 不影响序列化.
class Metric(TypedDict):
    """设备测点的当前值与量程, 前端量程条直接用这两个边界."""

    key: str
    unit: str
    value: float
    min: float
    max: float


class Building(TypedDict):
    """楼栋台账: 几何(poly)与业务属性分开, 几何只用于拉伸体块."""

    id: str
    name: str
    type: str
    type_label: str
    color: str
    height: float
    floors: int
    floor_height: float
    poly: list[tuple[float, float]]
    centroid: tuple[float, float]
    area_m2: float
    gfa_m2: float
    desc: str
    year: int


class Device(TypedDict):
    """设备台账: 室外设备的 building_id 为 None, floor 为 0."""

    id: str
    name: str
    type: str
    type_label: str
    building_id: str | None
    floor: int
    lon: float
    lat: float
    altitude: float
    status: str
    metric: Metric
    install_date: str


# ---------------------------------------------------------------- 坐标换算
def ll(x: float, y: float, alt: float | None = None) -> list[float]:
    """局部米制坐标 -> 经纬度."""
    lon = round(LON0 + x / M_PER_DEG_LON, 7)
    lat = round(LAT0 + y / M_PER_DEG_LAT, 7)
    return [lon, lat] if alt is None else [lon, lat, alt]


def ring(points: list[tuple[float, float]]) -> list[list[float]]:
    coords = [ll(x, y, GROUND) for x, y in points]
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    return coords


def rect(x: float, y: float, w: float, h: float) -> list[tuple[float, float]]:
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]


def inset(x: float, y: float, w: float, h: float, d: float) -> tuple[float, float, float, float]:
    return x + d, y + d, w - 2 * d, h - 2 * d


def inside(poly: list[tuple[float, float]], px: float, py: float) -> bool:
    """射线法判断点是否在多边形内."""
    hit = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > py) != (y2 > py):
            xt = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
            if xt > px:
                hit = not hit
    return hit


def centroid(poly: list[tuple[float, float]]) -> tuple[float, float]:
    a = cx = cy = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        cross = x1 * y2 - x2 * y1
        a += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    if abs(a) < 1e-9:
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        return sum(xs) / n, sum(ys) / n
    a *= 0.5
    return cx / (6 * a), cy / (6 * a)


def area_m2(poly: list[tuple[float, float]]) -> float:
    s = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def smooth_blob(
    cx: float, cy: float, rx: float, ry: float, count: int = 56, wobble: float = 0.1
) -> list[tuple[float, float]]:
    """自然水体轮廓: 椭圆 + 低阶谐波扰动, 顶点多且无随机数.

    之所以要有这种「真实曲线」: 全是轴对齐矩形的话, 8m 抽稀看不出任何变化,
    轻量化效果就没法在界面上被看见。
    """
    pts: list[tuple[float, float]] = []
    for i in range(count):
        t = 2 * math.pi * i / count
        r = 1 + wobble * math.sin(3 * t + 0.7) + 0.45 * wobble * math.sin(5 * t + 2.1)
        pts.append((cx + rx * r * math.cos(t), cy + ry * r * math.sin(t)))
    return pts


def rounded_loop(x: float, y: float, w: float, h: float, radius: float, seg: int = 10) -> list[tuple[float, float]]:
    """圆角矩形环路: 4 段 1/4 圆弧串联, 转角用多顶点逼近真实转弯."""
    arcs = [
        (x + w - radius, y + radius, -90.0, 0.0),
        (x + w - radius, y + h - radius, 0.0, 90.0),
        (x + radius, y + h - radius, 90.0, 180.0),
        (x + radius, y + radius, 180.0, 270.0),
    ]
    pts: list[tuple[float, float]] = []
    for cx, cy, a0, a1 in arcs:
        for i in range(seg + 1):
            a = math.radians(a0 + (a1 - a0) * i / seg)
            pts.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    pts.append(pts[0])
    return pts


# ---------------------------------------------------------------- 建筑台账
# (id, 名称, 类型, 地块, 层数, 高度m, 业态说明)
BUILDINGS = [
    ("B01", "研发一号楼", "office", (45, 450, 180, 105), 12, 48.0, "研发办公 / 共享会议"),
    ("B02", "研发二号楼", "office", (270, 450, 100, 105), 9, 36.0, "研发办公"),
    ("B03", "实验楼", "lab", (395, 450, 100, 105), 6, 27.0, "材料实验 / 检测中心"),
    ("B04", "数据中心", "datacenter", (540, 450, 175, 105), 4, 22.0, "A级机房 / 网络核心"),
    ("B05", "综合服务楼", "service", (45, 285, 180, 120), 5, 21.0, "园区服务 / 物业办公"),
    ("B06", "会议中心", "conference", (270, 285, 105, 120), 3, 15.0, "学术报告 / 路演"),
    ("B07", "能源中心", "energy", (390, 285, 110, 120), 2, 12.0, "冷热源 / 配电"),
    ("B08", "员工食堂", "canteen", (540, 285, 175, 120), 2, 10.0, "餐饮 / 后厨"),
    ("B09", "人才公寓A", "residential", (45, 120, 180, 135), 15, 54.0, "人才公寓"),
    ("B10", "人才公寓B", "residential", (270, 120, 105, 135), 15, 54.0, "人才公寓"),
    ("B11", "健身中心", "gym", (395, 120, 110, 135), 2, 14.0, "健身房 / 球场"),
    ("B12", "停车楼", "parking", (540, 120, 175, 135), 4, 15.0, "P1 立体车库"),
]

TYPE_COLOR = {
    "office": "#2E7DF7",
    "lab": "#7C5CFF",
    "datacenter": "#00C2A8",
    "service": "#F0A63A",
    "conference": "#3AA0F0",
    "energy": "#F2653A",
    "canteen": "#56C271",
    "residential": "#4FA8E0",
    "gym": "#9AD34F",
    "parking": "#8A94A6",
}

TYPE_LABEL = {
    "office": "研发办公",
    "lab": "实验检测",
    "datacenter": "数据中心",
    "service": "园区服务",
    "conference": "会议交流",
    "energy": "能源动力",
    "canteen": "生活配套",
    "residential": "人才公寓",
    "gym": "文体设施",
    "parking": "交通停车",
}

TYPE_FACTOR = {  # 单位面积日均能耗 kWh/m2
    "office": 0.09,
    "lab": 0.16,
    "datacenter": 0.62,
    "service": 0.08,
    "conference": 0.10,
    "energy": 0.20,
    "canteen": 0.18,
    "residential": 0.05,
    "gym": 0.11,
    "parking": 0.03,
}


def footprint(bid: str, plot: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    """建筑轮廓.

    刻意让一部分楼栋带折角/切角: 全是轴对齐矩形时, LOD0 的 8m 抽稀 + 包络框
    看不出任何变化, 「视图精度」就成了一个没有观感的功能。
    """
    x, y, w, h = inset(*plot, 10)
    if bid == "B01":  # L 形体块
        cut = min(w * 0.42, 62.0)
        return [
            (x, y),
            (x + w, y),
            (x + w, y + h * 0.42),
            (x + cut, y + h * 0.42),
            (x + cut, y + h),
            (x, y + h),
        ]
    if bid in ("B02", "B05", "B09"):  # 切角体块
        c = min(w, h) * 0.18
        return [
            (x + c, y),
            (x + w - c, y),
            (x + w, y + c),
            (x + w, y + h - c),
            (x + w - c, y + h),
            (x + c, y + h),
            (x, y + h - c),
            (x, y + c),
        ]
    if bid in ("B03", "B10"):  # 折角体块
        return [
            (x, y),
            (x + w, y),
            (x + w, y + h * 0.55),
            (x + w * 0.62, y + h * 0.55),
            (x + w * 0.62, y + h),
            (x, y + h),
        ]
    return rect(x, y, w, h)


# ---------------------------------------------------------------- 设备台账
# 类型 -> (显示名, 计量单位, 指标 key, 指标单位, 量程下限, 量程上限)
# 显式标注元组形状, 解包后每个变量才有确定类型 (否则六元组统一退化成 str | float).
DEVICE_TYPES: dict[str, tuple[str, str, str, str, float, float]] = {
    "hvac": ("暖通机组", "台", "power", "kW", 12.0, 96.0),
    "meter": ("智能电表", "只", "power", "kW", 4.0, 46.0),
    "water": ("远传水表", "只", "flow", "m³/h", 0.2, 6.5),
    "env": ("环境传感器", "只", "temp", "℃", 21.0, 28.5),
    "camera": ("安防摄像机", "路", "fps", "fps", 24.0, 25.0),
    "elevator": ("电梯", "部", "load", "%", 2.0, 68.0),
    "fire": ("消防探测器", "只", "smoke", "%obs/m", 0.0, 3.0),
    "charge": ("充电桩", "个", "power", "kW", 0.0, 60.0),
    "parking": ("车位感知", "个", "occupied", "%", 0.0, 100.0),
    "light": ("智能照明", "回路", "brightness", "%", 0.0, 100.0),
}

STATUS_POOL = ["normal"] * 16 + ["warning"] * 3 + ["alarm"] + ["offline"]


def device_status() -> str:
    return rng.choice(STATUS_POOL)


def make_devices(buildings: list[Building]) -> list[Device]:
    devices: list[Device] = []
    seq = 0
    for b in buildings:
        bid, bname, btype, height, floors, poly = (
            b["id"],
            b["name"],
            b["type"],
            b["height"],
            b["floors"],
            b["poly"],
        )
        plan = {
            "datacenter": ["hvac", "hvac", "meter", "meter", "env", "env", "fire", "fire", "camera", "elevator"],
            "residential": ["meter", "meter", "water", "env", "fire", "elevator", "light"],
            "parking": ["camera", "parking", "parking", "parking", "charge", "charge", "light"],
            "energy": ["hvac", "hvac", "hvac", "meter", "meter", "water", "fire", "camera"],
            "canteen": ["hvac", "meter", "water", "env", "fire", "light", "camera"],
        }.get(btype, ["hvac", "meter", "water", "env", "fire", "light", "camera", "elevator"])

        for i, dtype in enumerate(plan):
            label, unit, metric, munit, lo, hi = DEVICE_TYPES[dtype]
            for f in range(min(floors, 4) if dtype in ("env", "fire", "meter") else 1):
                seq += 1
                floor = 1 + (i + f * 3) % floors
                x0, y0, w0, h0 = (
                    min(p[0] for p in poly),
                    min(p[1] for p in poly),
                    max(p[0] for p in poly) - min(p[0] for p in poly),
                    max(p[1] for p in poly) - min(p[1] for p in poly),
                )
                # 兜底取形心: 24 次采样都落空时 (仅凹多边形可能), 点位仍在楼内
                px, py = centroid(poly)
                for _ in range(24):
                    px = x0 + rng.random() * w0
                    py = y0 + rng.random() * h0
                    if inside(poly, px, py):
                        break
                status = device_status()
                value = round(rng.uniform(lo, hi), 2)
                if status == "offline":
                    value = 0.0
                elif status == "alarm":
                    value = round(hi * rng.uniform(0.92, 1.12), 2)
                devices.append(
                    {
                        "id": f"DEV-{bid}-{seq:03d}",
                        "name": f"{bname}-{label}-{f + 1:02d}",
                        "type": dtype,
                        "type_label": label,
                        "building_id": bid,
                        "floor": floor,
                        "lon": ll(px, py)[0],
                        "lat": ll(px, py)[1],
                        "altitude": round(GROUND + (floor - 0.5) * (height / floors), 2),
                        "status": status,
                        "metric": {
                            "key": metric,
                            "unit": munit,
                            "value": value,
                            "min": lo,
                            "max": hi,
                        },
                        "install_date": f"202{3 + seq % 3}-{(seq % 12) + 1:02d}-{(seq % 27) + 1:02d}",
                    }
                )

    # 室外设备: 周界摄像机 / 环境监测 / 充电桩 / 车位
    outdoor = [
        ("camera", "周界摄像机", 30.0, 30.0),
        ("camera", "周界摄像机", 730.0, 30.0),
        ("camera", "周界摄像机", 30.0, 590.0),
        ("camera", "周界摄像机", 730.0, 590.0),
        ("camera", "主入口摄像机", 380.0, 26.0),
        ("env", "室外环境站", 300.0, 60.0),
        ("env", "室外环境站", 640.0, 60.0),
        ("env", "室外环境站", 245.0, 580.0),
        ("charge", "快充桩", 600.0, 95.0),
        ("charge", "快充桩", 620.0, 95.0),
        ("charge", "慢充桩", 645.0, 95.0),
        ("light", "路灯回路", 245.0, 500.0),
        ("light", "路灯回路", 520.0, 300.0),
    ]
    for dtype, label, px, py in outdoor:
        seq += 1
        _, unit, metric, munit, lo, hi = DEVICE_TYPES[dtype]
        devices.append(
            {
                "id": f"DEV-OUT-{seq:03d}",
                "name": f"{label}-{seq:03d}",
                "type": dtype,
                "type_label": label,
                "building_id": None,
                "floor": 0,
                "lon": ll(px, py)[0],
                "lat": ll(px, py)[1],
                "altitude": round(GROUND + 3.0, 2),
                "status": device_status(),
                "metric": {
                    "key": metric,
                    "unit": munit,
                    "value": round(rng.uniform(lo, hi), 2),
                    "min": lo,
                    "max": hi,
                },
                "install_date": "2025-04-18",
            }
        )
    return devices


# ---------------------------------------------------------------- 组装输出
# coords 允许 Point/LineString/Polygon 三种嵌套深度, 用 object 表达"任意 JSON 值";
# props 用只读 Mapping, 调用方能直接传 TypedDict, 不必先转成可变 dict.
def feature(geom_type: str, coords: object, props: Mapping[str, object]) -> dict[str, object]:
    return {"type": "Feature", "geometry": {"type": geom_type, "coordinates": coords}, "properties": props}


def main() -> None:
    DATA.mkdir(parents=True, exist_ok=True)

    # ---- 建筑
    buildings: list[Building] = []
    for bid, name, btype, plot, floors, height, desc in BUILDINGS:
        poly = footprint(bid, plot)
        area = area_m2(poly)
        cx, cy = centroid(poly)
        buildings.append(
            {
                "id": bid,
                "name": name,
                "type": btype,
                "type_label": TYPE_LABEL[btype],
                "color": TYPE_COLOR[btype],
                "height": height,
                "floors": floors,
                "floor_height": round(height / floors, 2),
                "poly": poly,
                "centroid": (cx, cy),
                "area_m2": round(area, 1),
                "gfa_m2": round(area * floors * 0.92, 1),
                "desc": desc,
                "year": 2019 + (int(bid[1:]) % 5),
            }
        )

    bfc = {
        "type": "FeatureCollection",
        "name": "buildings",
        "features": [
            feature(
                "Polygon",
                [ring(b["poly"])],
                {
                    "id": b["id"],
                    "name": b["name"],
                    "type": b["type"],
                    "type_label": b["type_label"],
                    "height": b["height"],
                    "floors": b["floors"],
                    "area_m2": b["area_m2"],
                    "gfa_m2": b["gfa_m2"],
                    "color": b["color"],
                },
            )
            for b in buildings
        ],
    }

    # ---- 园区边界
    boundary = {
        "type": "FeatureCollection",
        "name": "boundary",
        "features": [
            feature(
                "Polygon",
                [ring(rect(6, 6, PARK_W - 12, PARK_H - 12))],
                {"id": "PARK", "name": "云创智谷", "area_m2": round(PARK_W * PARK_H, 1)},
            )
        ],
    }

    # ---- 路网
    roads = [
        ("RD-01", "园区主环路", "main", rounded_loop(22, 22, 716, 576, 34, 12)),
        ("RD-02", "研发大道", "main", [(22, 435), (738, 435)]),
        ("RD-03", "服务支路", "branch", [(22, 275), (738, 275)]),
        ("RD-04", "东纵路", "branch", [(245, 22), (245, 598)]),
        ("RD-05", "西纵路", "branch", [(520, 22), (520, 598)]),
        ("RD-06", "南环路", "branch", [(22, 78), (738, 78)]),
    ]
    rfc = {
        "type": "FeatureCollection",
        "name": "roads",
        "features": [
            feature("LineString", [ll(x, y) for x, y in pts], {"id": rid, "name": name, "level": lvl})
            for rid, name, lvl, pts in roads
        ],
    }

    # ---- 绿地水系
    green = [
        ("GR-01", "南侧景观绿带", "lawn", rect(30, 30, 700, 40)),
        ("GR-02", "北侧防护绿地", "lawn", rect(30, 562, 700, 34)),
        ("GR-03", "西侧休闲绿地", "lawn", rect(8, 90, 26, 340)),
        ("GR-04", "东侧休闲绿地", "lawn", rect(726, 90, 26, 340)),
        ("GR-05", "中心广场", "plaza", rect(45, 410, 180, 20)),
        ("GR-06", "镜湖", "water", smooth_blob(138, 55, 66, 17, count=56)),
    ]
    gfc = {
        "type": "FeatureCollection",
        "name": "green",
        "features": [
            feature(
                "Polygon",
                [ring(poly)],
                {"id": gid, "name": name, "kind": kind},
            )
            for gid, name, kind, poly in green
        ],
    }

    # ---- 乔木点位 (轻量点位而非模型)
    trees = []
    ti = 0
    for _ in range(240):
        px = rng.uniform(10, PARK_W - 10)
        py = rng.uniform(10, PARK_H - 10)
        if any(inside(b["poly"], px, py) for b in buildings):
            continue
        if not (30 <= py <= 72 or 560 <= py <= 596 or px < 40 or px > 720):
            continue
        ti += 1
        trees.append(
            feature(
                "Point",
                ll(px, py, GROUND + 6),
                {"id": f"T-{ti:03d}", "height": round(rng.uniform(5.0, 9.5), 1), "crown": round(rng.uniform(2.4, 4.6), 1)},
            )
        )
    tfc = {"type": "FeatureCollection", "name": "trees", "features": trees}

    # ---- 综合管网
    pipe_types = [
        ("water", "给水", "#2E9BFF", 1.2),
        ("sewage", "污水", "#8A6B4A", 1.6),
        ("power", "电力", "#F0A63A", 0.9),
        ("network", "网络", "#00C2A8", 0.6),
    ]
    plant = next(b for b in buildings if b["id"] == "B07")
    pfc_features = []
    for pi, (pkey, pname, pcolor, poffset) in enumerate(pipe_types):
        pfc_features.append(
            feature(
                "LineString",
                [ll(plant["centroid"][0] + poffset, plant["centroid"][1] + poffset),
                 ll(plant["centroid"][0] + poffset + 8, plant["centroid"][1] + poffset + 40 + pi * 6)],
                {"id": f"PIPE-{pkey}", "name": f"{pname}干管", "type": pkey, "color": pcolor, "diameter": 200 + pi * 50},
            )
        )
    for bk, b in enumerate(buildings):
        if b["id"] == "B07":
            continue
        cx, cy = b["centroid"]
        for pi, (pkey, pname, pcolor, poffset) in enumerate(pipe_types):
            px, py = plant["centroid"]
            path = [
                ll(px + poffset, py + poffset),
                ll(px + poffset, cy + poffset),
                ll(cx + poffset, cy + poffset),
            ]
            pfc_features.append(
                feature(
                    "LineString",
                    path,
                    {
                        "id": f"PIPE-{pkey}-{b['id']}",
                        "name": f"{b['name']}-{pname}支管",
                        "type": pkey,
                        "color": pcolor,
                        "diameter": 100 + (bk % 4) * 25,
                    },
                )
            )
    pfc = {"type": "FeatureCollection", "name": "pipes", "features": pfc_features}

    # ---- 设备
    devices = make_devices(buildings)
    dfc = {
        "type": "FeatureCollection",
        "name": "devices",
        "features": [
            feature(
                "Point",
                [d["lon"], d["lat"], d["altitude"]],
                {
                    "id": d["id"],
                    "name": d["name"],
                    "type": d["type"],
                    "type_label": d["type_label"],
                    "building_id": d["building_id"],
                    "floor": d["floor"],
                    "status": d["status"],
                    "metric": d["metric"],
                },
            )
            for d in devices
        ],
    }

    # ---- 楼栋明细 (分层/房间/能耗), 与轻量几何分离存储
    details = {}
    for b in buildings:
        floors = []
        for f in range(1, b["floors"] + 1):
            rooms = max(2, int(b["area_m2"] / 180))
            floors.append(
                {
                    "floor": f,
                    "name": f"{f}F",
                    "area_m2": round(b["area_m2"] * 0.92, 1),
                    "rooms": rooms,
                    "occupancy": rng.randint(0, max(1, rooms * 3)),
                    "usage": "办公" if b["type"] in ("office", "lab", "service") else b["type_label"],
                }
            )
        energy_24h = [
            round(b["area_m2"] * TYPE_FACTOR[b["type"]] * b["floors"] * (0.55 + 0.45 * math.sin((h - 4) / 24 * math.pi * 2) ** 2), 1)
            for h in range(24)
        ]
        details[b["id"]] = {
            "id": b["id"],
            "name": b["name"],
            "type": b["type"],
            "type_label": b["type_label"],
            "height": b["height"],
            "floors": b["floors"],
            "floor_height": b["floor_height"],
            "area_m2": b["area_m2"],
            "gfa_m2": b["gfa_m2"],
            "year": b["year"],
            "desc": b["desc"],
            "center": ll(*b["centroid"]),
            "energy_kwh_today": round(sum(energy_24h), 1),
            "energy_24h": energy_24h,
            "energy_target": round(sum(energy_24h) * 1.08, 1),
            "carbon_kg_today": round(sum(energy_24h) * 0.581, 1),
            "floors_named": [{"name": f"{i + 1}F", "floors": 1} for i in range(0)],
            "floor_list": floors,
        }

    # ---- 告警种子
    alarm_devices = [d for d in devices if d["status"] in ("alarm", "warning")]
    alarms = []
    for i, d in enumerate(alarm_devices[:6]):
        alarms.append(
            {
                "id": f"ALM-{20261110}{i + 1:03d}",
                "level": "critical" if d["status"] == "alarm" else "warning",
                "title": f"{d['name']} 指标越限",
                "device_id": d["id"],
                "device_name": d["name"],
                "building_id": d["building_id"],
                "metric": d["metric"]["key"],
                "value": d["metric"]["value"],
                "threshold": d["metric"]["max"],
                "unit": d["metric"]["unit"],
                "ts": f"2026-11-10T{9 + i:02d}:{(i * 13) % 60:02d}:00+08:00",
                "status": "open",
                "hint": "已推送至值班工单池",
            }
        )

    # ---- 园区元数据
    boundary_poly = [(6, 6), (PARK_W - 6, 6), (PARK_W - 6, PARK_H - 6), (6, PARK_H - 6)]
    park = {
        "id": "park-yczg",
        "name": "云创智谷",
        "full_name": "云创智谷 · 园区级数字孪生底座",
        "province": "浙江省",
        "city": "杭州市",
        "address": "西湖区云创路 88 号",
        "center": ll(PARK_W / 2, PARK_H / 2),
        "ground_altitude": GROUND,
        "area_m2": round(PARK_W * PARK_H, 1),
        "green_ratio": 0.31,
        "building_count": len(buildings),
        "device_count": len(devices),
        "camera": {"height": 760, "heading": 12, "pitch": -38},
        "bbox": [
            ll(0, 0)[0],
            ll(0, 0)[1],
            ll(PARK_W, PARK_H)[0],
            ll(PARK_W, PARK_H)[1],
        ],
        "boundary": [ring(boundary_poly)],
        "engines": {
            "primary": "CesiumJS 1.147",
            "note": "园区级场景以地理坐标与多源 GIS 图层为先; 设备级高模由 Three.js 插件按需接入",
        },
    }

    def dump(name: str, obj: object) -> None:
        path = DATA / name
        path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"  {name:26s} {path.stat().st_size / 1024:8.1f} KB")

    print("生成演示数据 ->", DATA)
    dump("park.json", park)
    dump("layer_boundary.geojson", boundary)
    dump("layer_buildings.geojson", bfc)
    dump("layer_roads.geojson", rfc)
    dump("layer_green.geojson", gfc)
    dump("layer_trees.geojson", tfc)
    dump("layer_pipes.geojson", pfc)
    dump("devices.geojson", dfc)
    dump("building_details.json", details)
    dump("alarms.json", alarms)
    print(f"  建筑 {len(buildings)} 栋 / 设备 {len(devices)} 台 / 管网 {len(pfc_features)} 段 / 乔木 {ti} 株")


if __name__ == "__main__":
    main()
