import { useEffect, useRef, useState } from 'react';
import { Film, Play, Scissors, X } from 'lucide-react';
import type { VideoMetadata } from './videoMetadata';
import type { AnalysisQuality } from '../api';
import { AnalysisQualitySelector } from './AnalysisQualitySelector';

export interface PendingVideo extends VideoMetadata { file: File; url: string }
export interface ClipRange { clipStart?: number; clipEnd?: number }

export function ClipSelectionDialog({ source, quality, onQualityChange, onCancel, onConfirm }: { source: PendingVideo; quality: AnalysisQuality; onQualityChange: (quality: AnalysisQuality) => void; onCancel: () => void; onConfirm: (range: ClipRange) => void }) {
  const [startValue, setStartValue] = useState('0');
  const [endValue, setEndValue] = useState(String(Math.min(30, source.duration)));
  const [selection, setSelection] = useState<'full' | 'clip'>(source.duration <= 60 ? 'full' : 'clip');
  const [previewing, setPreviewing] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const startInput = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const start = selection === 'full' ? 0 : Number(startValue);
  const end = selection === 'full' ? source.duration : Number(endValue);
  const selectedDuration = end - start;
  let validation = '';
  if (selection === 'full' && source.duration > 60) validation = '전체 영상은 최대 60초까지 분석할 수 있습니다. 구간을 선택해 주세요.';
  else if (!startValue.trim() || !endValue.trim() || !Number.isFinite(start) || !Number.isFinite(end)) validation = '시작과 종료 시간을 숫자로 입력해 주세요.';
  else if (start < 0 || end > source.duration) validation = `0초부터 원본 끝 ${source.duration.toFixed(3)}초 사이에서 선택해 주세요.`;
  else if (selectedDuration < 0.2) validation = '종료 시간은 시작보다 최소 0.2초 뒤여야 합니다.';
  else if (selection === 'clip' && selectedDuration > 30) validation = '선택 구간은 최대 30초입니다. 더 긴 영상은 전체 영상 분석을 이용하세요.';
  const valid = !validation;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    if (startInput.current) startInput.current.focus();
    else dialog.current?.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus();
    startInput.current?.select();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelRef.current(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), video, [tabindex="0"]') ?? []);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  const preview = async () => {
    if (!valid || !video.current) return;
    video.current.currentTime = start;
    setPreviewing(true);
    try { await video.current.play(); } catch { setPreviewing(false); setPlaybackError(true); }
  };

  return <div className="clip-dialog-backdrop"><div ref={dialog} className="clip-dialog" role="dialog" aria-modal="true" aria-labelledby="clip-dialog-title" aria-describedby="clip-dialog-description">
    <div className="clip-dialog-heading"><div><span className="eyebrow">SELECT A CLIP</span><h2 id="clip-dialog-title"><Scissors size={19} />분석 구간 선택</h2></div><button className="icon-button" aria-label="구간 선택 닫기" onClick={onCancel}><X size={18} /></button></div>
    <p id="clip-dialog-description">이 영상은 {source.duration.toFixed(1)}초입니다. 전체 영상을 장면별로 분석하거나, 최대 30초 구간을 선택하세요.</p>
    <div className="clip-mode-switch" role="group" aria-label="분석 범위"><button type="button" aria-pressed={selection === 'full'} disabled={source.duration > 60} onClick={() => { setSelection('full'); video.current?.pause(); }}>전체 영상 분석<small>최대 60초 · 장면별 편집</small></button><button type="button" aria-pressed={selection === 'clip'} onClick={() => { setSelection('clip'); video.current?.pause(); }}>구간 선택<small>최대 30초</small></button></div>
    <div className="clip-source-name" title={source.file.name}><Film size={13} /><span>{source.file.name}</span><small>{source.width} × {source.height}</small></div>
    <div className="clip-video-frame"><video ref={video} src={source.url} aria-label="분석 구간 원본 미리보기" controls muted playsInline preload="metadata" onPause={() => setPreviewing(false)} onError={() => setPlaybackError(true)} onTimeUpdate={event => { if (previewing && event.currentTarget.currentTime >= end) { event.currentTarget.pause(); setPreviewing(false); } }} /></div>
    {playbackError && <p className="clip-playback-error" role="status">브라우저에서 이 영상의 미리보기를 재생하지 못했습니다. 시간을 입력해 분석을 진행할 수 있습니다.</p>}
    {selection === 'clip' && <div className="clip-range-fields"><label className="field"><span>시작 시간</span><div className="field-input"><input ref={startInput} aria-label="분석 시작 시간" type="number" min={0} max={source.duration} step={0.1} value={startValue} onChange={event => { setStartValue(event.target.value); video.current?.pause(); }} /><small>초</small></div></label><span className="clip-range-separator">→</span><label className="field"><span>종료 시간</span><div className="field-input"><input aria-label="분석 종료 시간" type="number" min={0.2} max={source.duration} step={0.1} value={endValue} onChange={event => { setEndValue(event.target.value); video.current?.pause(); }} /><small>초</small></div></label><div className={`clip-duration ${valid ? '' : 'invalid'}`}><span>선택 길이</span><strong>{Number.isFinite(selectedDuration) && startValue && endValue ? Math.max(0, selectedDuration).toFixed(1) : '—'}<small>초</small></strong></div></div>}
    <div className="clip-range-summary" aria-live="polite">{validation ? <p className="clip-validation">{validation}</p> : selection === 'full' ? <p><strong>전체 {source.duration.toFixed(3)}초</strong>를 장면별로 나누어 하나의 타임라인으로 만듭니다. 장면을 이동하며 문구와 요소를 수정할 수 있습니다.</p> : <p><strong>원본 {start.toFixed(1)}–{end.toFixed(1)}초</strong> 구간을 0초부터 시작하는 프로젝트로 만듭니다.</p>}</div>
    <AnalysisQualitySelector value={quality} onChange={onQualityChange} />
    <div className="clip-dialog-actions"><button className="button quiet" aria-label="선택 구간 미리보기" disabled={!valid} onClick={() => void preview()}><Play size={12} />{selection === 'full' ? '전체 미리보기' : '구간 미리보기'}</button><div><button className="button" aria-label="구간 선택 취소" onClick={onCancel}>취소</button><button className="button primary" aria-label={selection === 'full' ? '전체 영상 분석하기' : '선택 구간 분석하기'} disabled={!valid} onClick={() => { video.current?.pause(); onConfirm(selection === 'full' ? {} : { clipStart: start, clipEnd: end }); }}><Scissors size={13} />{selection === 'full' ? '전체 영상 분석하기' : '선택 구간 분석하기'}</button></div></div>
  </div></div>;
}
