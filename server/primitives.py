"""Conservative simple geometry for editable, pixel-measured color regions."""
from __future__ import annotations

import cv2
import numpy as np


def polygon_path(points: np.ndarray, width: int, height: int) -> str:
    coords = points * [1000 / width, 1000 / height]
    return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in coords) + " Z"


def straight_strip(mask: np.ndarray) -> np.ndarray | None:
    """Return the four corners of a continuous straight stroke in cell coordinates."""
    ys, xs = np.nonzero(mask)
    if len(xs) < 8 or max(mask.shape) < 8:
        return None
    points = np.column_stack((xs, ys)).astype(float) + .5
    center = points.mean(axis=0)
    centered = points - center
    _, axes = np.linalg.eigh(centered.T @ centered)
    direction = axes[:, 1]
    normal = axes[:, 0]
    along, across = centered @ direction, centered @ normal
    # Pixels on an oblique centerline can meet at their corners. Integrate
    # occupied area to estimate thickness without inflating the diagonal strip.
    half_cell = np.abs(direction).sum() / 2
    start, end = along.min() - half_cell, along.max() + half_cell
    length = end - start
    thickness = len(xs) / length
    if thickness > 6 or length < 7 * max(1, thickness):
        return None
    if np.abs(across).max() > thickness / 2 + .65:
        return None
    # Reject dotted lines, notches and bent strokes before joining components.
    trim = min(2.0, length * .12)
    samples = center + np.linspace(start + trim, end - trim,
                                  int(np.ceil(length * 2)))[:, None] * direction
    indices = np.floor(samples).astype(int)
    h, w = mask.shape
    indices = np.clip(indices, [0, 0], [w - 1, h - 1])
    if not mask[indices[:, 1], indices[:, 0]].all():
        return None
    # Concave edges and interior gaps can have the same area and centerline
    # as a filled bar. Require agreement with every interior pixel center.
    yy, xx = np.indices(mask.shape, dtype=float)
    xx += .5 - center[0]
    yy += .5 - center[1]
    off = np.abs(xx * normal[0] + yy * normal[1])
    pos = xx * direction[0] + yy * direction[1]
    interior = (off < thickness / 2 - .55) & (pos > start + trim) & (pos < end - trim)
    if np.any(interior & ~mask):
        return None
    side = normal * (thickness / 2)
    a, b = center + start * direction, center + end * direction
    return np.array([a - side, b - side, b + side, a + side])


def join_diagonal_strokes(mask: np.ndarray, components: np.ndarray) -> np.ndarray:
    """Join corner-touching same-color fragments only when they fit one stroke."""
    count, diagonal, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    remap = np.arange(int(components.max()) + 1, dtype=np.int32)
    for group in range(1, count):
        x, y, w, h, area = stats[group]
        if area < 8 or max(w, h) < 8 or area > 7 * np.hypot(w, h):
            continue
        selection = diagonal[y:y+h, x:x+w] == group
        ids = np.unique(components[y:y+h, x:x+w][selection])
        if len(ids) > 1 and straight_strip(selection) is not None:
            remap[ids] = ids[0]
    return remap[components]


def fit_region(mask: np.ndarray, contours: list[np.ndarray]) -> tuple[str | None, str] | None:
    """Fit the region in its original paint bounds, preserving holes and clipping."""
    h, w = mask.shape
    if mask.all():
        return "rect", "M0 0 L1000 0 L1000 1000 L0 1000 Z"
    # Multiple disjoint cell loops can comprise a one-pixel diagonal, but a
    # genuine interior loop must survive even on a very slender object.
    if any(cv2.contourArea(loop, oriented=True) < 0 for loop in contours):
        return None
    if int(mask.sum()) <= 7 * np.hypot(w, h):
        strip = straight_strip(mask)
        if strip is not None:
            return None, polygon_path(strip, w, h)
    if len(contours) != 1 or min(w, h) < 6:
        return None
    boundary = contours[0]
    if min(w, h) >= 8:
        yy, xx = np.indices(mask.shape, dtype=float)
        radial = ((xx + .5 - w/2) / (w/2))**2 + ((yy + .5 - h/2) / (h/2))**2
        ideal = radial <= 1
        error = np.count_nonzero(ideal ^ mask)
        if error <= max(2, int(mask.sum()) * .035):
            # Check local contour distance too: a long notch in a large disk
            # must not disappear merely because its area is a small percentage.
            points = boundary[:, 0, :] - [w/2, h/2]
            radii = np.array([w/2, h/2])
            squared = np.sum((points / radii)**2, axis=1)
            normal = np.linalg.norm(points / radii**2, axis=1)
            if np.all(abs(squared - 1) <= 1.05 * 2 * normal):
                return "ellipse", "M1000 500 A500 500 0 1 0 0 500 A500 500 0 1 0 1000 500 Z"
    points = cv2.approxPolyDP(boundary, 1.05, True)
    if len(points) not in (3, 4) or not cv2.isContourConvex(points):
        return None
    corners = points[:, 0, :].astype(float)
    # Test the entire digital boundary against the measured finite sides.
    samples = boundary[:, 0, :].astype(float)
    offsets = samples[:, None, :] - corners
    sides = np.roll(corners, -1, axis=0) - corners
    fractions = np.einsum('ijk,jk->ij', offsets, sides) / (sides * sides).sum(axis=1)
    closest = offsets - fractions.clip(0, 1)[:, :, None] * sides
    distance = np.linalg.norm(closest, axis=2).min(axis=1)
    if distance.max() > 1.05 or abs(cv2.contourArea(points) - mask.sum()) > .045 * mask.sum():
        return None
    return None, polygon_path(corners, w, h)


