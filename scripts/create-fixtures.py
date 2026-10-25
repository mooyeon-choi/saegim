"""Independent benchmark videos, drawn without using the reconstruction engine."""
from pathlib import Path
import json
import math
import subprocess

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.data' / 'qa-fixtures'
OUT.mkdir(parents=True, exist_ok=True)
FONT = next((p for p in [Path('/System/Library/Fonts/Supplemental/Arial.ttf'), Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')] if p.exists()), None)


def encode(name, width, height, seconds, painter):
    path = OUT / name
    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{width}x{height}', '-r', '30', '-i', '-', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', str(path)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for frame in range(round(seconds * 30)):
        image = painter(frame / 30, width, height)
        proc.stdin.write(image.tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError('fixture encoding failed')
    return str(path)


def font(size):
    return ImageFont.truetype(str(FONT), size) if FONT else ImageFont.load_default(size=size)


def shapes(t, w, h):
    im = Image.new('RGB', (w, h), '#171b23')
    d = ImageDraw.Draw(im)
    d.text((28, 26), 'HELLO FRAME', font=font(28), fill='#f4f1e8')
    x = 66 + 106 * t
    d.ellipse((x-26, 148-26, x+26, 148+26), fill='#df5caa')
    y = 90 + 24 * math.sin(t * 2)
    d.rounded_rectangle((345, y, 415, y+46), radius=6, fill='#c5e55d')
    return im


def portrait(t, w, h):
    first = t < 1.5
    im = Image.new('RGB', (w, h), '#f4f1e8' if first else '#152c38')
    d = ImageDraw.Draw(im)
    d.text((24, 45), 'SCENE ONE' if first else 'SCENE TWO', font=font(26), fill='#242831' if first else '#ffffff')
    if first:
        x = 35 + 70 * t
        d.rectangle((x, 200, x+70, 280), fill='#ed6c87')
    else:
        y = 220 + 60 * (t-1.5)
        d.ellipse((95, y-40, 175, y+40), fill='#66d5e8')
    return im


def icon(t, w, h):
    im = Image.new('RGB', (w, h), '#eef1e9')
    d = ImageDraw.Draw(im)
    d.text((24, 22), 'DRAW / MOVE', font=font(24), fill='#263d35')
    x = 70 + t * 60
    pts = [(x+math.cos(i*math.pi/5-math.pi/2)*(42 if i%2==0 else 19), 155+math.sin(i*math.pi/5-math.pi/2)*(42 if i%2==0 else 19)) for i in range(10)]
    d.polygon(pts, fill='#ef884b')
    d.line((320, 110, 355, 145, 320, 180), fill='#336e5d', width=9)
    return im


def same_color(t, w, h):
    im = Image.new('RGB', (w, h), '#23232c')
    d = ImageDraw.Draw(im)
    d.text((26, 24), 'TWO OBJECTS', font=font(24), fill='#ffffff')
    x = 60 + 45 * t
    d.ellipse((x-20, 105, x+20, 145), fill='#78b9ed')
    x2 = 350 - 42*t
    d.ellipse((x2-26, 175, x2+26, 227), fill='#78b9ed')
    return im


def short_text(t, w, h):
    im = Image.new('RGB', (w, h), '#f5f4ef')
    d = ImageDraw.Draw(im)
    if 0.4 <= t < 2.4:
        d.text((45+12*t, 80), 'EDIT ME', font=font(42), fill='#263326')
    d.rectangle((30, 180, 30+int(t/3*350), 190), fill='#779556')
    return im


if __name__ == '__main__':
    paths = [encode('motion-shapes.mp4', 480, 270, 3, shapes), encode('portrait-cuts.mp4', 270, 480, 3, portrait), encode('moving-icon.mp4', 480, 270, 3, icon), encode('same-color.mp4', 480, 270, 3, same_color), encode('short-text.mp4', 480, 270, 3, short_text)]
    (OUT / 'manifest.json').write_text(json.dumps({'files': paths}, indent=2))
    print(json.dumps({'files': paths}, indent=2))
