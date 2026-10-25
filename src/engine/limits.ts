/** The UTF-8 JSON limit shared by imports, browser storage and file exports. */
/** Shared with server/budgets.py to bound editable project size. */
export const MAX_PROJECT_NODES = 8000;
export const MAX_PROJECT_BYTES = 96 * 1024 * 1024;
/** Compressed schema 2 container, including base64 and JSON overhead. */
export const MAX_DOCUMENT_BYTES = 256 * 1024 * 1024;

/** Count UTF-8 without allocating a second, potentially 96 MiB byte buffer. */
export function assertProjectJsonSize(json: string): void {
  let bytes = json.length;
  const fail = () => { throw new Error('프로젝트 JSON은 UTF-8 기준 96MB 이하여야 합니다.'); };
  if (bytes > MAX_PROJECT_BYTES) fail();
  for (const match of json.matchAll(/[^\x00-\x7f]/gu)) {
    const code = match[0].codePointAt(0)!;
    // A surrogate pair already contributes two UTF-16 units to json.length.
    bytes += code > 0xffff ? 2 : code > 0x7ff ? 2 : 1;
    if (bytes > MAX_PROJECT_BYTES) fail();
  }
}
