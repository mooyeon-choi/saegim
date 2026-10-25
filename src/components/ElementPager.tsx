import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { MotionKeyframe } from '../types';

export const ELEMENT_PAGE_SIZE = 100;
export function timelineMarkers(keyframes: MotionKeyframe[]): MotionKeyframe[] {
  if (keyframes.length <= 40) return keyframes;
  return Array.from({ length: 40 }, (_, index) => keyframes[Math.round(index * (keyframes.length - 1) / 39)]);
}

export function ElementPager({ page, count, onChange, timeline = false }: { page: number; count: number; onChange: (page: number) => void; timeline?: boolean }) {
  const pages = Math.max(1, Math.ceil(count / ELEMENT_PAGE_SIZE));
  if (pages <= 1) return null;
  const prefix = timeline ? '타임라인 ' : '';
  return <div className={`element-pager ${timeline ? 'timeline-pager' : ''}`}>
    <span>{page * ELEMENT_PAGE_SIZE + 1}–{Math.min(count, (page + 1) * ELEMENT_PAGE_SIZE)} <small>/ {count}</small></span>
    <div><button className="icon-button" aria-label={`${prefix}이전 요소 페이지`} disabled={page === 0} onClick={() => onChange(page - 1)}><ChevronLeft size={13} /></button><span aria-label={`${prefix}요소 페이지`}>{page + 1} / {pages}</span><button className="icon-button" aria-label={`${prefix}다음 요소 페이지`} disabled={page >= pages - 1} onClick={() => onChange(page + 1)}><ChevronRight size={13} /></button></div>
  </div>;
}
