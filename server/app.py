"""FastAPI local API and optional built-web-app hosting."""
from __future__ import annotations
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import os
import logging
from pathlib import Path
import re
import threading
import time
import uuid
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from .analyzer import AnalysisCancelled, analyze_video
from .demo import create_demo
from .ocr import available_backend
from .clipping import prepare_clip, validate_range
from .composition import analyze_composition, requires_composition

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("MOTION_DATA_DIR", str(ROOT/".data")))
MEDIA = DATA/"media"
CACHE = DATA/"cache"
MAX_BYTES = 100*1024*1024
MEDIA.mkdir(parents=True, exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)
LOCK = threading.RLock()
JOBS: dict[str, dict] = {}
CANCEL: dict[str, threading.Event] = {}
CREATED: dict[str, float] = {}
EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="motion-analysis")
UPLOAD_SLOTS = asyncio.Semaphore(4)


@asynccontextmanager
async def lifespan(app):
    yield
    with LOCK:
        for event in CANCEL.values():
            event.set()
    EXECUTOR.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Motion to HTML Local API", version="0.1.0", lifespan=lifespan)


def snapshot(job_id: str) -> dict:
    with LOCK:
        if job_id not in JOBS:
            raise HTTPException(404, "작업을 찾을 수 없습니다. 서버를 재시작한 경우 다시 분석해 주세요.")
        return dict(JOBS[job_id])


def run_job(job_id: str, path: Path, original_name: str, sample_fps: float, clip_start: float | None = None, clip_end: float | None = None, quality: str = "standard"):
    def update(progress: float, stage: str):
        with LOCK:
            if JOBS[job_id]["status"] != "cancelled":
                JOBS[job_id].update(status="processing", progress=round(progress, 1), stage=stage)
    analysis_path = path
    project_title = None
    try:
        if clip_start is not None and clip_end is not None:
            update(2, "선택 구간 준비 중")
            analysis_path = MEDIA/f"{uuid.uuid4().hex}.mp4"
            prepare_clip(path, analysis_path, clip_start, clip_end, CANCEL[job_id])
            project_title = f"{Path(original_name).stem} · {clip_start:.1f}–{clip_end:.1f}초"
            original_name = f"{original_name} · {clip_start:.1f}–{clip_end:.1f}초"
        analyze = analyze_composition if requires_composition(analysis_path) else analyze_video
        project = analyze(analysis_path, original_name, f"/api/media/{analysis_path.name}", sample_fps, CANCEL[job_id], update, CACHE, quality=quality)
        if project_title:
            project["name"] = project_title[:100]
        with LOCK:
            if CANCEL[job_id].is_set():
                JOBS[job_id].update(status="cancelled", stage="분석 취소됨")
            else:
                JOBS[job_id].update(status="completed", progress=100, stage="분석 완료", project=project)
    except AnalysisCancelled:
        with LOCK:
            JOBS[job_id].update(status="cancelled", stage="분석 취소됨")
    except Exception as exc:
        if not isinstance(exc, ValueError):
            logging.getLogger(__name__).exception("Analysis job %s failed", job_id)
        with LOCK:
            if CANCEL[job_id].is_set():
                JOBS[job_id].update(status="cancelled", stage="분석 취소됨")
            else:
                error = str(exc) if isinstance(exc, ValueError) else f"영상 분석 중 문제가 발생했습니다 ({type(exc).__name__}). 다른 파일로 다시 시도해 주세요."
                JOBS[job_id].update(status="failed", stage="분석 실패", error=error)
    finally:
        if analysis_path != path:
            path.unlink(missing_ok=True)
        with LOCK:
            if JOBS[job_id]["status"] in ("failed", "cancelled"):
                analysis_path.unlink(missing_ok=True)


@app.get("/api/health")
def health():
    return {"ok": True, "version": "0.1.0", "capabilities": {"ocr": available_backend(), "video": True}}