def isolate_strokes(rgb: np.ndarray):
    """Measure isolated straight ink before palette quantization can fragment it."""
    height, width = rgb.shape[:2]
    chroma = np.ptp(rgb.astype(np.int16), axis=2)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    channels = rgb.astype(np.int16).transpose(2, 0, 1)
    masks = []
    for high in range(3):
        for low in range(3):
            if high == low:
                continue
            middle = 3-high-low
            material = ((channels[high]-channels[low] > 30) &
                        (channels[high]-channels[middle] > 6) &
                        (channels[middle]-channels[low] > 6))
            if np.count_nonzero(material) >= 10:
                masks.append(material)
    masks.extend((chroma > 30, cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, kernel) > 28,
                  cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, kernel) > 28))
    erased = np.zeros(gray.shape, np.uint8)
    shapes = []
    for mask in masks:
        n, labels, stats, _ = cv2.connectedComponentsWithStats(np.uint8(mask), connectivity=8)
        for group in range(1, n):
            x, y, w, h, area = map(int, stats[group])
            if max(w, h) < 10 or area < 8 or area > 7 * np.hypot(w, h):
                continue
            region = labels[y:y+h, x:x+w] == group
            if erased[y:y+h, x:x+w][region].any():
                continue
            corners = straight_strip(region)
            if corners is None:
                continue
            _, hierarchy = cv2.findContours(region.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
            if hierarchy is not None and np.any(hierarchy[0, :, 3] >= 0):
                continue
            x0, x1 = max(0, x-3), min(width, x+w+3)
            y0, y1 = max(0, y-3), min(height, y+h+3)
            patch = rgb[y0:y1, x0:x1]
            inside = labels[y0:y1, x0:x1] == group
            # Both sides must expose a similar underlying paint. This avoids
            # pulling a lit outer edge off a larger object or extending a shadow.
            exterior = cv2.dilate(inside.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & ~inside
            exterior &= ~mask[y0:y1, x0:x1]
            if np.count_nonzero(exterior) < max(5, .22 * area):
                continue
            # Fit the supporting paint as a local plane. A long stroke can
            # cross a light falloff even when both sides share one surface.
            ey, ex = np.where(exterior)
            step = max(1, len(ex)//400)
            ex, ey = ex[::step], ey[::step]
            design = np.column_stack([np.ones(len(ex)), ex/max(w, 1), ey/max(h, 1)])
            neighbors = patch[ey, ex].astype(float)
            plane = np.linalg.lstsq(design, neighbors, rcond=None)[0]
            residual = np.linalg.norm(neighbors - design @ plane, axis=1)
            if np.quantile(residual, .85) > 32:
                continue
            good = residual <= max(5, np.quantile(residual, .75))
            plane = np.linalg.lstsq(design[good], neighbors[good], rcond=None)[0]
            iy, ix = np.where(inside)
            background = (np.column_stack([np.ones(len(ix)), ix/max(w, 1), iy/max(h, 1)]) @ plane).clip(0, 255)
            pixels = patch[iy, ix].astype(float)
            delta = pixels - background
            contrast = np.linalg.norm(delta, axis=1)
            core = contrast >= np.quantile(contrast, .80)
            color = np.median(pixels[core], axis=0)
            ink = color[None, :] - background
            strength = np.linalg.norm(ink, axis=1)
            if np.median(strength) < 42:
                continue
            alpha = np.clip(np.sum(delta*ink, axis=1) / np.maximum(1, strength**2), 0, 1)
            paint_error = np.linalg.norm(delta-alpha[:, None]*ink, axis=1)
            if np.quantile(paint_error, .85) > max(25, .26*np.median(strength)):
                continue
            # Alpha coverage conserves the source's ink area on antialiased lines.
            offset = (corners[3]-corners[0]) * ((1-alpha.mean()) / 2)
            corners[[0, 1]] += offset
            corners[[2, 3]] -= offset
            paint = alpha >= .86
            if not paint.any():
                paint = core
            shapes.append((x, y, w, h, polygon_path(corners, w, h), float(alpha.sum()),
                           pixels[paint], ix[paint]+x0-x, iy[paint]+y0-y))
            erased[y:y+h, x:x+w][region] = 255
    return shapes, erased
