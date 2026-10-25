"""Analyze long videos as bounded vector projects in a compressed composition."""
from __future__ import annotations

import base64
from bisect import bisect_left
from datetime import datetime, timezone
import gzip
import json
import math
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import uuid

import cv2
import imageio_ffmpeg
import numpy as np

from .analyzer import analyze_video, check_cancel, probe_video
from .budgets import check_project_budget, require_budget
from .temporal import CutScan, CUT_WARNING, TIMING_WARNING, observed_temporal, selected_observations

MAX_COMPOSITION_SECONDS = 60.0
MAX_COMPOSITION_BYTES = 256 * 1024 * 1024
MAX_SEGMENTS = 64
SEGMENT_SECONDS = 2.0


def requires_composition(path: Path) -> bool:
    """A cheap routing hint; the selected analyzer still validates the input."""
    cap = cv2.VideoCapture(str(path))
    try:
        fps = cap.get(cv2.CAP_PROP_FPS)
        return bool(cap.isOpened() and fps > 0 and cap.get(cv2.CAP_PROP_FRAME_COUNT)/fps > 30.00001)
    finally:
        cap.release()


def scan_timeline(path: Path, metadata: dict, cancel: threading.Event, update,
                  cut_scan: CutScan | None = None) -> tuple[list[float], float]:
    """Read observed frame PTS, including the last partial processing segment."""
    cap = cv2.VideoCapture(str(path))
    times = []
    nominal_fps = metadata['fps']
    try:
        while cap.grab():
            check_cancel(cancel)
            pts = cap.get(cv2.CAP_PROP_POS_MSEC)/1000
            if not math.isfinite(pts) or times and pts <= times[-1]:
                pts = len(times)/nominal_fps
            if pts > MAX_COMPOSITION_SECONDS+.05:
                raise ValueError('전체 영상은 60초 이하여야 합니다.')
            times.append(pts)
            if cut_scan is not None:
                ok, frame = cap.retrieve()
                if not ok:
                    raise ValueError('장면 전환을 확인할 원본 프레임을 읽지 못했습니다.')
                cut_scan.add(frame)
            if len(times) % 120 == 0:
                update(min(4.0, 1+3*pts/max(metadata['duration'], .2)), '전체 영상의 프레임 시각 확인')
    finally:
        cap.release()
    if not times:
        raise ValueError('분석할 수 있는 영상 프레임이 없습니다.')
    deltas = np.diff(times)
    period = float(np.median(deltas[-min(30, len(deltas)):])) if len(deltas) else 1/nominal_fps
    # Exact CFR grids avoid one-ULP future keys at chunk boundaries. Preserve
    # genuinely variable frame timing instead of snapping arbitrary videos.
    cfr = bool(len(deltas) and np.max(np.abs(deltas-1/nominal_fps)) < 1e-5)
    if cfr:
        times = [index/nominal_fps for index in range(len(times))]
        period = 1/nominal_fps
    duration = len(times)/nominal_fps if cfr else times[-1]+period
    if duration > MAX_COMPOSITION_SECONDS+.04:
        raise ValueError('전체 영상은 60초 이하여야 합니다.')
    return times, min(duration, MAX_COMPOSITION_SECONDS)


def processing_ranges(times: list[float], seconds: float = SEGMENT_SECONDS) -> list[tuple[int, int]]:
    result = []
    start = 0
    while start < len(times):
        end = bisect_left(times, times[start]+seconds, lo=start+1)
        # A one-frame remainder is part of the preceding processing segment.
        if end < len(times) and len(times)-end < 6:
            end = len(times)
        result.append((start, end))
        start = end
    return result


