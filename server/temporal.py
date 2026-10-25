"""Conservative source-cut guards for blending complete vector observations.

Processing ranges never enter this detector. It uses source pixels at low
resolution, retains only a short look-ahead, and exports times, not pixels.
"""
from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np


CUT_WARNING = "장면 컷은 원본의 저해상도 색상·움직임 변화로 보수적으로 추정합니다. 비슷한 색의 컷이나 복잡한 전환은 놓칠 수 있으므로 원본과 확인하세요."
TIMING_WARNING = "관측 시각의 간격이 일정하지 않아 프레임 혼합을 껐습니다. 원본 PTS와 기존 요소 보간은 유지합니다."


def explained_by_camera_motion(previous: np.ndarray, current: np.ndarray, raw: float) -> bool:
    """Veto a candidate only if a well-supported global pan/zoom explains it."""
    a = cv2.cvtColor(previous, cv2.COLOR_BGR2GRAY)
    b = cv2.cvtColor(current, cv2.COLOR_BGR2GRAY)
    corners = cv2.goodFeaturesToTrack(a, 160, .015, 3)
    if corners is None or len(corners) < 8:
        return False
    target, status, _ = cv2.calcOpticalFlowPyrLK(a, b, corners, None, winSize=(15, 15), maxLevel=2)
    returned, back_status, _ = cv2.calcOpticalFlowPyrLK(b, a, target, None, winSize=(15, 15), maxLevel=2)
    consistent = ((status[:, 0] > 0) & (back_status[:, 0] > 0)
                  & (np.linalg.norm(corners[:, 0]-returned[:, 0], axis=1) < 1.5))
    if consistent.sum() < 8 or consistent.mean() < .4:
        return False
    matrix, inliers = cv2.estimateAffinePartial2D(corners[consistent], target[consistent],
                                                method=cv2.RANSAC, ransacReprojThreshold=2)
    if matrix is None or inliers.mean() < .6:
        return False
    height, width = a.shape
    warped = cv2.warpAffine(previous, matrix, (width, height))
    valid = cv2.warpAffine(np.ones(a.shape, np.uint8), matrix, (width, height)) > 0
    if valid.mean() < .6:
        return False
    residual = float(np.abs(warped.astype(float)-current)[valid].mean())
    return residual < max(12, raw*.65)


class CutScan:
    """Bounded-memory, five-frame look-ahead; indices refer to source frames."""

    def __init__(self):
        self.previous = None
        self.previous_hist = None
        self.deltas = [0.0]
        self.pending = []
        self.cut_indices = []
        self.frame_count = 0

    def add(self, frame: np.ndarray) -> None:
        current = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA)
        hsv = cv2.cvtColor(current, cv2.COLOR_BGR2HSV)
        histogram = cv2.calcHist([hsv], [0, 1, 2], None, [12, 4, 4], [0, 180, 0, 256, 0, 256])
        histogram /= histogram.sum()
        index = self.frame_count
        bright = float(((current.max(axis=2) > 240) & (current.min(axis=2) > 170)).mean())
        for candidate in self.pending:
            if index-candidate['index'] <= 3:
                difference = float(np.abs(candidate['previous'].astype(float)-current).mean())
                candidate['returnError'] = min(candidate['returnError'], difference)
                if candidate['brightening'] and bright > .7 and current.mean() >= candidate['current'].mean():
                    candidate['flash'] = True
        if self.previous is not None:
            difference = np.abs(current.astype(float)-self.previous)
            raw = float(difference.mean())
            self.deltas.append(raw)
            histogram_change = cv2.compareHist(histogram, self.previous_hist, cv2.HISTCMP_BHATTACHARYYA)
            changed = float((np.linalg.norm(difference, axis=2) > 55).mean())
            # Saturating flashes and continuous fast color cycles are not
            # assumed to be shot cuts. Ambiguous transitions remain blendable.
            white = max(float((current.min(axis=2) > 235).mean()),
                        float((self.previous.min(axis=2) > 235).mean()))
            if raw > 40 and histogram_change > .30 and changed > .5 and white < .55:
                brightening = current.mean()-self.previous.mean() > 25
                self.pending.append({'index': index, 'raw': raw, 'previous': self.previous,
                                     'current': current, 'returnError': float('inf'), 'brightening': brightening,
                                     'flash': brightening and bright > .7})
        self.previous, self.previous_hist = current, histogram
        self.frame_count += 1
        self._resolve(index-5)

    def _resolve(self, last_ready: int) -> None:
        while self.pending and self.pending[0]['index'] <= last_ready:
            candidate = self.pending.pop(0)
            index, raw = candidate['index'], candidate['raw']
            neighbors = self.deltas[max(1, index-5):index]+self.deltas[index+1:index+6]
            baseline = max(1.0, float(np.median(neighbors))) if neighbors else 1.0
            if raw/baseline < 2.6 or candidate['returnError'] < raw*.4 or candidate['flash']:
                continue
            if not explained_by_camera_motion(candidate['previous'], candidate['current'], raw):
                self.cut_indices.append(index)

    def finish(self) -> list[int]:
        self._resolve(self.frame_count)
        return list(self.cut_indices)


def scan_video_cuts(path: Path, fps: float, duration: float, check_cancel) -> list[float]:
    cap = cv2.VideoCapture(str(path))
    scanner = CutScan()
    times = []
    try:
        while True:
            check_cancel()
            ok, frame = cap.read()
            if not ok:
                break
            time = cap.get(cv2.CAP_PROP_POS_MSEC)/1000
            if not math.isfinite(time) or times and time <= times[-1]:
                time = len(times)/fps
            if time >= duration:
                break
            times.append(time)
            scanner.add(frame)
        check_cancel()
        cuts = scanner.finish()
    finally:
        cap.release()
    if all(abs(time-index/fps) < 1e-5 for index, time in enumerate(times)):
        times = [index/fps for index in range(len(times))]
    return [times[index] for index in cuts]


def observed_temporal(times: list[float], sample_fps: float, cuts: list[float]) -> dict:
    """A fixed blend grid is safe only when it is the actual observation grid."""
    period = float(np.median(np.diff(times))) if len(times) > 1 else 1/sample_fps
    uniform = period > 0 and all(abs(time-index*period) < 1e-5 for index, time in enumerate(times))
    rate = 1/period if uniform else sample_fps
    return {'mode': 'blend' if uniform else 'off', 'sampleFps': rate, 'cuts': sorted(set(cuts))}


def selected_observations(times: list[float], sample_fps: float) -> list[float]:
    """Mirror the analyzer's native-PTS sampling; never invent grid frames."""
    result = []
    next_time = 0.0
    for time in times:
        if time+1e-5 >= next_time:
            result.append(time)
            next_time += 1/sample_fps
    return result
