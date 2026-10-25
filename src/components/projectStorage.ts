import { strToU8, Unzlib, zlibSync } from 'fflate';
import { MAX_PROJECT_BYTES, MAX_DOCUMENT_BYTES, validateProject, validateDocument } from '../engine';
import type { MotionDocument, MotionProject } from '../types';

export const COMPRESSED_PROJECT_PREFIX = 'frameform:zlib:v1:';
export { MAX_PROJECT_BYTES } from '../engine';
const COMPRESSION_THRESHOLD = 1_000_000;
const MAX_ENCODED_LENGTH = Math.ceil((MAX_PROJECT_BYTES + 65_536) / 3) * 4;
const INFLATE_INPUT_CHUNK = 4096;

function sizeError(): Error { return new Error('프로젝트 저장 데이터는 압축 해제 후 96MB 이하여야 합니다.'); }

function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 32_768) parts.push(String.fromCharCode(...bytes.subarray(index, index + 32_768)));
  return btoa(parts.join(''));
}

function decodeBase64(value: string): Uint8Array {
  if (value.length > MAX_ENCODED_LENGTH) throw sizeError();
  if (!value.length || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('압축 프로젝트의 Base64 형식이 잘못됐습니다.');
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

function inflateBounded(compressed: Uint8Array): Uint8Array {
  if (compressed.length < 6) throw new Error('압축 프로젝트가 손상됐습니다.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  let adlerA = 1;
  let adlerB = 0;
  const inflater = new Unzlib(chunk => {
    total += chunk.length;
    if (total > MAX_PROJECT_BYTES) throw sizeError();
    chunks.push(chunk);
    // fflate decodes zlib without checking its Adler-32 trailer; verify it here.
    for (let offset = 0; offset < chunk.length; offset += 5552) {
      const end = Math.min(offset + 5552, chunk.length);
      for (let index = offset; index < end; index++) { adlerA += chunk[index]; adlerB += adlerA; }
      adlerA %= 65521;
      adlerB %= 65521;
    }
  });
  // Feed bounded compressed chunks so an expanding stream is rejected before it
  // can allocate its entire output, instead of inflating an untrusted blob at once.
  for (let offset = 0; offset < compressed.length; offset += INFLATE_INPUT_CHUNK) {
    inflater.push(compressed.subarray(offset, offset + INFLATE_INPUT_CHUNK), offset + INFLATE_INPUT_CHUNK >= compressed.length);
  }
  const expected = new DataView(compressed.buffer, compressed.byteOffset + compressed.length - 4, 4).getUint32(0);
  if ((((adlerB << 16) | adlerA) >>> 0) !== expected) throw new Error('압축 프로젝트의 무결성 검사에 실패했습니다.');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function serializeProject(project: MotionProject): string {
  const json = JSON.stringify(project);
  if (json.length > MAX_PROJECT_BYTES) throw sizeError();
  const bytes = strToU8(json);
  if (bytes.length > MAX_PROJECT_BYTES) throw sizeError();
  if (json.length <= COMPRESSION_THRESHOLD) return json;
  return COMPRESSED_PROJECT_PREFIX + encodeBase64(zlibSync(bytes, { level: 6 }));
}

export function deserializeProject(stored: string): MotionProject {
  let json: string;
  if (stored.startsWith(COMPRESSED_PROJECT_PREFIX)) {
    const bytes = inflateBounded(decodeBase64(stored.slice(COMPRESSED_PROJECT_PREFIX.length)));
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } else {
    if (stored.length > MAX_PROJECT_BYTES || strToU8(stored).length > MAX_PROJECT_BYTES) throw sizeError();
    json = stored;
  }
  return validateProject(JSON.parse(json));
}

/** Segment payloads are already compressed; avoid recompressing the whole book. */
export function serializeDocument(document: MotionDocument): string {
  if (document.schemaVersion === 1) return serializeProject(document);
  const json = JSON.stringify(document);
  if (json.length > MAX_DOCUMENT_BYTES || strToU8(json).length > MAX_DOCUMENT_BYTES) throw new Error('전체 영상 프로젝트는 256MB 이하여야 합니다.');
  return json;
}

export function deserializeDocument(stored: string): MotionDocument {
  if (stored.startsWith(COMPRESSED_PROJECT_PREFIX)) return deserializeProject(stored);
  if (stored.length > MAX_DOCUMENT_BYTES || strToU8(stored).length > MAX_DOCUMENT_BYTES) throw new Error('전체 영상 프로젝트는 256MB 이하여야 합니다.');
  const parsed: unknown = JSON.parse(stored);
  if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed && parsed.schemaVersion === 2) return validateDocument(parsed);
  if (stored.length > MAX_PROJECT_BYTES || strToU8(stored).length > MAX_PROJECT_BYTES) throw sizeError();
  return validateProject(parsed);
}
