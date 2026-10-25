"""Compare caller-annotated part ROIs in aligned source and actual render images.

This tool measures pixel differences, not shape accuracy. ROIs are caller-defined
fixed context windows. Optional visible masks must be independent source annotations.
"""
import argparse
import hashlib
import html
import json
import math
import os
from pathlib import Path, PureWindowsPath
import re
import tempfile

import numpy as np
from PIL import Image


SCHEMA = 'part-comparison-v1'
REPORT_SCHEMA = 'part-comparison-report-v1'
ID_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}\Z')
NOTE = ('제공한 시각의 고정 ROI만 비교합니다. 원본 잘라보기에는 앞을 가리는 다른 부품과 '
        '배경이 포함됩니다. RGB MAE는 윤곽 정확도나 재현율이 아닙니다. '
        '전체 영상의 시각 검수를 수행한 보고서가 아닙니다.')


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def valid_id(value, where):
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise ValueError(f'{where}: ID must start with an ASCII letter or digit and use only A-Z, a-z, 0-9, _ or - (1..80 characters)')
    return value


def input_path(base, value, where):
    if (not isinstance(value, str) or not value or '\\' in value or '\x00' in value
            or Path(value).is_absolute() or PureWindowsPath(value).drive or '://' in value):
        raise ValueError(f'{where}: use a local manifest-relative path')
    path = (base / value).resolve()
    if not path.is_file():
        raise ValueError(f'{where}: input file does not exist: {value}')
    return path


def read_rgb(path):
    with Image.open(path) as image:
        if getattr(image, 'n_frames', 1) != 1:
            raise ValueError(f'{path.name}: use a single aligned still image')
        rgba = image.convert('RGBA')
        if rgba.getchannel('A').getextrema() != (255, 255):
            raise ValueError(f'{path.name}: transparent images are unsupported; composite source and render identically before comparison')
        return np.asarray(rgba.convert('RGB')).copy()


def read_mask(path, size):
    array = read_rgb(path)
    if array.shape[:2] != size:
        raise ValueError(f'{path.name}: visibleMask dimensions must equal the source dimensions')
    if not (np.all(array == array[:, :, :1]) and np.all((array == 0) | (array == 255))):
        raise ValueError(f'{path.name}: visibleMask must be binary black/white (0/255), with no antialiasing')
    return array[:, :, 0] == 255


