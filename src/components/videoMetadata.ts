export interface VideoMetadata { duration: number; width: number; height: number }

/** Inspect a local object URL without uploading or retaining a decoder. */
export function readVideoMetadata(url: string, signal: AbortSignal): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;
    const timeout = window.setTimeout(() => fail(new Error('영상 정보를 읽는 데 시간이 초과됐습니다. 다른 파일을 선택해 주세요.')), 15_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const aborted = () => fail(new DOMException('영상 정보 확인이 취소됐습니다.', 'AbortError'));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      if (settled) return;
      if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
        fail(new Error('영상 길이나 화면 크기를 읽을 수 없습니다. 재생 가능한 MP4, WebM, MOV 파일을 선택해 주세요.'));
        return;
      }
      const metadata = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
      settled = true;
      cleanup();
      resolve(metadata);
    };
    video.onerror = () => fail(new Error('영상 정보를 읽을 수 없습니다. 파일이 손상됐거나 브라우저가 지원하지 않는 형식일 수 있습니다.'));
    video.src = url;
  });
}
