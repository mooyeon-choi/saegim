"""Pixel-evidence-based extraction into the shared MotionProject schema.

The model intentionally targets flat 2D graphics. No source frame is embedded in
its output. Every emitted element comes from an OCR observation or a color mask.
"""
from __future__ import annotations
from collections import Counter
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from difflib import SequenceMatcher
from functools import lru_cache
import math
from pathlib import Path
import re
import subprocess
import tempfile
import threading
from typing import Callable
import uuid
import cv2
import imageio_ffmpeg
import numpy as np
from scipy.optimize import linear_sum_assignment
from PIL import ImageFont
from .demo import font_path
from .ocr import VisionOCR
from .budgets import PROJECT_LIMITS, check_project_budget, require_budget

cv2.setNumThreads(1)
MAX_DURATION = 30.0
MAX_NODES = 240


class AnalysisCancelled(Exception):
    pass


def check_cancel(cancel: threading.Event):
    if cancel.is_set():
        raise AnalysisCancelled()


def hex_color(rgb) -> str:
    return "#" + "".join(f"{int(np.clip(c, 0, 255)):02x}" for c in rgb)


@lru_cache(maxsize=8)
def font_candidates(ascii_only: bool) -> tuple[tuple[str, str, int, int], ...]:
    choices = []
    if ascii_only:
        variants = [("Arial, Helvetica, sans-serif", "Arial.ttf", 400),
                    ("Arial, Helvetica, sans-serif", "Arial Bold.ttf", 700),
                    ("Arial Black, Arial, sans-serif", "Arial Black.ttf", 900)]
        for family, filename, weight in variants:
            for directory in ("/System/Library/Fonts/Supplemental", "/usr/share/fonts/truetype/msttcorefonts"):
                path = Path(directory)/filename
                if path.is_file():
                    choices.append((family, str(path), 0, weight))
                    break
    default = font_path()
    if default:
        family = "Apple SD Gothic Neo, Noto Sans KR, sans-serif" if "Apple" in default else "Noto Sans CJK KR, Noto Sans KR, sans-serif" if "CJK" in default else "DejaVu Sans, sans-serif"
        choices.append((family, default, 0, 400))
        if "Apple" in default:
            choices.extend([(family, default, 6, 700), (family, default, 16, 900)])
    return tuple(choices)


@lru_cache(maxsize=1024)
def selected_font(text: str, family: str, weight: int, size: int):
    choices = font_candidates(text.isascii())
    selected = next((c for c in choices if c[0] == family and c[3] == weight), choices[-1] if choices else None)
    return ImageFont.truetype(selected[1], size, index=selected[2]) if selected else None


@lru_cache(maxsize=2048)
def text_metrics(text: str, family: str = "", size: int = 100, weight: int = 400) -> tuple[float, float, float, float]:
    """Actual glyph ink at 100 px, including bearings instead of advance width."""
    font = selected_font(text, family, weight, size)
    if font:
        left, top, _, _ = font.getbbox(text, anchor="ls")
        ink = font.getmask(text).getbbox()
        if ink:
            return max(1, ink[2]-ink[0])*100/size, (left+ink[0])*100/size, (top+ink[1])*100/size, max(1, ink[3]-ink[1])*100/size
    return max(1, len(text)*65), 0, -80, 85


def fitted_text_metrics(text: str, family: str, width: float, weight: int = 400) -> tuple[float, float, float, float]:
    approximate_size = max(1, min(4096, round(width*100/text_metrics(text, family, weight=weight)[0])))
    return text_metrics(text, family, approximate_size, weight)


@lru_cache(maxsize=2048)
def normalized_glyphs(text: str, family: str, weight: int, size: int) -> np.ndarray:
    font = selected_font(text, family, weight, size)
    if font is None:
        return np.zeros((48, 240), np.float32)
    mask = font.getmask(text)
    ink = mask.getbbox()
    if not ink:
        return np.zeros((48, 240), np.float32)
    array = np.array(mask, dtype=np.uint8).reshape(mask.size[1], mask.size[0])
    crop = array[ink[1]:ink[3], ink[0]:ink[2]]
    return cv2.resize(crop.astype(np.float32)/255, (240, 48), interpolation=cv2.INTER_AREA)


