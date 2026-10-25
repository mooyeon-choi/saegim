import { useEffect, useState } from 'react';

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  suffix?: string;
}

export function NumberField({ label, value, onChange, min = -65536, max = 65536, step = 1, disabled, suffix }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(Math.round(value * 1000) / 1000));
  useEffect(() => { setDraft(String(Math.round(value * 1000) / 1000)); }, [value]);
  const commit = () => {
    let next = Number(draft);
    if (!draft.trim() || !Number.isFinite(next)) { setDraft(String(value)); return; }
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return <label className="field"><span>{label}</span><div className="field-input"><input data-testid={label === 'X 위치' ? 'node-x-input' : undefined} aria-label={label} type="number" value={draft} min={min} max={max} step={step} disabled={disabled} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />{suffix && <small>{suffix}</small>}</div></label>;
}

export function TextField({ label, value, onChange, disabled, multiline = false }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; multiline?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { if (draft !== value) onChange(draft); };
  return <label className="field"><span>{label}</span>{multiline ? <textarea data-testid={label === '텍스트' ? 'node-text-input' : undefined} aria-label={label} rows={3} maxLength={10000} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} onBlur={commit} /> : <input aria-label={label} maxLength={label === '글꼴' ? 300 : 1000} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />}</label>;
}

export function ColorField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const isHex = /^#[0-9a-f]{6}$/i.test(draft);
  return <label className="field"><span>{label}</span><div className="color-field"><input aria-label={`${label} 선택`} type="color" value={isHex ? draft : '#000000'} disabled={disabled} onChange={event => { setDraft(event.target.value); onChange(event.target.value); }} /><input aria-label={`${label} 값`} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} onBlur={() => { if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(draft) || draft === 'none' || draft === 'transparent') onChange(draft); else setDraft(value); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></div></label>;
}
