from pathlib import Path
import json
import math
import subprocess
import threading
import cv2
import imageio_ffmpeg
import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont
from server.analyzer import (AnalysisCancelled, analyze_video, associate, detect_frame,
                             probe_video, track_to_node)
from server.demo import font_path
from server.ocr import VisionOCR, available_backend


def make_video(path, width=320, height=180, seconds=1, color=(40, 90, 220)):
    frames = []
    for index in range(int(seconds*30)):
        image = Image.new("RGB", (width, height), (245, 245, 245))
        d = ImageDraw.Draw(image)
        x = 20+index*2
        d.rectangle((x, 60, x+60, 100), fill=color)
        frames.append(image.tobytes())
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}", "-r", "30", "-i", "pipe:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], input=b"".join(frames), check=True)


class NoOCR:
    error = None
    def __init__(self, cache):
        pass
    def recognize(self, path):
        return []
    def close(self):
        pass


def test_actual_video_inputs_preserve_measured_movement_and_color(tmp_path, monkeypatch):
    monkeypatch.setattr("server.analyzer.VisionOCR", NoOCR)
    results = []
    for color in [(40, 90, 220), (220, 70, 40)]:
        p = tmp_path/f"{color[0]}.mp4"
        make_video(p, color=color)
        result = analyze_video(p, p.name, "/api/media/test.mp4", 12, threading.Event(), lambda *_: None, tmp_path)
        results.append(result)
        assert result["analysis"]["sampleCount"] == 12
        assert len(result["nodes"]) == 1
        node = result["nodes"][0]
        assert node["type"] == "rect"
        frames = node["keyframes"]
        # Last sampled source frame is frame 28 at 0.9333s, not nominal 0.9167s.
        assert frames[-1]["time"] == pytest.approx(28/30, abs=.0001)
        assert frames[-1]["x"]-frames[0]["x"] == pytest.approx(56, abs=2)
        assert node["end"] == 1
        assert not any(token in json.dumps(result) for token in ("data:image", "<video", "base64"))
    assert results[0]["nodes"][0]["fill"] != results[1]["nodes"][0]["fill"]


def test_original_coordinates_survive_analysis_downscaling(tmp_path, monkeypatch):
    monkeypatch.setattr("server.analyzer.VisionOCR", NoOCR)
    p = tmp_path/"large.mp4"
    make_video(p, 1280, 720)
    result = analyze_video(p, p.name, "/api/media/test.mp4", 6, threading.Event(), lambda *_: None, tmp_path)
    assert result["width"] == 1280 and result["height"] == 720
    n = result["nodes"][0]
    frame = n["keyframes"][0]
    rendered_left = n["x"]+frame["x"]+(n["width"]-n["width"]*frame["scaleX"])/2
    assert rendered_left == pytest.approx(20, abs=3)
    assert n["height"] == pytest.approx(41, abs=3)


def test_rotating_rectangle_stays_one_track_without_width_swap():
    tracks = []
    for i, angle in enumerate([70, 80, 88, 96, 105, 116]):
        frame = np.full((240, 320, 3), 245, dtype=np.uint8)
        points = cv2.boxPoints(((160, 120), (110, 54), angle)).astype(np.int32)
        cv2.fillConvexPoly(frame, points, (40, 90, 220))
        detections, _ = detect_frame(frame, i/12, [])
        assert len(detections) == 1 and detections[0].kind == "rect"
        assert detections[0].corner_radius == 0
        associate(tracks, detections, i/12, 12, 400)
    assert len(tracks) == 1
    observations = tracks[0].observations
    assert max(o.width for o in observations)-min(o.width for o in observations) < 3
    rotations = [o.rotation for o in observations]
    assert all(0 < b-a < 15 for a, b in zip(rotations, rotations[1:]))
    node = track_to_node(tracks[0], 0, 1, 1, 1, 12)
    assert node["keyframes"][-1]["rotation"]-node["keyframes"][0]["rotation"] == pytest.approx(46, abs=2)


def test_hollow_icon_keeps_inner_subpath():
    frame = np.full((200, 300, 3), 245, dtype=np.uint8)
    cv2.circle(frame, (150, 100), 45, (30, 70, 190), 7)
    detections, _ = detect_frame(frame, 0, [])
    assert len(detections) == 1
    icon = detections[0]
    assert icon.kind == "path"
    assert icon.path.count("M") == 2


def test_invalid_video_and_early_cancel_release_resources(tmp_path):
    bad = tmp_path/"bad.mp4"
    bad.write_bytes(b"not video")
    with pytest.raises(ValueError, match="영상"):
        probe_video(bad)
    event = threading.Event()
    event.set()
    with pytest.raises(AnalysisCancelled):
        analyze_video(bad, bad.name, "/unused", 12, event, lambda *_: None, tmp_path)


