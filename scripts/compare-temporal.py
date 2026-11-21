"""Compare source-relative flicker in two aligned sequences of rendered PNGs."""
import argparse
from collections import defaultdict
from dataclasses import dataclass
import json
from pathlib import Path
import tempfile

import cv2
import numpy as np
from PIL import Image

ROLES = ('flat', 'shading', 'contour', 'uncertain')


def png_sequence(folder):
    paths = {}
    for path in folder.iterdir():
        if path.suffix.lower() != '.png':
            continue
        if not path.stem.isascii() or not path.stem.isdigit():
            raise ValueError(f'Expected a numeric PNG observation index: {path.name}')
        index = int(path.stem)
        if index in paths:
            raise ValueError(f'Duplicate observation {index} in {folder}')
        paths[index] = path
    if not paths or max(paths) - min(paths) + 1 != len(paths):
        raise ValueError(f'Expected consecutive numeric PNGs in {folder}')
    return paths


def rgb(path):
    with path.open('rb') as stream:
        # The IHDR bit depth distinguishes 16-bit RGB even when Pillow exposes mode RGB.
        header = stream.read(25)
        if header[12:16] == b'IHDR' and header[24:25] == bytes([16]):
            raise ValueError(f'Convert 16-bit images to a common 8-bit RGB space first: {path}')
        stream.seek(0)
        with Image.open(stream) as im:
            if im.format != 'PNG' or im.n_frames != 1:
                raise ValueError(f'Expected a single PNG still: {path}')
            rgba = im.convert('RGBA')
            if rgba.getchannel('A').getextrema() != (255, 255):
                raise ValueError(f'Composite transparent images on the same background first: {path}')
            return np.asarray(rgba.convert('RGB'))


@dataclass
class Observation:
    pixels: np.ndarray
    gray: np.ndarray
    edge: np.ndarray
    broad: np.ndarray


def observe(pixels):
    lab = cv2.cvtColor(pixels, cv2.COLOR_RGB2Lab).astype(np.float32)

    def gradient(sigma):
        blurred = cv2.GaussianBlur(lab, (0, 0), sigma)
        dx = cv2.Sobel(blurred, -1, 1, 0, scale=.125)
        dy = cv2.Sobel(blurred, -1, 0, 1, scale=.125)
        return np.sqrt((dx*dx + dy*dy).sum(axis=2))

    fine = cv2.dilate(gradient(.8), np.ones((3, 3), np.uint8))
    broad = gradient(2.6)
    sharpness = np.clip((fine - 4) / 11, 0, 1) * np.clip((fine / (broad + 1.4) - 1) / .8, 0, 1)
    return Observation(pixels.astype(np.float32), cv2.cvtColor(pixels, cv2.COLOR_RGB2GRAY), sharpness, broad)


