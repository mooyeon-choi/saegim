import type { AnalysisJob } from './types';

export type AnalysisQuality = 'standard' | 'high';

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `요청을 처리하지 못했습니다 (${response.status}).`;
    try { const body = await response.json(); detail = typeof body.detail === 'string' ? body.detail : body.error || detail; } catch { /* preserve status */ }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function analyzeVideo(file: File, options: { sampleFps?: number; signal?: AbortSignal; clipStart?: number; clipEnd?: number; quality?: AnalysisQuality } = {}): Promise<AnalysisJob> {
  const form = new FormData();
  form.append('file', file);
  form.append('quality', options.quality ?? 'standard');
  if (options.sampleFps) form.append('sample_fps', String(options.sampleFps));
  if (options.clipStart !== undefined) form.append('clip_start', String(options.clipStart));
  if (options.clipEnd !== undefined) form.append('clip_end', String(options.clipEnd));
  try {
    return await readResponse<AnalysisJob>(await fetch('/api/analyze', { method: 'POST', body: form, signal: options.signal }));
  } catch (error) {
    if (error instanceof TypeError) throw new Error('분석 서버에 연결할 수 없습니다. npm run dev로 앱을 실행해 주세요.');
    throw error;
  }
}
export async function getJob(id: string): Promise<AnalysisJob> {
  return readResponse(await fetch(`/api/jobs/${encodeURIComponent(id)}`));
}
export async function cancelJob(id: string): Promise<AnalysisJob> {
  return readResponse(await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }));
}
export async function getDemoVideo(): Promise<{ url: string; name: string }> {
  return readResponse(await fetch('/api/demo'));
}
