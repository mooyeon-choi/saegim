"""Optional, entirely local OCR. macOS Vision needs no API key or model download."""
from __future__ import annotations
import json
import platform
import selectors
import shutil
import subprocess
import threading
from pathlib import Path

_BUILD_LOCK = threading.Lock()


def available_backend() -> str:
    return "Apple Vision (한국어·영어, 로컬)" if platform.system() == "Darwin" and shutil.which("swiftc") else "unavailable"


class VisionOCR:
    def __init__(self, cache: Path):
        self.process = None
        self.error = None
        if available_backend() == "unavailable":
            self.error = "현재 운영체제에는 OCR이 없습니다. 텍스트가 벡터 윤곽으로 표시될 수 있습니다. macOS에서는 Apple Vision 한국어·영어 OCR을 사용합니다."
            return
        source = Path(__file__).with_name("vision_ocr.swift")
        binary = cache / "vision-ocr"
        cache.mkdir(parents=True, exist_ok=True)
        try:
            with _BUILD_LOCK:
                if not binary.exists() or binary.stat().st_mtime < source.stat().st_mtime:
                    subprocess.run(["swiftc", "-O", str(source), "-o", str(binary)], check=True, capture_output=True, timeout=120)
            self.process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.DEVNULL, text=True, bufsize=1)
        except (OSError, subprocess.SubprocessError) as exc:
            self.error = f"로컬 OCR을 시작할 수 없습니다 ({type(exc).__name__}). 텍스트 윤곽은 수동 확인이 필요합니다."

    def recognize(self, path: Path) -> list[dict]:
        if not self.process or self.error:
            return []
        try:
            self.process.stdin.write(json.dumps({"path": str(path)}) + "\n")
            self.process.stdin.flush()
            selector = selectors.DefaultSelector()
            selector.register(self.process.stdout, selectors.EVENT_READ)
            ready = selector.select(15)
            selector.close()
            if not ready:
                raise TimeoutError("OCR response timeout")
            result = json.loads(self.process.stdout.readline())
            if result.get("error"):
                raise RuntimeError(result["error"])
            return result.get("results", [])
        except (OSError, ValueError, RuntimeError, TimeoutError):
            self.error = "OCR 처리 중 오류가 발생했습니다. 인식하지 못한 글자는 벡터 윤곽으로 남을 수 있습니다."
            self.close()
            return []

    def close(self):
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
            self.process = None
