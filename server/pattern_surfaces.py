"""Source-measured shared outlines for touching surfaces with repetitive linework."""

from __future__ import annotations

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.optimize import least_squares, minimize
from scipy.signal import find_peaks


def color_hex(color):
    return "#" + np.rint(color).clip(0, 255).astype(np.uint8).tobytes().hex()


def color_fields(rgb):
    """Find well-separated hue populations independent of their names or ordering."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    hue = hsv[:, :, 0].astype(float)
    chroma = np.ptp(rgb.astype(np.int16), axis=2).astype(np.float32)
    strong = chroma > 32
    if strong.mean() < 0.10:
        return None
    hist = np.bincount(hue[strong].astype(int), minlength=180)
    hist = gaussian_filter1d(hist.astype(float), 2, mode="wrap")
    peaks, _ = find_peaks(np.tile(hist, 3), distance=10, prominence=max(8, hist.max() * 0.025))
    peaks = peaks[(peaks >= 180) & (peaks < 360)] - 180
    if not 2 <= len(peaks) <= 4:
        return None
    distance = abs((hue[:, :, None] - peaks + 90) % 180 - 90)
    labels = distance.argmin(axis=2)
    norms = np.array([np.quantile(chroma[(labels == j) & strong], 0.75) for j in range(len(peaks))])
    # Compare mixtures in opponent-color space. Normalizing by locally observed
    # saturation keeps a lighter stripe on the same material as its darker base.
    local = cv2.dilate(chroma, np.ones((13, 13), np.uint8))
    coverage = chroma / np.maximum(0.65 * norms[labels], np.minimum(local, norms[labels]))
    masks = [(labels == j) & (coverage >= 0.50) & (chroma > 14) for j in range(len(peaks))]
    # At a mixed-color interface the chroma can dip below either material's
    # coverage threshold. Recover ownership only where the actual RGB agrees
    # with a mixture of nearby colors. A white keyline remains a separate mark.
    vacant = ~np.logical_or.reduce(masks)
    if not vacant.any():
        return masks
    kernel = np.ones((11, 11), np.float32)
    observed = masks
    masks = [m.copy() for m in observed]
    support = [cv2.filter2D(m.astype(np.float32), -1, kernel) for m in observed]
    for i, a in enumerate(masks[:-1]):
        for j in range(i + 1, len(masks)):
            nearby = vacant & (support[i] > 6) & (support[j] > 6)
            if not nearby.any():
                continue
            colors = []
            for k in (i, j):
                summed = cv2.filter2D(np.where(observed[k][:, :, None], rgb, 0).astype(np.float32), -1, kernel)
                colors.append(summed[nearby] / support[k][nearby, None])
            diff = colors[1] - colors[0]
            sampled = rgb[nearby] - colors[0]
            alpha = np.sum(sampled * diff, axis=1) / np.maximum(1, np.sum(diff * diff, axis=1))
            error = np.linalg.norm(sampled - alpha[:, None] * diff, axis=1)
            match = (
                (alpha >= 0) & (alpha <= 1) & (error < np.maximum(28, 0.24 * np.linalg.norm(diff, axis=1)))
            )
            y, x = np.where(nearby)
            a[y[match & (alpha < 0.5)], x[match & (alpha < 0.5)]] = True
            masks[j][y[match & (alpha >= 0.5)], x[match & (alpha >= 0.5)]] = True
            vacant[y[match], x[match]] = False
    return masks


def sample(image, xy):
    shape = xy.shape[:-1]
    coords = xy.astype(np.float32).reshape(-1, 1, 2)
    # Chunk remap so a long interface also works at large frame sizes.
    values = [
        cv2.remap(image, p[:, :, 0], p[:, :, 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)[:, 0]
        for p in np.array_split(coords, 1 + len(coords) // 16000)
    ]
    return np.concatenate(values).reshape((*shape, *image.shape[2:]))


def shared_lines(rgb, masks):
    """Fit one subpixel boundary from two-sided color transitions along a real contact."""
    h, w = masks[0].shape
    minimum = max(18, min(w, h) * 0.08)
    result = []
    kernel = np.ones((5, 5), np.uint8)
    for i, first in enumerate(masks[:-1]):
        a = first.astype(np.uint8)
        for j in range(i + 1, len(masks)):
            b = masks[j].astype(np.uint8)
            contact = cv2.dilate(a, kernel) & cv2.dilate(b, kernel)
            touching = (cv2.dilate(a, np.ones((3, 3), np.uint8)) & b).astype(bool)
            count, cc, stats, _ = cv2.connectedComponentsWithStats(contact, connectivity=8)
            for group in range(1, count):
                x, y, width, height, area = stats[group]
                if max(width, height) < minimum or area < minimum:
                    continue
                py, px = np.where(cc[y : y + height, x : x + width] == group)
                points = np.column_stack((px + x, py + y)).astype(float)
                center = points.mean(0)
                tangent = np.linalg.eigh((points - center).T @ (points - center))[1][:, 1]
                normal = np.array([-tangent[1], tangent[0]])
                along = (points - center) @ tangent
                if np.quantile(abs((points - center) @ normal), 0.95) > 3.2:
                    continue
                joins = touching[py + y, px + x]
                if not joins.any():
                    continue
                occupied = np.unique(np.floor((along[joins] - along.min()) / 3))
                if len(occupied) * 3 < 0.6 * np.ptp(along):
                    continue
                points = center + np.arange(along.min(), along.max() + 0.1, 1.5)[:, None] * tangent
                for direction in (normal, -normal):
                    supported = (
                        sample(a, points - 4 * direction) & sample(b, points + 4 * direction)
                    ).astype(bool)
                    if supported.mean() > 0.80:
                        break
                else:
                    continue
                points = points[supported]
                offsets = np.arange(-6, 6.01, 0.25)
                colors = sample(rgb, points[:, None, :] + offsets[None, :, None] * direction).astype(float)
                # Opponent color is less sensitive to light stripes than RGB luma.
                # The integral estimates the subpixel edge even in 4:2:0 material
                # with a two-pixel plateau where a single threshold is ambiguous.
                colors -= colors.mean(2, keepdims=True)
                low, high = colors[:, :6].mean(1), colors[:, -6:].mean(1)
                step = high - low
                weights = np.einsum("ijk,ik->ij", colors - low[:, None, :], step)
                weights /= np.maximum(1, (step * step).sum(1))[:, None]
                delta = 6 - 0.25 * (weights[:, :-1].clip(0, 1) + weights[:, 1:].clip(0, 1)).sum(1) / 2
                valid = (abs(delta) < 3.5) & (np.linalg.norm(step, axis=1) > 40)
                if valid.sum() < minimum / 2:
                    continue
                p = points[valid] + direction * delta[valid, None] + 0.5
                vx, vy, cx, cy = cv2.fitLine(p.astype(np.float32), cv2.DIST_HUBER, 0, 0.001, 0.001).ravel()
                center = np.array([cx, cy])
                tangent = np.array([vx, vy])
                normal = np.array([-vy, vx])
                normal *= np.sign(normal @ direction)
                if np.quantile(abs((p - center) @ normal), 0.95) > 0.95:
                    continue
                # Include the ends at the frame or at a third material.
                ends = (points - center + 0.5) @ tangent
                result.append((i, j, center, tangent, normal, ends.min() - 6, ends.max() + 6))
    return result


def shape_path(mask, material, lines, extent):
    """Clip touching parts to their shared line; the rear paint backs its AA edge."""
    pad = cv2.copyMakeBorder(mask.astype(np.float32), 1, 1, 1, 1, cv2.BORDER_CONSTANT)
    contours, _ = cv2.findContours(pad.astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    paths = []
    gx, gy = [cv2.Sobel(pad, -1, int(axis == 0), int(axis == 1), scale=0.125) for axis in range(2)]
    for contour in contours:
        if len(contour) < 3:
            continue
        x, y = contour[:, 0, :].T
        grad = np.column_stack((gx[y, x], gy[y, x]))
        p = contour[:, 0, :].astype(float) - 0.5
        p -= grad * (0.5 / np.maximum(0.3, (grad * grad).sum(1)))[:, None]
        for i, j, center, tangent, normal, a, b in lines:
            if material not in (i, j):
                continue
            along, distance = (p - center) @ tangent, (p - center) @ normal
            near = (along >= a) & (along <= b) & (abs(distance) < 2.3)
            p[near] += ((0.90 if material == i else 0) - distance[near, None]) * normal
        poly = simplify_sides(p)
        if len(poly) >= 3:
            paths.append(polygon(poly, extent))
    # Fill-less point subpaths establish a common square SVG paint coordinate
    # system even for a small disconnected silhouette or an off-center gradient.
    return " ".join(paths) + " M0 0h0 M1000 1000h0" if paths else ""


def simplify_sides(points):
    """Replace staircase samples by fitted finite sides only at measured corners."""
    raw = points.astype(np.float32)
    fine = cv2.approxPolyDP(raw, 0.40, True)[:, 0, :]
    coarse = cv2.approxPolyDP(raw, 2.3, True)[:, 0, :]
    if not 3 <= len(coarse) <= 48:
        return fine
    sides = []
    indices = [int(np.argmin(np.sum((raw - corner) ** 2, axis=1))) for corner in coarse]
    for k, start in enumerate(indices):
        end = indices[(k + 1) % len(indices)]
        side = raw[start : end + 1] if end > start else np.concatenate((raw[start:], raw[: end + 1]))
        if len(side) < 6:
            return fine
        vx, vy, cx, cy = cv2.fitLine(side[1:-1], cv2.DIST_HUBER, 0, 0.001, 0.001).ravel()
        normal = np.array([-vy, vx])
        offset = normal @ [cx, cy]
        if np.quantile(abs(side @ normal - offset), 0.94) > 1.2:
            return fine
        sides.append((normal, offset))
    corners = []
    for k, corner in enumerate(coarse):
        axes, values = zip(sides[k - 1], sides[k])
        if abs(np.linalg.det(axes)) < 0.12:
            return fine
        fitted = np.linalg.solve(axes, values)
        if np.linalg.norm(fitted - corner) > 3:
            return fine
        corners.append(fitted)
    return np.asarray(corners)


def polygon(points, extent):
    return "M" + " ".join(f"{x:.2f} {y:.2f}" for x, y in points * (1000 / extent)) + "Z"


def lighting(rgb, mask, extent):
    """Fit a constant, a plane, or radial falloff to robust interior tile colors."""
    h, w = mask.shape
    tile = max(6, round(min(w, h) / 22))
    xy, colors = [], []
    for y in range(0, h, tile):
        for x in range(0, w, tile):
            sub = mask[y : y + tile, x : x + tile]
            if sub.sum() < max(5, tile * tile * 0.10):
                continue
            iy, ix = np.where(sub)
            xy.append([(x + ix.mean() + 0.5) / extent, (y + iy.mean() + 0.5) / extent])
            colors.append(np.median(rgb[y + iy, x + ix], axis=0))
    if len(colors) < 5:
        return None
    xy, colors = np.array(xy), np.array(colors)
    constant = np.median(colors, axis=0)

    def error(pred):
        return float(np.mean(np.minimum(80, abs(pred - colors)) ** 2))

    flat = (error(constant), lambda p: np.broadcast_to(constant, (*p.shape[:-1], 3)), None)
    design = np.column_stack((np.ones(len(xy)), xy))
    coef = np.linalg.lstsq(design, colors, rcond=None)[0]
    axis = np.linalg.svd(coef[1:], full_matrices=False)[0][:, 0]
    axis *= np.abs(axis).sum()
    a, b = 0.5 - axis / 2, 0.5 + axis / 2

    def fraction(p):
        return ((p - a) @ axis / (axis @ axis)).clip(0, 1)

    coef = np.linalg.lstsq(np.column_stack((np.ones(len(xy)), fraction(xy))), colors, rcond=None)[0]
    first, last = coef[0].clip(0, 255), coef.sum(0).clip(0, 255)

    def linear(p):
        return first + fraction(p)[..., None] * (last - first)

    line = (
        error(linear(xy)) * 1.02,
        linear,
        {
            "type": "linear",
            "x1": float(a[0]),
            "y1": float(a[1]),
            "x2": float(b[0]),
            "y2": float(b[1]),
            "stops": [{"offset": 0, "color": color_hex(first)}, {"offset": 1, "color": color_hex(last)}],
        },
    )
    best = min(flat, line, key=lambda x: x[0])
    if best[0] < 2:
        return best[1:]

    def fit(param, pos=xy):
        radius = np.linalg.norm(pos - param[:2], axis=-1)
        return np.exp(-0.5 * (radius / param[2]) ** 2)

    def residual(param):
        basis = np.column_stack((np.ones(len(xy)), fit(param)))
        return (basis @ np.linalg.lstsq(basis, colors, rcond=None)[0] - colors).ravel()

    init = [w / extent / 2, h / extent / 2, 0.22]
    param = least_squares(residual, init, bounds=([-0.8, -0.8, 0.035], [1.8, 1.8, 1.8]), max_nfev=32).x
    c, diff = np.linalg.lstsq(np.column_stack((np.ones(len(xy)), fit(param))), colors, rcond=None)[0]

    def radial(p):
        return np.clip(c + fit(param, p)[..., None] * diff, 0, 255)

    radius = min(3.0, max(0.15, float(np.linalg.norm(xy - param[:2], axis=1).max()) + 0.08))
    stops = [
        {"offset": float(t), "color": color_hex(c + np.exp(-0.5 * (t * radius / param[2]) ** 2) * diff)}
        for t in np.linspace(0, 1, 13)
    ]
    circ = (
        error(radial(xy)) * 1.06,
        radial,
        {"type": "radial", "cx": float(param[0]), "cy": float(param[1]), "r": radius, "stops": stops},
    )
    candidates = [best, circ]
    if len(xy) >= 36:
        # The three color channels can reach their peaks at different radii.
        # Use independent stops only when held-out tiles support that freedom.
        radii = np.linalg.norm(xy - param[:2], axis=1)
        grid = np.linspace(0, radius, 16)
        train = np.arange(len(xy)) % 4 != 0
        amplitudes = []
        for target in grid:
            nearest = np.argsort(abs(radii[train] - target))[: min(16, train.sum())]
            sample_r = radii[train][nearest]
            local_target = np.clip(target, sample_r.min(), sample_r.max())
            design = np.column_stack((np.ones(len(nearest)), sample_r - local_target))
            values = np.linalg.lstsq(design, colors[train][nearest], rcond=None)[0][0]
            amplitudes.append(values.clip(0, 255))
        tones = np.asarray(amplitudes)

        def measured(p):
            distance = np.linalg.norm(p - param[:2], axis=-1)
            return np.stack([np.interp(distance, grid, tones[:, ch]) for ch in range(3)], axis=-1)

        held = xy[~train]
        if np.mean(abs(measured(held) - colors[~train])) < 0.94 * np.mean(
            abs(radial(held) - colors[~train])
        ):
            sampled = {
                **circ[2],
                "stops": [
                    {"offset": float(t), "color": color_hex(color)}
                    for t, color in zip(grid / radius, tones)
                ],
            }
            candidates.append((error(measured(xy)) * 1.08, measured, sampled))
    return min(candidates, key=lambda entry: entry[0])[1:]


def stripe_profile(rgb, mask, paint, extent):
    """Measure the wavevector and phase profile of parallel, repeating marks."""
    y, x = np.where(mask)
    if len(x) < 250:
        return None
    # Use a reproducible spatial sample for frequency refinement and an
    # independent set for validation. Subpixel phase is in source pixel cells.
    rng = np.random.default_rng(13)
    indices = rng.choice(len(x), min(7000, len(x)), replace=False)
    xy = np.column_stack((x[indices] + 0.5, y[indices] + 0.5))
    residual = rgb[y[indices], x[indices]].astype(float) - paint(xy / extent)
    axis = np.linalg.svd(residual - residual.mean(0), full_matrices=False)[2][0]
    signal = residual @ axis
    if np.std(signal) < 4:
        return None
    scalar = rgb.astype(np.float32) @ axis.astype(np.float32)
    hp = scalar - cv2.GaussianBlur(scalar, (0, 0), 2.5)
    spectrum = abs(np.fft.rfft2(np.where(mask, hp, 0)))
    h, w = mask.shape
    fy, fx = np.fft.fftfreq(h)[:, None], np.fft.rfftfreq(w)[None, :]
    frequency = np.hypot(fx, fy)
    spectrum[(frequency < 1 / max(12, min(h, w) / 4)) | (frequency > 0.36)] = 0
    ky, kx = np.unravel_index(spectrum.argmax(), spectrum.shape)
    guess = np.array([fx[0, kx], fy[ky, 0]])
    # Optimize in Fourier-bin units to keep rotations and periods continuous.
    train = xy[::2]
    values = signal[::2] - np.mean(signal[::2])
    size = np.array([w, h])

    def peak(delta):
        arg = 2 * np.pi * (train @ (guess + delta / size))
        return -abs(values @ np.exp(1j * arg)) / len(values)

    strongest = guess.copy()
    best = None
    for harmonic in (1, 2, 3):
        guess = strongest / harmonic
        if np.linalg.norm(guess) < 1 / max(12, min(h, w) / 4):
            continue
        delta = minimize(peak, [0.0, 0.0], bounds=[(-1, 1), (-1, 1)], method="L-BFGS-B").x
        freq = guess + delta / size
        bins = 48
        phase = (np.floor((xy @ freq % 1) * bins).astype(int)) % bins
        dirs = np.arange(bins)
        levels = np.array(
            [
                np.median(residual[::2][phase[::2] == i], axis=0)
                if np.any(phase[::2] == i)
                else [np.nan] * 3
                for i in dirs
            ]
        )
        valid = np.isfinite(levels[:, 0])
        if valid.sum() < 3:
            continue
        for ch in range(3):
            levels[:, ch] = np.interp(dirs, dirs[valid], levels[valid, ch], period=bins)
        ref = residual[1::2]
        error = np.mean((ref - levels[phase[1::2]]) ** 2)
        if best is None or error < best[0] * 0.985:
            best = (error, freq, levels)
    if best is None or best[0] > 0.72 * np.mean((ref - np.median(ref, axis=0)) ** 2):
        return None
    return best[1:]


def stripe_bands(freq, levels, extent, size):
    """Use nested vector bands to approximate the measured antialiased waveform."""
    center = np.median(levels, axis=0)
    dist = np.linalg.norm(levels - center, axis=1)
    peak = dist.max()
    if peak < 8:
        return []
    bands = []
    normal = freq / np.linalg.norm(freq)
    tangent = np.array([-normal[1], normal[0]])
    corners = np.array([[0, 0], [size[0], 0], size, [0, size[1]]], float)
    limits = corners @ freq
    for threshold, color_level in [(0.16, 0.31), (0.47, 0.63), (0.78, 0.92)]:
        m = dist / peak
        starts = np.where((m >= threshold) & (np.roll(m, 1) < threshold))[0]
        ends = np.where((m >= threshold) & (np.roll(m, -1) < threshold))[0]
        paths = []
        for start in starts:
            end = start + int(np.min((ends - start) % len(m)))
            left = (
                start - 0.5 + (threshold - m[(start - 1) % len(m)]) / (m[start] - m[(start - 1) % len(m)])
            ) / len(m)
            k = end % len(m)
            right = (end + 0.5 + (threshold - m[k]) / (m[(k + 1) % len(m)] - m[k])) / len(m)
            for cycle in range(int(np.floor(limits.min())) - 1, int(np.ceil(limits.max())) + 1):
                d0 = (cycle + left) / np.linalg.norm(freq)
                d1 = (cycle + right) / np.linalg.norm(freq)
                if cycle + right < limits.min() or cycle + left > limits.max():
                    continue
                ends_t = corners @ tangent
                p0, p1 = tangent * (ends_t.min() - 1), tangent * (ends_t.max() + 1)
                paths.append(
                    polygon(
                        np.array([p0 + d0 * normal, p1 + d0 * normal, p1 + d1 * normal, p0 + d1 * normal]),
                        extent,
                    )
                )
        if paths:
            indices = np.argsort(abs(m - color_level))[: max(2, len(m) // 10)]
            delta = np.median(levels[indices], axis=0)
            bands.append((" ".join(paths), delta))
    return bands


def shift_paint(gradient, delta):
    if gradient is None:
        return None
    return {
        **gradient,
        "stops": [
            {
                "offset": s["offset"],
                "color": color_hex(
                    np.frombuffer(bytes.fromhex(s["color"][1:]), dtype=np.uint8).astype(float) + delta
                ),
            }
            for s in gradient["stops"]
        ],
    }


def patterned_frame(rgb):
    """Return a complete measured frame only if both sides and the remaining canvas fit."""
    masks = color_fields(rgb)
    if masks is None:
        return None
    lines = shared_lines(rgb, masks)
    if not lines:
        return None
    h, w = rgb.shape[:2]
    extent = max(h, w)
    background = ~np.logical_or.reduce(masks)
    fields = [background, *masks]
    result = []
    patterned = set()
    inner_kernel = np.ones((7, 7), np.uint8)
    for index, mask in enumerate(fields):
        mid = index - 1
        interior = cv2.erode(mask.astype(np.uint8), inner_kernel).astype(bool)
        if index == 0 and not mask.any():
            continue
        model = lighting(rgb, interior, extent) if interior.any() else None
        if model is None:
            if index or mask.mean() > 0.01:
                return None
            # A tiny visible remnant can support a single measured backing color
            # even when it contains too few tiles to identify a lighting field.
            visible = mask & (np.ptp(rgb.astype(np.int16), axis=2) < 18)
            interior = visible if visible.any() else mask
            color = np.median(rgb[interior], axis=0)
            # Residual chromatic pixels on this sub-percent sliver are transition
            # mixtures, not samples of either pure surface paint.
            result.append((-1, "M0 0H1000V1000H0Z", color_hex(color), None, [], int(mask.sum())))
            continue

        else:
            paint, gradient = model
        stripe = stripe_profile(rgb, interior, paint, extent) if index else None
        ys, xs = np.where(interior)
        sel = np.arange(0, len(xs), max(1, len(xs) // 3500))
        xy = np.column_stack((xs[sel] + 0.5, ys[sel] + 0.5))
        predicted = paint(xy / extent)
        regions = []
        fill = paint(np.array([0.5, 0.5]))
        if stripe is not None:
            freq, levels = stripe
            predicted = (
                predicted + levels[(np.floor((xy @ freq % 1) * len(levels)).astype(int)) % len(levels)]
            )
            for path, delta in stripe_bands(freq, levels, extent, (w, h)):
                region = {"path": path, "fill": color_hex(fill + delta)}
                if gradient:
                    region["gradient"] = shift_paint(gradient, delta)
                regions.append(region)
            if regions:
                patterned.add(mid)
        err = abs(predicted - rgb[ys[sel], xs[sel]])
        if err.mean() > 6 or np.quantile(err, 0.95) > 18:
            return None
        path = shape_path(mask, mid, lines, extent) if index else "M0 0H1000V1000H0Z"
        if not path:
            return None
        result.append((mid, path, color_hex(fill), gradient, regions, int(mask.sum())))
    if not any(i in patterned and j in patterned for i, j, *_ in lines):
        return None
    return result
