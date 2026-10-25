import { strToU8, zipSync } from 'fflate';
import type { MotionDocument, MotionProject } from '../types';
import { createMotionRuntime } from './runtime';
import { validateProject } from './validate';
import { assertProjectJsonSize } from './limits';
import { validateDocument } from './composition';
import { exportCompositionHtml, exportCompositionJson } from './compositionExport';

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Safe even if OCR text contains a closing script tag or Unicode line separators. */
export function serializeProject(project: MotionProject): string {
  const json = JSON.stringify(project);
  assertProjectJsonSize(json);
  return json.replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function editableJson(project: MotionProject): string {
  const compact = JSON.stringify(project);
  assertProjectJsonSize(compact);
  // Pretty-printing hundreds of thousands of observations can make an otherwise
  // importable project exceed the shared limit. Keep large documents compact.
  return compact.length > 1_000_000 ? compact : JSON.stringify(project, null, 2);
}

export function exportProjectJson(value: MotionDocument): string {
  if (value.schemaVersion === 2) return exportCompositionJson(value);
  return editableJson(validateProject(value));
}

export function exportHtml(value: MotionDocument): string {
  if (value.schemaVersion === 2) return exportCompositionHtml(value);
  const project = validateProject(value);
  // Source references are useful in editable JSON, but are never needed in the offline player.
  delete project.source;
  const title = escapeHtml(project.name || 'Motion Project');
  const initialSvg = createMotionRuntime().render(project, 0);
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<link rel="icon" href="data:,">
<title>${title}</title>
<style>
*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:#121418;color:#f6f6f3;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:32px}main{width:min(1120px,100%)}header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}h1{font-size:18px;font-weight:600;margin:0;overflow-wrap:anywhere}header span{font-size:11px;letter-spacing:.12em;color:#92969e;white-space:nowrap}#stage{width:100%;aspect-ratio:${project.width}/${project.height};overflow:hidden;background:#fff;border:1px solid #30333a;border-radius:12px;box-shadow:0 18px 80px #0004}#stage svg{max-width:100%;height:100%}.controls{display:flex;align-items:center;gap:12px;margin-top:20px}button{border:1px solid #373b43;background:#24272e;color:#eceef4;border-radius:8px;min-height:40px;padding:8px 14px;cursor:pointer;font:inherit;white-space:nowrap}button:hover{background:#353a44}button:focus-visible,input:focus-visible{outline:2px solid #b7a8ff;outline-offset:3px}#play{background:#c0b3ff;border-color:#c0b3ff;color:#21173e;min-width:76px;font-weight:650}#seek{min-width:0;flex:1;accent-color:#b7a8ff;cursor:pointer}output{font:12px ui-monospace,monospace;color:#b2b5bf;white-space:nowrap;min-width:106px;text-align:right}footer{margin-top:14px;color:#797e89;font-size:11px;display:flex;justify-content:space-between;gap:16px}label{display:flex;align-items:center;gap:5px}label input{accent-color:#b7a8ff}@media(max-width:600px){body{padding:16px}.controls{gap:7px;flex-wrap:wrap}#seek{order:2;flex-basis:100%}.step{padding:6px 10px}output{margin-left:auto}header span{display:none}footer{font-size:10px}}
</style>
</head>
<body>
<main>
<header><h1>${title}</h1><span>FRAME / HTML MOTION</span></header>
<div id="stage">${initialSvg}</div>
<div class="controls" aria-label="재생 컨트롤">
<button id="play" type="button" aria-label="재생">재생</button>
<button id="previous" class="step" type="button" aria-label="이전 프레임">←</button>
<button id="next" class="step" type="button" aria-label="다음 프레임">→</button>
<input id="seek" type="range" aria-label="재생 위치" min="0" max="${project.duration}" step="${1 / project.fps}" value="0">
<output id="time">0.00 / ${project.duration.toFixed(2)}s</output>
</div>
<footer><span>${project.width} × ${project.height} · ${project.fps} FPS · Space 재생 / ← → 프레임 이동</span><label><input type="checkbox" id="loop" checked>반복</label></footer>
</main>
<script type="application/json" id="motion-data">${serializeProject(project)}</script>
<script>
"use strict";
const createMotionRuntime = ${createMotionRuntime.toString()};
(() => {
  const project = JSON.parse(document.getElementById('motion-data').textContent);
  const runtime = createMotionRuntime();
  const stage = document.getElementById('stage');
  const slider = document.getElementById('seek');
  const output = document.getElementById('time');
  const playButton = document.getElementById('play');
  let time = 0, playing = false, previous = null, frame = null;
  const redraw = project.temporal?.mode === 'frames';
  const applyPair = !redraw && (project.temporal?.mode === 'blend' || project.backgroundMotion?.mode === 'on' || project.foregroundMotion?.mode === 'on') ? runtime.createStageRenderer(stage) : null;
  let drawnSample = null;
  function draw(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('seek에는 유한한 초 단위 숫자가 필요합니다.');
    time = Math.max(0, Math.min(project.duration, value));
    if (applyPair) applyPair(runtime.framePair(project, time));
    else {
      const sample = redraw ? runtime.framePlan(project.temporal, project.duration, time).from : time;
      if (!redraw || sample !== drawnSample) stage.innerHTML = runtime.render(project, time);
      drawnSample = sample;
      if (redraw) { stage.dataset.frameFrom = String(sample); stage.dataset.renderMode = 'frames'; }
    }
    slider.value = String(time);
    output.textContent = time.toFixed(2) + ' / ' + project.duration.toFixed(2) + 's';
    return time;
  }
  function pause() {
    playing = false; previous = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; playButton.textContent = '재생'; playButton.setAttribute('aria-label', '재생');
  }
  function tick(now) {
    if (!playing) return;
    if (previous !== null) {
      let next = time + Math.max(0, now - previous) / 1000;
      if (next >= project.duration) {
        if (document.getElementById('loop').checked) next %= project.duration;
        else { draw(project.duration); pause(); return; }
      }
      draw(next);
    }
    previous = now; frame = requestAnimationFrame(tick);
  }
  function play() {
    if (playing) return;
    if (time >= project.duration) draw(0);
    playing = true; previous = null;
    playButton.textContent = '일시정지'; playButton.setAttribute('aria-label', '일시정지');
    frame = requestAnimationFrame(tick);
  }
  function seek(value) { previous = null; return draw(value); }
  function step(direction) { pause(); seek((Math.round(time * project.fps) + direction) / project.fps); }
  playButton.addEventListener('click', () => playing ? pause() : play());
  slider.addEventListener('input', () => seek(Number(slider.value)));
  document.getElementById('previous').addEventListener('click', () => step(-1));
  document.getElementById('next').addEventListener('click', () => step(1));
  document.addEventListener('keydown', event => {
    if (/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable) return;
    if (event.code === 'Space') { event.preventDefault(); playing ? pause() : play(); }
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') { event.preventDefault(); step(event.code === 'ArrowLeft' ? -1 : 1); }
  });
  window.motionPlayer = Object.freeze({ seek, renderAt: seek, play, pause, step, get currentTime() { return time; }, get duration() { return project.duration; }, get playing() { return playing; } });
  draw(0);
})();
</script>
</body>
</html>`;
}

function filename(project: MotionDocument) {
  return (project.name || 'motion-project').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 100) || 'motion-project';
}

function download(bytes: BlobPart, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.style.display = 'none';
  document.body.append(link); link.click(); link.remove();
  // Delaying revocation keeps large downloads and Safari's save flow reliable.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function createProjectZip(value: MotionDocument): Uint8Array {
  const project = validateDocument(value);
  return zipSync({
    'index.html': strToU8(exportHtml(project)),
    'project.json': strToU8(exportProjectJson(project)),
    'README.txt': strToU8('FRAME / HTML Motion\n\nindex.html을 브라우저로 열면 네트워크 없이 재생됩니다.\nproject.json은 편집기에 다시 가져올 수 있는 요소와 키프레임 데이터입니다.\n원본 영상 및 오디오는 포함되지 않습니다.\n배경 수식이 있는 프로젝트는 검증된 영역에서 정적 벡터 앵커의 위치와 색상을 계산합니다. 지원 범위 밖에서는 기존 벡터 프레임 연결을 유지합니다.\n프로젝트에 임베딩한 글꼴은 HTML과 JSON에 포함되어 오프라인에서도 사용됩니다. 글꼴 라이선스는 JSON의 fonts[].license와 SVG metadata에 보존됩니다.\n임베딩되지 않은 글꼴은 시스템 설치 글꼴을 사용하므로 기기에 따라 모양이 달라질 수 있습니다.\n\nJavaScript API: await window.motionPlayer.ready; await window.motionPlayer.seek(seconds), play(), pause(), step(frames)\n전체 영상(schema 2)은 압축된 장면을 순서대로 재생합니다. gzip을 지원하는 최신 브라우저가 필요합니다. 활성 장면과 다음 장면 두 개만 압축 해제하여 유지합니다.\n'),
  }, { level: 6 });
}

export function downloadHtml(project: MotionDocument): void { download(exportHtml(project), `${filename(project)}.html`, 'text/html;charset=utf-8'); }
export function downloadProject(project: MotionDocument): void { download(exportProjectJson(project), `${filename(project)}.json`, 'application/json;charset=utf-8'); }
export function downloadZip(project: MotionDocument): void { download(createProjectZip(project).slice().buffer as ArrayBuffer, `${filename(project)}.zip`, 'application/zip'); }
