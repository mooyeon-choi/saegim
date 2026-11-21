from dataclasses import replace

import numpy as np
import pytest

from server.analyzer import Track, track_to_node
from server.pattern_surfaces import color_fields, patterned_frame, shared_lines
from server.quality import high_detections


def graphic(transpose=False, markings=True):
    y, x = np.mgrid[:112, :176] + 0.5
    normal_x = x - 0.19 * y - 73.30
    alpha = (0.5 + normal_x).clip(0, 1)
    left = np.array([29.0, 150.0, 70.0])
    right = np.array([212.0, 132.0, 18.0])
    light = 1 - 0.13 * x / x.max()
    stripe = 35 * (np.cos(2 * np.pi * (x / 12 + y / 17)) > 0.7) if markings else 0
    rgb = ((1 - alpha[:, :, None]) * left + alpha[:, :, None] * right) * light[:, :, None]
    rgb += np.broadcast_to(stripe, x.shape)[:, :, None]
    rgb = np.rint(rgb).astype(np.uint8)
    return np.ascontiguousarray(rgb.transpose(1, 0, 2)) if transpose else rgb


@pytest.mark.parametrize("transpose", [False, True])
def test_shared_edge_is_measured_once_for_different_hues_and_orientations(transpose):
    rgb = graphic(transpose)
    lines = shared_lines(rgb, color_fields(rgb))
    assert len(lines) == 1
    _, _, center, _, normal, a, b = lines[0]
    points = np.array([[73.3 + 0.19 * y, y] for y in (12, 55, 100)])
    if transpose:
        points = points[:, ::-1]
    assert np.max(abs((points - center) @ normal)) < 0.35
    assert b - a > 80


def test_only_verified_repetitions_are_clipped_and_remain_editable():
    assert patterned_frame(graphic(markings=False)) is None
    observations, _ = high_detections(graphic(), 0, [])
    surfaces = [o for o in observations if o.paint_regions]
    assert len(surfaces) == 2
    nodes = [track_to_node(Track([o]), i, 1, 1, 1, 15) for i, o in enumerate(surfaces)]
    for node in nodes:
        assert node["stackBoundary"] == {"featherPx": 0}
        assert node["paintRegions"] == node["keyframes"][0]["paintRegions"]
        assert all("path" in paint for paint in node["paintRegions"])
        assert node["keyframes"][0]["path"] == node["path"]


def test_real_neutral_divider_is_not_closed_as_a_mixed_color_edge():
    rgb = graphic()
    yy, xx = np.indices(rgb.shape[:2]) + 0.5
    rgb[np.abs(xx - 0.19 * yy - 73.3) < 1.4] = 245
    assert not shared_lines(rgb, color_fields(rgb))


def test_pattern_disappearance_clears_measured_paint_regions():
    observations, _ = high_detections(graphic(), 0, [])
    first = next(o for o in observations if o.paint_regions)
    second = replace(first, time=1 / 15, paint_regions=[])
    node = track_to_node(Track([first, second]), 0, 1, 1, 1, 15)
    assert node["keyframes"][0]["paintRegions"]
    assert node["keyframes"][1]["paintRegions"] == []
