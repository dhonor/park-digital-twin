#!/usr/bin/env python3
"""生成演示用「三维外壳」瓦片 (3D Tiles 1.1 + glb).

P1 要打通的是外壳链路本身: 瓦片加载、加载进度、按楼栋拾取代理、楼层裁剪。
真实项目把倾斜摄影/激光扫描切片产物放进 data/tileset/ 即可替换,
前端与接口都不用改 —— 这就是这一层抽象的价值。

体块替身要做到「不像纸箱」, 靠三件事:
    1. 楼层带: 每个立面按真实层数切成横向条带, 明暗交替 —— 全景视距下就靠它读出层数;
    2. 体量分段: 高层做裙楼 + 塔楼退台, 屋顶加女儿墙与设备箱, 首层加雨棚;
    3. 明暗: 按面法线与太阳方向烘焙受光面, 再叠自下而上的垂直渐变。

> 为什么不贴窗格纹理: 试过把程序化 PNG 作为 baseColorTexture 写进 glb,
> 顶点色/几何都换了但贴图始终不生效（Cesium 侧 unlit 与 PBR 两条路径都验证过）;
> 而在 900m 的全景视距下, 一块 7.5m 见方的窗格只有 2~3 像素, 本来也读不出来。
> 改用「几何楼层带」: 不依赖纹理管线, 且在任何视距下都有稳定的横向节奏。

坐标约定:
    以园区中心为原点的 ENU 局部米制坐标 (X 东 / Y 北 / Z 上);
    根瓦片 transform 把 ENU 转到 ECEF;
    顶点按 glTF 规范换成 Y-up 输出.

用法: python tools/gen_demo_tileset.py
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUT = DATA / "tileset"

WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)
M_PER_DEG_LAT = 111_320.0

# 固定太阳方向(西北高角), 用于把明暗烘进顶点色 —— 材质是 unlit, 靠顶点色读立体感
SUN = (-0.45, -0.62, 0.64)

#: 楼层带的明暗对比: 太大像斑马线, 太小读不出层
BAND_CONTRAST = 0.13

TYPE_FALLBACK = {
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


# ---------------------------------------------------------------- 地理换算
def geodetic_to_ecef(lon: float, lat: float, height: float) -> tuple[float, float, float]:
    lam = math.radians(lon)
    phi = math.radians(lat)
    sin_phi = math.sin(phi)
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * sin_phi * sin_phi)
    x = (n + height) * math.cos(phi) * math.cos(lam)
    y = (n + height) * math.cos(phi) * math.sin(lam)
    z = (n * (1 - WGS84_E2) + height) * sin_phi
    return x, y, z


def enu_to_ecef_matrix(lon: float, lat: float, height: float) -> list[float]:
    """列主序 4x4: [east, north, up, origin]"""
    lam = math.radians(lon)
    phi = math.radians(lat)
    east = (-math.sin(lam), math.cos(lam), 0.0)
    north = (-math.sin(phi) * math.cos(lam), -math.sin(phi) * math.sin(lam), math.cos(phi))
    up = (math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi))
    origin = geodetic_to_ecef(lon, lat, height)
    return [
        east[0], east[1], east[2], 0.0,
        north[0], north[1], north[2], 0.0,
        up[0], up[1], up[2], 0.0,
        origin[0], origin[1], origin[2], 1.0,
    ]


def linear_color(rgb: tuple[float, float, float]) -> tuple[float, float, float, float]:
    """sRGB -> 线性.

    glTF 的 COLOR_0 按线性空间解释, 直接写 sRGB 值会被再做一次线性->sRGB,
    结果整体发灰发白. 这里先转线性, 显示时正好还原成设计稿里的颜色.
    """
    return (rgb[0] ** 2.2, rgb[1] ** 2.2, rgb[2] ** 2.2, 1.0)


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    text = value.lstrip("#")
    return (
        int(text[0:2], 16) / 255.0,
        int(text[2:4], 16) / 255.0,
        int(text[4:6], 16) / 255.0,
    )


def mix(rgb: tuple[float, float, float], target: tuple[float, float, float], amount: float):
    return tuple(rgb[i] + (target[i] - rgb[i]) * amount for i in range(3))


# ---------------------------------------------------------------- 几何
def pad4(blob: bytes, filler: bytes) -> bytes:
    remainder = (-len(blob)) % 4
    return blob + filler * remainder


def to_gltf(p: tuple[float, float, float]) -> tuple[float, float, float]:
    """ENU(东/北/上) -> glTF Y-up(右/上/前).

    glTF 规范是 Y-up, 3D Tiles 1.1 已经去掉 gltfUpAxis 提示, 实现必须自行按 Y-up 解释.
    所以顶点在写盘前统一换轴, 瓦片 transform 仍是 ENU->ECEF, 两者叠加正好还原.
    """
    x, y, z = p
    return (x, z, -y)


def inset_ring(ring: list[tuple[float, float]], factor: float) -> list[tuple[float, float]]:
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    return [(cx + (x - cx) * factor, cy + (y - cy) * factor) for x, y in ring]


def ring_area(ring: list[tuple[float, float]]) -> float:
    total = 0.0
    for i, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(i + 1) % len(ring)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


class Mesh:
    def __init__(self) -> None:
        self.positions: list[tuple[float, float, float]] = []
        self.normals: list[tuple[float, float, float]] = []
        self.colors: list[tuple[float, float, float, float]] = []
        self.indices: list[int] = []

    def add_prism(
        self,
        ring: list[tuple[float, float]],
        base: float,
        top: float,
        rgb: tuple[float, float, float],
        floors: int = 1,
        shade_bottom: float = 0.78,
        shade_top: float = 1.04,
    ) -> None:
        """挤出一段楼体，立面按 `floors` 层切成明暗交替的横向条带."""
        if top <= base:
            return

        count = len(ring)
        floors = max(1, min(floors, 40))
        height = top - base

        for i in range(count):
            px, py = ring[i]
            qx, qy = ring[(i + 1) % count]
            ex, ey = qx - px, qy - py
            length = math.hypot(ex, ey) or 1.0
            if length < 0.05:
                continue

            nx, ny = ey / length, -ex / length  # 逆时针环的外法线
            litness = max(0.0, nx * SUN[0] + ny * SUN[1])
            face_shade = 0.66 + 0.34 * litness

            for floor in range(floors):
                z0 = base + height * floor / floors
                z1 = base + height * (floor + 1) / floors
                # 交替明暗 = 玻璃带 / 实墙带
                band = 1.0 if floor % 2 == 0 else 1.0 - BAND_CONTRAST
                mid = (floor + 0.5) / floors
                gradient = shade_bottom + (shade_top - shade_bottom) * mid

                start = len(self.positions)
                quad = ((px, py, z0), (qx, qy, z0), (qx, qy, z1), (px, py, z1))
                for x, y, z in quad:
                    self.positions.append((x, y, z))
                    self.normals.append((nx, ny, 0.0))
                    k = face_shade * gradient * band
                    tinted = mix(rgb, (0.62, 0.68, 0.76), 0.12)  # 轻微去饱和
                    self.colors.append(
                        linear_color((tinted[0] * k, tinted[1] * k, tinted[2] * k))
                    )
                self.indices.extend([start, start + 1, start + 2, start, start + 2, start + 3])

        # 顶面略亮即可: 加太多白会变成"白顶盒子", 把立面的楼层带压掉
        top_color = linear_color(mix(rgb, (1.0, 1.0, 1.0), 0.12))
        base_index = len(self.positions)
        for x, y in ring:
            self.positions.append((x, y, top))
            self.normals.append((0.0, 0.0, 1.0))
            self.colors.append(top_color)
        for i in range(1, count - 1):
            self.indices.extend([base_index, base_index + i, base_index + i + 1])

    def add_box(
        self,
        cx: float,
        cy: float,
        sx: float,
        sy: float,
        base: float,
        top: float,
        rgb: tuple[float, float, float],
    ) -> None:
        ring = square_ring((cx - sx / 2, cy - sy / 2, cx + sx / 2, cy + sy / 2))
        self.add_prism(ring, base, top, rgb, floors=1, shade_bottom=0.9, shade_top=1.0)

    def add_building(
        self, ring: list[tuple[float, float]], height: float, rgb, floors: int
    ) -> None:
        """体量分段：低层直接挤出；高层做裙楼 + 塔楼 + 女儿墙 + 屋顶设备。"""
        if height >= 34 and ring_area(ring) > 260:
            podium_floors = max(2, min(floors // 3, 4))
            podium_h = height * podium_floors / max(floors, 1)
            tower = inset_ring(ring, 0.84)
            self.add_prism(
                ring, 0.2, podium_h, rgb,
                floors=podium_floors, shade_bottom=0.72, shade_top=0.92,
            )
            self.add_prism(
                tower, podium_h, height, rgb,
                floors=floors - podium_floors, shade_bottom=0.95, shade_top=1.06,
            )
            self._add_roof(tower, height, rgb, equipment=True)
        else:
            self.add_prism(
                ring, 0.2, height, rgb,
                floors=floors, shade_bottom=0.76, shade_top=1.02,
            )
            self._add_roof(ring, height, rgb, equipment=height >= 24)

        self._add_canopy(ring, rgb)

    def _add_roof(
        self, ring: list[tuple[float, float]], height: float, rgb, equipment: bool
    ) -> None:
        # 女儿墙：屋顶一圈略深的窄条，把体量"封口"
        parapet = inset_ring(ring, 0.985)
        edge = mix(rgb, (0.08, 0.1, 0.14), 0.45)
        self.add_prism(parapet, height - 0.05, height + 0.9, edge, 0.85, 0.95)

        if not equipment:
            return
        cx = sum(p[0] for p in ring) / len(ring)
        cy = sum(p[1] for p in ring) / len(ring)
        span = max(max(p[0] for p in ring) - min(p[0] for p in ring), 1.0)
        size = min(span * 0.22, 7.0)
        unit = mix(rgb, (0.72, 0.76, 0.82), 0.55)
        self.add_box(cx - span * 0.16, cy, size, size * 0.7, height + 0.9, height + 3.4, unit)
        self.add_box(
            cx + span * 0.14, cy + size * 0.2,
            size * 0.7, size * 0.5, height + 0.9, height + 2.4, unit,
        )

    def _add_canopy(self, ring: list[tuple[float, float]], rgb) -> None:
        if len(ring) < 3:
            return
        best = None
        for i in range(len(ring)):
            px, py = ring[i]
            qx, qy = ring[(i + 1) % len(ring)]
            length = math.hypot(qx - px, qy - py)
            if best is None or length > best[0]:
                best = (length, px, py, qx, qy)
        if best is None:
            return

        length, px, py, qx, qy = best
        if length < 8:
            return
        ex, ey = (qx - px) / length, (qy - py) / length
        nx, ny = ey, -ex
        depth = 3.2
        t0, t1 = 0.28, 0.72
        a = (px + ex * length * t0, py + ey * length * t0)
        b = (px + ex * length * t1, py + ey * length * t1)
        slab = [
            a,
            b,
            (b[0] + nx * depth, b[1] + ny * depth),
            (a[0] + nx * depth, a[1] + ny * depth),
        ]
        canopy = mix(rgb, (0.9, 0.94, 1.0), 0.35)
        self.add_prism(slab, 3.6, 4.1, canopy, 0.9, 0.98)


def write_glb(path: Path, mesh: Mesh) -> int:
    positions = [to_gltf(p) for p in mesh.positions]
    normals = [to_gltf(n) for n in mesh.normals]
    pos = b"".join(struct.pack("<3f", *p) for p in positions)
    nrm = b"".join(struct.pack("<3f", *n) for n in normals)
    col = b"".join(struct.pack("<4f", *c) for c in mesh.colors)
    idx = b"".join(struct.pack("<I", i) for i in mesh.indices)

    views, offset = [], 0
    for blob, target in ((pos, 34962), (nrm, 34962), (col, 34962), (idx, 34963)):
        views.append(
            {"buffer": 0, "byteOffset": offset, "byteLength": len(blob), "target": target}
        )
        offset += len(blob)
    binary = pad4(pos + nrm + col + idx, b"\x00")

    xs = [p[0] for p in positions] or [0.0]
    ys = [p[1] for p in positions] or [0.0]
    zs = [p[2] for p in positions] or [0.0]

    gltf = {
        "asset": {"version": "2.0", "generator": "park-digital-twin demo tileset"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "shell"}],
        "meshes": [
            {
                "primitives": [
                    {
                        "attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2},
                        "indices": 3,
                        "material": 0,
                    }
                ]
            }
        ],
        "materials": [
            {
                "name": "shell-unlit",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0,
                },
                "doubleSided": True,
                "extensions": {"KHR_materials_unlit": {}},
            }
        ],
        "extensionsUsed": ["KHR_materials_unlit"],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": len(mesh.positions),
                "type": "VEC3",
                "min": [min(xs), min(ys), min(zs)],
                "max": [max(xs), max(ys), max(zs)],
            },
            {"bufferView": 1, "componentType": 5126, "count": len(mesh.normals), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5126, "count": len(mesh.colors), "type": "VEC4"},
            {"bufferView": 3, "componentType": 5125, "count": len(mesh.indices), "type": "SCALAR"},
        ],
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
    }

    json_chunk = pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    total = 12 + 8 + len(json_chunk) + 8 + len(binary)
    blob = struct.pack("<III", 0x46546C67, 2, total)
    blob += struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    blob += struct.pack("<II", len(binary), 0x004E4942) + binary
    path.write_bytes(blob)
    return len(blob)


def square_ring(bounds: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    x0, y0, x1, y1 = bounds
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def box_from(
    x0: float, y0: float, z0: float, x1: float, y1: float, z1: float
) -> list[float]:
    center = ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    half = (abs(x1 - x0) / 2, abs(y1 - y0) / 2, abs(z1 - z0) / 2)
    return [center[0], center[1], center[2], half[0], 0, 0, 0, half[1], 0, 0, 0, half[2]]


def main() -> None:
    park = json.loads((DATA / "park.json").read_text(encoding="utf-8"))
    buildings = json.loads((DATA / "layer_buildings.geojson").read_text(encoding="utf-8"))
    center_lon, center_lat = park["center"]
    ground = float(park.get("ground_altitude", 0.0))
    lon_scale = M_PER_DEG_LAT * math.cos(math.radians(center_lat))

    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.glb"):
        stale.unlink()

    shell = Mesh()
    children = []
    total_bytes = 0

    for feature in buildings["features"]:
        props = feature["properties"]
        bid = str(props["id"])
        ring_lon = [(float(p[0]), float(p[1])) for p in feature["geometry"]["coordinates"][0][:-1]]
        ring = [
            ((lon - center_lon) * lon_scale, (lat - center_lat) * M_PER_DEG_LAT)
            for lon, lat in ring_lon
        ]
        height = float(props.get("height", 20.0))
        floors = int(props.get("floors") or max(1, round(height / 3.8)))
        rgb = hex_to_rgb(
            str(props.get("color") or TYPE_FALLBACK.get(str(props.get("type")), "#2E7DF7"))
        )

        mesh = Mesh()
        mesh.add_building(ring, height, rgb, floors)
        size = write_glb(OUT / f"{bid.lower()}.glb", mesh)
        total_bytes += size

        # 远景合并壳：只保留体量 + 楼层带，不做屋顶设备，控制首包体积
        if height >= 34:
            podium_floors = max(2, min(floors // 3, 4))
            podium_h = height * podium_floors / max(floors, 1)
            shell.add_prism(ring, 0.2, podium_h, rgb, podium_floors, 0.72, 0.92)
            shell.add_prism(
                inset_ring(ring, 0.84), podium_h, height, rgb,
                floors - podium_floors, 0.95, 1.06,
            )
        else:
            shell.add_prism(ring, 0.2, height, rgb, floors, 0.76, 1.02)

        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        children.append(
            {
                "boundingVolume": {
                    "box": box_from(min(xs), min(ys), 0.0, max(xs), max(ys), height + 1.0)
                },
                "geometricError": 0.0,
                "content": {"uri": f"{bid.lower()}.glb"},
                "extras": {"building_id": bid, "name": props.get("name")},
            }
        )

    total_bytes += write_glb(OUT / "shell.glb", shell)

    all_x = [c["boundingVolume"]["box"][0] for c in children]
    all_y = [c["boundingVolume"]["box"][1] for c in children]
    max_h = max(c["boundingVolume"]["box"][2] + c["boundingVolume"]["box"][8] for c in children)
    root_box = box_from(
        min(all_x) - 40, min(all_y) - 40, -2.0, max(all_x) + 40, max(all_y) + 40, max_h + 6
    )

    tileset = {
        "asset": {
            "version": "1.1",
            "generator": "park-digital-twin / tools/gen_demo_tileset.py",
            "extras": {
                "gltfUpAxis": "Y",
                "source": "vector-extrude-standin",
                "note": "演示用外壳: 矢量体块挤出 + 楼层带 + 屋顶构造; 真实项目替换为倾斜摄影切片",
            },
        },
        "geometricError": 128.0,
        "root": {
            "boundingVolume": {"box": root_box},
            "geometricError": 24.0,
            "refine": "REPLACE",
            "transform": enu_to_ecef_matrix(center_lon, center_lat, ground),
            "content": {"uri": "shell.glb"},
            "children": children,
        },
    }
    (OUT / "tileset.json").write_text(
        json.dumps(tileset, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    index_size = (OUT / "tileset.json").stat().st_size
    print(f"生成演示外壳瓦片 -> {OUT}")
    print(f"  tileset.json          {index_size / 1024:8.1f} KB")
    print(f"  shell.glb             {(total_bytes - sum(0 for _ in children)) / 1024:8.1f} KB (含单栋)")
    print(f"  单栋瓦片              {len(children)} 个")
    print(f"  顶点/三角面           {len(shell.positions)} / {len(shell.indices) // 3}")


if __name__ == "__main__":
    main()
