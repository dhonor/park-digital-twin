"""图层与 LOD 目录.

这里是「数据轻量化」的唯一事实来源:
  - 每个图层在不同 LOD 下保留哪些属性
  - 对应 PostGIS 表名 / 源数据文件
新增图层只需要在这里登记, API 与前端自动感知.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LayerDef:
    key: str
    name: str
    name_en: str
    geometry: str
    source_file: str
    table: str
    lod_attrs: dict[int, tuple[str, ...]]
    default_visible: bool
    note: str

    def attrs(self, lod: int) -> tuple[str, ...]:
        return self.lod_attrs.get(lod, self.lod_attrs[max(self.lod_attrs)])


LAYERS: dict[str, LayerDef] = {
    defn.key: defn
    for defn in [
        LayerDef(
            key="boundary",
            name="园区边界",
            name_en="Park Boundary",
            geometry="Polygon",
            source_file="layer_boundary.geojson",
            table="dt_layer_feature",
            lod_attrs={
                0: ("id", "name"),
                1: ("id", "name", "area_m2"),
                2: ("id", "name", "area_m2"),
            },
            default_visible=True,
            note="园区红线, 同时作为场景承载面",
        ),
        LayerDef(
            key="buildings",
            name="建筑体块",
            name_en="Buildings",
            geometry="Polygon",
            source_file="layer_buildings.geojson",
            table="dt_layer_feature",
            lod_attrs={
                0: ("id", "name", "height", "type"),
                1: ("id", "name", "type", "type_label", "height", "floors", "color"),
                2: (
                    "id",
                    "name",
                    "type",
                    "type_label",
                    "height",
                    "floors",
                    "area_m2",
                    "gfa_m2",
                    "color",
                ),
            },
            default_visible=True,
            note="2.5D 拉伸体块, 而非 BIM/glTF; 楼栋明细走独立接口按需加载",
        ),
        LayerDef(
            key="roads",
            name="道路路网",
            name_en="Roads",
            geometry="LineString",
            source_file="layer_roads.geojson",
            table="dt_layer_feature",
            lod_attrs={
                0: ("id", "level"),
                1: ("id", "name", "level"),
                2: ("id", "name", "level"),
            },
            default_visible=True,
            note="主干路/支路分级, 前端按 level 决定线宽",
        ),
        LayerDef(
            key="green",
            name="绿地水系",
            name_en="Green & Water",
            geometry="Polygon",
            source_file="layer_green.geojson",
            table="dt_layer_feature",
            lod_attrs={
                0: ("id", "kind"),
                1: ("id", "name", "kind"),
                2: ("id", "name", "kind"),
            },
            default_visible=True,
            note="草坪/广场/水体三类面要素",
        ),
        LayerDef(
            key="trees",
            name="乔木点位",
            name_en="Trees",
            geometry="Point",
            source_file="layer_trees.geojson",
            table="dt_layer_feature",
            lod_attrs={0: ("id",), 1: ("id", "height"), 2: ("id", "height", "crown")},
            default_visible=True,
            note="点位 + 高度, 不加载树木模型",
        ),
        LayerDef(
            key="pipes",
            name="综合管网",
            name_en="Utility Pipes",
            geometry="LineString",
            source_file="layer_pipes.geojson",
            table="dt_layer_feature",
            lod_attrs={
                0: ("id", "type"),
                1: ("id", "name", "type", "color"),
                2: ("id", "name", "type", "color", "diameter"),
            },
            default_visible=False,
            note="给水/污水/电力/网络四类管线",
        ),
        LayerDef(
            key="devices",
            name="物联设备",
            name_en="IoT Devices",
            geometry="Point",
            source_file="devices.geojson",
            table="dt_layer_feature",
            lod_attrs={
                0: ("id", "status"),
                1: ("id", "name", "type", "status", "building_id", "floor", "metric"),
                2: (
                    "id",
                    "name",
                    "type",
                    "type_label",
                    "status",
                    "building_id",
                    "floor",
                    "metric",
                ),
            },
            default_visible=True,
            note="点要素 + 实时值, LOD0 只保留状态字段",
        ),
    ]
}

# LOD 策略: 以"看得清"为界, 不以"画得精"为界
LODS: dict[int, dict] = {
    0: {
        "key": "LOD0",
        "label": "概览",
        "viewport": "园区全景 / 大屏轮播",
        "tolerance_m": 8.0,
        "coord_precision": 4,
        "bbox_only": True,
    },
    1: {
        "key": "LOD1",
        "label": "标准",
        "viewport": "日常巡检 / 单栋浏览",
        "tolerance_m": 1.5,
        "coord_precision": 5,
        "bbox_only": False,
    },
    2: {
        "key": "LOD2",
        "label": "精细",
        "viewport": "专题分析 / 上报归档",
        "tolerance_m": 0.0,
        "coord_precision": 7,
        "bbox_only": False,
    },
}

DEFAULT_LOD = 1


def lod_meta(lod: int) -> dict:
    return LODS.get(lod, LODS[DEFAULT_LOD])
