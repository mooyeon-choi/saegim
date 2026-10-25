"""Create a labelled, duration-checked comparison GIF from two local videos."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import tempfile

import cv2
import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont


def metadata(path):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError(f'Cannot open video: {path}')
    fps, frames = cap.get(cv2.CAP_PROP_FPS), int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    if fps <= 0 or frames <= 0:
        raise ValueError('Video must contain frames with valid timing')
    return {'fps': fps, 'frames': frames, 'duration': frames / fps}


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for b in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def validate_gif_timing(path, requested_frames, step_ms):
    """Accept merged identical frames only when their accumulated timing matches."""
    delays = []
    with Image.open(path) as gif:
        for i in range(gif.n_frames):
            gif.seek(i)
            gif.load()
            delays.append(gif.info.get('duration', 0))
        size = gif.size
    if not delays or any(d <= 0 or d % step_ms for d in delays) or sum(delays) != requested_frames * step_ms:
        raise RuntimeError(f'GIF timing mismatch: {sum(delays)}ms vs {requested_frames * step_ms}ms')
    return {'delays': delays, 'size': size}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--rendered', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--fps', type=int, choices=[5, 10, 20, 25, 50], default=20)
    p.add_argument('--width', type=int, default=480, help='Width of each comparison panel')
    p.add_argument('--source-start', type=float, default=0)
    p.add_argument('--overwrite', action='store_true')
    a = p.parse_args()
    if a.width < 64 or a.width > 1920 or a.source_start < 0 or a.output.suffix.lower() != '.gif':
        p.error('Use width64..1920, nonnegative source-start and a .gif output')
    if a.output.exists() and not a.overwrite:
        p.error('Output already exists; choose another path or --overwrite')
    src, rebuilt = metadata(a.source), metadata(a.rendered)
    if src['duration'] - a.source_start + max(1/src['fps'], 1/rebuilt['fps']) < rebuilt['duration']:
        p.error('Source clip is shorter than rendered video; check source-start or render duration')
    frame_count = math.ceil(rebuilt['duration'] * a.fps - 1e-8)
    duration, delay = frame_count / a.fps, 100 // a.fps
    cap = cv2.VideoCapture(str(a.rendered))
    aspect = cap.get(cv2.CAP_PROP_FRAME_HEIGHT) / cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    cap.release()
    height = max(2, round(a.width * aspect / 2) * 2)
    a.output.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    def run(args):
        subprocess.run([ffmpeg, '-y', '-v', 'error', *map(str,args)], check=True)
    # Raster labels are delivery metadata, never reconstructed scene content.
    # Pillow's built-in font avoids an operating-system-specific font path.
    with tempfile.TemporaryDirectory(prefix='frameform-compare-') as tmp:
        tmp = Path(tmp)
        header = Image.new('RGB', (2*a.width, 32), '#111612')
        draw = ImageDraw.Draw(header)
        font = ImageFont.load_default(size=14)
        draw.text((12,8), 'ORIGINAL', fill='white', font=font)
        draw.text((a.width+12,8), 'RECONSTRUCTED', fill='#cef5a5', font=font)
        header.save(tmp/'header.png')
        base = f'[0:v]setpts=PTS-STARTPTS,fps={a.fps},tpad=stop_mode=clone:stop_duration={duration},trim=duration={duration},scale={a.width}:{height}:force_original_aspect_ratio=decrease,pad={a.width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1[left];[1:v]setpts=PTS-STARTPTS,fps={a.fps},tpad=stop_mode=clone:stop_duration={duration},trim=duration={duration},scale={a.width}:{height},setsar=1[right];[left][right]hstack=shortest=1,tpad=stop_mode=clone:stop_duration={1/a.fps},trim=duration={duration},pad={2*a.width}:{height+32}:0:32[pair];[pair][2:v]overlay=0:0:eof_action=repeat:shortest=0[labels]'
        inputs = ['-ss',a.source_start,'-i',a.source,'-i',a.rendered,'-i',tmp/'header.png']
        run([*inputs,'-filter_complex',base+';[labels]palettegen=max_colors=256:reserve_transparent=0[p]','-map','[p]','-frames:v','1',tmp/'palette.png'])
        run([*inputs,'-i',tmp/'palette.png','-filter_complex',base+';[labels][3:v]paletteuse=dither=sierra2_4a[out]','-map','[out]','-frames:v',frame_count,'-loop','0','-final_delay',delay,a.output])
    timing = validate_gif_timing(a.output, frame_count, delay * 10)
    delays, size = timing['delays'], timing['size']
    with Image.open(a.output) as gif:
        gif.seek(gif.n_frames - 1)
        gif.convert('RGB').save(a.output.with_suffix('.last.png'))
    result = {'passed':True,'sourceSHA256':digest(a.source),'renderedSHA256':digest(a.rendered),'gifSHA256':digest(a.output),'sourceStart':a.source_start,'source':src,'rendered':rebuilt,'requestedFrames':frame_count,'gifFrames':len(delays),'gifDuration':sum(delays)/1000,'size':size,'frameStepMs':delay*10,'fullFrameDecode':True,'note':'Identical frames may merge with accumulated delay. Encoded frame rate and pixel differences do not measure reconstruction accuracy.'}
    a.output.with_suffix('.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result),flush=True)


if __name__ == '__main__':
    main()
