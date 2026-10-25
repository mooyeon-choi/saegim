import { ScanLine } from 'lucide-react';
import { useState } from 'react';
import type { MotionNode } from '../types';
import { evaluateNode } from '../engine';
import { NumberField } from './Fields';

type TextWarp = NonNullable<MotionNode['textWarp']>;

export function hasTextWarp(node: MotionNode): boolean {
  return node.type === 'text' && Boolean(node.textWarp || node.keyframes.some(frame => frame.textWarp));
}

export function PerspectiveTextNotice() {
  return <div className="perspective-notice"><div><ScanLine size={14} /><strong>원근 텍스트</strong></div><p>기울기와 곡면을 따라 그려지는 하나의 텍스트 요소입니다. 아래 문구·글꼴·색상을 바꾸면 전체 제목에 적용됩니다.</p></div>;
}

export function PerspectiveTextPanel({ node, preserveAspect, onPreserveAspectChange, showOcclusion, onShowOcclusionChange, onPatch }: {
  node: MotionNode;
  preserveAspect: boolean;
  onPreserveAspectChange: (value: boolean) => void;
  showOcclusion: boolean;
  onShowOcclusionChange: (value: boolean) => void;
  onPatch: (patch: Partial<MotionNode>) => void;
}) {
  const [cornerError, setCornerError] = useState('');
  const [cornerRevision, setCornerRevision] = useState(0);
  const warp = node.textWarp ?? node.keyframes.find(frame => frame.textWarp)?.textWarp;
  if (!warp) return null;
  const corners = [
    { edge: 'top', last: false, label: '왼쪽 위', letter: 'A' },
    { edge: 'top', last: true, label: '오른쪽 위', letter: 'B' },
    { edge: 'bottom', last: true, label: '오른쪽 아래', letter: 'C' },
    { edge: 'bottom', last: false, label: '왼쪽 아래', letter: 'D' },
  ] as const;
  const hasMask = Boolean(node.occlusionPath || node.keyframes.some(frame => frame.occlusionPath));
  const points = [...warp.top, ...warp.bottom.slice().reverse()];
  const minX = Math.min(0, ...points.map(point => point.x));
  const minY = Math.min(0, ...points.map(point => point.y));
  const width = Math.max(1000, ...points.map(point => point.x)) - minX;
  const height = Math.max(1000, ...points.map(point => point.y)) - minY;
  const margin = Math.max(width, height) * 0.12;

  const cornerBounds = (edge: 'top' | 'bottom', last: boolean, axis: 'x' | 'y') => {
    const base = warp[edge][last ? warp[edge].length - 1 : 0][axis];
    const values = [warp, ...node.keyframes.flatMap(frame => frame.textWarp ? [frame.textWarp] : [])].map(source => source[edge][last ? source[edge].length - 1 : 0][axis]);
    // A shared delta must keep every animated corner within the engine's range.
    return { min: base - 4000 - Math.min(...values), max: base + 5000 - Math.max(...values) };
  };

  const changeCorner = (edge: 'top' | 'bottom', last: boolean, axis: 'x' | 'y', value: number) => {
    if (node.locked) return;
    const index = last ? warp[edge].length - 1 : 0;
    const delta = value - warp[edge][index][axis];
    const move = (source: TextWarp): TextWarp => ({ ...source, [edge]: source[edge].map((point, pointIndex) => pointIndex === (last ? source[edge].length - 1 : 0) ? { ...point, [axis]: point[axis] + delta } : point) });
    const patch = { textWarp: move(warp), keyframes: node.keyframes.map(frame => frame.textWarp ? { ...frame, textWarp: move(frame.textWarp) } : frame) };
    try {
      evaluateNode({ ...node, ...patch }, node.start);
      setCornerError('');
      onPatch(patch);
    } catch {
      setCornerError('모서리가 겹치거나 접힌 형태입니다. 기존 위치를 유지했으니 다른 좌표를 입력해 주세요.');
      setCornerRevision(previous => previous + 1);
    }
  };

  return <section className="inspector-section perspective-panel">
    <div className="section-title"><h3>원근과 가림</h3><span>WARP</span></div>
    <label className="inspector-checkbox"><input type="checkbox" aria-label="원본 비율 유지" checked={preserveAspect} disabled={node.locked} onChange={event => onPreserveAspectChange(event.target.checked)} /><span>원본 비율 유지</span></label>
    <p className="perspective-control-note">너비와 높이를 같은 비율로 조절합니다.</p>
    <label className="inspector-checkbox"><input type="checkbox" aria-label="텍스트를 원본 폭에 맞춤" checked={node.textFit === 'width'} disabled={node.locked} onChange={event => onPatch({ textFit: event.target.checked ? 'width' : undefined })} /><span>텍스트를 원본 폭에 맞춤</span></label>
    <p className="perspective-control-note">문구가 길어져도 제목 영역의 폭을 유지합니다.</p>
    <label className="inspector-checkbox"><input type="checkbox" aria-label="기울임꼴" checked={node.fontStyle === 'italic'} disabled={node.locked} onChange={event => onPatch({ fontStyle: event.target.checked ? 'italic' : 'normal' })} /><span>기울임꼴</span></label>
    <div className="occlusion-review"><label className="inspector-checkbox"><input type="checkbox" aria-label="가림 영역 표시" checked={showOcclusion && hasMask} disabled={!hasMask} onChange={event => onShowOcclusionChange(event.target.checked)} /><span>가림 영역 표시</span><small>{hasMask ? 'MASK' : '없음'}</small></label><p>{hasMask ? '앞의 사물에 가려지는 부분을 빨강으로 확인합니다. 내보낸 파일에는 표시되지 않습니다.' : '이 제목에는 별도 가림 영역이 없습니다.'}</p></div>
    <details className="warp-corners"><summary>네 모서리 조정 <span>{warp.top.length > 2 ? '곡면' : '원근'}</span></summary>
      <svg className="warp-diagram" role="img" aria-label="원근 텍스트 네 모서리" viewBox={`${minX - margin} ${minY - margin} ${width + margin * 2} ${height + margin * 2}`}>
        <polygon points={points.map(point => `${point.x},${point.y}`).join(' ')} fill="#b6e98c18" stroke="#8aaf69" strokeWidth={Math.max(width, height) * 0.008} />
        {corners.map(corner => { const point = warp[corner.edge][corner.last ? warp[corner.edge].length - 1 : 0]; return <g key={corner.letter}><circle cx={point.x} cy={point.y} r={Math.max(width, height) * 0.022} fill="#d0efb6" /><text x={point.x + margin * (corner.last ? -0.65 : 0.65)} y={point.y + margin * (corner.edge === 'top' ? 0.7 : -0.25)} textAnchor="middle" fill="#d0efb6" fontSize={Math.max(width, height) * 0.08}>{corner.letter}</text></g>; })}
      </svg>
      <p className="perspective-control-note">요소 내부 좌표 0–1000 기준입니다.{warp.top.length > 2 ? ' 곡면 내부 점은 유지하고 끝점만 조절합니다.' : ''}{node.keyframes.some(frame => frame.textWarp) ? ' 모든 원근 키프레임에 같은 변화량을 적용합니다.' : ''}</p>
      {cornerError && <p className="warp-validation" role="alert">{cornerError}</p>}
      {corners.map(corner => { const point = warp[corner.edge][corner.last ? warp[corner.edge].length - 1 : 0]; return <div className="warp-corner-row" key={`${corner.letter}-${cornerRevision}`}><span>{corner.letter} · {corner.label}</span><div className="field-grid"><NumberField label={`${corner.label} X`} value={point.x} {...cornerBounds(corner.edge, corner.last, 'x')} disabled={node.locked} onChange={value => changeCorner(corner.edge, corner.last, 'x', value)} /><NumberField label={`${corner.label} Y`} value={point.y} {...cornerBounds(corner.edge, corner.last, 'y')} disabled={node.locked} onChange={value => changeCorner(corner.edge, corner.last, 'y', value)} /></div></div>; })}
    </details>
  </section>;
}
