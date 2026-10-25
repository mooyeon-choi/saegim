import io
from pathlib import Path
import threading
import time
from fastapi.testclient import TestClient
import pytest
from server import app as module


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "MEDIA", tmp_path)
    return TestClient(module.app)


def test_health_and_media_path_validation(client):
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["capabilities"]["video"] is True
    assert client.get("/api/media/password.txt").status_code == 404
    assert client.get("/api/media/..%2Frequirements.txt").status_code == 404
    assert client.get("/api/jobs/not-found").status_code == 404


def test_upload_type_empty_size_and_fps_validation(client, monkeypatch):
    assert client.post("/api/analyze", files={"file": ("text.txt", b"hello")}).status_code == 415
    assert client.post("/api/analyze", files={"file": ("empty.mp4", b"")}).status_code == 422
    assert client.post("/api/analyze", files={"file": ("clip.mp4", b"video")}, data={"sample_fps": "NaN"}).status_code == 422
    monkeypatch.setattr(module, "MAX_BYTES", 5)
    response = client.post("/api/analyze", files={"file": ("large.mp4", b"0123456789")})
    assert response.status_code == 413
    assert not list(module.MEDIA.iterdir())


def test_cancel_cleans_upload_and_does_not_publish_project(client, monkeypatch):
    started = threading.Event()
    def slow_analyze(path, name, url, fps, cancel, update, cache, quality="standard"):
        update(10, "testing")
        started.set()
        cancel.wait(3)
        raise module.AnalysisCancelled()
    monkeypatch.setattr(module, "analyze_video", slow_analyze)
    response = client.post("/api/analyze", files={"file": ("cancel.mp4", b"video")})
    assert response.status_code == 202
    job_id = response.json()["id"]
    assert started.wait(2)
    assert client.post(f"/api/jobs/{job_id}/cancel").json()["status"] == "cancelled"
    deadline = time.time()+3
    while list(module.MEDIA.iterdir()) and time.time() < deadline:
        time.sleep(.02)
    result = client.get(f"/api/jobs/{job_id}").json()
    assert result["status"] == "cancelled" and "project" not in result
    assert not list(module.MEDIA.iterdir())


def test_fake_video_fails_as_job_and_removes_invalid_media(client):
    response = client.post("/api/analyze", files={"file": ("fake.mp4", b"not-a-movie")})
    assert response.status_code == 202
    job_id = response.json()["id"]
    deadline = time.time()+4
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] == "failed":
            break
        time.sleep(.03)
    assert job["status"] == "failed"
    assert job["error"]
    assert not list(module.MEDIA.iterdir())


def test_quality_is_validated_and_forwarded_to_the_worker(client, monkeypatch):
    invalid = client.post("/api/analyze", files={"file": ("clip.mp4", b"video")}, data={"quality": "unbounded"})
    assert invalid.status_code == 422
    assert not list(module.MEDIA.iterdir())
    received = []
    finished = threading.Event()
    def capture(path, name, url, fps, cancel, update, cache, quality="standard"):
        received.append((quality, fps))
        finished.set()
        return {"nodes": []}
    monkeypatch.setattr(module, "analyze_video", capture)
    response = client.post("/api/analyze", files={"file": ("clip.mp4", b"video")}, data={"quality": "high", "sample_fps": 24})
    assert response.status_code == 202
    assert finished.wait(2)
    assert received == [("high", 24)]


def test_budget_failure_is_reported_and_never_publishes_unimportable_project(client, monkeypatch):
    from server.budgets import require_budget
    def oversized(*args, **kwargs):
        require_budget("요소 수", 8001, 8000)
    monkeypatch.setattr(module, "analyze_video", oversized)
    response = client.post("/api/analyze", files={"file": ("large.mp4", b"video")}, data={"quality": "high"})
    assert response.status_code == 202
    job_id = response.json()["id"]
    deadline = time.time()+3
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] == "failed" and not list(module.MEDIA.iterdir()):
            break
        time.sleep(.01)
    assert job["status"] == "failed" and "project" not in job
    assert "8,001개 / 한도 8,000개" in job["error"]
    assert "더 짧은 영상 구간" in job["error"]
    assert not list(module.MEDIA.iterdir())
