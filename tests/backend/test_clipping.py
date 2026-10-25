from pathlib import Path
import subprocess
import threading
import time

import cv2
import imageio_ffmpeg
import numpy as np
import pytest
from fastapi.testclient import TestClient

from server import app as module
from server.clipping import prepare_clip, validate_range
from server.analyzer import AnalysisCancelled


@pytest.mark.parametrize('start,end', [(None,1),(1,None),(-1,1),(0,61),(1,1),(float('nan'),2),(0,float('inf'))])
def test_invalid_clip_ranges(start,end):
    with pytest.raises(ValueError):
        validate_range(start,end)


def make_source(path):
    # A 31.5-second input exceeds the analyzer's limit, while the selected
    # green ending segment is valid and must start at zero after trimming.
    frames = np.zeros((315,48,64,3),dtype=np.uint8)
    frames[:300,:, :,0]=220
    frames[300:,:, :,1]=220
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-loglevel','error','-y',
                    '-f','rawvideo','-pix_fmt','rgb24','-s','64x48','-r','10','-i','pipe:0',
                    '-c:v','libx264','-pix_fmt','yuv420p',str(path)],input=frames.tobytes(),check=True)


def test_clip_upload_returns_trimmed_source_and_keeps_original_range(tmp_path,monkeypatch):
    source=tmp_path/'long.mp4';make_source(source)
    media=tmp_path/'media';media.mkdir()
    monkeypatch.setattr(module,'MEDIA',media)
    observed={}
    def analyze(path,name,url,fps,cancel,update,cache,quality="standard"):
        cap=cv2.VideoCapture(str(path));ok,frame=cap.read()
        observed.update(duration=cap.get(cv2.CAP_PROP_FRAME_COUNT)/cap.get(cv2.CAP_PROP_FPS),color=frame.mean(axis=(0,1)),ok=ok)
        cap.release()
        return {'name':'test','source':{'name':name,'url':url}}
    monkeypatch.setattr(module,'analyze_video',analyze)
    client=TestClient(module.app)
    response=client.post('/api/analyze',files={'file':('long.mp4',source.read_bytes())},data={'clip_start':30,'clip_end':31.5})
    assert response.status_code==202
    job_id=response.json()['id'];deadline=time.time()+8
    while time.time()<deadline:
        job=client.get(f'/api/jobs/{job_id}').json()
        if job['status'] in ('completed','failed'):break
        time.sleep(.02)
    assert job['status']=='completed',job
    assert observed['ok'] and observed['duration']==pytest.approx(1.5,abs=.02)
    assert observed['color'][1]>200 and observed['color'][2]<10
    assert '30.0–31.5초' in job['project']['name']
    assert '30.0–31.5초' in job['project']['source']['name']
    assert len(list(media.iterdir()))==1
    assert client.get(job['project']['source']['url']).status_code==200


def test_clip_outside_source_and_cancel_do_not_create_output(tmp_path):
    source=tmp_path/'long.mp4';make_source(source)
    output=tmp_path/'clip.mp4'
    with pytest.raises(ValueError,match='원본'):
        prepare_clip(source,output,31,33,threading.Event())
    event=threading.Event();event.set()
    with pytest.raises(AnalysisCancelled):
        prepare_clip(source,output,30,31,event)
    assert not output.exists()


def test_range_rejected_before_upload_is_stored(tmp_path,monkeypatch):
    monkeypatch.setattr(module,'MEDIA',tmp_path)
    client=TestClient(module.app)
    response=client.post('/api/analyze',files={'file':('long.mp4',b'bad')},data={'clip_start':0,'clip_end':61})
    assert response.status_code==422 and not list(tmp_path.iterdir())
