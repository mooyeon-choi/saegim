import threading
import subprocess

import cv2
import numpy as np
import pytest
import imageio_ffmpeg

from server.analyzer import AnalysisCancelled, analyze_video
from server.temporal import CutScan, explained_by_camera_motion, observed_temporal, scan_video_cuts, selected_observations
from tests.backend.test_analysis import NoOCR, make_video


def scan(frames):
    detector = CutScan()
    for frame in frames:
        detector.add(frame)
    return detector.finish()


def image(color):
    return np.full((90, 160, 3), color, np.uint8)


def test_whole_frame_color_cut_is_protected_at_exact_observation():
    a, b = image((20, 30, 180)), image((180, 80, 20))
    assert scan([a]*12+[b]*12) == [12]
    assert observed_temporal([i/24 for i in range(24)], 24, [12/24]) == {
        'mode': 'blend', 'sampleFps': pytest.approx(24), 'cuts': [.5]}


def test_gradual_fade_flash_and_repeated_color_cycles_are_not_shot_cuts():
    a, b = image((20, 30, 180)), image((180, 80, 20))
    fade = [((1-t)*a+t*b).astype(np.uint8) for t in np.linspace(0, 1, 24)]
    assert scan(fade) == []
    assert scan([a]*10+[image((255, 255, 255))]+[a]*10) == []
    assert scan([a, b]*15) == []
    flare = [image((80, 90, 200)),image((150, 160, 225)),image((235, 240, 255))]
    # The brightening ramp is continuous; the later abrupt switch to a
    # different non-white scene remains a protected transition.
    assert scan([a]*10+flare+[flare[-1]]*5+[b]*10) == [18]


def test_matching_camera_pan_is_explained_before_protecting_a_cut():
    rng = np.random.default_rng(15)
    a = cv2.GaussianBlur(rng.integers(0, 255, (90, 160, 3), dtype=np.uint8), (3, 3), .6)
    matrix = np.float32([[1, 0, 7], [0, 1, -3]])
    b = cv2.warpAffine(a, matrix, (160, 90))
    raw = float(np.abs(a.astype(float)-b).mean())
    assert explained_by_camera_motion(a, b, raw)
    assert scan([a]*10+[b]*10) == []


def test_native_30fps_sampling_at_24_is_not_misrepresented_as_uniform():
    observations = selected_observations([i/30 for i in range(60)], 24)
    assert len(observations) == 48
    assert observed_temporal(observations, 24, [])['mode'] == 'off'
    irregular = [0, 1/24, 3/24, 4/24]
    assert observed_temporal(irregular, 24, [])['mode'] == 'off'
    assert observed_temporal([i/12 for i in range(24)], 24, [])['sampleFps'] == pytest.approx(12)


def test_cut_scan_cooperatively_cancels_before_decode(tmp_path):
    def cancelled():
        raise AnalysisCancelled()
    with pytest.raises(AnalysisCancelled):
        scan_video_cuts(tmp_path/'not-needed.mp4', 24, 1, cancelled)


def test_cut_scan_rechecks_cancellation_during_source_pass(tmp_path):
    path = tmp_path/'cancel.mp4'
    make_video(path, seconds=.5)
    checks = []
    def cancelled_after_frames():
        checks.append(True)
        if len(checks) == 4:
            raise AnalysisCancelled()
    with pytest.raises(AnalysisCancelled):
        scan_video_cuts(path, 30, .5, cancelled_after_frames)
    assert len(checks) == 4


def test_real_uniform24_input_gets_source_cut_and_safe_blend_metadata(tmp_path, monkeypatch):
    monkeypatch.setattr('server.analyzer.VisionOCR', NoOCR)
    path = tmp_path/'uniform.mp4'
    frames = np.stack([image((20,30,180))]*6+[image((180,80,20))]*6)
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-loglevel','error','-y','-f','rawvideo',
                    '-pix_fmt','bgr24','-s','160x90','-r','24','-i','pipe:0','-c:v','libx264',
                    '-crf','0','-pix_fmt','yuv420p',str(path)],input=frames.tobytes(),check=True)
    project = analyze_video(path,path.name,'/api/media/uniform.mp4',24,threading.Event(),lambda *_:None,tmp_path,quality='high')
    assert project['temporal']['mode'] == 'blend'
    assert project['temporal']['sampleFps'] == pytest.approx(24)
    assert project['temporal']['cuts'] == [6/24]
    assert project['analysis']['sampleCount'] == 12


def test_high_track_ids_do_not_cross_explicit_source_cut(tmp_path, monkeypatch):
    monkeypatch.setattr('server.analyzer.VisionOCR', NoOCR)
    path = tmp_path/'cut.mp4'
    make_video(path, seconds=.5)
    boundary = 6/24
    result = analyze_video(path,path.name,'/api/media/cut.mp4',24,threading.Event(),lambda *_:None,tmp_path,
                           quality='high',cut_times=[boundary])
    assert result['temporal']['cuts'] == [boundary]
    assert all(not (node['start'] < boundary < node['end']) for node in result['nodes'])
    assert len(result['scenes']) == 2


def test_standard_mode_has_no_temporal_behavior_change(tmp_path, monkeypatch):
    monkeypatch.setattr('server.analyzer.VisionOCR', NoOCR)
    path = tmp_path/'standard.mp4'
    make_video(path, seconds=.5)
    result = analyze_video(path,path.name,'/api/media/standard.mp4',12,threading.Event(),lambda *_:None,tmp_path)
    assert 'temporal' not in result
