import { readFileSync } from 'node:fs';
import { createDemoProject } from '../../../src/demo';
import type { MotionNode, MotionProject } from '../../../src/types';

/** A deterministic synthetic stress fixture; an explicit local project is optional. */
export function largeProjectFixture(): MotionProject {
  const actual = process.env.FRAMEFORM_LARGE_PROJECT;
  let project: MotionProject;
  if (actual) {
    project = JSON.parse(readFileSync(actual, 'utf8')) as MotionProject;
    delete project.source;
  } else {
    project = createDemoProject();
    let seed = 17;
    const coordinate = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return ((seed >>> 0) % 1_000_000 / 1000).toFixed(3); };
    project.nodes = Array.from({ length: 1200 }, (_, index): MotionNode => ({ id: `contour-${index}`, name: `합성 윤곽 ${index}`, type: 'path', x: 0, y: 0, width: 500, height: 500, rotation: 0, opacity: 1, fill: '#ffffff', stroke: 'none', strokeWidth: 0, start: 0, end: project.duration, hidden: true, locked: false, path: `M${coordinate()} ${coordinate()} ${Array.from({ length: 600 }, () => `L${coordinate()} ${coordinate()}`).join(' ')}Z`, keyframes: [] }));
  }
  project.id = 'large-storage-regression';
  project.name = '대용량 저장 검수';
  const existingTitle = project.nodes.findIndex(node => node.type === 'text' && (node.textWarp || node.keyframes.some(frame => frame.textWarp)));
  if (existingTitle >= 0) project.nodes[existingTitle] = { ...project.nodes[existingTitle], id: 'storage-title', name: '저장 검수 제목', text: '대형 프로젝트 문구', hidden: false, locked: false };
  else {
    const title: MotionNode = { ...createDemoProject().nodes.find(node => node.type === 'text')!, id: 'storage-title', name: '저장 검수 제목', text: '대형 프로젝트 문구', x: 40, y: 40, width: 500, height: 100, fontSize: 60, start: 2, end: project.duration, keyframes: [], textWarp: { top: [{ u: 0, x: 0, y: 0 }, { u: 1, x: 1000, y: 0 }], bottom: [{ u: 0, x: 0, y: 1000 }, { u: 1, x: 1000, y: 1000 }] } };
    project.nodes.push(title);
  }
  return project;
}