@dataclass
class Neighbor:
    x: np.ndarray
    y: np.ndarray
    reliable: np.ndarray
    weight: np.ndarray
    edge: np.ndarray

    def warp(self, values):
        return cv2.remap(values, self.x, self.y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def neighbors(left, right, grid):
    flow = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    forward = flow.calc(left.gray, right.gray, None)
    backward = flow.calc(right.gray, left.gray, None)

    def match(frame, other, step, reverse):
        x, y = grid[0] + step[:, :, 0], grid[1] + step[:, :, 1]
        def warp(values):
            return cv2.remap(values, x, y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        h, w = x.shape
        inside = (x >= 0) & (x <= w - 1) & (y >= 0) & (y <= h - 1)
        consistent = inside & (np.linalg.norm(step + warp(reverse), axis=2) < .9)
        diff = np.abs(frame.pixels - warp(other.pixels)).max(axis=2)
        weight = consistent * np.exp(-np.square(diff / 14))
        return Neighbor(x, y, consistent & (diff < 14), weight, warp(other.edge))

    return match(left, right, forward, backward), match(right, left, backward, forward)


def roles(frame, matches):
    votes = frame.edge.copy()
    weight = np.ones_like(votes)
    confidence = np.zeros_like(votes)
    for match in matches:
        if match is not None:
            votes += match.edge * match.weight
            weight += match.weight
            confidence = np.maximum(confidence, match.weight)
    role = (frame.broad > 1.35).astype(np.uint8)
    role[votes / weight > .42] = 2
    role[(confidence < .18) & (frame.edge > .12)] = 3
    return role


class Measurements:
    def __init__(self):
        self.totals = defaultdict(lambda: np.zeros(3, np.float64))

    def add(self, name, errors, mask=None):
        pixels = errors[0].size if mask is None else np.count_nonzero(mask)
        sums = [e.sum(dtype=np.float64, where=True if mask is None else mask) for e in errors]
        self.totals[name] += [*sums, pixels]
        return [s / pixels if pixels else None for s in sums]

    def report(self):
        result = {}
        for name, (base, candidate, count) in self.totals.items():
            result[name] = dict(baseline=base / count if count else None,
                                candidate=candidate / count if count else None,
                                pixels=int(count))
        return result


def compare(source, baseline, candidate, cut_starts, output, save_maps):
    sources, bases, candidates = map(png_sequence, (source, baseline, candidate))
    if sources.keys() != bases.keys() or sources.keys() != candidates.keys():
        raise ValueError('Source, baseline and candidate observation indices must match')
    indices = sorted(sources)
    cuts = set(cut_starts)
    if len(cuts) != len(cut_starts) or not cuts.issubset(indices[1:]):
        raise ValueError('Each cut must name a distinct first observation after the initial shot')
    current = observe(rgb(sources[indices[0]]))
    height, width = current.gray.shape
    if min(width, height) < 12 or max(width, height) >= 32767:
        raise ValueError('Optical flow requires image dimensions from 12 through 32766 pixels')
    y, x = np.mgrid[:height, :width].astype(np.float32)
    previous_match = previous_residuals = None
    metrics, pairs = Measurements(), []
    if save_maps:
        (output / 'roles').mkdir()
    for pos, index in enumerate(indices):
        next_frame = next_match = reverse = None
        if pos + 1 < len(indices):
            next_index = indices[pos + 1]
            next_frame = observe(rgb(sources[next_index]))
            if next_frame.gray.shape != (height, width):
                raise ValueError(f'Source dimensions change at observation {next_index}')
            if next_index not in cuts:
                next_match, reverse = neighbors(current, next_frame, (x, y))
        role = roles(current, (previous_match, next_match))
        if save_maps:
            Image.fromarray(role).save(output / 'roles' / sources[index].name)
        renders = [rgb(paths[index]) for paths in (bases, candidates)]
        if any(im.shape != current.pixels.shape for im in renders):
            raise ValueError(f'Render and source dimensions differ at observation {index}')
        residuals = [im - current.pixels for im in renders]
        metrics.add('spatial', [np.abs(e).mean(axis=2) for e in residuals])
        if previous_match is not None:
            changes = [np.abs(now - old).mean(axis=2) for now, old in zip(residuals, previous_residuals)]
            before, after = metrics.add('sameScreenChange', changes)
            tracked = [np.abs(now - previous_match.warp(old)).mean(axis=2)
                       for now, old in zip(residuals, previous_residuals)]
            support = previous_match.reliable
            metrics.add('trackedChange', tracked, support)
            for code, label in enumerate(ROLES):
                metrics.add('trackedChange/' + label, tracked, support & (role == code))
            pairs.append(dict(previous=indices[pos - 1], current=index, baseline=before,
                              candidate=after, trackedPixels=int(np.count_nonzero(support))))
        current, previous_match, previous_residuals = next_frame, reverse, residuals
    report = dict(schema='temporal-comparison-v1', width=width, height=height, frames=len(indices),
                  cutStarts=sorted(cuts), pairs=pairs, roleCodes=list(ROLES), metrics=metrics.report())
    (output / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'baseline', 'candidate'):
        parser.add_argument('--' + name, type=Path, required=True, help='Aligned numeric PNG directory')
    parser.add_argument('--cut-starts', type=int, nargs='*', required=True,
                        help='First index of each new shot, excluding the initial shot. Pass alone for no cuts.')
    parser.add_argument('--out-dir', type=Path, required=True, help='New output directory')
    parser.add_argument('--save-role-maps', action='store_true', help='Write per-pixel role IDs as lossless PNGs')
    args = parser.parse_args()
    cv2.setNumThreads(1)
    try:
        if args.out_dir.exists():
            raise ValueError(f'Output exists: {args.out_dir}')
        args.out_dir.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=args.out_dir.parent) as scratch:
            result = Path(scratch) / 'result'
            result.mkdir()
            compare(args.source, args.baseline, args.candidate, args.cut_starts, result, args.save_role_maps)
            result.rename(args.out_dir)
    except (ValueError, OSError, cv2.error) as exc:
        parser.exit(1, f'{exc}\n')


if __name__ == '__main__':
    main()
