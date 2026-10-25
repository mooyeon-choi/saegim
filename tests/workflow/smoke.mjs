/** Real CLI regression checks with tiny generated inputs; no API or downloaded media.
 * Run: node tests/workflow/smoke.mjs
 * Requires npm dependencies, Playwright Chromium, and the Python requirements.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await fs.mkdir(path.join(root, '.cache'), {recursive: true});
const out = await fs.mkdtemp(path.join(root, '.cache/workflow-smoke-'));
const localPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = existsSync(localPython) ? localPython : process.env.FRAMEFORM_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
// A stale setup interpreter must not override an existing installed .venv.
const cliEnv = {...process.env, FRAMEFORM_PYTHON: existsSync(localPython) ? path.join(out, 'missing-base-python') : python};
const execute = promisify(execFile);
const report = {passed: false, pythonSelection: existsSync(localPython) ? 'local-venv-over-stale-environment' : 'environment-fallback', checks: []};
const sha = data => createHash('sha256').update(data).digest('hex');
const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJSON = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
async function run(command, args, env = process.env) {
  return execute(command, args, {cwd: root, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024});
}
async function workflow(...args) {
  return run(process.execPath, ['scripts/workflow.mjs', ...args], cliEnv);
}
async function rejectedRun(args, message) {
  let failure;
  try { await workflow(...args); } catch (error) { failure = error; }
  assert.ok(failure, 'An existing output must be rejected without --overwrite');
  assert.match(failure.stderr ?? '', message);
}
function project(id, color, text, fps = 29.97) {
  return {
    schemaVersion: 1, id, name: id, width: 160, height: 90, duration: .2, fps, background: color,
    scenes: [{id: `${id}-scene`, name: id, start: 0, end: .2}],
    nodes: [{id: `${id}-text`, name: 'Editable title', type: 'text', text, fontFamily: 'sans-serif', fontSize: 16, fontWeight: 400,
      x: 8, y: 20, width: 144, height: 24, rotation: 0, opacity: 1, fill: '#ffffff', stroke: 'none', strokeWidth: 0,
      start: 0, end: .2, hidden: false, locked: false, keyframes: []}],
  };
}
const inspectMedia = String.raw`
import json, sys, cv2, hashlib
from PIL import Image
result = {}
for name, filename in json.loads(sys.argv[1]).items():
    if filename.endswith('.gif'):
        with Image.open(filename) as im:
            delays, hashes = [], set()
            for index in range(im.n_frames):
                im.seek(index)
                hashes.add(hashlib.sha256(im.convert('RGB').tobytes()).hexdigest())
                delays.append(im.info.get('duration', 0))
            result[name] = {'frames': len(delays), 'delays': delays, 'duration': sum(delays)/1000, 'uniqueRGBFrames': len(hashes)}
    else:
        cap = cv2.VideoCapture(filename)
        if not cap.isOpened():
            raise RuntimeError('Cannot decode ' + name)
        fps = cap.get(cv2.CAP_PROP_FPS)
        pixels = []
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            pixels.append(frame[-8, 8, ::-1].tolist())
        cap.release()
        result[name] = {'fps': fps, 'frames': len(pixels), 'duration': len(pixels)/fps, 'pixels': pixels}
print(json.dumps(result))
`;
let browser;
try {
  const original = project('fractional-rate', '#1166aa', 'EDITABLE TITLE');
  const sourceProject = path.join(out, 'fractional-project.json');
  await writeJSON(sourceProject, original);
  const normal = path.join(out, 'fractional-render');
  const low = path.join(out, 'low-rate-render');

  await workflow('render', '--project', sourceProject, '--out-dir', normal, '--width', '160');
  const normalCheck = await readJSON(path.join(normal, 'render-check.json'));
  assert.equal(normalCheck.passed, true);
  assert.equal(normalCheck.projectFPS, 29.97);
  assert.equal(normalCheck.fps, 29.97);
  assert.equal(normalCheck.frames, 6);
  assert.deepEqual(normalCheck.externalRequests, []);
  const originalOutputs = await Promise.all(['index.html', 'preview.mp4'].map(async name => sha(await fs.readFile(path.join(normal, name)))));
  await rejectedRun(['render', '--project', sourceProject, '--out-dir', normal, '--width', '160'], /Output exists/);
  assert.deepEqual(await Promise.all(['index.html', 'preview.mp4'].map(async name => sha(await fs.readFile(path.join(normal, name))))), originalOutputs);
  report.checks.push({name: 'fractional-default-fps-and-overwrite-protection', passed: true, frames: 6, fps: 29.97});

  await workflow('render', '--project', sourceProject, '--out-dir', low, '--width', '160', '--fps', '1');
  const lowCheck = await readJSON(path.join(low, 'render-check.json'));
  assert.equal(lowCheck.passed, true);
  assert.equal(lowCheck.frames, 1);
  assert.equal(lowCheck.encodedDuration, 1);
  const {stdout: ffmpegPath} = await run(python, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())']);
  const sourceVideo = path.join(out, 'synthetic-source.mp4');
  // A lossless static source makes identical GIF display frames deterministic.
  await run(ffmpegPath.trim(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x1166aa:s=160x90:r=30:d=0.2', '-frames:v', '6', '-an', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', sourceVideo]);
  const gif = path.join(out, 'low-rate-comparison.gif');
  await workflow('compare', '--source', sourceVideo, '--rendered', path.join(low, 'preview.mp4'), '--output', gif, '--width', '160', '--fps', '20');
  const gifCheck = await readJSON(path.join(out, 'low-rate-comparison.json'));
  assert.equal(gifCheck.passed, true);
  assert.equal(gifCheck.gifDuration, 1);
  assert.equal(gifCheck.requestedFrames, 20);

  const bundle = path.join(out, 'engine.mjs');
  await build({entryPoints: [path.join(root, 'src/engine/index.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm'});
  const {encodeSegment} = await import(pathToFileURL(bundle).href);
  const first = project('before', '#dd2222', 'BEFORE CUT', 20);
  const second = project('after', '#2244dd', 'AFTER CUT', 20);
  first.temporal = second.temporal = {mode: 'blend', sampleFps: 20, cuts: []};
  const composition = {
    schemaVersion: 2, id: 'cut-composition', name: 'Synthetic cut', width: 160, height: 90, fps: 20, duration: .4,
    background: first.background, temporal: {mode: 'blend', sampleFps: 20, cuts: [.2]},
    segments: [await encodeSegment({id: 'first', name: 'First', start: 0, end: .2}, first), await encodeSegment({id: 'second', name: 'Second', start: .2, end: .4}, second)],
  };
  const compositionPath = path.join(out, 'composition.json');
  await writeJSON(compositionPath, composition);
  const cut = path.join(out, 'cut-render');
  await workflow('render', '--project', compositionPath, '--out-dir', cut, '--width', '160');
  assert.equal((await readJSON(path.join(cut, 'render-check.json'))).passed, true);
  const {stdout: mediaJSON} = await run(python, ['-c', inspectMedia, JSON.stringify({fractional: path.join(normal, 'preview.mp4'), source: sourceVideo, low: path.join(low, 'preview.mp4'), gif, cut: path.join(cut, 'preview.mp4')})]);
  const media = JSON.parse(mediaJSON);
  await writeJSON(path.join(out, 'decoded-media.json'), media);
  assert.equal(media.fractional.frames, 6);
  assert.ok(Math.abs(media.fractional.fps - 29.97) < .001);
  assert.equal(media.source.frames, 6);
  assert.ok(Math.abs(media.source.duration - .2) < 1e-8);
  assert.equal(media.low.frames, 1);
  assert.equal(media.low.duration, 1);
  assert.equal(media.gif.duration, 1);
  assert.equal(media.gif.uniqueRGBFrames, 1);
  assert.ok(media.gif.frames <= 20, 'Static GIF encoding may merge equal frames, but must not add display time');
  assert.ok(media.gif.delays.every(value => value > 0 && value % 50 === 0));
  // Some FFmpeg builds retain equal frames. Exercise the production validator
  // against an actually coalesced GIF too, without prescribing encoder choices.
  const coalescedPath = path.join(out, 'static-coalesced.gif');
  const {stdout: coalescedJSON} = await run(python, ['-c', String.raw`
import importlib.util, json, sys
from pathlib import Path
from PIL import Image
spec = importlib.util.spec_from_file_location('comparison_cli', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with Image.open(sys.argv[2]) as image:
    image.convert('RGB').save(sys.argv[3], format='GIF', duration=1000, loop=0)
valid = module.validate_gif_timing(Path(sys.argv[3]), 20, 50)
assert valid['delays'] == [1000], valid
try:
    module.validate_gif_timing(Path(sys.argv[3]), 19, 50)
except RuntimeError:
    rejected = True
else:
    raise AssertionError('A 1000ms GIF must not pass a 950ms requested timeline')
print(json.dumps({'frames': len(valid['delays']), 'delays': valid['delays'], 'duration': sum(valid['delays'])/1000, 'rejectsWrongDuration': rejected}))
`, path.join(root, 'scripts/compare-video.py'), gif, coalescedPath]);
  const coalesced = JSON.parse(coalescedJSON);
  assert.equal(coalesced.frames, 1);
  assert.equal(coalesced.duration, 1);
  assert.equal(coalesced.rejectsWrongDuration, true);
  await writeJSON(path.join(out, 'coalesced-gif-check.json'), coalesced);
  assert.equal(media.cut.frames, 8);
  const closeColor = (actual, expected) => assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) <= 8), `Unexpected cut color: ${actual}, expected ${expected}`);
  closeColor(media.cut.pixels[3], [221, 34, 34]);
  closeColor(media.cut.pixels[4], [34, 68, 221]);
  report.checks.push({name: 'low-fps-end-padding-and-static-gif-delay', passed: true, sourceDuration: .2, renderDuration: 1, gifDuration: media.gif.duration, gifFrames: media.gif.frames, delays: media.gif.delays, coalesced});

  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({offline: true});
  const requests = [], errors = [];
  context.on('request', request => {if (/^https?:/.test(request.url())) requests.push(request.url());});
  await context.route(/^https?:/, route => route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  for (const [htmlFile, samples] of [[path.join(normal, 'index.html'), [[.1, 'EDITABLE TITLE']]], [path.join(cut, 'index.html'), [[.199999, 'BEFORE CUT'], [.2, 'AFTER CUT'], [.200001, 'AFTER CUT'], [.1, 'BEFORE CUT']]]]) {
    await page.goto(pathToFileURL(htmlFile).href);
    await page.evaluate(async () => {await window.motionPlayer.ready; window.motionPlayer.pause(); await document.fonts.ready;});
    for (const [time, text] of samples) {
      await page.evaluate(async t => {await window.motionPlayer.seek(t); await document.fonts.ready;}, time);
      const result = await page.locator('#stage').evaluate(stage => ({text: [...new Set([...stage.querySelectorAll('text')].map(node => node.textContent))], rasterNodes: stage.querySelectorAll('image,video,canvas,foreignObject').length}));
      assert.deepEqual(result.text, [text]);
      assert.equal(result.rasterNodes, 0);
    }
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
  report.checks.push({name: 'schema2-cut-pixels-and-offline-editable-text', passed: true, beforeRGB: media.cut.pixels[3], afterRGB: media.cut.pixels[4], externalRequests: requests, browserErrors: errors});
  report.passed = true;
} catch (error) {
  report.failure = String(error.stack ?? error);
  throw error;
} finally {
  await browser?.close();
  await writeJSON(path.join(out, 'smoke-check.json'), report);
  console.log(JSON.stringify({passed: report.passed, checks: report.checks.length, output: out}));
}
