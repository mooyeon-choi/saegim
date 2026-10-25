"""Analyze a user-supplied local video through the running application API."""
import argparse
import hashlib
import json
import mimetypes
from pathlib import Path
import time

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--out-dir', type=Path, required=True)
    parser.add_argument('--base-url', default='http://127.0.0.1:8000')
    parser.add_argument('--quality', choices=['standard', 'high'], default='standard')
    parser.add_argument('--sample-fps', type=float, default=12)
    parser.add_argument('--clip-start', type=float)
    parser.add_argument('--clip-end', type=float)
    parser.add_argument('--timeout', type=float, default=1800)
    parser.add_argument('--overwrite', action='store_true')
    args = parser.parse_args()
    if not args.input.is_file():
        parser.error('Input video does not exist')
    if not 2 <= args.sample_fps <= 30 or args.timeout <= 0:
        parser.error('sample-fps must be 2..30 and timeout must be positive')
    if (args.clip_start is None) != (args.clip_end is None):
        parser.error('clip-start and clip-end must be supplied together')
    output = args.out_dir / 'project.json'
    if output.exists() and not args.overwrite:
        parser.error('project.json already exists; choose another out-dir or --overwrite')
    data = {'quality': args.quality, 'sample_fps': str(args.sample_fps)}
    if args.clip_start is not None:
        data.update(clip_start=str(args.clip_start), clip_end=str(args.clip_end))
    job = None
    with httpx.Client(base_url=args.base_url, timeout=120) as client:
        client.get('/api/health').raise_for_status()
        try:
            with args.input.open('rb') as stream:
                response = client.post('/api/analyze', files={'file': (args.input.name, stream, mimetypes.guess_type(args.input.name)[0] or 'application/octet-stream')}, data=data)
            response.raise_for_status()
            job = response.json()
            deadline = time.monotonic() + args.timeout
            previous = None
            while job['status'] in ('queued', 'processing'):
                state = (job.get('stage'), job.get('progress'))
                if state != previous:
                    print(json.dumps({'status': job['status'], 'stage': state[0], 'progress': state[1]}, ensure_ascii=False), flush=True)
                    previous = state
                if time.monotonic() > deadline:
                    raise TimeoutError('Analysis exceeded the configured timeout')
                time.sleep(0.5)
                response = client.get(f"/api/jobs/{job['id']}")
                response.raise_for_status()
                job = response.json()
            if job['status'] != 'completed':
                raise RuntimeError(job.get('error') or job['status'])
        except BaseException:
            if job and job['status'] in ('queued', 'processing'):
                try:
                    client.post(f"/api/jobs/{job['id']}/cancel")
                except httpx.HTTPError:
                    pass
            raise
    args.out_dir.mkdir(parents=True, exist_ok=True)
    text = json.dumps(job['project'], ensure_ascii=False, separators=(',', ':'))
    temporary = output.with_suffix('.pending.json')
    temporary.write_text(text, encoding='utf-8')
    temporary.replace(output)
    digest = hashlib.sha256()
    with args.input.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    report = {'passed': True, 'inputName': args.input.name, 'inputSHA256': digest.hexdigest(), 'projectSHA256': hashlib.sha256(text.encode()).hexdigest(), 'schemaVersion': job['project']['schemaVersion'], 'duration': job['project']['duration'], 'quality': args.quality, 'requestedSampleFPS': args.sample_fps, 'clipStart': args.clip_start, 'clipEnd': args.clip_end}
    (args.out_dir / 'analysis-check.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'project': str(output), **report}), flush=True)


if __name__ == '__main__':
    main()