def choose_text_font(text: str, width: float, height: float, ink_mask: np.ndarray | None = None) -> tuple[str, int]:
    choices = font_candidates(text.isascii())
    if not choices:
        return "sans-serif", 400
    observed_ratio = width/max(1, height)
    observed = cv2.resize(ink_mask.astype(np.float32), (240, 48), interpolation=cv2.INTER_AREA) if ink_mask is not None else None
    def score(choice):
        family, _, _, weight = choice
        metrics = fitted_text_metrics(text, family, width, weight)
        aspect = abs(math.log((metrics[0]/metrics[3])/observed_ratio))
        if observed is None:
            return aspect
        size = max(1, min(4096, round(width*100/metrics[0])))
        glyphs = normalized_glyphs(text, family, weight, size)
        # Both actual stroke occupancy and letter shapes contribute. Merely
        # stretching a thin font to the OCR box cannot win on aspect alone.
        ink_error = float(np.mean(np.abs(observed-glyphs)))/max(.2, float(np.mean(np.maximum(observed, glyphs))))
        return aspect*.45+ink_error
    choice = min(choices, key=score)
    return choice[0], choice[3]


def estimate_corner_radius(contour, center_x: float, center_y: float, width: float, height: float, angle: float) -> float:
    """Fit a rounded-rectangle signed distance boundary in unrotated coordinates.

    Fitting the contour, rather than area alone, avoids interpreting the raster
    stair steps on a rotated sharp rectangle as a large corner radius.
    """
    deficit = max(0, width*height-cv2.contourArea(contour))
    if deficit < 1 or min(width, height) < 6:
        return 0.0
    theta = math.radians(angle)
    rotate = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    points = (contour.reshape(-1, 2)-[center_x, center_y]) @ rotate
    upper = min(width/2, height/2, math.sqrt(deficit/(4-math.pi))*1.5+3)
    candidates = np.linspace(0, upper, min(100, max(2, int(upper*2)+1)))
    best = (float("inf"), 0.0)
    sharp_error = None
    for radius in candidates:
        q = np.abs(points)-np.array([width/2-radius, height/2-radius])
        signed = np.linalg.norm(np.maximum(q, 0), axis=1)+np.minimum(np.maximum(q[:, 0], q[:, 1]), 0)-radius
        score = float(np.mean(signed*signed))
        if sharp_error is None:
            sharp_error = score
        if score < best[0]:
            best = (score, float(radius))
    # Pixel stair steps can weakly prefer a tiny radius even for a sharp corner.
    # Require a material improvement over the sharp-rectangle boundary.
    return round(best[1], 2) if best[1] >= 2 and best[0] < .8*max(sharp_error, 1e-9) else 0.0


def probe_video(path: Path, max_duration: float = MAX_DURATION) -> dict:
    cap = cv2.VideoCapture(str(path))
    try:
        if not cap.isOpened():
            raise ValueError("영상 파일을 읽을 수 없습니다. MP4 또는 WebM 영상을 확인해 주세요.")
        declared_width = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
        declared_height = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
        if max(declared_width, declared_height) > 4096 or declared_width*declared_height > 4096*2160:
            raise ValueError("최대 4K 해상도(4096×2160 또는 세로 방향)까지 지원합니다.")
        ok, frame = cap.read()
        if not ok or frame is None:
            raise ValueError("영상에 디코딩 가능한 프레임이 없습니다.")
        height, width = frame.shape[:2]
        fps = float(cap.get(cv2.CAP_PROP_FPS))
        count = float(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if not math.isfinite(fps) or fps <= 0:
            fps = 30.0
        duration = count / fps if math.isfinite(count) and count > 0 else 0
        probe = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True, timeout=15)
        match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", probe.stderr)
        if match:
            declared_duration = int(match[1])*3600 + int(match[2])*60 + float(match[3])
            # FFmpeg's human-readable duration has only two decimal places.
            # Retain the frame-count duration when they differ just by rounding.
            if not math.isfinite(duration) or duration <= 0 or abs(duration-declared_duration) > .1:
                duration = declared_duration
        if not math.isfinite(duration) or duration < 0.2:
            raise ValueError("길이가 0.2초 이상인 영상이 필요합니다.")
        if duration > max_duration + 0.04:
            raise ValueError(f"{max_duration:g}초 이하의 영상을 지원합니다. 구간을 잘라 업로드해 주세요.")
        if max(width, height) > 4096 or width*height > 4096*2160:
            raise ValueError("최대 4K 해상도(4096×2160 또는 세로 방향)까지 지원합니다.")
        return {"width": width, "height": height, "fps": round(fps, 5), "duration": min(duration, max_duration)}
    finally:
        cap.release()


