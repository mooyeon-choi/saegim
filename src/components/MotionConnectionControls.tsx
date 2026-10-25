import { useState } from 'react';
import type { ForegroundMotion } from '../types';
import type { BackgroundMotionControlProps, BackgroundRegionSummary } from './BackgroundMotionControl';

interface Props {
  background?: BackgroundMotionControlProps;
  foreground: BackgroundMotionControlProps;
}

interface ForegroundRegionSummary extends BackgroundRegionSummary { appearanceAdjusted: boolean }
const hasDetailCorrection = (region: BackgroundRegionSummary) => 'appearanceAdjusted' in region && region.appearanceAdjusted === true;

/** Both switches remain visible; only one interval detail occupies vertical space. */
export function MotionConnectionControls({ background, foreground }: Props) {
  const [details, setDetails] = useState<'background' | 'foreground'>('foreground');
  const selected = details === 'background' && background ? background : foreground;
  const kind = selected === background ? 'background' : 'foreground';
  const title = kind === 'background' ? '배경' : '전경';
  const region = selected.regions.find(region => region.id === selected.activeId);
  const status = (item: BackgroundMotionControlProps, foreground: boolean) => {
    if (!item.enabled) return '꺼짐 · 기존 연결';
    const active = item.regions.find(region => region.id === item.activeId);
    if (!active || active.kind === 'fallback' || item.currentSupported === false) return '기존 연결 사용';
    return foreground ? hasDetailCorrection(active) ? '세부 형태 연결' : '전경 위치 연결' : active.kind === 'color' ? '기본색 보간' : '윤곽·면 연결';
  };
  return <section className="motion-connection-controls" aria-label="영역별 연결 설정">
    <div className="connection-switches">
      {([['background', background, '배경'], ['foreground', foreground, '전경']] as const).filter(([, item]) => item).map(([key, item, label]) => item && <div className={`connection-switch ${kind === key ? 'selected' : ''}`} key={key}>
        <button className={`smoothing-toggle ${item.enabled ? 'active' : ''}`} aria-label={`${label} 수식 연결`} aria-pressed={item.enabled} disabled={item.disabled} onClick={item.onToggle}>
          <span className="toggle-track"><i /></span><span>{label} 수식 연결</span>
        </button>
        <button className="connection-detail-tab" aria-label={`${label} 연결 세부정보`} aria-pressed={kind === key} onClick={() => setDetails(key)}>
          <span data-testid={`${key}-motion-status`}>{status(item, key === 'foreground')}</span><span aria-hidden="true">⌄</span>
        </button>
      </div>)}
    </div>
    <div className="connection-interval-detail">
      <select aria-label={`${title} 연결 구간`} value={selected.activeId ?? ''} disabled={selected.disabled || !selected.regions.length} onChange={event => {
        const next = selected.regions.find(region => region.id === event.target.value);
        if (next) selected.onSeek(next.start);
      }}>
        {!region && <option value="">현재 구간 · 기존 연결 사용</option>}
        {selected.regions.map(region => <option key={region.id} value={region.id}>{region.start.toFixed(3)}–{region.end.toFixed(3)}초 · {region.name}{hasDetailCorrection(region) ? ' · 세부 형태' : ''}</option>)}
      </select>
      <p title={selected.note ?? region?.note}>{selected.note ?? region?.note ?? (selected.enabled ? '지원하는 영역만 연결합니다.' : `${title} 연결 데이터를 보존합니다.`)}</p>
    </div>
  </section>;
}

export function foregroundRegions(motion: ForegroundMotion, duration: number, cuts: readonly number[]): ForegroundRegionSummary[] {
  const events = new Map<number, { add: typeof motion.tracks; remove: string[] }>();
  const eventAt = (time: number) => { if (!events.has(time)) events.set(time, { add: [], remove: [] }); return events.get(time)!; };
  for (const time of [0, duration, ...cuts]) eventAt(time);
  for (const track of motion.tracks) { eventAt(track.start).add.push(track); eventAt(track.end).remove.push(track.id); }
  const points = [...events.keys()].filter(time => time >= 0 && time <= duration).sort((a, b) => a - b);
  const active = new Map<string, ForegroundMotion['tracks'][number]>(), protectedCuts = new Set(cuts);
  const regions: ForegroundRegionSummary[] = [];
  for (const [index, start] of points.slice(0, -1).entries()) {
    const event = events.get(start)!; event.remove.forEach(id => active.delete(id)); event.add.forEach(track => active.set(track.id, track));
    const end = points[index + 1];
    const labels = [...new Set([...active.values()].map(track => track.label?.trim() || '캐릭터·전경 영역'))].sort();
    const appearanceAdjusted = [...active.values()].some(track => track.appearance !== undefined);
    const name = labels.length ? labels.join(' · ') : '기존 연결 사용';
    // Thousands of adjacent frame pairs should read as one labeled interval.
    const previous = regions.at(-1);
    if (previous?.name === name && previous.appearanceAdjusted === appearanceAdjusted && !protectedCuts.has(start)) { previous.end = end; continue; }
    regions.push({ id: `foreground-region-${regions.length}`, name, start, end, appearanceAdjusted, kind: active.size ? 'geometry' : 'fallback', note: active.size
      ? appearanceAdjusted ? `${labels.join(' · ')}의 위치와 형태 전환을 작은 영역 안에서 조절합니다. 전체 가림 복원은 아닙니다.` : `${labels.join(' · ')}의 관측 사이 위치를 연결합니다. 전체 캐릭터·가림 복원은 아닙니다.`
      : '검증된 전경 구간이 없어 기존 프레임 연결을 사용합니다.' });
  }
  return regions;
}
