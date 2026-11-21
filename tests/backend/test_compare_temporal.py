"""Exercise the public temporal comparison command on aligned synthetic observations."""
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
from PIL import Image


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/compare-temporal.py'


def run_review(tmp_path, frames, offsets, cuts):
    inputs = [tmp_path / name for name in ('source', 'baseline', 'candidate')]
    for folder in inputs:
        folder.mkdir()
    for i, (frame, offset) in enumerate(zip(frames, offsets, strict=True)):
        for folder, pixels in zip(inputs, (frame, frame + offset, frame), strict=True):
            Image.fromarray(pixels).save(folder / f'{i:03}.png')
    output = tmp_path / 'result'
    cmd = [sys.executable, str(SCRIPT), '--source', str(inputs[0]), '--baseline', str(inputs[1]),
           '--candidate', str(inputs[2]), '--cut-starts', *map(str, cuts), '--out-dir', str(output),
           '--save-role-maps']
    return subprocess.run(cmd, capture_output=True, text=True), output


def test_roles_and_source_relative_changes_reset_at_cuts(tmp_path):
    row = np.arange(96)
    ramp = np.where(row >= 72, 25, 30 + 3 * np.clip(row - 20, 0, 40))
    img = np.tile(ramp.astype('uint8'), (48, 1))
    second_shot = np.flip(img, axis=1)
    run, out = run_review(tmp_path, [img, img, second_shot, np.roll(second_shot, 2, axis=1)],
                          [3, 9, 24, 24], [2])
    assert run.returncode == 0, run.stderr
    data = json.loads((out / 'report.json').read_text())
    assert [(p['previous'], p['current']) for p in data['pairs']] == [(0, 1), (2, 3)]
    assert data['metrics']['sameScreenChange'] == dict(baseline=3, candidate=0, pixels=2*48*96)
    assert data['metrics']['trackedChange']['candidate'] == 0
    with Image.open(out / 'roles' / '000.png') as role:
        assert [role.getpixel((x, 24)) for x in (6, 40, 71)] == [0, 1, 2]


def test_unsupported_correspondence_has_no_tracked_score(tmp_path):
    first = np.full((48, 64), 40, np.uint8)
    run, out = run_review(tmp_path, [first, first + 100], [0, 5], [])
    assert run.returncode == 0, run.stderr
    metrics = json.loads((out / 'report.json').read_text())['metrics']
    assert metrics['trackedChange'] == dict(baseline=None, candidate=None, pixels=0)
    assert metrics['sameScreenChange']['baseline'] == 5


def test_rejected_cut_leaves_no_partial_run(tmp_path):
    img = np.full((48, 64), 33, np.uint8)
    run, out = run_review(tmp_path, [img, img], [0, 0], [2])
    assert run.returncode != 0 and 'cut' in run.stderr.lower()
    assert not out.exists()


def test_high_bit_depth_requires_explicit_color_conversion(tmp_path):
    img = np.full((48, 64), 1024, np.uint16)
    run, out = run_review(tmp_path, [img], [0], [])
    assert run.returncode != 0 and '16-bit' in run.stderr
    assert not out.exists()
