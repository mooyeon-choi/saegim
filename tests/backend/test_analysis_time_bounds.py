"""Serialization must not round valid observations beyond the video duration."""
import threading

import cv2
import numpy as np
import pytest

from server import analyzer


def observation(time):
    return analyzer.Observation(time, 'rect', 10, 10, 20, 20, (40, 90, 220), (245, 245, 245), area=400)


@pytest.mark.parametrize('duration', [13 / 24, 11 / 24])
@pytest.mark.parametrize('precise', [False, True])
def test_track_end_preserves_unrounded_duration_and_bounds_keyframes(duration, precise):
    track = analyzer.Track([observation(duration - 1 / 12), observation(duration - 1e-8)])
    node = analyzer.track_to_node(track, 0, 1, 1, duration, 12, precise_timing=precise)
    assert node['end'] == duration
    assert 0 <= node['start'] < node['end']
    assert all(0 <= frame['time'] <= duration for frame in node['keyframes'])
    assert node['keyframes'][-1]['time'] < duration


def test_last_short_track_remains_nonempty_after_time_serialization():
    duration = 1 / 3
    track = analyzer.Track([observation(duration - 1e-8)])
    node = analyzer.track_to_node(track, 0, 1, 1, duration, 24)
    assert node['end'] == duration
    assert 0 <= node['start'] < node['end']


def test_analysis_scene_and_background_times_stay_inside_measured_duration(tmp_path, monkeypatch):
    # Only the observation source is synthetic: exercise real output assembly.
    # The last color cut is close enough that decimal rounding exceeds duration.
    duration = 13 / 24
    times = [0.0, .1, duration - 1e-8]
    colors = [(245, 245, 245), (245, 245, 245), (30, 30, 210)]

    class Capture:
        index = 0

        def read(self):
            if self.index == len(times):
                return False, None
            frame = np.full((32, 48, 3), colors[self.index], np.uint8)
            self.index += 1
            return True, frame

        def get(self, prop):
            assert prop == cv2.CAP_PROP_POS_MSEC
            return times[self.index - 1] * 1000

        def release(self):
            pass

    class NoOCR:
        error = None

        def __init__(self, _cache):
            pass

        def recognize(self, _path):
            return []

        def close(self):
            pass

    monkeypatch.setattr(analyzer, 'probe_video', lambda _path: {'width': 48, 'height': 32, 'fps': 24, 'duration': duration})
    monkeypatch.setattr(analyzer.cv2, 'VideoCapture', lambda _path: Capture())
    monkeypatch.setattr(analyzer, 'VisionOCR', NoOCR)
    monkeypatch.setattr(analyzer, 'detect_frame', lambda rgb, time, _rows: ([observation(time)], rgb[0, 0]))
    result = analyzer.analyze_video(tmp_path / 'synthetic.mp4', 'synthetic.mp4', '/api/media/synthetic.mp4', 12, threading.Event(), lambda *_: None, tmp_path)
    assert result['duration'] == result['source']['duration'] == duration
    assert len(result['scenes']) == 2
    assert result['scenes'][-1]['end'] == duration
    assert result['scenes'][0]['end'] == result['scenes'][1]['start']
    assert all(0 <= scene['start'] < scene['end'] <= duration for scene in result['scenes'])
    assert all(0 <= frame['time'] <= duration for frame in result['backgroundKeyframes'])
    assert result['backgroundKeyframes'][-1]['time'] < duration
    assert all(0 <= node['start'] < node['end'] <= duration for node in result['nodes'])
    assert all(0 <= frame['time'] <= duration for node in result['nodes'] for frame in node['keyframes'])
