"""Independent raster reference generation, never used as analysis output."""
from __future__ import annotations
import math
import subprocess
import threading
from pathlib import Path
import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

_LOCK = threading.Lock()


def font_path() -> str | None:
    candidates = ["/System/Library/Fonts/AppleSDGothicNeo.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    return next((p for p in candidates if Path(p).is_file()), None)


def create_demo(path: Path):
    with _LOCK:
        if path.exists():
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".pending.mp4")
        command = [imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "960x540", "-r", "30", "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(temp)]
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        font = ImageFont.truetype(font_path(), 52) if font_path() else ImageFont.load_default(size=52)
        small = ImageFont.truetype(font_path(), 22) if font_path() else ImageFont.load_default(size=22)
        korean = bool(font_path() and ("Apple" in font_path() or "CJK" in font_path()))
        try:
            for index in range(240):
                t = index / 30
                image = Image.new("RGB", (960, 540), "#f5f3ee")
                draw = ImageDraw.Draw(image)
                # Separate monochrome objects, large text and an outlined triangle icon.
                draw.text((70, 68 + max(0, 1-t) * 20), "움직임을 코드로" if korean else "Motion into code", fill="#252c40", font=font, anchor="lt")
                draw.text((72, 145), "MOTION / LOCAL VIDEO RECONSTRUCTION", fill="#626a80", font=small, anchor="lt")
                u = min(1, max(0, t/6))
                cx = 132 + 400*(3*u*u-2*u*u*u)
                cy = 305 + 30*math.sin(t*math.pi/4)
                r = 46 + 8*math.sin(t*math.pi/4)
                draw.ellipse((cx-r, cy-r, cx+r, cy+r), fill="#4467ed")
                if t >= 1.0 and t < 7.1:
                    x = 665 - 45*math.sin(t*math.pi/4)
                    y = 252 + 36*math.sin(t*math.pi/4)
                    draw.rectangle((x, y, x+114, y+86), fill="#29a883")
                if t >= 2:
                    center_x, center_y = 811, 415 - 35*math.sin((t-2)*math.pi/6)
                    vertices = [(center_x+(40 if i % 2 == 0 else 18)*math.sin(i*math.pi/5), center_y-(40 if i % 2 == 0 else 18)*math.cos(i*math.pi/5)) for i in range(10)]
                    draw.polygon(vertices, fill="#e78b44")
                draw.line((72, 462, 540, 462), fill="#252c40", width=4)
                proc.stdin.write(image.tobytes())
            proc.stdin.close()
            error = proc.stderr.read().decode("utf-8", errors="replace")
            if proc.wait(timeout=30):
                raise RuntimeError(f"데모 영상을 만들지 못했습니다: {error[:300]}")
            temp.replace(path)
        except BaseException:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=3)
            temp.unlink(missing_ok=True)
            raise