@pytest.mark.skipif(available_backend() == "unavailable", reason="macOS Vision unavailable")
def test_real_local_korean_ocr(tmp_path):
    font = font_path()
    if not font or "Apple" not in font:
        pytest.skip("Korean test font unavailable")
    im = Image.new("RGB", (700, 180), "white")
    ImageDraw.Draw(im).text((35, 45), "움직임을 코드로", font=ImageFont.truetype(font, 60), fill="black")
    image_path = tmp_path/"korean.png"
    im.save(image_path)
    worker = VisionOCR(Path(".data/cache"))
    try:
        results = worker.recognize(image_path)
        assert any("움직임을 코드로" in row["text"] for row in results), (worker.error, results)
    finally:
        worker.close()


def test_abrupt_cut_splits_scenes_and_prevents_cross_cut_interpolation(tmp_path, monkeypatch):
    monkeypatch.setattr("server.analyzer.VisionOCR", NoOCR)
    path = tmp_path/"cut.mp4"
    frames = []
    for i in range(60):
        image = Image.new("RGB", (320, 180), (245, 245, 245) if i < 30 else (20, 30, 40))
        ImageDraw.Draw(image).rectangle((70, 55, 150, 115), fill=(210, 60, 70))
        frames.append(image.tobytes())
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "320x180", "-r", "30", "-i", "pipe:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], input=b"".join(frames), check=True)
    project = analyze_video(path, path.name, "/api/media/test.mp4", 12, threading.Event(), lambda *_: None, tmp_path)
    assert len(project["scenes"]) == 2
    assert project["scenes"][0]["end"] == project["scenes"][1]["start"] == 1
    assert len(project["nodes"]) == 2
    assert sorted((n["start"], n["end"]) for n in project["nodes"]) == [(0, 1), (1, 2)]


@pytest.mark.parametrize("radius", [0, 3, 6, 10])
def test_rounded_corners_remain_editable_rectangles(radius):
    image = Image.new("RGB", (240, 140), "white")
    ImageDraw.Draw(image).rounded_rectangle((35, 35, 145, 95), radius=radius, fill=(25, 75, 180))
    detections, _ = detect_frame(np.array(image), 0, [])
    assert len(detections) == 1 and detections[0].kind == "rect"
    assert detections[0].corner_radius == pytest.approx(radius, abs=1)
    from server.analyzer import Track
    node = track_to_node(Track(detections), 0, 1, 1, 1, 12)
    assert node["borderRadius"] == pytest.approx(radius, abs=1)


@pytest.mark.skipif(available_backend() == "unavailable", reason="macOS Vision unavailable")
def test_latin_font_selection_uses_observed_glyph_proportions(tmp_path):
    path = Path("/System/Library/Fonts/Supplemental/Arial.ttf")
    if not path.is_file():
        pytest.skip("Arial test font unavailable")
    image = Image.new("RGB", (600, 150), "white")
    ImageDraw.Draw(image).text((30, 30), "HELLO FRAME", font=ImageFont.truetype(str(path), 48), fill="#203040")
    png = tmp_path/"latin.png"
    image.save(png)
    worker = VisionOCR(Path(".data/cache"))
    try:
        rows = worker.recognize(png)
        detections, _ = detect_frame(np.array(image), 0, rows)
    finally:
        worker.close()
    text = next(d for d in detections if d.kind == "text")
    assert text.font_family.startswith("Arial")
    from server.analyzer import Track
    node = track_to_node(Track([text]), 0, 1, 1, 1, 12)
    assert node["text"] == "HELLO FRAME"
    assert node["fontSize"] == pytest.approx(48, abs=1.5)


def test_draw_on_video_preserves_observed_vector_path_at_every_keyframe(tmp_path, monkeypatch):
    monkeypatch.setattr("server.analyzer.VisionOCR", NoOCR)
    path = tmp_path/"draw-on.mp4"
    frames = []
    for index in range(30):
        frame = np.full((240, 320, 3), 245, np.uint8)
        cv2.ellipse(frame, (160, 120), (78, 78), 0, 0, 120+index*6, (35, 145, 175), 9)
        frames.append(frame.tobytes())
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "320x240", "-r", "30", "-i", "pipe:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], input=b"".join(frames), check=True)
    project = analyze_video(path, path.name, "/api/media/test.mp4", 12, threading.Event(), lambda *_: None, tmp_path)
    node = max(project["nodes"], key=lambda n: len(n["keyframes"]))
    assert node["type"] == "path"
    assert len(node["keyframes"]) == 12
    assert all(k.get("path") for k in node["keyframes"])
    assert len(set(k["path"] for k in node["keyframes"])) >= 8
    assert node["keyframes"][0]["path"] != node["keyframes"][-1]["path"]


@pytest.mark.parametrize("filename,expected", [("Arial.ttf", 400), ("Arial Bold.ttf", 700), ("Arial Black.ttf", 900)])
def test_text_weight_is_measured_from_glyph_ink(filename, expected):
    path = Path("/System/Library/Fonts/Supplemental")/filename
    if not path.is_file():
        pytest.skip("Arial test font unavailable")
    image = Image.new("RGB", (640, 160), "white")
    ImageDraw.Draw(image).text((30, 30), "SHAPE STUDY", font=ImageFont.truetype(str(path), 54), fill="#203040")
    rgb = np.array(image)
    # Supply the independently measured full text region, leaving the classifier
    # to compare actual ink rather than feeding it font or weight metadata.
    rows = [{"text": "SHAPE STUDY", "confidence": 1, "x": 20/640, "y": 20/160, "width": 570/640, "height": 100/160}]
    detections, _ = detect_frame(rgb, 0, rows)
    text = next(d for d in detections if d.kind == "text")
    assert text.font_weight == expected


