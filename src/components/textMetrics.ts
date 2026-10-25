import type { MotionNode } from '../types';

export const TEXT_REFIT_FIELDS = ['text', 'fontFamily', 'fontWeight', 'fontStyle', 'letterSpacing'] as const;
export function textMetricSignature(node: MotionNode): string {
  // fontSize alone deliberately scales within the existing calibrated envelope.
  return JSON.stringify(TEXT_REFIT_FIELDS.map(field => node[field]));
}
export function textFont(node: MotionNode): string {
  return `${node.fontStyle ?? 'normal'} ${node.fontWeight ?? 400} ${node.fontSize ?? 48}px ${node.fontFamily ?? 'sans-serif'}`;
}

/** Match SVG tspan baseline spacing and its common textLength for multiple lines. */
export function measureTextBox(node: MotionNode): NonNullable<MotionNode['textBox']> {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) throw new Error('이 브라우저에서 글자 크기를 측정하지 못했습니다.');
  const fontSize = node.fontSize ?? 48;
  context.font = textFont(node);
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.letterSpacing = `${node.letterSpacing ?? 0}px`;
  const lines = (node.text ?? '').split('\n');
  const measurements = lines.map(line => context.measureText(line));
  const advance = Math.max(1, ...measurements.map(metric => metric.width));
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  measurements.forEach((metric, index) => {
    if (!lines[index].trim() || metric.actualBoundingBoxLeft + metric.actualBoundingBoxRight <= 0) return;
    const scale = node.textFit === 'width' && metric.width > 0 ? advance / metric.width : 1;
    x = Math.min(x, -metric.actualBoundingBoxLeft * scale);
    right = Math.max(right, metric.actualBoundingBoxRight * scale);
    y = Math.min(y, index * fontSize * 1.2 - metric.actualBoundingBoxAscent);
    bottom = Math.max(bottom, index * fontSize * 1.2 + metric.actualBoundingBoxDescent);
  });
  const result = Number.isFinite(x)
    ? { x, y, width: Math.max(0.001, right - x), height: Math.max(0.001, bottom - y), advance }
    : { x: 0, y: -fontSize * .8, width: advance, height: Math.max(1, lines.length * fontSize * 1.2), advance };
  if (Object.values(result).some(value => !Number.isFinite(value) || Math.abs(value) > 65536)) throw new Error('원근 문구가 너무 깁니다. 줄바꿈을 넣거나 글자 크기를 줄여 주세요.');
  return result;
}

export async function loadTextFont(node: MotionNode): Promise<void> {
  // The new project render installs any embedded @font-face rules first.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  await document.fonts.load(textFont(node), (node.text ?? '').replace(/\n/g, '') || '한글 Mg');
}