def load_manifest(manifest):
    data = json.loads(manifest.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or data.get('schema') != SCHEMA:
        raise ValueError(f'manifest.schema must be {SCHEMA!r}; this is not an app project schema')
    if not isinstance(data.get('frames'), list) or not data['frames']:
        raise ValueError('manifest.frames must be a non-empty array')
    seen_frames, prepared, all_inputs = set(), [], {manifest.resolve()}
    for frame in data['frames']:
        if not isinstance(frame, dict):
            raise ValueError('Each frame must be an object')
        fid = valid_id(frame.get('id'), 'frame.id')
        if fid.casefold() in seen_frames:
            raise ValueError(f'Duplicate frame ID: {fid}')
        seen_frames.add(fid.casefold())
        time = frame.get('time')
        if isinstance(time, bool) or not isinstance(time, (int, float)) or not math.isfinite(time) or time < 0:
            raise ValueError(f'{fid}: time must be a finite nonnegative number of seconds')
        paths = {key: input_path(manifest.parent, frame.get(key), f'{fid}.{key}')
                 for key in ('source', 'rendered')}
        if 'baseline' in frame:
            paths['baseline'] = input_path(manifest.parent, frame['baseline'], f'{fid}.baseline')
        arrays = {key: read_rgb(path) for key, path in paths.items()}
        shape = arrays['source'].shape
        if any(array.shape != shape for array in arrays.values()):
            raise ValueError(f'{fid}: source, rendered and baseline dimensions must match; no resizing or registration is performed')
        parts = frame.get('parts')
        if not isinstance(parts, list) or not parts:
            raise ValueError(f'{fid}: parts must be a non-empty array')
        seen_parts, prepared_parts = set(), []
        height, width = shape[:2]
        for part in parts:
            if not isinstance(part, dict):
                raise ValueError(f'{fid}: each part must be an object')
            pid = valid_id(part.get('id'), f'{fid}.part.id')
            if pid.casefold() in seen_parts:
                raise ValueError(f'{fid}: duplicate part ID: {pid}')
            seen_parts.add(pid.casefold())
            label = part.get('label', pid)
            if not isinstance(label, str):
                raise ValueError(f'{fid}/{pid}: label must be text')
            roi = part.get('roi')
            if not isinstance(roi, list) or len(roi) != 4 or any(type(n) is not int for n in roi):
                raise ValueError(f'{fid}/{pid}: roi must be four integers [x, y, width, height]')
            x, y, rw, rh = roi
            if min(x, y) < 0 or min(rw, rh) <= 0 or x + rw > width or y + rh > height:
                raise ValueError(f'{fid}/{pid}: ROI is outside the image or empty')
            mask_path, mask = None, None
            if 'visibleMask' in part:
                mask_path = input_path(manifest.parent, part['visibleMask'], f'{fid}/{pid}.visibleMask')
                mask = read_mask(mask_path, (height, width))[y:y+rh, x:x+rw].copy()
                if not mask.any():
                    raise ValueError(f'{fid}/{pid}: visibleMask selects no pixels within the ROI')
                all_inputs.add(mask_path)
            prepared_parts.append({'id': pid, 'label': label, 'roi': roi, 'mask': mask,
                                   'maskPath': mask_path, 'maskInput': part.get('visibleMask')})
        all_inputs.update(paths.values())
        prepared.append({'id': fid, 'time': time, 'paths': paths,
                         'inputs': {key: frame[key] for key in paths}, 'parts': prepared_parts})
    return prepared, all_inputs


def planned_outputs(frames):
    outputs = [Path('index.html'), Path('report.json')]
    for frame in frames:
        for part in frame['parts']:
            names = ['source', 'rendered', 'overlay', 'diff-x3']
            if 'baseline' in frame['paths']:
                names += ['baseline']
            if part['mask'] is not None:
                names += ['visible-mask']
            outputs.extend(Path(frame['id']) / part['id'] / f'{name}.png' for name in names)
    return outputs


def check_destination(out_dir, outputs, inputs, overwrite):
    if out_dir.is_symlink():
        raise ValueError('Output directory must not be a symlink')
    root = out_dir.resolve()
    if root.exists() and not root.is_dir():
        raise ValueError('Output path is not a directory')
    # Never mix original inputs with an output directory, even under --overwrite.
    if any(path == root or root in path.parents for path in inputs):
        raise ValueError('Output directory must not contain any input file or the manifest')
    if root.exists() and any(root.iterdir()) and not overwrite:
        raise ValueError('Output directory is not empty; choose another directory or --overwrite')
    for relative in outputs:
        target = out_dir / relative
        cursor = target
        while cursor != out_dir:
            if cursor.is_symlink():
                raise ValueError(f'Output paths must not use symlinks: {relative}')
            if cursor != target and cursor.exists() and not cursor.is_dir():
                raise ValueError(f'Output parent conflicts with a file: {relative}')
            cursor = cursor.parent
        if target.exists():
            if not target.is_file():
                raise ValueError(f'Output file conflicts with a directory: {relative}')
            if any(os.path.samefile(target, source) for source in inputs):
                raise ValueError(f'Output file aliases an input: {relative}')


def mae(source, rendered, mask=None):
    delta = np.abs(source.astype(np.float64) - rendered.astype(np.float64))
    return float(delta[mask].mean() if mask is not None else delta.mean())


def gallery(report):
    escape = html.escape
    sections = []
    navigation = ' · '.join(f'<a href="#{escape(frame["id"], quote=True)}">{escape(frame["id"])} ({frame["time"]:.3f}초)</a>' for frame in report['frames'])
    for frame in report['frames']:
        cards = []
        for part in frame['parts']:
            figures = ''.join(f'<figure><img loading="lazy" src="{escape(path, quote=True)}" alt="{escape(part["label"] + " · " + label, quote=True)}"><figcaption>{label}</figcaption></figure>'
                              for key, label in [('source', '원본 문맥'), ('baseline', '수정 전'), ('rendered', '현재 렌더'), ('overlay', '원본·현재 50% 겹침'), ('diff-x3', 'RGB 차이 ×3'), ('visible-mask', '가시 색상 평가 마스크')]
                              if (path := part['images'].get(key)))
            metrics = f'고정 ROI RGB MAE {part["metrics"]["roiRgbMae"]:.3f} / 255'
            if 'visibleRgbMae' in part['metrics']:
                metrics += f' · 원본 가시 영역 색상 MAE {part["metrics"]["visibleRgbMae"]:.3f} / 255'
            if 'change' in part:
                metrics += f' · 수정 전 대비 ROI 차이 {part["change"]["roiRgbMaeDelta"]:+.3f} (음수: 감소)'
            cards.append(f'<article><h3>{escape(part["label"])} <small>{escape(part["id"])}</small></h3><p>{metrics}</p><p class="muted">ROI {escape(str(part["roi"]))} · {escape(part["measurementScope"])}</p><div class="panels">{figures}</div></article>')
        sections.append(f'<section id="{escape(frame["id"], quote=True)}"><h2>{escape(frame["id"])} · {frame["time"]:.6f}초</h2>{"".join(cards)}</section>')
    return '''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>부품별 원본 비교</title><style>
body{margin:0;background:#10151b;color:#e9eef4;font:15px/1.6 system-ui,sans-serif}main{max-width:1600px;margin:auto;padding:24px}h1,h2,h3{line-height:1.3}small,.muted{color:#a5b2c2}small{font-size:12px}article{border:1px solid #344152;border-radius:12px;padding:18px;margin:18px 0;background:#19222d}p{margin:8px 0}.panels{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;min-width:0;flex:1 1 200px;max-width:400px}img{display:block;width:100%;height:auto;background:#000}figcaption{text-align:center;color:#c6d1df;font-size:13px}a{color:#9ed3ff}header{position:relative;max-width:1000px}nav{padding:12px 0;line-height:2;overflow-wrap:anywhere}</style><main><header><h1>부품별 원본 비교</h1><p>''' + escape(NOTE) + f'''</p><p>검사 입력: {report['coverage']['frameCount']}개 프레임 · {report['coverage']['partComparisons']}개 부품 비교. 입력 시각과 화면 정렬은 호출자가 확인해야 합니다. 도구는 시각 정렬을 자동으로 검증하지 않습니다.</p><p><a href="report.json">수치·해시 보고서</a></p><nav aria-label="프레임 바로가기">{navigation}</nav></header>''' + ''.join(sections) + '</main></html>'


def compare(manifest, out_dir, overwrite=False):
    manifest = Path(manifest).resolve()
    out_dir = Path(out_dir).absolute()
    frames, inputs = load_manifest(manifest)
    outputs = planned_outputs(frames)
    check_destination(out_dir, outputs, inputs, overwrite)
    input_hashes = {path: digest(path) for path in inputs}
    report = {'schema': REPORT_SCHEMA, 'manifestSHA256': input_hashes[manifest],
              'alignment': 'caller-supplied identical dimensions and timestamps; no resizing, temporal alignment or registration',
              'colorPolicy': 'opaque decoded 8-bit RGB; ICC color management is not applied',
              'annotationPolicy': 'ROIs are caller-defined fixed context windows, not semantic ground-truth masks; optional visible masks must be independent source annotations, never fitted geometry ground truth',
              'coverage': {'frameCount': len(frames), 'partComparisons': sum(len(f['parts']) for f in frames),
                           'times': [f['time'] for f in frames], 'fullVideoVisuallyReviewed': False},
              'metricUnits': 'mean absolute RGB channel difference in 0..255; no accuracy percentage or shape IoU',
              'note': NOTE, 'frames': []}
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.part-comparison-', dir=out_dir.parent) as temp:
        staging = Path(temp)
        for frame in frames:
            # Keep full-color rasters for only one frame at a time on long comparisons.
            arrays = {key: read_rgb(path) for key, path in frame['paths'].items()}
            source = arrays['source']
            fr = {'id': frame['id'], 'time': frame['time'], 'size': [source.shape[1], source.shape[0]],
                  'inputs': {key: {'path': frame['inputs'][key], 'sha256': input_hashes[path]}
                             for key, path in frame['paths'].items()}, 'parts': []}
            for part in frame['parts']:
                x, y, width, height = part['roi']
                crops = {key: array[y:y+height, x:x+width] for key, array in arrays.items()}
                before, current = crops['source'], crops['rendered']
                mask = part['mask']
                metrics = {'roiRgbMae': mae(before, current), 'roiPixels': width * height}
                if mask is not None:
                    metrics.update(visibleRgbMae=mae(before, current, mask), visiblePixels=int(mask.sum()))
                pr = {'id': part['id'], 'label': part['label'], 'roi': part['roi'], 'metrics': metrics,
                      'measurementScope': '문맥 ROI 및 독립 주석한 원본 가시 영역의 색상' if mask is not None else '다른 부품·배경이 포함될 수 있는 문맥 ROI',
                      'images': {}}
                if mask is not None:
                    pr['visibleMask'] = {'path': part['maskInput'], 'sha256': input_hashes[part['maskPath']]}
                if 'baseline' in crops:
                    baseline = {'roiRgbMae': mae(before, crops['baseline'])}
                    change = {'roiRgbMaeDelta': metrics['roiRgbMae'] - baseline['roiRgbMae']}
                    if mask is not None:
                        baseline['visibleRgbMae'] = mae(before, crops['baseline'], mask)
                        change['visibleRgbMaeDelta'] = metrics['visibleRgbMae'] - baseline['visibleRgbMae']
                    pr.update(baseline=baseline, change=change)
                images = {**crops, 'overlay': np.rint((before.astype(float) + current) / 2).astype(np.uint8),
                          'diff-x3': np.clip(np.abs(before.astype(np.int16) - current.astype(np.int16)) * 3, 0, 255).astype(np.uint8)}
                if mask is not None:
                    images['visible-mask'] = mask.astype(np.uint8) * 255
                for name, array in images.items():
                    relative = Path(frame['id']) / part['id'] / f'{name}.png'
                    target = staging / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    Image.fromarray(array).save(target)
                    pr['images'][name] = relative.as_posix()
                fr['parts'].append(pr)
            report['frames'].append(fr)
        (staging / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (staging / 'index.html').write_text(gallery(report), encoding='utf-8')
        # Validate all data before creating final outputs; never recursively clear an output directory.
        check_destination(out_dir, outputs, inputs, overwrite)
        out_dir.mkdir(parents=True, exist_ok=True)
        for relative in outputs:
            destination = out_dir / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staging / relative, destination)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog='See docs/scripts.md for part-comparison-v1. Source, rendered, optional baseline and mask paths are relative to the manifest. Source/rendered must be aligned opaque stills of equal size. ROI values are integer source-image pixels; optional masks are full-size binary 0/255 images. No automatic registration, segmentation, shape IoU or accuracy percentage is produced.')
    parser.add_argument('--manifest', type=Path, required=True, help='part-comparison-v1 JSON containing caller-annotated frames and part ROIs')
    parser.add_argument('--out-dir', type=Path, required=True, help='Separate output directory for PNG crops, index.html and report.json')
    parser.add_argument('--overwrite', action='store_true', help='Replace generated filenames in a nonempty output directory; never delete unrelated files or overwrite inputs')
    args = parser.parse_args()
    try:
        result = compare(args.manifest, args.out_dir, args.overwrite)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        parser.error(str(error))
    print(json.dumps({'output': str(args.out_dir), 'frames': result['coverage']['frameCount'],
                      'partComparisons': result['coverage']['partComparisons'], 'fullVideoVisuallyReviewed': False}))


if __name__ == '__main__':
    main()