def extract_frames(source: Path, output: Path, first: int, end: int, cancel: threading.Event, fps: float = 24, cfr: bool = True):
    command = [imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
               '-i', str(source), '-an', '-vf', f'trim=start_frame={first}:end_frame={end},setpts=PTS-STARTPTS',
               *(['-r', str(fps), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0'] if cfr
                 else ['-fps_mode', 'passthrough', '-c:v', 'ffv1']),
               '-pix_fmt', 'yuv420p', str(output)]
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.monotonic()+120
    try:
        while True:
            check_cancel(cancel)
            if time.monotonic() > deadline:
                raise ValueError('분석 구간 준비 시간이 초과되었습니다. 짧은 구간으로 다시 시도해 주세요.')
            try:
                _, error = process.communicate(timeout=.15)
                break
            except subprocess.TimeoutExpired:
                continue
        check_cancel(cancel)
        if process.returncode or not output.is_file():
            raise ValueError('원본의 분석 구간을 준비하지 못했습니다.')
    except BaseException:
        process.kill()
        process.communicate()
        output.unlink(missing_ok=True)
        raise


def align_segment(project: dict, local_times: list[float], duration: float) -> None:
    """Keep observed local PTS and the final frame alive through the true end."""
    old_duration = project['duration']
    period = float(np.median(np.diff(local_times))) if len(local_times)>1 else duration
    cfr = len(local_times)>1 and max(abs(t-index*period) for index,t in enumerate(local_times)) < 1e-5
    def nearest(value):
        index = bisect_left(local_times, value)
        candidates = local_times[max(0,index-1):min(len(local_times),index+1)]
        found = min(candidates,key=lambda t:abs(t-value)) if candidates else value
        # The lossless VFR Matroska intermediary has a millisecond time base.
        # Restore the original observed PTS rather than keeping that rounding.
        return found if abs(found-value)<1e-3 else value
    for node in project['nodes']:
        node['start'] = nearest(node['start'])
        if abs(node['end']-old_duration)<1e-4:
            node['end'] = duration
        elif cfr and abs(node['end']/period-round(node['end']/period))<1e-4:
            node['end'] = min(duration,round(node['end']/period)*period)
        else:
            node['end'] = min(duration,node['end'])
        for key in node['keyframes']:
            key['time'] = nearest(key['time'])
    for key in project.get('backgroundKeyframes',[]): key['time'] = nearest(key['time'])
    for scene in project['scenes']:
        scene['start'] = nearest(scene['start'])
        scene['end'] = duration if abs(scene['end']-old_duration)<1e-4 else nearest(scene['end'])
    if 'temporal' in project:
        project['temporal']['cuts'] = [nearest(time) for time in project['temporal']['cuts']]
    project['duration'] = duration
    project.pop('source',None)


def pack_segment(project: dict, first: float, end: float, number: int) -> dict:
    check_project_budget(project)
    raw = json.dumps(project,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8')
    return {'id': f'segment-{number}', 'name': f'분석 구간 {number}', 'start':first,'end':end,
            'encoding':'gzip-base64','data':base64.b64encode(gzip.compress(raw,compresslevel=6,mtime=0)).decode('ascii'),
            'uncompressedBytes':len(raw),'nodeCount':len(project['nodes'])}


def analyze_composition(path: Path, original_name: str, source_url: str, sample_fps: float,
                        cancel: threading.Event, update, cache: Path, quality: str = 'standard') -> dict:
    check_cancel(cancel)
    update(1,'전체 영상 정보 확인')
    meta = probe_video(path,max_duration=MAX_COMPOSITION_SECONDS)
    cut_scan = CutScan() if quality == 'high' else None
    times,duration = scan_timeline(path,meta,cancel,update,cut_scan)
    check_cancel(cancel)
    cuts = [times[index] for index in cut_scan.finish()] if cut_scan is not None else []
    meta['duration'] = duration
    cfr = all(time == index/meta['fps'] for index,time in enumerate(times))
    queue = processing_ranges(times)
    segments = []
    sample_count = 0
    first_background = '#000000'
    encoded_bytes = 0
    last_progress = 4.0
    observations = []
    cache.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='motion-segments-',dir=cache) as folder:
        while queue:
            check_cancel(cancel)
            first,end_index = queue.pop(0)
            start_time = times[first]
            end_time = times[end_index] if end_index<len(times) else duration
            local_times = ([index/meta['fps'] for index in range(end_index-first)] if cfr
                           else [time-start_time for time in times[first:end_index]])
            clip = Path(folder)/f'{first}-{end_index}{".mp4" if cfr else ".mkv"}'
            def child_update(progress,stage):
                nonlocal last_progress
                check_cancel(cancel)
                value = 4+92*(first+(end_index-first)*progress/100)/len(times)
                last_progress = max(last_progress,min(96,value))
                update(last_progress,f'전체 영상 {start_time:.1f}–{end_time:.1f}초 · {stage}')
            child_update(0,'원본 프레임 준비')
            extract_frames(path,clip,first,end_index,cancel,meta['fps'],cfr)
            try:
                options = {'quality': quality}
                if quality == 'high':
                    options['cut_times'] = [time-start_time for time in cuts if start_time < time < end_time]
                child = analyze_video(clip,original_name,'',sample_fps,cancel,child_update,cache,**options)
                align_segment(child,local_times,end_time-start_time)
                # VFR intermediary containers can advertise a different nominal
                # rate. Playback uses the preserved keys; the composition's
                # display rate remains consistent across all of its children.
                child['fps'] = meta['fps']
                child['analysis']['warnings'].append('이 구간 경계는 처리 용량을 나눈 위치이며 원본의 장면 컷을 의미하지 않습니다.')
                packed = pack_segment(child,start_time,end_time,len(segments)+1)
            except ValueError as error:
                if '한도' in str(error) and end_index-first>=12:
                    middle=(first+end_index)//2
                    queue[:0]=[(first,middle),(middle,end_index)]
                    continue
                raise
            finally:
                clip.unlink(missing_ok=True)
            if not segments:first_background=child['background']
            sample_count+=child['analysis']['sampleCount']
            if quality == 'high':
                observations.extend(start_time+time for time in selected_observations(local_times,min(24,meta['fps'])))
            segments.append(packed)
            encoded_bytes+=len(packed['data'])
            require_budget('전체 압축 프로젝트 크기',encoded_bytes,MAX_COMPOSITION_BYTES,'바이트')
            require_budget('전체 분석 구간 수',len(segments)+len(queue),MAX_SEGMENTS)
            child_update(100,'분석 구간 완료')
    check_cancel(cancel)
    project={'schemaVersion':2,'id':str(uuid.uuid4()),'name':Path(original_name).stem[:100] or '전체 영상 변환',
             **meta,'background':first_background,'source':{'name':original_name,'url':source_url,**meta},'segments':segments,
             'analysis':{'engine':'local-segmented-vector-v1','sampleCount':sample_count,
                         'warnings':['전체 영상을 편집 가능한 벡터 구간으로 연결했습니다. 처리 구간은 원본 장면 컷과 다를 수 있습니다.',
                                     '자동 분석은 원본의 3D 리깅·조명·숨은 영역을 복구하지 않으며 세부 윤곽과 글꼴은 보정이 필요합니다. 오디오는 포함되지 않습니다.'],
                         'createdAt':datetime.now(timezone.utc).isoformat()}}
    if quality == 'high':
        project['temporal'] = observed_temporal(observations,min(24,meta['fps']),cuts)
        if not cfr:
            project['temporal']['mode'] = 'off'
        project['analysis']['warnings'].append(CUT_WARNING)
        if project['temporal']['mode'] == 'off':
            project['analysis']['warnings'].append(TIMING_WARNING)
    size=sum(len(chunk.encode('utf-8')) for chunk in json.JSONEncoder(ensure_ascii=False,separators=(',',':')).iterencode(project))
    require_budget('전체 압축 프로젝트 크기',size,MAX_COMPOSITION_BYTES,'바이트')
    update(99,'전체 프레임과 압축 구간 검증 완료')
    return project