def test_disappeared_object_does_not_reconnect_to_different_colored_object():
    from server.analyzer import Observation, Track
    old = Observation(0, "ellipse", 90, 90, 40, 40, (247, 196, 32), (15, 13, 20))
    last = Observation(1/12, "ellipse", 90, 90, 40, 40, (247, 196, 32), (15, 13, 20))
    new = Observation(1/3, "ellipse", 145, 125, 40, 40, (244, 243, 237), (15, 13, 20))
    tracks = [Track([old, last])]
    associate(tracks, [new], 1/3, 12, 1000)
    assert len(tracks) == 2
    assert len(tracks[0].observations) == 2
    assert tracks[1].observations == [new]


def test_missing_sample_can_reconnect_same_hue_fade():
    from server.analyzer import Observation, Track
    old = Observation(0, "ellipse", 90, 90, 40, 40, (220, 100, 40), (20, 20, 20))
    last = Observation(1/12, "ellipse", 90, 90, 40, 40, (220, 100, 40), (20, 20, 20))
    fading = Observation(1/3, "ellipse", 92, 90, 40, 40, (120, 60, 30), (20, 20, 20))
    tracks = [Track([old, last])]
    associate(tracks, [fading], 1/3, 12, 1000)
    assert len(tracks) == 1
    assert tracks[0].observations[-1] == fading


def test_consecutive_different_region_cannot_poison_track_color():
    from server.analyzer import Observation, Track
    background = (0, 0, 38)
    pale = Observation(0, "path", 200, 160, 65, 210, (216, 224, 245), background)
    warm = Observation(1/12, "path", 202, 130, 66, 58, (244, 147, 126), background)
    tracks = [Track([pale])]
    associate(tracks, [warm], 1/12, 12, 1000)
    assert len(tracks) == 2
    node = track_to_node(tracks[1], 0, 1, 1, 1, 12)
    assert node["fill"] == "#f4937e"
    assert node["keyframes"][0]["opacity"] == 1


def test_consecutive_same_hue_shape_change_keeps_identity():
    from server.analyzer import Observation, Track
    old = Observation(0, "path", 200, 160, 65, 210, (220, 100, 40), (20, 20, 20))
    small = Observation(1/12, "path", 202, 130, 66, 58, (120, 60, 30), (20, 20, 20))
    tracks = [Track([old])]
    associate(tracks, [small], 1/12, 12, 1000)
    assert len(tracks) == 1
    assert len(tracks[0].observations) == 2


def test_coherent_rare_color_survives_many_gradient_background_bins():
    height, width = 320, 480
    yy, xx = np.mgrid[0:height, 0:width]
    # Independent two-dimensional lighting gradient: many frequently occurring
    # blue/violet shades plus one small, coherent warm foreground object.
    rgb = np.stack([64+136*xx/width, 56+145*yy/height,
                    180+64*xx*yy/(width*height)], axis=2).astype(np.uint8)
    cv2.circle(rgb, (340, 210), 10, (244, 153, 134), -1)
    detections, _ = detect_frame(rgb, 0, [])
    warm = [o for o in detections if o.color[0] > 220 and o.color[0] > o.color[2]*1.25]
    assert len(warm) == 1
    assert warm[0].center[0] == pytest.approx(340, abs=1)
    assert warm[0].center[1] == pytest.approx(210, abs=1)
    assert warm[0].width == pytest.approx(20, abs=2)


def test_ocr_removal_keeps_local_colored_panel_beneath_editable_text():
    # The local background differs from the global canvas. Excluding the whole
    # OCR box from every mask used to cut a black rectangle through this panel.
    image = np.full((240, 480, 3), (10, 12, 20), np.uint8)
    cv2.rectangle(image, (30, 35), (445, 205), (45, 80, 150), -1)
    cv2.putText(image, "EDITABLE", (85, 135), cv2.FONT_HERSHEY_SIMPLEX,
                1.5, (245, 245, 245), 3, cv2.LINE_AA)
    rows = [{"text": "EDITABLE", "confidence": 1, "x": 80/480,
             "y": 90/240, "width": 255/480, "height": 55/240}]
    detections, _ = detect_frame(image, 0, rows)
    assert any(o.kind == "text" and o.text == "EDITABLE" for o in detections)
    shapes = [o for o in detections if o.kind != "text"]
    assert len(shapes) == 1
    assert shapes[0].kind == "rect"
    assert shapes[0].width == pytest.approx(416, abs=2)
    assert shapes[0].height == pytest.approx(171, abs=2)
    assert np.linalg.norm(np.array(shapes[0].color)-[45, 80, 150]) < 3
