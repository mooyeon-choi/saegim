// Render analyzed projects at known source times, independently of the editor UI.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const root = process.cwd();
const output = path.join(root, 'artifacts/qa');
const cache = path.join(root, '.cache');
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true });
const bundle = path.join(cache, 'qa-engine.mjs');
await build({ entryPoints: ['src/engine/index.ts'], outfile: bundle, bundle: true, minify: true, format: 'esm', platform: 'browser' });
const { renderSvg, validateProject, evaluateNode } = await import(pathToFileURL(bundle).href);
const names = process.argv.slice(2);
if (!names.length) names.push('motion-shapes', 'portrait-cuts', 'moving-icon', 'same-color', 'short-text');
const browser = await chromium.launch({ headless: true });
const report = [];
try {
  for (const name of names) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Use a fixture name without a path.');
    const file = path.join(output, `${name}.json`);
    await access(file);
    const project = validateProject(JSON.parse(await readFile(file, 'utf8')));
    const times = name === 'korean-demo' ? [0.5, 2.5, 6.5, 7.5]
      : name === 'portrait-cuts' ? [0.5, 1.46666667, 1.5, 2.5]
      : name === 'short-text' ? [0.36666667, 0.4, 0.5, 1.5, 2.36666667, 2.4, 2.5]
      : [0.5, 1.5, 2.5];
    const page = await browser.newPage({ viewport: { width: project.width, height: project.height }, deviceScaleFactor: 1 });
    const samples = [];
    for (const time of times) {
      await page.setContent('<html><head><style>html,body{margin:0;width:100%;height:100%}</style></head><body>' + renderSvg(project, time) + '</body></html>');
      await page.screenshot({ path: path.join(output, `${name}-${time.toFixed(3)}-render.png`) });
      samples.push({ time, nodes: project.nodes.map(node => evaluateNode(node, time)).filter(node => node.visible).map(node => ({ id: node.id, type: node.type, text: node.text, x: node.x, y: node.y, width: node.width, height: node.height, fontSize: node.fontSize })) });
    }
    report.push({ name, projectFile: file, width: project.width, height: project.height, samples });
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(path.join(output, 'visual-review-data.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.map(item => ({ name: item.name, samples: item.samples.length })), null, 2));
