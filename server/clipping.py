"""Prepare a bounded, accurately re-encoded clip before vector analysis."""
from pathlib import Path
import math
import subprocess
import threading
import time

import cv2
import imageio_ffmpeg

from .analyzer import AnalysisCancelled, check_cancel


def validate_range(start: float | None, end: float | None):
    if start is None and end is None:
        return
    if start is None or end is None or not math.isfinite(start) or not math.isfinite(end):
        raise ValueError("구간의 시작과 종료 시간을 모두 입력해 주세요.")
    if start < 0 or end-start < .2-1e-8 or end-start > 60+1e-8:
        raise ValueError("시작은 0초 이상, 선택 구간은 0.2~60초여야 합니다.")


def prepare_clip(source: Path, output: Path, start: float, end: float, cancel: threading.Event):
    validate_range(start, end)
    check_cancel(cancel)
    cap = cv2.VideoCapture(str(source))
    try:
        if not cap.isOpened():
            raise ValueError("영상 파일을 읽을 수 없습니다.")
        width, height = cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
        if max(width, height) > 4096 or width*height > 4096*2160:
            raise ValueError("최대 4K 해상도까지 지원합니다.")
        fps = cap.get(cv2.CAP_PROP_FPS)
        duration = cap.get(cv2.CAP_PROP_FRAME_COUNT)/fps if fps > 0 else 0
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("영상 길이를 확인할 수 없습니다.")
        if end > duration+.04 or start >= duration:
            raise ValueError("선택 구간이 원본 영상의 길이를 벗어납니다.")
    finally:
        cap.release()
    # Re-encode instead of stream-copy so the new timeline starts at the
    # requested frame, rather than the preceding video keyframe.
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
               "-ss", str(start), "-i", str(source), "-t", str(end-start),
               "-map", "0:v:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
               "-pix_fmt", "yuv420p", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-movflags", "+faststart", str(output)]
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.monotonic()+120
    try:
        while True:
            check_cancel(cancel)
            if time.monotonic() > deadline:
                raise ValueError("구간 준비 시간이 초과되었습니다. 해상도나 구간 길이를 줄여 주세요.")
            try:
                _, error = process.communicate(timeout=.15)
                break
            except subprocess.TimeoutExpired:
                continue
        check_cancel(cancel)
        if process.returncode != 0 or not output.is_file():
            raise ValueError("선택 구간을 준비하지 못했습니다. 다른 파일이나 구간을 선택해 주세요.")
    except BaseException:
        process.kill()
        process.communicate()
        output.unlink(missing_ok=True)
        raise
