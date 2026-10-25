import type { MotionKeyframe, MotionNode, MotionProject } from './types';

const key = (time: number, values: Partial<MotionKeyframe> = {}): MotionKeyframe => ({ time, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, easing: 'ease-in-out', ...values });
const node = (id: string, name: string, type: MotionNode['type'], values: Partial<MotionNode>): MotionNode => ({ id, name, type, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, fill: '#25252c', stroke: 'none', strokeWidth: 0, start: 0, end: 8, hidden: false, locked: false, keyframes: [], ...values });

/** Editable sample data. This is intentionally labelled a sample, never an analysis result. */
export function createDemoProject(): MotionProject {
  return {
    schemaVersion: 1, id: 'demo-motion-001', name: '움직임을 코드로', width: 960, height: 540, duration: 8, fps: 30, background: '#f5f5ef',
    scenes: [{ id: 'scene-1', name: '등장', start: 0, end: 2.4 }, { id: 'scene-2', name: '움직임', start: 2.4, end: 6.4 }, { id: 'scene-3', name: '마무리', start: 6.4, end: 8 }],
    nodes: [
      node('eyebrow', '작은 제목 · MOTION, REBUILT', 'text', { x: 72, y: 68, width: 420, height: 20, text: 'MOTION, REBUILT', fontSize: 14, letterSpacing: 3, fontWeight: 650, fontFamily: 'Arial, sans-serif', fill: '#75766e', keyframes: [key(0, { opacity: 0, y: 12 }), key(0.6), key(7), key(8, { opacity: 0 })] }),
      node('headline', '한글 제목', 'text', { x: 66, y: 124, width: 810, height: 90, text: '움직임을 코드로', fontSize: 74, fontWeight: 800, letterSpacing: -4, fontFamily: 'Apple SD Gothic Neo, Malgun Gothic, sans-serif', keyframes: [key(0, { y: 38, opacity: 0 }), key(0.85), key(6.9), key(8, { y: -12, opacity: 0 })] }),
      node('subtitle', '영문 설명', 'text', { x: 72, y: 224, width: 600, height: 32, text: 'Every frame, editable.', fontSize: 24, letterSpacing: -0.4, fontWeight: 400, fontFamily: 'Arial, sans-serif', fill: '#787971', keyframes: [key(0, { y: 18, opacity: 0 }), key(0.45, { y: 18, opacity: 0 }), key(1.2), key(7), key(8, { opacity: 0 })] }),
      node('orbit-circle', '녹색 원', 'ellipse', { x: 92, y: 332, width: 112, height: 112, fill: '#b8df52', keyframes: [key(0, { x: -90, scaleX: 0.2, scaleY: 0.2, opacity: 0 }), key(0.3, { x: -90, scaleX: 0.2, scaleY: 0.2, opacity: 0 }), key(1.35), key(3.8, { x: 150, y: -35 }), key(5.2, { x: 75, y: 0, scaleX: 1.15, scaleY: 1.15 }), key(6.8, { x: 22 }), key(8, { x: 22, opacity: 0 })] }),
      node('square', '보라 사각형', 'rect', { x: 397, y: 337, width: 104, height: 104, borderRadius: 19, fill: '#9f8fe5', keyframes: [key(0, { y: 75, rotation: -30, opacity: 0, scaleX: 0.6, scaleY: 0.6 }), key(0.6, { y: 75, rotation: -30, opacity: 0, scaleX: 0.6, scaleY: 0.6 }), key(1.65), key(3.9, { x: 38, rotation: 95 }), key(5.8, { x: 5, rotation: 180 }), key(6.8, { rotation: 180 }), key(8, { rotation: 180, opacity: 0 })] }),
      node('arrow', '주황색 선 아이콘', 'path', { x: 690, y: 342, width: 96, height: 96, fill: 'none', stroke: '#ef8b52', strokeWidth: 11, path: 'M 120 880 L 880 120 M 120 120 L 880 120 L 880 880', keyframes: [key(0, { x: -25, y: 25, opacity: 0 }), key(0.9, { x: -25, y: 25, opacity: 0 }), key(1.9), key(3.5, { x: 38, y: -25 }), key(5.1, { x: -20, y: 15 }), key(6.8), key(8, { opacity: 0 })] }),
      node('baseline', '하단 구분선', 'line', { x: 72, y: 485, width: 816, height: 0, stroke: '#d9dad2', strokeWidth: 1, fill: 'none', keyframes: [key(0, { scaleX: 0, opacity: 0 }), key(0.8, { scaleX: 0, opacity: 0 }), key(1.8), key(8)] }),
      node('caption', '하단 설명', 'text', { x: 72, y: 501, width: 600, height: 17, text: 'TEXT  /  SHAPES  /  TIMING', fontSize: 10, letterSpacing: 1.5, fontWeight: 600, fontFamily: 'Arial, sans-serif', fill: '#93958b', keyframes: [key(0, { opacity: 0 }), key(1.4, { opacity: 0 }), key(2.1), key(7), key(8, { opacity: 0 })] }),
    ],
  };
}
