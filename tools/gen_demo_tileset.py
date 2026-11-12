#!/usr/bin/env python3
"""生成演示用「三维外壳」瓦片 (3D Tiles 1.1 + glb).

P1 要打通的是外壳链路本身: 瓦片加载、加载进度、按楼栋拾取代理、楼层裁剪。
真实项目把倾斜摄影/激光扫描切片产物放进 data/tileset/ 即可替换,
前端与接口都不用改 —— 这就是这一层抽象的价值。

本脚本用现有建筑矢量体块挤出成棱柱, 产出:
    tileset.json          根瓦片(整园合并) + 每栋楼一个子瓦片
    shell.glb             整园合并外壳(远景时只加载它)
    b01.glb ... b12.glb   单栋外壳(近景细化)

坐标约定:
    以园区中心为原点的 ENU 局部米制坐标 (X 东 / Y 北 / Z 上);
    根瓦片 transform 把 ENU 转到 ECEF;
    glTF 直接按 Z-up 输出, 并在 asset.extras.gltfUpAxis 声明, 避免换轴出错.

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


# ---------------------------------------------------------------- 几何
class Mesh:
    def __init__(self) -> None:
        self.positions: list[tuple[float, float, float]] = []
        self.normals: list[tuple[float, float, float]] = []
        self.colors: list[tuple[float, float, float, float]] = []
        self.indices: list[int] = []

    def add_prism(self, ring: list[tuple[float, float]], base: float, top: float, rgb) -> None:
        count = len(ring)
        for i in range(count):
            px, py = ring[i]
            qx, qy = ring[(i + 1) % count]
            ex, ey = qx - px, qy - py
            length = math.hypot(ex, ey) or 1.0
            nx, ny = ey / length, -ex / length  # 逆时针环的外法线
            litness = max(0.0, nx * SUN[0] + ny * SUN[1])
            shade = 0.58 + 0.42 * litness
            color = linear_color((rgb[0] * shade, rgb[1] * shade, rgb[2] * shade))

            start = len(self.positions)
            quad = ((px, py, base), (qx, qy, base), (qx, qy, top), (px, py, top))
            for x, y, z in quad:
                self.positions.append((x, y, z))
                self.normals.append((nx, ny, 0.0))
                self.colors.append(color)
            self.indices.extend([start, start + 1, start + 2, start, start + 2, start + 3])

        # 顶面
        top_color = linear_color(rgb)
        base_index = len(self.positions)
        for x, y in ring:
            self.positions.append((x, y, top))
            self.normals.append((0.0, 0.0, 1.0))
            self.colors.append(top_color)
        for i in range(1, count - 1):
            self.indices.extend([base_index, base_index + i, base_index + i + 1])


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
        ring = [((lon - center_lon) * lon_scale, (lat - center_lat) * M_PER_DEG_LAT) for lon, lat in ring_lon]
        height = float(props.get("height", 20.0))
        rgb = hex_to_rgb(str(props.get("color") or TYPE_FALLBACK.get(str(props.get("type")), "#2E7DF7")))

        mesh = Mesh()
        mesh.add_prism(ring, 0.2, height, rgb)
        size = write_glb(OUT / f"{bid.lower()}.glb", mesh)
        total_bytes += size
        shell.add_prism(ring, 0.2, height, rgb)

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
                "note": "演示用外壳: 由矢量体块挤出, 用于验证 3D Tiles 链路; 真实项目替换为倾斜摄影切片",
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
