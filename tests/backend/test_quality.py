import json
import threading

import cv2
import numpy as np
import pytest

from server.analyzer import Observation, Track, analyze_video, track_to_node
from server.quality import fit_gradient, high_detections, pixel_edge_contours, segment_regions
from server.primitives import fit_region, isolate_strokes
from tests.backend.test_analysis import NoOCR, make_video


def test_pixel_edges_cover_cells_exactly_including_holes():
    mask = np.ones((6, 8), np.uint8)
    mask[2:4, 3:5] = 0
    contours = pixel_edge_contours(mask)
    assert len(contours) == 2
    assert sum(cv2.contourArea(contour, oriented=True) for contour in contours) == pytest.approx(44)
    points = np.concatenate(contours).reshape(-1, 2)
    assert tuple(points.min(axis=0)) == (0, 0)
    assert tuple(points.max(axis=0)) == (8, 6)


def test_measured_linear_and_radial_gradients_are_continuous():
    ys, xs = np.mgrid[:100, :120]
    pixels = np.stack([20+180*xs/120, 40+80*xs/120, 90+60*xs/120], axis=2)
    _, gradient = fit_gradient(pixels.reshape(-1, 3), xs.ravel(), ys.ravel(), 120, 100)
    assert gradient is not None and gradient["type"] == "linear"
    assert len(gradient["stops"]) == 2
    assert gradient["stops"][0]["color"] != gradient["stops"][1]["color"]
    radial = np.linalg.norm(np.stack([xs/120-.5, ys/100-.5], axis=2), axis=2)
    pixels = np.stack([180-140*radial, 160-110*radial, 230-150*radial], axis=2)
    _, gradient = fit_gradient(pixels.reshape(-1, 3), xs.ravel(), ys.ravel(), 120, 100)
    assert gradient is not None and gradient["type"] == "radial"
    assert gradient["cx"] == gradient["cy"] == .5


def test_small_high_contrast_detail_is_not_merged_into_skin_gradient():
    image = np.full((120, 180, 3), (242, 151, 128), np.uint8)
    cv2.ellipse(image, (90, 55), (15, 11), 0, 0, 360, (250, 249, 246), -1)
    cv2.circle(image, (94, 54), 5, (12, 10, 20), -1)
    labels = segment_regions(image, color_count=12)
    assert labels[54, 94] != labels[55, 80]
    assert labels[54, 94] != labels[90, 90]
    assert labels[55, 80] != labels[90, 90]


def test_minor_bright_boundary_pixels_do_not_turn_dark_region_gray():
    ys, xs = np.mgrid[:10, :10]
    pixels = np.full((100, 3), (3, 2, 6), dtype=float)
    pixels[:12] = (250, 249, 255)
    fill, gradient = fit_gradient(pixels, xs.ravel(), ys.ravel(), 10, 10)
    assert fill == "#030206"
    assert gradient is None


def test_precise_keys_preserve_actual_paint_instead_of_opacity_guess():
    first = Observation(0, "path", 0, 0, 60, 40, (240, 140, 120), (0, 0, 0),
                        path="M0 0 L1000 0 L1000 1000 Z", precise=True)
    second = Observation(1/24, "path", 2, 0, 60, 40, (80, 160, 220), (0, 0, 0),
                         path=first.path, precise=True)
    node = track_to_node(Track([first, second]), 0, 1, 1, 1, 24)
    assert [key["fill"] for key in node["keyframes"]] == ["#f08c78", "#50a0dc"]
    assert all(key["opacity"] == 1 and key["gradient"] is None for key in node["keyframes"])
    precise = track_to_node(Track([first, second]), 0, 1, 1, 1, 24, precise_timing=True)
    assert precise["keyframes"][1]["time"] == 1/24


def test_high_mode_observes_24fps_and_emits_only_editable_vectors(tmp_path, monkeypatch):
    monkeypatch.setattr("server.analyzer.VisionOCR", NoOCR)
    source = tmp_path/"high.mp4"
    make_video(source, seconds=.5)
    project = analyze_video(source, source.name, "/api/media/high.mp4", 12,
                            threading.Event(), lambda *_: None, tmp_path, quality="high")
    assert project["analysis"]["sampleCount"] == 12
    assert project["analysis"]["engine"] == "local-gradient-vector-v1"
    # This fixture is native30fps: selecting24 observations produces unequal
    # PTS intervals, so a fictional24fps blend grid must not be enabled.
    assert project['temporal']['mode'] == 'off'
    assert project['temporal']['sampleFps'] == pytest.approx(24)
    assert project['temporal']['cuts'] == []
    assert project["nodes"]
    assert all(node["type"] in {"rect", "ellipse", "path"} for node in project["nodes"])
    assert all(key.get("path") for node in project["nodes"] if node["type"] == "path"
               for key in node["keyframes"])
    assert not any(token in json.dumps(project) for token in ("data:image", "base64", "<video", "<image"))

@pytest.mark.parametrize("start_y", [8, 9])
def test_thin_diagonal_survives_quantization_as_one_four_corner_shape(start_y):
    img = np.full((64, 80, 3), 226, np.uint8)
    cv2.line(img, (4, start_y), (44, start_y+40), (30, 86, 178), 1)
    # Moving the stroke by one pixel puts it between all palette training samples.
    labels = segment_regions(img, color_count=4)
    stroke = labels[np.arange(start_y, start_y+41), np.arange(4, 45)]
    assert len(np.unique(stroke)) == 1 and stroke[0] != labels[1, 1]
    observations, _ = high_detections(img, 0, [])
    line = next(o for o in observations if o.x == 4 and o.y == start_y)
    assert line.path.count("M") == 1 and line.path.count("L") == 3


def test_simple_regions_use_native_shapes_only_across_compatible_observations():
    ellipse = np.zeros((24, 32), bool)
    y, x = np.indices(ellipse.shape)
    ellipse[:] = ((x + .5 - 16)/16)**2 + ((y + .5 - 12)/12)**2 <= 1
    hint, path = fit_region(ellipse, pixel_edge_contours(ellipse))
    assert hint == "ellipse"
    plain = Observation(0, "path", 10, 20, 32, 24, (40, 80, 150), (255, 255, 255),
                        path=path, primitive_kind=hint, precise=True)
    assert track_to_node(Track([plain]), 0, 1, 1, 1, 24)["type"] == "ellipse"
    ellipse[9:14, 13:19] = False
    assert fit_region(ellipse, pixel_edge_contours(ellipse)) is None
    with_hole = Observation(1/24, "path", 10, 20, 32, 24, plain.color, plain.background,
                            path="M0 0 H1000 V1000 H0 Z M400 400 V600 H600 V400 Z", precise=True)
    tracked = track_to_node(Track([plain, with_hole]), 0, 1, 1, 1, 24)
    assert tracked["type"] == "path"
    assert [k["path"] for k in tracked["keyframes"]] == [path, with_hole.path]


def test_stroke_isolation_preserves_gaps_and_paints_under_gradients():
    im = np.zeros((86, 144, 3), np.uint8)
    im[:] = np.linspace(160, 224, 144, dtype=np.uint8)[None, :, None]
    for x0, x1 in [(12, 53), (60, 106)]:
        cv2.line(im, (x0, 26), (x1, 26), (45, 85, 181), 2)
    cv2.rectangle(im, (8, 52), (132, 57), (20, 60, 165), -1)
    im[53:55, 76:78] = 200
    shapes, mask = isolate_strokes(im)
    assert len(shapes) == 2
    assert mask[26, 18] and mask[26, 98] and not mask[26, 56]
    assert not mask[54, 76]
