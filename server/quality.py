"""Measured color regions and fitted SVG gradients for the optional high mode.

The temporary pixel arrays are analysis inputs only. Output consists of paths,
linear/radial paint parameters and the existing editable OCR text observations.
"""
from __future__ import annotations

import heapq
import math
import cv2
import numpy as np
from PIL import Image
from scipy.optimize import linear_sum_assignment


def pixel_edge_contours(mask: np.ndarray) -> list[np.ndarray]:
    """Trace cell edges, not centers, so adjacent color regions share a border."""
    pad = np.pad(mask.astype(bool), 1)
    inside = pad[1:-1, 1:-1]
    edges: dict[tuple[int, int], list] = {}
    for near, direction in ((pad[:-2, 1:-1], 0), (pad[1:-1, 2:], 1),
                            (pad[2:, 1:-1], 2), (pad[1:-1, :-2], 3)):
        ys, xs = np.where(inside & ~near)
        for x, y in zip(xs.tolist(), ys.tolist()):
            a, b = (((x, y), (x+1, y)), ((x+1, y), (x+1, y+1)),
                    ((x+1, y+1), (x, y+1)), ((x, y+1), (x, y)))[direction]
            edges.setdefault(a, []).append((b, direction))
    contours = []
    while edges:
        start = next(iter(edges))
        point, direction, loop = start, None, []
        while True:
            loop.append(point)
            choices = edges[point]
            # At a diagonal contact, turn into the same connected cell instead
            # of crossing to the neighboring contour.
            index = 0 if direction is None else min(range(len(choices)), key=lambda i: {1: 0, 0: 1, 3: 2, 2: 3}[(choices[i][1]-direction) % 4])
            point, direction = choices.pop(index)
            if not choices:
                del edges[loop[-1]]
            if point == start:
                break
        if len(loop) >= 4:
            contours.append(np.asarray(loop, np.float32).reshape(-1, 1, 2))
    return contours


def color_hex(color) -> str:
    return "#" + "".join(f"{int(c):02x}" for c in np.clip(np.round(color), 0, 255))


def _plane_fit(matrix, products, square_sum):
    coefficients = np.linalg.solve(matrix+np.eye(3)*1e-8, products)
    # A linear SVG gradient varies along one spatial axis. Reject the unsupported
    # second axis instead of pretending a general RGB plane is an SVG gradient.
    u, singular, vt = np.linalg.svd(coefficients[1:], full_matrices=False)
    coefficients[1:] = singular[0]*np.outer(u[:, 0], vt[0])
    coefficients[0] = (products[0]-matrix[0, 1:]@coefficients[1:])/matrix[0, 0]
    error = max(0, float(square_sum-2*np.sum(coefficients*products)+np.sum(coefficients*(matrix@coefficients))))
    return coefficients, error


