"""Independent tiny rasters exercise alignment, metric meaning and output safety."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
from PIL import Image
import pytest


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'compare-parts.py'
SPEC = importlib.util.spec_from_file_location('compare_parts', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def fixture(tmp_path):
    source = np.full((6, 8, 3), 80, dtype=np.uint8)
    rendered = source.copy()
    rendered[1:3, 2:4] = 90
    baseline = source.copy()
    baseline[1:3, 2:4] = 110
    # The neighboring context regresses, while the independently marked part improves.
    rendered[1:3, 4:6] = 130
    baseline[1:3, 4:6] = 100
    for name, array in [('source', source), ('rendered', rendered), ('baseline', baseline)]:
        Image.fromarray(array).save(tmp_path / f'{name}.png')
    mask = np.zeros((6, 8), dtype=np.uint8)
    mask[1:3, 2:4] = 255
    Image.fromarray(mask).save(tmp_path / 'visible.png')
    data = {'schema': 'part-comparison-v1', 'frames': [{
        'id': 'frame-1', 'time': 0.125, 'source': 'source.png', 'rendered': 'rendered.png',
        'baseline': 'baseline.png', 'parts': [{'id': 'part-1', 'label': '<script>alert("unsafe")</script>',
                                              'roi': [2, 1, 4, 2], 'visibleMask': 'visible.png'}]}]}
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps(data))
    return data, manifest


def save(data, path):
    path.write_text(json.dumps(data))


def test_reports_context_and_visible_color_separately_with_baseline(tmp_path):
    _, manifest = fixture(tmp_path)
    report = MODULE.compare(manifest, tmp_path / 'output')
    part = report['frames'][0]['parts'][0]
    assert part['metrics'] == {'roiRgbMae': 30.0, 'roiPixels': 8, 'visibleRgbMae': 10.0, 'visiblePixels': 4}
    assert part['baseline'] == {'roiRgbMae': 25.0, 'visibleRgbMae': 30.0}
    assert part['change'] == {'roiRgbMaeDelta': 5.0, 'visibleRgbMaeDelta': -20.0}
    assert report['coverage'] == {'frameCount': 1, 'partComparisons': 1, 'times': [0.125], 'fullVideoVisuallyReviewed': False}
    assert len(report['manifestSHA256']) == 64
    assert len(part['visibleMask']['sha256']) == 64
    assert len(report['frames'][0]['inputs']['source']['sha256']) == 64
    assert 'shapeIoU' not in part['metrics']
    html = (tmp_path / 'output/index.html').read_text()
    assert '<script>alert' not in html
    assert '&lt;script&gt;alert' in html
    assert '전체 영상의 시각 검수' in html
    assert 'roiRgbMae' in (tmp_path / 'output/report.json').read_text()
    with Image.open(tmp_path / 'output/frame-1/part-1/diff-x3.png') as image:
        assert image.size == (4, 2)
        assert image.getpixel((0, 0)) == (30, 30, 30)
        assert image.getpixel((3, 0)) == (150, 150, 150)
    with Image.open(tmp_path / 'output/frame-1/part-1/overlay.png') as image:
        assert image.getpixel((0, 0)) == (85, 85, 85)


def test_no_mask_is_explicitly_context_only(tmp_path):
    data, manifest = fixture(tmp_path)
    del data['frames'][0]['parts'][0]['visibleMask']
    del data['frames'][0]['baseline']
    save(data, manifest)
    report = MODULE.compare(manifest, tmp_path / 'output')
    part = report['frames'][0]['parts'][0]
    assert 'visibleRgbMae' not in part['metrics']
    assert 'baseline' not in part
    assert '문맥 ROI' in part['measurementScope']
    assert len(list((tmp_path / 'output').rglob('*.png'))) == 4


@pytest.mark.parametrize('roi', [[-1, 0, 2, 2], [7, 0, 2, 2], [0, 5, 2, 2], [0, 0, 0, 2], [0, 0, 2.0, 2], [True, 0, 2, 2]])
def test_invalid_rois_rejected_before_output(tmp_path, roi):
    data, manifest = fixture(tmp_path)
    data['frames'][0]['parts'][0]['roi'] = roi
    save(data, manifest)
    with pytest.raises(ValueError, match='ROI|roi'):
        MODULE.compare(manifest, tmp_path / 'output')
    assert not (tmp_path / 'output').exists()


@pytest.mark.parametrize('bad_id', ['../escape', '/absolute', 'a/b', 'a\\b', '.', '..', '<script>', '', 'a' * 81])
def test_path_traversal_ids_rejected(tmp_path, bad_id):
    data, manifest = fixture(tmp_path)
    data['frames'][0]['parts'][0]['id'] = bad_id
    save(data, manifest)
    with pytest.raises(ValueError, match='ID'):
        MODULE.compare(manifest, tmp_path / 'output')


@pytest.mark.parametrize('field', ['source', 'rendered', 'baseline'])
def test_dimension_mismatch_rejected(tmp_path, field):
    _, manifest = fixture(tmp_path)
    Image.new('RGB', (7, 6)).save(tmp_path / f'{field}.png')
    with pytest.raises(ValueError, match='dimensions must match'):
        MODULE.compare(manifest, tmp_path / 'output')


def test_same_size_shift_is_not_claimed_as_automatic_alignment(tmp_path):
    data, manifest = fixture(tmp_path)
    del data['frames'][0]['parts'][0]['visibleMask']
    source = np.zeros((6, 8, 3), dtype=np.uint8)
    source[1:3, 2:4] = 255
    Image.fromarray(source).save(tmp_path / 'source.png')
    Image.fromarray(np.roll(source, 1, axis=1)).save(tmp_path / 'rendered.png')
    save(data, manifest)
    report = MODULE.compare(manifest, tmp_path / 'output')
    assert report['frames'][0]['parts'][0]['metrics']['roiRgbMae'] > 0
    assert 'caller-supplied' in report['alignment']
    assert 'no resizing' in report['alignment']


@pytest.mark.parametrize('which', ['frames', 'parts'])
def test_duplicate_ids_case_insensitive(tmp_path, which):
    data, manifest = fixture(tmp_path)
    if which == 'frames':
        second = dict(data['frames'][0], id='FRAME-1')
        data['frames'].append(second)
    else:
        part = data['frames'][0]['parts'][0]
        data['frames'][0]['parts'].append(dict(part, id='PART-1'))
    save(data, manifest)
    with pytest.raises(ValueError, match='[Dd]uplicate'):
        MODULE.compare(manifest, tmp_path / 'output')


@pytest.mark.parametrize('time', [-1, True, float('nan'), float('inf'), '1'])
def test_invalid_times(tmp_path, time):
    data, manifest = fixture(tmp_path)
    data['frames'][0]['time'] = time
    save(data, manifest)
    with pytest.raises(ValueError, match='time must'):
        MODULE.compare(manifest, tmp_path / 'output')


@pytest.mark.parametrize('kind', ['empty', 'antialias', 'dimensions', 'colored'])
def test_invalid_visible_masks(tmp_path, kind):
    _, manifest = fixture(tmp_path)
    mask = Image.new('L', (8, 6), 0)
    if kind == 'antialias':
        mask.putpixel((2, 1), 127)
    elif kind == 'dimensions':
        mask = Image.new('L', (1, 1), 255)
    elif kind == 'colored':
        mask = Image.new('RGB', (8, 6), (255, 0, 0))
    mask.save(tmp_path / 'visible.png')
    with pytest.raises(ValueError, match='visibleMask'):
        MODULE.compare(manifest, tmp_path / 'output')


def test_transparent_input_rejected(tmp_path):
    _, manifest = fixture(tmp_path)
    Image.new('RGBA', (8, 6), (80, 80, 80, 100)).save(tmp_path / 'rendered.png')
    with pytest.raises(ValueError, match='transparent'):
        MODULE.compare(manifest, tmp_path / 'output')


def test_absolute_path_rejected_but_parent_relative_allowed(tmp_path):
    data, manifest = fixture(tmp_path)
    data['frames'][0]['source'] = str(tmp_path / 'source.png')
    save(data, manifest)
    with pytest.raises(ValueError, match='manifest-relative'):
        MODULE.compare(manifest, tmp_path / 'output')
    nested = tmp_path / 'annotations'
    nested.mkdir()
    for field in ['source', 'rendered', 'baseline']:
        data['frames'][0][field] = f'../{field}.png'
    data['frames'][0]['parts'][0]['visibleMask'] = '../visible.png'
    save(data, nested / 'manifest.json')
    assert MODULE.compare(nested / 'manifest.json', tmp_path / 'output')['coverage']['frameCount'] == 1


def test_overwrite_refuses_input_directory_and_preserves_unrelated_files(tmp_path):
    _, manifest = fixture(tmp_path)
    original_hash = MODULE.digest(tmp_path / 'source.png')
    with pytest.raises(ValueError, match='contain any input'):
        MODULE.compare(manifest, tmp_path, overwrite=True)
    output = tmp_path / 'output'
    MODULE.compare(manifest, output)
    unrelated = output / 'notes.txt'
    unrelated.write_text('keep')
    with pytest.raises(ValueError, match='not empty'):
        MODULE.compare(manifest, output)
    MODULE.compare(manifest, output, overwrite=True)
    assert unrelated.read_text() == 'keep'
    assert MODULE.digest(tmp_path / 'source.png') == original_hash


@pytest.mark.parametrize('kind', ['symlink', 'hardlink'])
def test_output_alias_cannot_overwrite_input(tmp_path, kind):
    _, manifest = fixture(tmp_path)
    output = tmp_path / 'output'
    target = output / 'frame-1/part-1/source.png'
    target.parent.mkdir(parents=True)
    source = tmp_path / 'source.png'
    original_hash = MODULE.digest(source)
    if kind == 'symlink':
        target.symlink_to(source)
    else:
        os.link(source, target)
    with pytest.raises(ValueError, match='symlink|aliases an input'):
        MODULE.compare(manifest, output, overwrite=True)
    assert MODULE.digest(source) == original_hash
    assert not (output / 'index.html').exists()


def test_cli_help_and_valid_invocation(tmp_path):
    _, manifest = fixture(tmp_path)
    result = subprocess.run([sys.executable, str(SCRIPT), '--help'], capture_output=True, text=True)
    assert result.returncode == 0
    assert '--manifest' in result.stdout and 'shape IoU' in result.stdout
    result = subprocess.run([sys.executable, str(SCRIPT), '--manifest', str(manifest), '--out-dir', str(tmp_path / 'output')], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['partComparisons'] == 1
