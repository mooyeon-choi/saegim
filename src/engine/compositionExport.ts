import type { MotionComposition } from '../types';
import { createCompositionRuntime, validateComposition } from './composition';
import { createMotionRuntime } from './runtime';
import { createProjectValidator } from './validate';
import { MAX_PROJECT_NODES, MAX_PROJECT_BYTES, MAX_DOCUMENT_BYTES } from './limits';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function exportCompositionJson(value: MotionComposition): string { return JSON.stringify(validateComposition(value)); }

/** All segments stay compressed in the file. Only the active and next segment are decoded. */
export function exportCompositionHtml(value: MotionComposition): string {
  const doc = validateComposition(value); delete doc.source;
  const data = JSON.stringify(doc).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<link rel="icon" href="data:,"><title>${escape(doc.name)}</title>
<style>*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;padding:32px;min-height:100vh;display:grid;place-items:center;background:#121418;color:#f6f6f3;font:14px/1.5 system-ui,sans-serif}main{width:min(1120px,100%)}header{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:20px}h1{font-size:18px;margin:0;overflow-wrap:anywhere}header span,footer{color:#92969e;font-size:11px}#stage{width:100%;aspect-ratio:${doc.width}/${doc.height};overflow:hidden;background:#17191e;border:1px solid #30333a;border-radius:12px}#stage svg{display:block;width:100%;height:100%}.controls{display:flex;gap:12px;align-items:center;margin-top:20px}button{background:#24272e;color:#fff;border:1px solid #373b43;border-radius:8px;padding:8px 14px;cursor:pointer;min-height:40px}#play{background:#c0b3ff;color:#21173e}#seek{flex:1;min-width:0;accent-color:#b7a8ff}output{font:12px monospace;white-space:nowrap}footer{display:flex;justify-content:space-between;gap:16px;margin-top:14px}#error{color:#ffb9b9;white-space:pre-wrap}button:focus-visible,input:focus-visible{outline:2px solid #b7a8ff;outline-offset:3px}@media(max-width:600px){body{padding:16px}.controls{flex-wrap:wrap;gap:7px}#seek{order:2;flex-basis:100%}header span{display:none}}</style></head>
<body><main><header><h1>${escape(doc.name)}</h1><span>FRAME / HTML MOTION · ${doc.segments.length} SCENES</span></header>
<div id="stage" aria-label="벡터 모션 영상"></div><div id="error" role="alert"></div>
<div class="controls"><button id="play" type="button" aria-label="재생">재생</button><button id="previous" type="button" aria-label="이전 프레임">←</button><button id="next" type="button" aria-label="다음 프레임">→</button><input id="seek" type="range" aria-label="재생 위치" min="0" max="${doc.duration}" step="${1 / doc.fps}" value="0"><output id="time">준비 중</output></div>
<footer><span>${doc.width} × ${doc.height} · ${doc.fps} FPS · Space 재생 / ← → 프레임 이동</span><label><input id="loop" type="checkbox" checked>반복</label></footer></main>
<script type="application/json" id="motion-data">${data}</script>
<script>
"use strict";
const createMotionRuntime = ${createMotionRuntime.toString()};
const createProjectValidator = ${createProjectValidator.toString()};
const createCompositionRuntime = ${createCompositionRuntime.toString()};
(() => {
 const doc = JSON.parse(document.getElementById('motion-data').textContent);
 const runtime = createMotionRuntime();
 const api = createCompositionRuntime(createProjectValidator(${MAX_PROJECT_NODES}).validateProject, runtime.render, runtime.evaluate, ${MAX_PROJECT_BYTES}, ${MAX_DOCUMENT_BYTES}, ${MAX_PROJECT_NODES}, runtime);
 const controller = api.createCompositionPlayer(doc);
 const stage = document.getElementById('stage'), slider = document.getElementById('seek'), output = document.getElementById('time'), button = document.getElementById('play');
 let time = 0, playing = false, frame = null, previous = null, sequence = 0;
 let drawnSample = null;
 const loadedFonts = new Set();
 const applyPair = doc.temporal?.mode !== 'frames' && (doc.temporal?.mode === 'blend' || doc.backgroundMotion?.mode === 'on') ? runtime.createStageRenderer(stage) : null;
 function failure(error) { document.getElementById('error').textContent = error instanceof Error ? error.message : String(error); pause(); }
 async function draw(value) {
   const revision = ++sequence;
   const plan = doc.temporal?.mode === 'frames' ? runtime.framePlan(doc.temporal, doc.duration, value) : null;
   if (plan && plan.from === drawnSample) {
     time = plan.time; slider.value = String(time); output.textContent = time.toFixed(2) + ' / ' + doc.duration.toFixed(2) + 's';
     return time;
   }
   if (applyPair) {
     const pair = await controller.framePair(value);
     if (!pair || revision !== sequence) return time;
     applyPair(pair);
     stage.getBoundingClientRect();
     await document.fonts.ready;
     if (revision !== sequence) return time;
     time = pair.time; slider.value = String(time); output.textContent = time.toFixed(2) + ' / ' + doc.duration.toFixed(2) + 's';
     return time;
   }
   const result = await controller.seek(value);
   if (!result || revision !== sequence) return time;
   stage.innerHTML = result.svg;
   drawnSample = plan?.from ?? null;
   if (plan) { stage.dataset.frameFrom = String(plan.from); stage.dataset.renderMode = 'frames'; }
   time = result.time; slider.value = String(time); output.textContent = time.toFixed(2) + ' / ' + doc.duration.toFixed(2) + 's';
   const fonts = result.project.fonts || [];
   for (const font of fonts) {
     const identity = font.family + ':' + font.weight + ':' + font.style + ':' + font.data;
     if (!loadedFonts.has(identity)) {
       await document.fonts.load((font.style || 'normal') + ' ' + (font.weight || 400) + ' 16px "' + font.family + '"');
       loadedFonts.add(identity);
     }
   }
   return time;
 }
 function pause() { playing = false; previous = null; if (frame !== null) cancelAnimationFrame(frame); frame = null; button.textContent = '재생'; button.setAttribute('aria-label','재생'); }
 async function tick(now) {
   if (!playing) return;
   try {
     if (previous !== null) {
       let next = time + Math.max(0, now - previous) / 1000;
       if (next >= doc.duration) {
         if (document.getElementById('loop').checked) next %= doc.duration;
         else { await draw(doc.duration); pause(); return; }
       }
       previous = now; await draw(next);
     } else previous = now;
     if (playing) frame = requestAnimationFrame(tick);
   } catch (error) { failure(error); }
 }
 async function play() { if (playing) return; if (time >= doc.duration) await draw(0); playing = true; previous = null; button.textContent = '일시정지'; button.setAttribute('aria-label','일시정지'); frame = requestAnimationFrame(tick); }
 function seek(value) { previous = null; return draw(value); }
 function step(direction) { pause(); return seek((Math.round(time * doc.fps) + direction) / doc.fps); }
 button.addEventListener('click', () => { if (playing) pause(); else void play().catch(failure); });
 slider.addEventListener('input', () => { void seek(Number(slider.value)).catch(failure); });
 document.getElementById('previous').addEventListener('click', () => { void step(-1).catch(failure); });
 document.getElementById('next').addEventListener('click', () => { void step(1).catch(failure); });
 document.addEventListener('keydown', event => {
   if (/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable) return;
   if (event.code === 'Space') { event.preventDefault(); if (playing) pause(); else void play().catch(failure); }
   if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') { event.preventDefault(); void step(event.code === 'ArrowLeft' ? -1 : 1).catch(failure); }
 });
 const ready = draw(0); ready.catch(failure);
 window.motionPlayer = Object.freeze({ready, seek, renderAt:seek, play, pause, step, get currentTime(){return time;}, get duration(){return doc.duration;}, get playing(){return playing;}, get cachedSegmentIds(){return controller.cachedSegmentIds;}});
})();
</script></body></html>`;
}
