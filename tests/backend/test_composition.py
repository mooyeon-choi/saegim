import base64
import gzip
import json
import subprocess
import threading
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np
import pytest
from fastapi.testclient import TestClient

from server import app as app_module
from server import composition
from server.analyzer import AnalysisCancelled


# Synthetic duration includes a partial final second and a cut at a chunk boundary.
FULL_FRAME_COUNT = 32 * 24 + 17
CUT_FRAME = 32 * 24


@pytest.fixture
def long_source(tmp_path):
    path=tmp_path/'whole.mp4'
    frames=np.full((FULL_FRAME_COUNT,32,48,3),(30,60,100),np.uint8)
    frames[CUT_FRAME:]=(220,80,40)
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','48x32','-r','24','-i','pipe:0','-c:v','libx264','-crf','0','-pix_fmt','yuv420p',str(path)],input=frames.tobytes(),check=True)
    return path


def measured_stub(path,name,url,fps,cancel,update,cache,quality='standard',cut_times=None):
    cap=cv2.VideoCapture(str(path));frames=[]
    while True:
        ok,frame=cap.read()
        if not ok:break
        frames.append(frame)
    cap.release()
    assert frames
    duration=len(frames)/24
    update(50,'test measured frames')
    return {'schemaVersion':1,'id':'child','name':name,'width':48,'height':32,'duration':duration,'fps':24,'background':'#1e3c64',
            'nodes':[{'id':'n','type':'rect','start':0,'end':duration,'keyframes':[{'time':i/24} for i in range(len(frames))]}],
            'scenes':[{'id':'s','name':'all','start':0,'end':duration}],
            'source':{'name':name,'url':url},'analysis':{'sampleCount':len(frames),'warnings':[]},
            'measuredLastPixel':frames[-1][0,0].tolist()}


def unpack(segment):
    raw=gzip.decompress(base64.b64decode(segment['data']))
    assert len(raw)==segment['uncompressedBytes']
    return json.loads(raw)


def test_synthetic_long_input_keeps_every_frame_including_partial_ending(long_source,tmp_path,monkeypatch):
    monkeypatch.setattr(composition,'analyze_video',measured_stub)
    assert composition.requires_composition(long_source)
    progress=[]
    result=composition.analyze_composition(long_source,'whole.mp4','/api/media/source.mp4',24,threading.Event(),lambda p,s:progress.append(p),tmp_path/'cache',quality='high')
    assert result['schemaVersion']==2
    assert result['temporal']['mode']=='blend'
    assert result['temporal']['sampleFps']==pytest.approx(24)
    # The synthetic cut is a processing boundary; other memory boundaries
    # must not be reported as cuts.
    assert result['temporal']['cuts']==[CUT_FRAME/24]
    assert result['duration']==FULL_FRAME_COUNT/24
    assert result['analysis']['sampleCount']==FULL_FRAME_COUNT
    assert result['segments'][0]['start']==0
    assert result['segments'][-1]['end']==FULL_FRAME_COUNT/24
    children=[unpack(s) for s in result['segments']]
    assert sum(len(c['nodes'][0]['keyframes']) for c in children)==FULL_FRAME_COUNT
    assert all('source' not in child for child in children)
    assert all(child['nodes'][0]['end']==child['duration'] for child in children)
    assert all(a['end']==b['start'] for a,b in zip(result['segments'],result['segments'][1:]))
    assert children[-1]['measuredLastPixel'][2]>200
    assert progress==sorted(progress) and progress[-1]==99
    assert not list((tmp_path/'cache').glob('motion-segments-*'))


def test_composition_cancellation_removes_temporary_clips(long_source,tmp_path,monkeypatch):
    cancel=threading.Event()
    def stop(*args,**kwargs):
        cancel.set()
        raise AnalysisCancelled()
    monkeypatch.setattr(composition,'analyze_video',stop)
    with pytest.raises(AnalysisCancelled):
        composition.analyze_composition(long_source,'whole.mp4','',24,cancel,lambda *_:None,tmp_path/'cache',quality='high')
    assert not list((tmp_path/'cache').glob('motion-segments-*'))