@app.post("/api/analyze", status_code=202)
async def analyze(file: UploadFile = File(...), sample_fps: float = Form(12), clip_start: float | None = Form(None), clip_end: float | None = Form(None), quality: str = Form("standard")):
    if quality not in ("standard", "high"):
        await file.close()
        raise HTTPException(422, "분석 품질은 standard 또는 high여야 합니다.")
    if not 2 <= sample_fps <= 30:
        raise HTTPException(422, "분석 FPS는 2~30 사이여야 합니다.")
    try:
        validate_range(clip_start, clip_end)
    except ValueError as error:
        await file.close()
        raise HTTPException(422, str(error)) from None
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in (".mp4", ".webm", ".mov", ".m4v"):
        await file.close()
        raise HTTPException(415, "MP4, WebM, MOV 또는 M4V 영상 파일을 업로드해 주세요.")
    with LOCK:
        running = sum(j["status"] in ("queued", "processing") for j in JOBS.values())
        if running >= 4:
            await file.close()
            raise HTTPException(429, "분석 작업이 많습니다. 진행 중인 작업을 완료하거나 취소한 뒤 다시 시도해 주세요.")
    job_id = uuid.uuid4().hex
    path = MEDIA/f"{job_id}{suffix}"
    count = 0
    try:
        async with UPLOAD_SLOTS:
            with path.open("wb") as stream:
                while chunk := await file.read(1024*1024):
                    count += len(chunk)
                    if count > MAX_BYTES:
                        raise HTTPException(413, "100MB 이하의 영상을 업로드해 주세요.")
                    stream.write(chunk)
            if count == 0:
                raise HTTPException(422, "빈 파일은 분석할 수 없습니다.")
        with LOCK:
            # Re-check after upload; separate requests can complete their upload together.
            if sum(j["status"] in ("queued", "processing") for j in JOBS.values()) >= 4:
                raise HTTPException(429, "분석 작업이 많습니다. 잠시 후 다시 시도해 주세요.")
            # Bound in-memory completed jobs. Media persists for saved-project comparison.
            completed_ids = [key for key in JOBS if JOBS[key]["status"] not in ("queued", "processing")]
            for key in completed_ids[:-40]:
                JOBS.pop(key, None)
                CANCEL.pop(key, None)
                CREATED.pop(key, None)
            JOBS[job_id] = {"id": job_id, "status": "queued", "progress": 0, "stage": "분석 대기"}
            CANCEL[job_id] = threading.Event()
            CREATED[job_id] = time.time()
        EXECUTOR.submit(run_job, job_id, path, Path(file.filename or "video.mp4").name[:180], sample_fps, clip_start, clip_end, quality)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    return snapshot(job_id)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return snapshot(job_id)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    snapshot(job_id)
    with LOCK:
        if JOBS[job_id]["status"] in ("queued", "processing"):
            CANCEL[job_id].set()
            JOBS[job_id].update(status="cancelled", stage="분석 취소됨")
    return snapshot(job_id)


@app.get("/api/demo")
async def demo():
    path = MEDIA/"motion-demo-v1.mp4"
    try:
        await asyncio.to_thread(create_demo, path)
    except Exception:
        raise HTTPException(500, "데모 영상을 준비하지 못했습니다. FFmpeg 설치를 확인해 주세요.") from None
    return {"url": "/api/media/motion-demo-v1.mp4", "name": "모션 재구성 데모.mp4"}


@app.get("/api/media/{filename}")
def media(filename: str):
    if not re.fullmatch(r"(?:[0-9a-f]{32}\.(?:mp4|webm|mov|m4v)|motion-demo-v1\.mp4)", filename):
        raise HTTPException(404, "영상을 찾을 수 없습니다.")
    path = MEDIA/filename
    if not path.is_file():
        raise HTTPException(404, "원본 영상이 없습니다. 서버의 로컬 저장 폴더를 확인해 주세요.")
    mime = "video/webm" if filename.endswith(".webm") else "video/quicktime" if filename.endswith(".mov") else "video/mp4"
    return FileResponse(path, media_type=mime)


if (ROOT/"dist").is_dir():
    app.mount("/", StaticFiles(directory=ROOT/"dist", html=True), name="web")