def segment_regions(rgb: np.ndarray, color_count: int = 64) -> np.ndarray:
    """Join neighboring regions only when a continuous gradient explains them."""
    height, width = rgb.shape[:2]
    smooth = cv2.bilateralFilter(rgb, 5, 12, 3)
    lab = cv2.cvtColor(smooth, cv2.COLOR_RGB2LAB)
    training = lab[::4, ::4].reshape(-1, 3).astype(np.float32)
    count_colors = min(color_count, len(np.unique(training, axis=0)))
    cv2.setRNGSeed(1)
    _, _, centers = cv2.kmeans(training, max(1, count_colors), None,
                             (cv2.TERM_CRITERIA_EPS+cv2.TERM_CRITERIA_MAX_ITER, 25, .3), 1, cv2.KMEANS_PP_CENTERS)
    palette = cv2.cvtColor(centers.astype(np.uint8)[None, :, :], cv2.COLOR_LAB2RGB)[0]
    # Tiny neutral details (pupils, eye highlights, thin white marks) can be
    # absent from a palette dominated by a colorful background. Preserve only
    # neutral tones actually present in this frame as additional segmentation
    # seeds; the eventual paint is still measured from the original region.
    flat = smooth.reshape(-1, 3)
    neutral = flat[np.ptp(flat.astype(np.int16), axis=1) < 18]
    if len(neutral):
        levels = neutral.mean(axis=1)//32
        for level in np.unique(levels):
            samples = neutral[levels == level]
            if len(samples) < 8:
                continue
            candidate = np.median(samples, axis=0).astype(np.uint8)
            if np.min(np.linalg.norm(palette.astype(float)-candidate, axis=1)) > 18:
                palette = np.vstack([palette, candidate])
    pal_image = Image.new("P", (1, 1))
    # Repeat a valid color in unused slots; a black padding slot would introduce
    # an unintended quantization color in very dark input regions.
    palette_full = np.concatenate([palette, np.repeat(palette[:1], 256-len(palette), axis=0)])
    pal_image.putpalette(palette_full.ravel().tolist())
    quantized = np.asarray(Image.fromarray(smooth).quantize(palette=pal_image, dither=Image.Dither.NONE))
    labels = np.zeros((height, width), np.int32)
    count = 0
    for color in np.unique(quantized):
        n, components = cv2.connectedComponents((quantized == color).astype(np.uint8), connectivity=4)
        inside = components > 0
        labels[inside] = components[inside]+count-1
        count += n-1
    sizes = np.bincount(labels.ravel(), minlength=count)
    sums = np.stack([np.bincount(labels.ravel(), weights=rgb[:, :, channel].ravel(), minlength=count) for channel in range(3)], axis=1)
    means = sums/np.maximum(1, sizes[:, None])
    neutral_detail = (np.ptp(means, axis=1) < 12) & ((means.mean(axis=1) < 30) | (means.mean(axis=1) > 235)) & (sizes >= 2)
    tiny = (sizes[labels] < 8) & ~neutral_detail[labels]
    if np.any(tiny) and np.any(~tiny):
        _, nearest = cv2.distanceTransformWithLabels(tiny.astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
        kept = labels[~tiny]
        labels[tiny] = kept[nearest[tiny]-1]
    _, inverse = np.unique(labels, return_inverse=True)
    labels = inverse.reshape(height, width).astype(np.int32)
    count = int(labels.max())+1
    if count == 1:
        return labels

    yy, xx = np.mgrid[:height, :width]
    x, y, ids = xx.ravel()/width, yy.ravel()/height, labels.ravel()
    pixels = rgb.reshape(-1, 3).astype(float)
    features = np.stack([np.ones(len(x)), x, y], axis=1)
    matrices, products = np.zeros((count, 3, 3)), np.zeros((count, 3, 3))
    for i in range(3):
        for j in range(3):
            matrices[:, i, j] = np.bincount(ids, weights=features[:, i]*features[:, j], minlength=count)
            products[:, i, j] = np.bincount(ids, weights=features[:, i]*pixels[:, j], minlength=count)
    squares = np.bincount(ids, weights=(pixels*pixels).sum(1), minlength=count)
    sizes = matrices[:, 0, 0].copy()
    parents, versions = np.arange(count), np.zeros(count, int)
    neighbors = [set() for _ in range(count)]
    left = np.concatenate([labels[:, :-1].ravel(), labels[:-1, :].ravel()])
    right = np.concatenate([labels[:, 1:].ravel(), labels[1:, :].ravel()])
    differs = left != right
    pairs = np.unique(np.sort(np.stack([left[differs], right[differs]], axis=1), axis=1), axis=0)
    for a, b in pairs:
        neighbors[a].add(b)
        neighbors[b].add(a)
    errors = np.array([_plane_fit(matrices[i], products[i], squares[i])[1] for i in range(count)])
    heap = []

    def push(a, b):
        if a == b:
            return
        if a > b:
            a, b = b, a
        # A narrow high-contrast detail can look like a perfect linear ramp to
        # least squares. Protect real boundaries such as white eye / dark pupil
        # before evaluating gradient error, including very small regions.
        if np.linalg.norm(products[a, 0]/sizes[a]-products[b, 0]/sizes[b]) > 48:
            return
        _, error = _plane_fit(matrices[a]+matrices[b], products[a]+products[b], squares[a]+squares[b])
        # Normalize by the smaller region so a large background cannot cheaply
        # swallow a face, hand, pupil or small icon of a contrasting color.
        penalty = max(0, error-errors[a]-errors[b])/max(1, min(sizes[a], sizes[b]))
        heapq.heappush(heap, (penalty, int(a), int(b), versions[a], versions[b], error))

    for a, b in pairs:
        push(a, b)
    while heap:
        penalty, a, b, va, vb, error = heapq.heappop(heap)
        if versions[a] != va or versions[b] != vb or parents[a] != a or parents[b] != b:
            continue
        if penalty > 8**2*3:
            break
        parents[b] = a
        matrices[a] += matrices[b]
        products[a] += products[b]
        squares[a] += squares[b]
        sizes[a] += sizes[b]
        errors[a] = error
        versions[a] += 1
        versions[b] += 1
        neighbors[a] |= neighbors[b]
        neighbors[a].discard(a)
        neighbors[a].discard(b)
        for neighbor in tuple(neighbors[a]):
            neighbors[neighbor].discard(b)
            neighbors[neighbor].add(a)
            push(a, neighbor)
        neighbors[b].clear()
    for i in range(count):
        parent = i
        while parents[parent] != parent:
            parent = parents[parent]
        parents[i] = parent
    return parents[labels]


def fit_gradient(pixels: np.ndarray, xs: np.ndarray, ys: np.ndarray, width: int, height: int):
    """Choose a measured linear/radial paint only when it improves flat color."""
    step = max(1, len(pixels)//1600)
    colors = pixels[::step].astype(float)
    positions = np.column_stack([xs[::step]/max(1, width), ys[::step]/max(1, height)])
    # Small removed codec/quantization fragments can contribute a few strongly
    # contrasting boundary pixels to a region. Robust paint fitting prevents a
    # white highlight from turning an otherwise black pupil uniformly gray.
    median = np.median(colors, axis=0)
    distances = np.linalg.norm(colors-median, axis=1)
    inliers = distances <= max(12, 3*float(np.median(distances)))
    if np.count_nonzero(inliers) >= max(3, len(colors)*.55):
        colors, positions = colors[inliers], positions[inliers]
    mean = colors.mean(axis=0)
    constant_error = float(np.mean((colors-mean)**2))
    if constant_error < 2:
        return color_hex(mean), None
    features = np.column_stack([np.ones(len(colors)), positions])
    coefficients, _ = _plane_fit(features.T@features, features.T@colors, float(np.sum(colors*colors)))
    u, _, _ = np.linalg.svd(coefficients[1:], full_matrices=False)
    direction = u[:, 0]
    low, high = positions.min(0), positions.max(0)
    center, half = (low+high)/2, (high-low)/2
    span = float(np.sum(np.abs(direction)*half))
    candidates = []
    if span > 1e-5:
        a, b = center-direction*span, center+direction*span
        c1, c2 = np.clip(np.r_[1, a]@coefficients, 0, 255), np.clip(np.r_[1, b]@coefficients, 0, 255)
        t = np.clip((positions-a)@direction/(2*span), 0, 1)
        predicted = c1[None, :]+t[:, None]*(c2-c1)
        gradient = {"type": "linear", "x1": round(float(a[0]), 5), "y1": round(float(a[1]), 5), "x2": round(float(b[0]), 5), "y2": round(float(b[1]), 5),
                    "stops": [{"offset": 0, "color": color_hex(c1)}, {"offset": 1, "color": color_hex(c2)}]}
        candidates.append((float(np.mean((predicted-colors)**2)), gradient))
    for cx in (.15, .5, .85):
        for cy in (.15, .5, .85):
            radii = np.linalg.norm(positions-[cx, cy], axis=1)
            radius = max(.001, float(radii.max()))
            t = radii/radius
            centered = t-t.mean()
            denominator = float(centered@centered)
            if denominator < 1e-7:
                continue
            slope = centered@colors/denominator
            start = mean-slope*t.mean()
            c1, c2 = np.clip(start, 0, 255), np.clip(start+slope, 0, 255)
            predicted = c1[None, :]+t[:, None]*(c2-c1)
            gradient = {"type": "radial", "cx": cx, "cy": cy, "r": round(radius, 5),
                        "stops": [{"offset": 0, "color": color_hex(c1)}, {"offset": 1, "color": color_hex(c2)}]}
            candidates.append((float(np.mean((predicted-colors)**2)), gradient))
    error, gradient = min(candidates, key=lambda item: item[0]) if candidates else (constant_error, None)
    return color_hex(np.median(colors, axis=0)), gradient if error < constant_error*.80 else None


def high_detections(rgb: np.ndarray, time: float, ocr_rows: list[dict]):
    from .analyzer import Observation, background_color, detect_frame
    height, width = rgb.shape[:2]
    # Reuse the tested OCR/font measurement; its coarse geometry is discarded.
    text, bg = detect_frame(rgb, time, ocr_rows)
    text = [item for item in text if item.kind == "text"]
    exclusion = np.zeros((height, width), np.uint8)
    for row in ocr_rows:
        if len(str(row.get("text", "")).strip()) < 2 or float(row.get("confidence", 0)) < .35:
            continue
        x, y = max(0, int(row["x"]*width)), max(0, int(row["y"]*height))
        w, h = max(1, int(row["width"]*width)), max(1, int(row["height"]*height))
        cv2.rectangle(exclusion, (max(0, x-3), max(0, y-3)), (min(width-1, x+w+3), min(height-1, y+h+3)), 255, -1)
    clean = cv2.inpaint(rgb, exclusion, 3, cv2.INPAINT_TELEA) if np.any(exclusion) else rgb
    labels = segment_regions(clean)
    observations = []
    for region in np.unique(labels):
        ys, xs = np.where(labels == region)
        if len(xs) < 2:
            continue
        x, y, right, bottom = int(xs.min()), int(ys.min()), int(xs.max())+1, int(ys.max())+1
        w, h = right-x, bottom-y
        mask = labels[y:bottom, x:right] == region
        paths = []
        for contour in pixel_edge_contours(mask):
            points = cv2.approxPolyDP(contour, .35 if len(xs) < 256 else 1.0, True).reshape(-1, 2)
            if len(points) < 3:
                continue
            # Adjacent independently simplified curves can differ by a fraction
            # of a pixel. Extend the measured paint by 0.35 analysis pixels so
            # antialiasing cannot expose dark canvas seams between them.
            edges = np.roll(points, -1, axis=0)-points
            lengths = np.maximum(1e-6, np.linalg.norm(edges, axis=1))
            normals = np.column_stack([edges[:, 1], -edges[:, 0]])/lengths[:, None]
            previous = np.roll(normals, 1, axis=0)
            shifts = .35*(normals+previous)/np.maximum(.35, 1+np.sum(normals*previous, axis=1))[:, None]
            points = points+shifts
            coords = [(round(float(px)*1000/w, 1), round(float(py)*1000/h, 1)) for px, py in points]
            paths.append("M"+" L".join(f"{px:g} {py:g}" for px, py in coords)+" Z")
        if not paths:
            continue
        fill, gradient = fit_gradient(clean[ys, xs], xs-x, ys-y, w, h)
        color = tuple(int(fill[i:i+2], 16) for i in (1, 3, 5))
        observations.append(Observation(time, "path", x, y, w, h, color, tuple(bg), path=" ".join(paths),
                                        area=float(len(xs)), gradient=gradient, precise=True))
    return [*observations, *text], bg


def associate_precise(tracks, detections, time, sample_fps, diagonal):
    """Vectorized matching keeps dense region observations practical at 24 fps."""
    from .analyzer import Track, associate
    text_tracks = [track for track in tracks if track.observations[-1].kind == "text"]
    text_detections = [observation for observation in detections if observation.kind == "text"]
    previous_count = len(text_tracks)
    associate(text_tracks, text_detections, time, sample_fps, diagonal)
    tracks.extend(text_tracks[previous_count:])
    objects = [observation for observation in detections if observation.kind != "text"]
    active = [track for track in tracks if track.end_boundary is None and track.observations[-1].kind != "text"
              and time-track.observations[-1].time <= 1.5/sample_fps+1e-6]
    if not active or not objects:
        tracks.extend(Track([observation]) for observation in objects)
        return
    last = [track.observations[-1] for track in active]
    centers = np.array([observation.center for observation in last])
    for i, track in enumerate(active):
        if len(track.observations) >= 2:
            previous, current = track.observations[-2:]
            dt = current.time-previous.time
            if dt > 0:
                centers[i] += (current.center-previous.center)*(time-current.time)/dt
    new_centers = np.array([observation.center for observation in objects])
    distances = np.linalg.norm(centers[:, None, :]-new_centers[None, :, :], axis=2)/diagonal
    sizes = np.maximum(1, [[observation.width, observation.height] for observation in last])
    new_sizes = np.maximum(1, [[observation.width, observation.height] for observation in objects])
    size_cost = np.abs(np.log(new_sizes[None, :, :]/sizes[:, None, :])).sum(axis=2)
    colors = np.array([observation.color for observation in last])
    new_colors = np.array([observation.color for observation in objects])
    color_cost = np.linalg.norm(colors[:, None, :]-new_colors[None, :, :], axis=2)/441.7
    costs = distances*5+size_cost*.15+color_cost*.45
    costs[(distances > .2) | (size_cost > 1.7) | (color_cost > .5)] = 1e6
    rows, columns = linear_sum_assignment(costs)
    matched = set()
    for i, j in zip(rows, columns):
        if costs[i, j] < 1.1:
            active[i].observations.append(objects[j])
            matched.add(j)
    tracks.extend(Track([observation]) for j, observation in enumerate(objects) if j not in matched)
