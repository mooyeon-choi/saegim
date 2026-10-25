"""Compare actual source frames with visual-qa.mjs screenshots (no accuracy claims)."""
from pathlib import Path
import json
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
output = root / 'artifacts' / 'qa'
report = json.loads((output / 'visual-review-data.json').read_text())
font_path = next((p for p in [Path('/System/Library/Fonts/Supplemental/Arial.ttf'), Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')] if p.exists()), None)
font = ImageFont.truetype(str(font_path), 14) if font_path else ImageFont.load_default(size=14)
metrics = []
for item in report:
    source_video = root / '.data/media/motion-demo-v1.mp4' if item['name'] == 'korean-demo' else root / '.data/qa-fixtures' / f"{item['name']}.mp4"
    cap = cv2.VideoCapture(str(source_video))
    if not cap.isOpened():
        raise RuntimeError(f'Missing source video: {source_video}')
    width, height = item['width'], item['height']
    sheet = Image.new('RGB', (width * 3, height * len(item['samples']) + 32 * (len(item['samples']) + 1)), '#161a21')
    draw = ImageDraw.Draw(sheet)
    draw.text((10, 8), item['name'] + ' | SOURCE / REBUILT / DIFFERENCE (x3)', fill='white', font=font)
    try:
        fps = cap.get(cv2.CAP_PROP_FPS)
        for index, sample in enumerate(item['samples']):
            time = sample['time']
            cap.set(cv2.CAP_PROP_POS_FRAMES, round(time * fps))
            ok, frame = cap.read()
            if not ok:
                raise RuntimeError(f'Cannot decode {source_video} at {time}s')
            source = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            rebuilt = np.array(Image.open(output / f"{item['name']}-{time:.3f}-render.png").convert('RGB'))
            Image.fromarray(source).save(output / f"{item['name']}-{time:.3f}-source.png")
            difference = np.abs(source.astype(np.float32) - rebuilt.astype(np.float32))
            mask = np.max(np.abs(source.astype(np.float32) - source[0, 0]), axis=2) > 30
            foreground_mae = float(difference[mask].mean()) if mask.any() else 0
            metrics.append({'name': item['name'], 'time': time, 'mae': round(float(difference.mean()), 2), 'foreground_mae': round(foreground_mae, 2), 'foreground_pixels': int(mask.sum())})
            y = 32 + index * (height + 32)
            for column, array in enumerate([source, rebuilt, np.clip(difference * 3, 0, 255).astype('uint8')]):
                sheet.paste(Image.fromarray(array), (column * width, y + 32))
            draw.text((10, y + 8), f't={time:.3f}s / foreground MAE {foreground_mae:.1f}', fill='white', font=font)
    finally:
        cap.release()
    sheet.save(output / f"{item['name']}-comparison.png")
(output / 'visual-review-metrics.json').write_text(json.dumps(metrics, indent=2))
print(json.dumps(metrics, indent=2))