@dataclass
class Observation:
    time: float
    kind: str
    x: float
    y: float
    width: float
    height: float
    color: tuple
    background: tuple
    path: str = ""
    text: str = ""
    confidence: float = 1.0
    rotation: float = 0.0
    area: float = 0.0
    corner_radius: float = 0.0
    font_family: str = ""
    font_weight: int = 400
    ink_x: float | None = None
    ink_y: float | None = None
    gradient: dict | None = None
    precise: bool = False

    @property
    def center(self):
        return np.array([self.x+self.width/2, self.y+self.height/2])


@dataclass
class Track:
    observations: list[Observation] = field(default_factory=list)
    end_boundary: float | None = None


def background_color(rgb: np.ndarray) -> np.ndarray:
    # Border majority is robust to centrally placed titles and objects.
    border = np.concatenate([rgb[:3].reshape(-1, 3), rgb[-3:].reshape(-1, 3), rgb[:, :3].reshape(-1, 3), rgb[:, -3:].reshape(-1, 3)])
    bins = (border // 16).astype(np.int16)
    packed = bins[:, 0]*256+bins[:, 1]*16+bins[:, 2]
    dominant = np.bincount(packed, minlength=4096).argmax()
    return np.median(border[packed == dominant], axis=0).astype(np.uint8)


def contour_path(contours: list[np.ndarray], x: int, y: int, w: int, h: int) -> str:
    chunks = []
    for contour in contours:
        epsilon = max(0.6, cv2.arcLength(contour, True)*0.002)
        points = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
        if len(points) < 3:
            continue
        coords = [((float(px)-x)*1000/max(w, 1), (float(py)-y)*1000/max(h, 1)) for px, py in points]
        chunks.append("M" + " L".join(f"{px:.2f} {py:.2f}" for px, py in coords) + " Z")
    return " ".join(chunks)


def detect_frame(rgb: np.ndarray, time: float, ocr_rows: list[dict]) -> tuple[list[Observation], np.ndarray]:
    height, width = rgb.shape[:2]
    bg = background_color(rgb)
    detections = []
    exclusion = np.zeros((height, width), dtype=np.uint8)
    for row in ocr_rows:
        text = str(row.get("text", "")).strip()
        confidence = float(row.get("confidence", 0))
        if len(text) < 2 or confidence < 0.35:
            continue
        x = max(0, int(row["x"]*width))
        y = max(0, int(row["y"]*height))
        w = min(width-x, max(1, int(row["width"]*width)))
        h = min(height-y, max(1, int(row["height"]*height)))
        crop = rgb[y:y+h, x:x+w]
        distances = np.linalg.norm(crop.astype(float)-bg.astype(float), axis=2)
        ink = crop[distances >= max(28, float(np.quantile(distances, .9)))]
        if len(ink) < 3:
            continue
        color = np.median(ink, axis=0)
        # Vision's box includes padding; measure the glyph ink inside it and map
        # the chosen local font's baseline to that measured ink position.
        yy, xx = np.where(distances > max(28, float(np.quantile(distances, .8))*.55))
        if len(xx):
            ink_x, ink_y = x+int(xx.min()), y+int(yy.min())
            ink_w, ink_h = int(xx.max()-xx.min()+1), int(yy.max()-yy.min()+1)
        else:
            ink_x, ink_y, ink_w, ink_h = x, y, w, h
        glyph_mask = (distances > max(28, float(np.quantile(distances, .8))*.55)).astype(np.float32)
        glyph_mask = glyph_mask[ink_y-y:ink_y-y+ink_h, ink_x-x:ink_x-x+ink_w]
        family, weight = choose_text_font(text, ink_w, ink_h, glyph_mask)
        metric_width, metric_left, metric_top, _ = fitted_text_metrics(text, family, ink_w, weight)
        font_size = ink_w*100/metric_width
        origin_x = ink_x-metric_left*font_size/100
        origin_y = ink_y-(.86+metric_top/100)*font_size
        detections.append(Observation(time, "text", origin_x, origin_y, ink_w, ink_h, tuple(color), tuple(bg), text=text, confidence=confidence, area=ink_w*ink_h, font_family=family, font_weight=weight, ink_x=ink_x, ink_y=ink_y))
        cv2.rectangle(exclusion, (max(0, x-3), max(0, y-3)), (min(width-1, x+w+3), min(height-1, y+h+3)), 255, -1)
    # Removing an OCR rectangle from every color mask exposes the global canvas
    # background as a visible band when text sits over a colored panel/gradient.
    # Reconstruct nearby background only for geometry extraction, then render
    # the independently measured editable text above those vector regions.
    geometry_rgb = cv2.inpaint(rgb, exclusion, 3, cv2.INPAINT_TELEA) if np.any(exclusion) else rgb
    reduced = geometry_rgb[::2, ::2]
    bins = reduced // 16
    packed = bins[:, :, 0].astype(np.int32)*256 + bins[:, :, 1].astype(np.int32)*16 + bins[:, :, 2]
    unique, counts = np.unique(packed, return_counts=True)
    order = np.argsort(counts)[::-1]
    colors = []
    min_pixels = max(5, width*height*0.00008)
    # A smooth background can occupy dozens of neighboring quantized bins.
    # Search every sufficiently populated bin before applying the distinct-color
    # budget, so a smaller but coherent face/icon color is not silently lost.
    for index in order:
        if counts[index] < min_pixels:
            break
        col = np.median(reduced[packed == unique[index]], axis=0)
        if np.linalg.norm(col-bg) < 38 or any(np.linalg.norm(col-c) < 60 for c in colors):
            continue
        # Codec/antialias fringes are mixtures of an existing ink and background,
        # not new objects. Keep the most frequently observed interior ink.
        fringe = False
        for existing in colors:
            vector = existing-bg
            fraction = float(np.dot(col-bg, vector)/max(1, np.dot(vector, vector)))
            if 0 < fraction < 1 and np.linalg.norm(col-(bg+fraction*vector)) < 23:
                fringe = True
                break
        if fringe:
            continue
        colors.append(col)
        if len(colors) == 14:
            break
    occupied = np.zeros_like(exclusion)
    image_float = geometry_rgb.astype(np.float32)
    foreground = np.linalg.norm(image_float-bg, axis=2) > 32
    for color in colors:
        mask = ((np.linalg.norm(image_float-color, axis=2) < 48) & foreground & (occupied == 0)).astype(np.uint8)*255
        # Compression pinholes disappear, but distinct nearby elements stay separate.
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        occupied[mask > 0] = 255
        contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
        if hierarchy is None:
            continue
        for i, contour in enumerate(contours):
            if hierarchy[0][i][3] != -1:
                continue
            area = cv2.contourArea(contour)
            x, y, w, h = cv2.boundingRect(contour)
            if area < max(10, width*height*.000025) or w < 2 or h < 2:
                continue
            children = []
            child_index = int(hierarchy[0][i][2])
            while child_index != -1:
                if cv2.contourArea(contours[child_index]) > 6:
                    children.append(contours[child_index])
                child_index = int(hierarchy[0][child_index][0])
            ratio = area/(w*h)
            perimeter = cv2.arcLength(contour, True)
            circularity = 4*math.pi*area/max(1, perimeter*perimeter)
            # A rotated rectangle is represented by its unrotated dimensions and
            # center, rather than a changing axis-aligned bounding box.
            rotation = 0.0
            corner_radius = 0.0
            (cx, cy), (rw, rh), angle = cv2.minAreaRect(contour)
            oriented_fill = area/max(1, rw*rh)
            if not children and oriented_fill > .90:
                kind = "rect"
                if rw < rh:
                    rw, rh, angle = rh, rw, angle+90
                rotation = (angle+90) % 180-90
                if abs(rotation) < .7:
                    rotation = 0.0
                corner_radius = estimate_corner_radius(contour, cx, cy, rw, rh, angle)
                x, y, w, h = cx-(rw+1)/2, cy-(rh+1)/2, rw+1, rh+1
            elif not children and .65 < ratio < .85 and circularity > .73 and len(contour) >= 5:
                kind = "ellipse"
            else:
                kind = "path"
            path = contour_path([contour, *children], x, y, w, h) if kind == "path" else ""
            points_mask = np.zeros_like(mask)
            cv2.drawContours(points_mask, [contour], -1, 255, -1)
            ink = geometry_rgb[(points_mask > 0) & (mask > 0)]
            actual_color = np.median(ink, axis=0) if len(ink) else color
            detections.append(Observation(time, kind, x, y, w, h, tuple(actual_color), tuple(bg), path=path, area=area, rotation=rotation, corner_radius=corner_radius))
    return detections[:MAX_NODES], bg


def associate(tracks: list[Track], detections: list[Observation], time: float, sample_fps: float, diagonal: float):
    active = [t for t in tracks if t.end_boundary is None and time-t.observations[-1].time <= max(.26, 2.5/sample_fps)]
    if not active or not detections:
        tracks.extend(Track([d]) for d in detections)
        return
    costs = np.full((len(active), len(detections)), 1e6)
    for i, track in enumerate(active):
        last = track.observations[-1]
        predicted = last.center.copy()
        if len(track.observations) >= 2:
            previous = track.observations[-2]
            dt = last.time-previous.time
            if dt > 0:
                velocity = (last.center-previous.center)/dt
                predicted += velocity*min(time-last.time, .2)
        for j, obs in enumerate(detections):
            if (last.kind == "text") != (obs.kind == "text"):
                continue
            distance = np.linalg.norm(predicted-obs.center)/diagonal
            size_cost = abs(math.log(max(obs.width, 1)/max(last.width, 1))) + abs(math.log(max(obs.height, 1)/max(last.height, 1)))
            color_cost = np.linalg.norm(np.array(last.color)-obs.color)/441.7
            if distance > .2 or size_cost > 1.7 or color_cost > .5:
                continue
            gap = time-last.time
            if color_cost > .12 and (gap > 1.5/sample_fps or size_cost > .7):
                last_ink = np.array(last.color)-np.array(last.background)
                new_ink = np.array(obs.color)-np.array(obs.background)
                hue_shift = np.linalg.norm(last_ink/max(1, np.linalg.norm(last_ink))-new_ink/max(1, np.linalg.norm(new_ink)))
                if hue_shift > .25:
                    # A missing object or a large shape change must not attach
                    # to a differently colored region. This also handles an
                    # adjacent hand/sleeve whose visibility changes without a
                    # missing sample. Foreground direction permits same-hue fades.
                    continue
            if last.kind == "text":
                similarity = SequenceMatcher(None, last.text.replace(" ", ""), obs.text.replace(" ", "")).ratio()
                if similarity < .5:
                    continue
                costs[i, j] = distance*5+size_cost*.1+(1-similarity)*.25
            else:
                costs[i, j] = distance*5+size_cost*.15+color_cost*.45+(.12 if last.kind != obs.kind else 0)
    rows, cols = linear_sum_assignment(costs)
    matched = set()
    for i, j in zip(rows, cols):
        if costs[i, j] < 1.1:
            obs = detections[j]
            last = active[i].observations[-1]
            if obs.kind == "rect" and last.kind == "rect":
                # A rectangle is visually invariant under 180-degree rotation.
                # Choose the equivalent angle nearest the preceding sample.
                obs.rotation += round((last.rotation-obs.rotation)/180)*180
            active[i].observations.append(obs)
            matched.add(j)
    tracks.extend(Track([d]) for j, d in enumerate(detections) if j not in matched)



def _project_time(value: float, duration: float, precise: bool = False) -> float:
    """Keep serialized times inside the original, unrounded project interval."""
    bounded = min(duration, max(0.0, value))
    if precise or bounded == 0.0 or bounded == duration:
        return bounded
    rounded = round(bounded, 5)
    # Rounding a last observation up to the endpoint can collapse a nonempty
    # node/scene. Retain its measured time when rounding would hit either edge.
    return rounded if 0.0 < rounded < duration else bounded

def track_to_node(track: Track, index: int, sx: float, sy: float, duration: float, sample_fps: float, precise_timing: bool = False) -> dict:
    observations = track.observations
    counts = Counter(o.kind for o in observations)
    kind = counts.most_common(1)[0][0]
    dominant_text = ""
    if kind == "text":
        dominant_text = Counter(o.text for o in observations if o.kind == "text").most_common(1)[0][0]
        dominant_family, dominant_weight = Counter((o.font_family, o.font_weight) for o in observations if o.text == dominant_text).most_common(1)[0][0]
        stable_observations = []
        for o in observations:
            mw, ml, mt, _ = fitted_text_metrics(o.text, dominant_family, o.width, dominant_weight)
            fs = o.width*100/mw
            stable_observations.append(replace(o, x=o.ink_x-ml*fs/100 if o.ink_x is not None else o.x,
                                              y=o.ink_y-(.86+mt/100)*fs if o.ink_y is not None else o.y,
                                              font_family=dominant_family, font_weight=dominant_weight))
        observations = stable_observations
    candidates = [o for o in observations if o.kind == kind and (kind != "text" or o.text == dominant_text)]
    base = max(candidates, key=lambda o: o.confidence*o.width*o.height)
    strongest = max(observations, key=lambda o: np.linalg.norm(np.array(o.color)-o.background))
    fill = np.array(strongest.color)
    frames = []
    for o in observations:
        full_difference = np.linalg.norm(fill-np.array(o.background))
        opacity = min(1, np.linalg.norm(np.array(o.color)-o.background)/max(1, full_difference))
        frames.append({"time": _project_time(o.time, duration, precise_timing), "x": round((o.x-base.x)*sx, 3), "y": round((o.y-base.y)*sy, 3), "scaleX": round(o.width/base.width, 5), "scaleY": round(o.height/base.height, 5), "rotation": round(o.rotation-base.rotation, 4), "opacity": round(opacity, 4), "easing": "linear"})
        if o.precise:
            frames[-1].update(fill=hex_color(o.color), gradient=o.gradient, opacity=1)
    if kind == "path":
        for o, keyframe in zip(observations, frames):
            if o.path:
                keyframe["path"] = o.path
            elif o.kind == "ellipse":
                keyframe["path"] = "M1000 500 A500 500 0 1 0 0 500 A500 500 0 1 0 1000 500 Z"
            else:
                keyframe["path"] = "M0 0 L1000 0 L1000 1000 L0 1000 Z"
    # Renderer scales about the center; shift top-left translation to preserve observed bounds.
    for o, frame in zip(observations, frames):
        frame["x"] += (o.width-base.width)*sx/2
        frame["y"] += (o.height-base.height)*sy/2
    first, last = observations[0].time, observations[-1].time
    end = min(duration, last+1/sample_fps)
    if duration-last < 1.75/sample_fps:
        end = duration
    if track.end_boundary is not None:
        end = min(end, track.end_boundary)
    node = {"id": f"node-{index+1}", "name": "", "type": kind,
            "x": round(base.x*sx, 3), "y": round(base.y*sy, 3), "width": round(base.width*sx, 3), "height": round(base.height*sy, 3),
            "rotation": round(base.rotation, 4), "opacity": 1, "fill": hex_color(fill), "stroke": "none", "strokeWidth": 0,
            "start": _project_time(first, duration, precise_timing), "end": _project_time(end, duration, precise_timing), "hidden": False, "locked": False, "keyframes": frames,
            "evidence": {"method": "Apple Vision OCR + 시간 추적" if kind == "text" else "OpenCV 색상 윤곽 + Hungarian 추적", "observations": len(observations), "needsReview": kind in ("text", "path"), "note": "폰트는 추정값입니다. 원본과 비교해 문구·크기를 확인하세요." if kind == "text" else "겹침·윤곽 변형·회전은 수동 확인이 필요합니다." if kind == "path" else "표본 프레임에서 관측한 위치·크기를 보간합니다."}}
    if base.precise:
        node["fill"] = hex_color(base.color)
        if base.gradient:
            node["gradient"] = base.gradient
        node["evidence"] = {"method": "공유 픽셀 경계 + 연속 그라데이션 추정 + 시간 추적", "observations": len(observations), "needsReview": True,
                            "note": "관측 색상 영역입니다. 의미상 같은 물체도 여러 영역으로 나뉠 수 있으며 조명·가림·영역 연결을 원본과 비교해 확인하세요."}
    if kind == "text":
        words = Counter(o.text for o in observations)
        node["text"] = words.most_common(1)[0][0]
        node["name"] = node["text"][:26]
        node["fontSize"] = round(base.width*sx*100/fitted_text_metrics(node["text"], base.font_family, base.width, base.font_weight)[0], 2)
        node["fontFamily"] = base.font_family or "sans-serif"
        node["fontWeight"] = base.font_weight
        node["letterSpacing"] = 0
    else:
        node["name"] = {"rect": "사각형", "ellipse": "원 / 타원", "path": "벡터 윤곽"}[kind] + f" {index+1}"
        if kind == "path":
            node["path"] = base.path
        elif kind == "rect":
            normalized_radii = [o.corner_radius*base.width/max(o.width, 1) for o in candidates]
            node["borderRadius"] = round(float(np.median(normalized_radii))*min(sx, sy), 2)
    return node


def analyze_video(path: Path, original_name: str, source_url: str, sample_fps: float,
                  cancel: threading.Event, update: Callable[[float, str], None], cache: Path, quality: str = "standard",
                  cut_times: list[float] | None = None) -> dict:
    check_cancel(cancel)
    update(2, "영상 정보와 입력 조건 확인")
    meta = probe_video(path)
    high_quality = quality == "high"
    if quality not in ("standard", "high"):
        raise ValueError("분석 품질은 standard 또는 high여야 합니다.")
    sample_fps = min(24 if high_quality else float(sample_fps), meta["fps"])
    max_nodes = PROJECT_LIMITS.nodes if high_quality else MAX_NODES
    if high_quality:
        from .temporal import scan_video_cuts
        update(3, "원본 장면 전환과 관측 시각 확인")
        if cut_times is None:
            cut_times = scan_video_cuts(path, meta["fps"], meta["duration"], lambda: check_cancel(cancel))
        cut_times = sorted(time for time in set(cut_times) if 0 < time < meta["duration"])
    update(5, "로컬 OCR 준비")
    ocr = VisionOCR(cache)
    cap = cv2.VideoCapture(str(path))
    warnings = ["평면 단색 2D 영상용 자동 초안입니다. 그라데이션·그림자·실사·가려짐은 정확히 복원하지 못할 수 있습니다.",
                f"초당 {sample_fps:g}개 표본 사이를 선형 보간합니다. 빠른 이동·등장·퇴장 시점은 원본과 비교해 보정하세요.",
                "원본 폰트 이름·레이어 순서·임의 아이콘의 회전·마스크는 자동 복원하지 않습니다. 사각형의 회전은 윤곽에서 추정하고, 패스 모양은 관측 시점마다 바뀌는 벡터로 보존합니다. 오디오는 내보내기에 포함되지 않습니다."]
    tracks = []
    backgrounds = []
    scene_starts = [0.0]
    next_cut = 0
    previous_signature = None
    sample_count = 0
    next_time = 0.0
    previous_pts = -1.0
    used_fallback = False
    frame_index = 0
    sx = sy = 1.0
    try:
        with tempfile.TemporaryDirectory(prefix="motion-frames-") as folder:
            image_path = Path(folder)/"ocr.png"
            while True:
                check_cancel(cancel)
                ok, frame = cap.read()
                if not ok:
                    break
                pts = cap.get(cv2.CAP_PROP_POS_MSEC)/1000
                if not math.isfinite(pts) or (frame_index > 0 and pts <= previous_pts):
                    pts = frame_index/meta["fps"]
                    used_fallback = True
                previous_pts = pts
                frame_index += 1
                if pts > MAX_DURATION+.05:
                    break
                if pts+1e-5 < next_time:
                    continue
                if pts >= meta["duration"]:
                    break
                next_time += 1/sample_fps
                ratio = min(1, (1280 if high_quality else 960)/max(frame.shape[:2]))
                if ratio < 1:
                    frame = cv2.resize(frame, None, fx=ratio, fy=ratio, interpolation=cv2.INTER_AREA)
                sy, sx = meta["height"]/frame.shape[0], meta["width"]/frame.shape[1]
                cv2.imwrite(str(image_path), frame)
                rows = ocr.recognize(image_path)
                check_cancel(cancel)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                if high_quality:
                    from .quality import high_detections
                    detections, bg = high_detections(rgb, pts, rows)
                else:
                    detections, bg = detect_frame(rgb, pts, rows)
                signature = cv2.resize(rgb, (32, 32), interpolation=cv2.INTER_AREA).astype(float)
                if high_quality:
                    while next_cut < len(cut_times) and cut_times[next_cut] <= pts+1e-9:
                        boundary = cut_times[next_cut]
                        scene_starts.append(boundary)
                        for track in tracks:
                            if track.end_boundary is None:
                                track.end_boundary = boundary
                        next_cut += 1
                elif previous_signature is not None and pts-scene_starts[-1] >= .25:
                    pixel_delta = np.linalg.norm(signature-previous_signature, axis=2)
                    changed = float(np.mean(pixel_delta > 55))
                    bg_delta = np.linalg.norm(bg.astype(float)-backgrounds[-1][1].astype(float))
                    # A widespread abrupt color/content change is a cut candidate.
                    # Local object motion or ordinary gradual fades do not split IDs.
                    if (bg_delta > 65 and changed > .68) or (changed > .93 and float(np.mean(pixel_delta)) > 145):
                        scene_starts.append(pts)
                        for track in tracks:
                            if track.end_boundary is None:
                                track.end_boundary = pts
                previous_signature = signature
                if high_quality:
                    from .quality import associate_precise
                    associate_precise(tracks, detections, pts, sample_fps, math.hypot(frame.shape[0], frame.shape[1]))
                else:
                    associate(tracks, detections, pts, sample_fps, math.hypot(frame.shape[0], frame.shape[1]))
                backgrounds.append((pts, bg))
                sample_count += 1
                update(min(92, 8+84*pts/meta["duration"]), f"요소 분석·추적 {sample_count} 프레임 / {pts:.1f}초")
            check_cancel(cancel)
    finally:
        cap.release()
        ocr.close()
    if ocr.error:
        warnings.append(ocr.error)
    if used_fallback:
        warnings.append("일부 프레임의 PTS를 읽을 수 없어 해당 구간에 평균 FPS 기반 시각을 사용했습니다. 가변 프레임률의 타이밍을 확인하세요.")
    if not backgrounds:
        raise ValueError("분석할 수 있는 영상 프레임이 없습니다.")
    update(94, "키프레임과 편집 가능한 벡터 데이터 정리")
    valid_tracks = [t for t in tracks if len(t.observations) >= (1 if high_quality else min(2, sample_count))]
    if len(valid_tracks) > max_nodes:
        if high_quality:
            require_budget("요소 수", len(valid_tracks), max_nodes)
        warnings.append(f"요소가 {len(valid_tracks)}개 검출되어 관측 면적·시간이 큰 {max_nodes}개만 보존했습니다. 복잡한 영상은 단순화해 주세요.")
        valid_tracks.sort(key=lambda t: sum(o.area for o in t.observations), reverse=True)
        valid_tracks = valid_tracks[:max_nodes]
    # Geometric layers below semantic text; within each group larger objects first.
    valid_tracks.sort(key=lambda t: (t.observations[0].kind == "text", -np.median([o.area for o in t.observations])))
    nodes = [track_to_node(t, i, sx, sy, meta["duration"], sample_fps, precise_timing=high_quality) for i, t in enumerate(valid_tracks)]
    if high_quality:
        warnings[0] = "정밀 색상 영역·선형/방사형 그라데이션으로 만든 벡터 초안입니다. 원본의 3D 모델·조명·리깅·숨은 영역을 복구한 결과는 아닙니다."
        warnings[1] = "관측 시점의 벡터 상태를 보존하며 같은 장면 안의 인접 관측 화면을 혼합합니다. 빠른 움직임에는 잔상이 보일 수 있습니다."
        warnings.append("정밀 모드는 관측한 윤곽·색상·그라데이션을 프레임별로 보존합니다. 같은 물체가 여러 편집 영역으로 분리될 수 있으며 파일이 커질 수 있습니다.")
    if not nodes:
        warnings.append("편집 가능한 요소를 찾지 못했습니다. 단색 배경에 대비가 높은 텍스트·도형 영상을 사용하거나 요소를 직접 추가하세요.")
    if len(nodes) > 60:
        warnings.append("작은 윤곽이 많이 검출되었습니다. 글자 미인식·복잡한 배경 때문에 한 요소가 여러 조각으로 분리되었을 수 있습니다.")
    bg_keyframes = []
    previous_bg = None
    for time, color in backgrounds:
        if previous_bg is None or np.linalg.norm(color.astype(float)-previous_bg.astype(float)) > 10:
            bg_keyframes.append({"time": _project_time(time, meta["duration"], high_quality), "color": hex_color(color)})
            previous_bg = color
    scene_ends = scene_starts[1:] + [meta["duration"]]
    scenes = [{"id": f"scene-{i+1}", "name": "전체 영상" if len(scene_starts) == 1 else f"장면 {i+1}", "start": _project_time(start, meta["duration"], high_quality), "end": _project_time(end, meta["duration"], high_quality)} for i, (start, end) in enumerate(zip(scene_starts, scene_ends))]
    if len(scenes) > 1:
        warnings.append(f"화면 전체의 급격한 변화에서 {len(scenes)}개 장면을 구분했습니다. 컷을 넘는 요소 ID는 분리되며 장면 경계는 표본 단위 추정입니다.")
    project = {"schemaVersion": 1, "id": str(uuid.uuid4()), "name": Path(original_name).stem[:100] or "변환 프로젝트", **meta,
            "background": hex_color(backgrounds[0][1]), "backgroundKeyframes": bg_keyframes,
            "nodes": nodes, "scenes": scenes, "source": {"name": original_name, "url": source_url, **meta},
            "analysis": {"engine": "local-gradient-vector-v1" if high_quality else "local-opencv-vision-v1", "sampleCount": sample_count, "warnings": warnings, "createdAt": datetime.now(timezone.utc).isoformat()}}
    if high_quality:
        from .temporal import CUT_WARNING, TIMING_WARNING, observed_temporal
        project["temporal"] = observed_temporal([time for time, _ in backgrounds], sample_fps, cut_times)
        warnings.append(CUT_WARNING)
        if project["temporal"]["mode"] == "off":
            warnings[1] = TIMING_WARNING
    check_cancel(cancel)
    update(97, "편집기 데이터 크기와 경로 한도 확인")
    check_project_budget(project)
    check_cancel(cancel)
    return project
