"""轻量化管线单元测试: 抽稀 / 量化 / 属性裁剪 都要可度量."""

from __future__ import annotations

import json

from app.domain.catalog import LAYERS
from app.services import lightweight as lw


def _fc():
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "B01",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [120.0755, 30.2791],
                            [120.0760, 30.2791],
                            [120.0760, 30.2796],
                            [120.0755, 30.2796],
                            [120.0755, 30.2791],
                        ]
                    ],
                },
                "properties": {
                    "id": "B01",
                    "name": "研发一号楼",
                    "type": "office",
                    "type_label": "研发办公",
                    "height": 48.0,
                    "floors": 12,
                    "area_m2": 1234.5,
                    "gfa_m2": 14814.0,
                    "color": "#2E7DF7",
                },
            }
        ],
    }


def test_douglas_peucker_keeps_endpoints():
    pts = [(0.0, 0.0), (1.0, 0.01), (2.0, 0.0)]
    kept = lw._douglas_peucker(pts, 0.5)
    assert kept == [pts[0], pts[-1]]


def test_lod0_is_smaller_than_lod2():
    fc = _fc()
    lod0, s0 = lw.lighten(fc, "buildings", 0)
    lod2, s2 = lw.lighten(fc, "buildings", 2)
    assert s0["bytes"]["output"] < s2["bytes"]["output"]
    assert s0["attributes_kept"] == list(LAYERS["buildings"].attrs(0))
    assert "color" not in lod0["features"][0]["properties"]
    assert lod2["features"][0]["properties"]["gfa_m2"] == 14814.0


def test_simplify_keeps_small_building_ring():
    """回归: 容差单位是米, 170m 见方的楼栋在 1.5m 容差下不能被压成一条线."""
    ring = [
        [120.07600, 30.27910],
        [120.07780, 30.27910],
        [120.07780, 30.28000],
        [120.07600, 30.28000],
        [120.07600, 30.27910],
    ]
    out = lw.simplify_geometry({"type": "Polygon", "coordinates": [ring]}, 1.5)
    assert len(out["coordinates"][0]) == 5


def test_coordinate_quantization():
    geom = {"type": "Point", "coordinates": [120.075512345, 30.27911234]}
    out = lw.quantize_geometry(geom, 5)
    assert out["coordinates"] == [120.07551, 30.27911]
    assert len(json.dumps(out)) < len(json.dumps(geom))


def test_bbox_only_reduces_vertices():
    geom = {
        "type": "Polygon",
        "coordinates": [
            [
                [120.0, 30.0],
                [120.1, 30.0],
                [120.1, 30.1],
                [120.05, 30.08],
                [120.0, 30.1],
                [120.0, 30.0],
            ]
        ],
    }
    assert lw.count_points(geom) == 6
    out = lw.simplify_geometry(geom, 0.0, bbox_only=True)
    assert lw.count_points(out) == 5


def test_report_totals_are_consistent():
    report = lw.report({"buildings": _fc()}, 1)
    assert report["total"]["bytes_output"] <= report["total"]["bytes_source"]
    assert 0.0 <= report["total"]["bytes_reduction"] <= 1.0
