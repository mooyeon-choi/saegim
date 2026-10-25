import type { BackgroundMotion } from '../types';

export interface BackgroundRegionSummary {
  id: string;
  name: string;
  start: number;
  end: number;
  kind: 'geometry' | 'color' | 'fallback';
  note?: string;
}

export interface BackgroundMotionControlProps {
  enabled: boolean;
  disabled: boolean;
  regions: readonly BackgroundRegionSummary[];
  activeId?: string;
  note?: string;
  currentSupported?: boolean;
  onToggle: () => void;
  onSeek: (time: number) => void;
}

const kindLabel = { geometry: '윤곽·면 연결', color: '기본색 보간', fallback: '기존 연결 사용' };

/** Coverage describes the fitted background only; foreground and text remain editable. */
export function BackgroundMotionControl({ enabled, disabled, regions, activeId, note, currentSupported, onToggle, onSeek }: BackgroundMotionControlProps) {
  const current = regions.find(region => region.id === activeId);
  const geometry = regions.filter(region => region.kind === 'geometry').length;
  const color = regions.filter(region => region.kind === 'color').length;
  return <section className="background-motion-bar" aria-label="배경 연결 설정">
    <div className="background-motion-heading">
      <button className={`smoothing-toggle ${enabled ? 'active' : ''}`} aria-label="배경 수식 연결" aria-pressed={enabled} disabled={disabled} onClick={onToggle}>
        <span className="toggle-track"><i /></span><span>배경 수식 연결</span>
      </button>
      <span className="background-coverage">시간 구간 · 윤곽·면 {geometry} · 기본색 {color}</span>
    </div>
    <div className="background-region-control">
      <select aria-label="배경 연결 구간" value={activeId ?? ''} disabled={disabled || !regions.length} onChange={event => {
        const region = regions.find(item => item.id === event.target.value);
        if (region) onSeek(region.start);
      }}>
        {!current && <option value="">현재 구간 · 기존 연결 사용</option>}
        {regions.map(region => <option key={region.id} value={region.id}>{region.start.toFixed(2)}–{region.end.toFixed(2)}초 · {region.name} · {kindLabel[region.kind]}</option>)}
      </select>
      <p data-testid="background-motion-status" title={note ?? current?.note}>
        <strong>{enabled ? current && currentSupported !== false ? kindLabel[current.kind] : '기존 연결 사용' : '꺼짐 · 기존 연결 사용'}</strong>
        <span>{note ?? current?.note ?? (enabled ? '지원하는 배경만 수식으로 연결합니다.' : '배경 수식 데이터를 보존합니다.')}</span>
      </p>
    </div>
  </section>;
}


export function backgroundRegions(motion: BackgroundMotion, duration: number, cuts: readonly number[]): BackgroundRegionSummary[] {
  const points = [...new Set([0, duration, ...cuts, ...motion.tracks.flatMap(track => [track.start, track.end])])].filter(time => time >= 0 && time <= duration).sort((a, b) => a - b);
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1], time = (start + end) / 2;
    const tracks = motion.tracks.filter(track => time >= track.start && time < track.end);
    const kind = tracks.some(track => track.anchor.nodes.length > 0) ? 'geometry' : tracks.length ? 'color' : 'fallback';
    return { id: `background-region-${index}`, name: `구간 ${index + 1}`, start, end, kind, note: kind === 'geometry'
      ? `지정한 배경 영역 ${tracks.length}개에 적용합니다. 인물·문구와 영역 밖은 기존 요소를 유지합니다.`
      : kind === 'color' ? `지정 영역 ${tracks.length}개의 기본색만 연결합니다. 윤곽·면 연결은 포함하지 않습니다.`
        : '검증된 배경 영역이 없어 기존 프레임 연결을 사용합니다.' };
  });
}