def test_chunk_overflow_splits_and_retries_without_losing_frames(long_source,tmp_path,monkeypatch):
    calls=[]
    def limited(*args,**kwargs):
        child=measured_stub(*args,**kwargs)
        calls.append(child['analysis']['sampleCount'])
        if child['analysis']['sampleCount']>24:
            raise ValueError('분석 결과가 편집기 한도를 초과했습니다')
        return child
    monkeypatch.setattr(composition,'analyze_video',limited)
    result=composition.analyze_composition(long_source,'whole.mp4','',24,threading.Event(),lambda *_:None,tmp_path/'cache',quality='high')
    assert max(calls)>24
    assert sum(unpack(s)['analysis']['sampleCount'] for s in result['segments'])==FULL_FRAME_COUNT
    assert all(unpack(s)['analysis']['sampleCount']<=24 for s in result['segments'])


def test_long_video_api_dispatches_to_composition(long_source,tmp_path,monkeypatch):
    media=tmp_path/'media';media.mkdir();monkeypatch.setattr(app_module,'MEDIA',media)
    called=threading.Event()
    def analyze(*args,**kwargs):
        called.set();return {'schemaVersion':2,'name':'whole','segments':[]}
    monkeypatch.setattr(app_module,'analyze_composition',analyze)
    client=TestClient(app_module.app)
    response=client.post('/api/analyze',files={'file':('whole.mp4',long_source.read_bytes())},data={'quality':'high'})
    assert response.status_code==202 and called.wait(3)
    job=app_module.snapshot(response.json()['id'])
    # Worker completion follows immediately after its dispatch signal.
    import time
    deadline=time.time()+3
    while job['status']!='completed' and time.time()<deadline:
        time.sleep(.01);job=app_module.snapshot(response.json()['id'])
    assert job['project']['schemaVersion']==2


def test_composition_size_limit_is_checked_before_publishing(long_source,tmp_path,monkeypatch):
    monkeypatch.setattr(composition,'analyze_video',measured_stub)
    monkeypatch.setattr(composition,'MAX_COMPOSITION_BYTES',10)
    with pytest.raises(ValueError,match='압축 프로젝트 크기'):
        composition.analyze_composition(long_source,'whole.mp4','',24,threading.Event(),lambda *_:None,tmp_path/'cache')
    assert not list((tmp_path/'cache').glob('motion-segments-*'))


def test_variable_frame_timing_survives_lossless_segment_container(tmp_path,monkeypatch):
    source=tmp_path/'variable.mp4'
    frames=np.full((48,32,48,3),(40,80,120),np.uint8)
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','48x32','-r','24','-i','pipe:0','-vf','setpts=PTS+floor(N/12)*0.2/TB','-fps_mode','vfr','-c:v','libx264','-crf','0','-pix_fmt','yuv420p',str(source)],input=frames.tobytes(),check=True)
    metadata=composition.probe_video(source,max_duration=60)
    observed,duration=composition.scan_timeline(source,metadata,threading.Event(),lambda *_:None)
    def measured_vfr(path,name,url,fps,cancel,update,cache,quality='standard',cut_times=None):
        child=measured_stub(path,name,url,fps,cancel,update,cache,quality)
        cap=cv2.VideoCapture(str(path));times=[]
        while cap.grab():times.append(cap.get(cv2.CAP_PROP_POS_MSEC)/1000)
        cap.release()
        end=times[-1]+1/24
        child['duration']=end
        child['nodes'][0].update(end=end,keyframes=[{'time':time} for time in times])
        child['scenes'][0]['end']=end
        return child
    monkeypatch.setattr(composition,'analyze_video',measured_vfr)
    result=composition.analyze_composition(source,'variable.mp4','',24,threading.Event(),lambda *_:None,tmp_path/'cache',quality='high')
    actual=[]
    for segment in result['segments']:
        child=unpack(segment)
        assert child['fps']==result['fps']
        actual.extend(segment['start']+key['time'] for key in child['nodes'][0]['keyframes'])
    assert len(actual)==48
    assert actual==pytest.approx(observed,abs=1e-12)
    assert result['duration']==duration
    assert result['temporal']['mode']=='off'
