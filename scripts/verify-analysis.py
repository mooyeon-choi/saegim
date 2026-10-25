"""Exercise the public upload API on independent videos and save review artifacts."""
from pathlib import Path
import argparse
import json
import time
import httpx

ROOT = Path(__file__).resolve().parents[1]


def run(base, names):
    output = ROOT / 'artifacts' / 'qa'
    output.mkdir(parents=True, exist_ok=True)
    summary = []
    with httpx.Client(base_url=base, timeout=60) as client:
        client.get('/api/health').raise_for_status()
        for name in names:
            source = ROOT / '.data' / 'qa-fixtures' / name
            started = time.monotonic()
            with source.open('rb') as stream:
                response = client.post('/api/analyze', files={'file': (name, stream, 'video/mp4')}, data={'sample_fps': '12'})
            response.raise_for_status()
            job = response.json()
            deadline = time.monotonic() + 240
            print(f'Analyzing {name}', flush=True)
            while job['status'] in ('queued', 'processing'):
                if time.monotonic() > deadline:
                    client.post(f"/api/jobs/{job['id']}/cancel")
                    raise RuntimeError(f'Timeout: {name}')
                time.sleep(.75)
                job = client.get(f"/api/jobs/{job['id']}").json()
            if job['status'] != 'completed':
                raise RuntimeError(f'{name}: {job}')
            project = job['project']
            assert project['nodes'], f'No elements reconstructed: {name}'
            assert project['source']['name'] == name
            assert all(n['type'] in ('rect', 'ellipse', 'text', 'path', 'line') for n in project['nodes'])
            assert 'data:image/' not in json.dumps(project), 'Raster frame fallback is forbidden'
            path = output / (source.stem + '.json')
            path.write_text(json.dumps(project, ensure_ascii=False, indent=2))
            texts = [n.get('text') for n in project['nodes'] if n['type'] == 'text']
            record = {'file': name, 'seconds': round(time.monotonic()-started, 2), 'nodes': len(project['nodes']), 'texts': texts, 'samples': project['analysis']['sampleCount'], 'scenes': len(project['scenes']), 'project': str(path.relative_to(ROOT))}
            summary.append(record)
            print(json.dumps(record, ensure_ascii=False), flush=True)
    (output/'analysis-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='http://127.0.0.1:8000')
    parser.add_argument('files', nargs='*', default=['motion-shapes.mp4','portrait-cuts.mp4','moving-icon.mp4','same-color.mp4','short-text.mp4'])
    args = parser.parse_args()
    run(args.base_url, args.files)
