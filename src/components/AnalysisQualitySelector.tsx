import { useId } from 'react';
import { ScanLine, Zap } from 'lucide-react';
import type { AnalysisQuality } from '../api';

export function AnalysisQualitySelector({ value, onChange, disabled = false }: { value: AnalysisQuality; onChange: (value: AnalysisQuality) => void; disabled?: boolean }) {
  const id = useId();
  return <fieldset className="quality-selector" disabled={disabled} aria-describedby={`${id}-description`}>
    <legend>분석 품질</legend>
    <div className="quality-options">
      <label className={value === 'standard' ? 'selected' : ''}><input type="radio" name={id} aria-label="빠른 분석" value="standard" checked={value === 'standard'} onChange={() => onChange('standard')} /><Zap size={12} /><span>빠른 분석</span></label>
      <label className={value === 'high' ? 'selected' : ''}><input type="radio" name={id} aria-label="정밀 분석" value="high" checked={value === 'high'} onChange={() => onChange('high')} /><ScanLine size={12} /><span>정밀 분석</span></label>
    </div>
    <p id={`${id}-description`}>{value === 'high' ? '더 세밀한 윤곽·음영, 분석 시간과 파일 크기 증가' : '텍스트와 단순 도형을 빠르게 재구성'}</p>
  </fieldset>;
}
