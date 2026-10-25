import type { MotionComposition, MotionDocument, MotionNode, MotionProject } from '../types';
import { validateProject, validateComposition, decodeSegment, encodeSegment, MAX_DOCUMENT_BYTES } from '../engine';
import { deserializeDocument, serializeDocument } from './projectStorage';

export const PROJECT_STORAGE_KEY = 'frame-form.project.v1';
const BACKUP_KEY = `${PROJECT_STORAGE_KEY}.last-good`;
const JOURNAL_KEY = `${PROJECT_STORAGE_KEY}.journal`;
const POINTER_PREFIX = 'frameform:idb:v1:';
const DATABASE = 'frameform-projects';
const SNAPSHOTS = 'snapshots';
const LOCAL_CHARACTER_LIMIT = 2_000_000;
const JOURNAL_CHARACTER_LIMIT = 200_000;
interface Pointer { revision: string; previousRevision?: string }
export interface InitialSave { project?: MotionDocument; pointer?: Pointer }
export interface SaveResult { kind: 'local' | 'database'; revision?: string }
export interface RestoreResult { project: MotionDocument; baseProject: MotionDocument; revision?: string; recoveredJournal: boolean; warning?: string; recoveredChunk?: { segmentId: string; project: MotionProject; baseProject: MotionProject } }
let databasePromise: Promise<IDBDatabase> | undefined;

function pointerFrom(value: string | null): Pointer | undefined {
  if (!value?.startsWith(POINTER_PREFIX)) return;
  const pointer = JSON.parse(value.slice(POINTER_PREFIX.length)) as Pointer;
  if (typeof pointer.revision !== 'string' || pointer.revision.length > 100 || pointer.previousRevision !== undefined && (typeof pointer.previousRevision !== 'string' || pointer.previousRevision.length > 100)) throw new Error('저장 위치 정보가 손상됐습니다.');
  return pointer;
}

export function readInitialSave(): InitialSave {
  try {
    const value = localStorage.getItem(PROJECT_STORAGE_KEY);
    const pointer = pointerFrom(value);
    if (pointer) return { pointer };
    if (value) return { project: deserializeDocument(value) };
  } catch { /* Preserve malformed data until the user makes a new edit. */ }
  return {};
}

function database(): Promise<IDBDatabase> {
  if (!databasePromise) databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(SNAPSHOTS)) request.result.createObjectStore(SNAPSHOTS); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); databasePromise = undefined; }; resolve(request.result); };
    request.onerror = () => reject(request.error || new Error('브라우저 저장소를 열 수 없습니다.'));
    request.onblocked = () => reject(new Error('다른 탭이 저장소 갱신을 막고 있습니다. 다른 편집기 탭을 닫고 다시 시도해 주세요.'));
  }).catch(error => { databasePromise = undefined; throw error; });
  return databasePromise;
}

async function readSnapshot(revision: string): Promise<string> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(SNAPSHOTS, 'readonly').objectStore(SNAPSHOTS).get(revision);
    request.onsuccess = () => {
      if (typeof request.result === 'string') resolve(request.result);
      else if (request.result instanceof Blob && request.result.size <= MAX_DOCUMENT_BYTES) void request.result.text().then(resolve, reject);
      else reject(new Error('저장된 프로젝트를 찾을 수 없거나 허용 크기를 넘습니다.'));
    };
    request.onerror = () => reject(request.error);
  });
}

async function writeSnapshots(records: { revision: string; value: string }[]): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SNAPSHOTS, 'readwrite');
    // Chromium rejects an inline IndexedDB value above about 127 MiB even when
    // the origin has ample quota. Blobs use the database's external byte storage.
    records.forEach(record => transaction.objectStore(SNAPSHOTS).put(record.value.length > 32 * 1024 * 1024 ? new Blob([record.value], { type: 'text/plain;charset=utf-8' }) : record.value, record.revision));
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('브라우저 저장 공간이 부족합니다.'));
  });
}

async function pruneSnapshots(keep: Set<string>): Promise<void> {
  try {
    const db = await database();
    const transaction = db.transaction(SNAPSHOTS, 'readwrite');
    const store = transaction.objectStore(SNAPSHOTS);
    const request = store.openKeyCursor();
    request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if (typeof cursor.key === 'string' && !keep.has(cursor.key)) store.delete(cursor.key); cursor.continue(); };
  } catch { /* Cleanup never invalidates a successful snapshot. */ }
}

const pendingRevisions = new Set<string>();

/** Commit the small pointer only after the full database transaction succeeds. */
export async function saveBrowserProject(project: MotionDocument, isCurrent: () => boolean, lastGoodRevision?: string): Promise<SaveResult | undefined> {
  const serialized = serializeDocument(project);
  if (!isCurrent()) return;
  if (project.schemaVersion === 1 && serialized.length <= LOCAL_CHARACTER_LIMIT) {
    try {
      localStorage.setItem(PROJECT_STORAGE_KEY, serialized);
      localStorage.removeItem(JOURNAL_KEY);
      return { kind: 'local' };
    } catch { /* Retry the same data in the roomier database. */ }
  }
  const previousValue = localStorage.getItem(PROJECT_STORAGE_KEY);
  let previousPointer: Pointer | undefined;
  try { previousPointer = pointerFrom(previousValue); } catch { /* Invalid old metadata cannot become the fallback. */ }
  const revision = `${Date.now()}-${crypto.randomUUID()}`;
  const previousRevision = lastGoodRevision ?? previousPointer?.revision ?? (previousValue && !previousValue.startsWith(POINTER_PREFIX) ? `${revision}-previous` : undefined);
  pendingRevisions.add(revision);
  if (previousRevision) pendingRevisions.add(previousRevision);
  try {
    await writeSnapshots([{ revision, value: serialized }, ...(!previousPointer && previousRevision && previousValue ? [{ revision: previousRevision, value: previousValue }] : [])]);
    if (!isCurrent()) return;
    localStorage.setItem(PROJECT_STORAGE_KEY, POINTER_PREFIX + JSON.stringify({ revision, previousRevision }));
    if (previousValue && !previousPointer) {
      try { localStorage.setItem(BACKUP_KEY, previousValue); } catch { /* A copy also exists in the previous database revision. */ }
    }
    localStorage.removeItem(JOURNAL_KEY);
    const keep = new Set([...pendingRevisions, revision, ...(previousRevision ? [previousRevision] : [])]);
    void pruneSnapshots(keep);
    return { kind: 'database', revision };
  } finally {
    pendingRevisions.delete(revision);
    if (previousRevision) pendingRevisions.delete(previousRevision);
  }
}

interface FieldPatch { set: Record<string, unknown>; remove: string[]; backgroundMotionMode?: string; foregroundMotionMode?: string }
interface Journal { revision: string; meta: FieldPatch; changed: { id: string; fields: FieldPatch }[]; added: MotionNode[]; removed: string[]; order?: string[] }

function fieldsBetween(before: object, after: object, excluded = new Set<string>()): FieldPatch {
  const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
  const set: Record<string, unknown> = {};
  const modes: Pick<FieldPatch, 'backgroundMotionMode' | 'foregroundMotionMode'> = {};
  for (const key of Object.keys(b)) if (!excluded.has(key) && b[key] !== a[key] && b[key] !== undefined) {
    const previous = a[key], next = b[key];
    // Whole-video region tracks can exceed the small exit journal. A
    // switch changes only its mode, so retain all existing tracks by reference.
    if ((key === 'backgroundMotion' || key === 'foregroundMotion') && previous && next && typeof previous === 'object' && typeof next === 'object' && !Array.isArray(previous) && !Array.isArray(next)) {
      const left = previous as Record<string, unknown>, right = next as Record<string, unknown>;
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      if (typeof right.mode === 'string' && [...keys].every(field => field === 'mode' || left[field] === right[field])) {
        if (right.mode !== left.mode) modes[key === 'backgroundMotion' ? 'backgroundMotionMode' : 'foregroundMotionMode'] = right.mode;
        continue;
      }
    }
    set[key] = b[key];
  }
  return { set, remove: Object.keys(a).filter(key => !excluded.has(key) && (!(key in b) || b[key] === undefined)), ...modes };
}

/** Best-effort synchronous journal for last-moment text and property edits. */
export function writeProjectJournal(base: MotionProject, current: MotionProject, revision: string): boolean {
  try {
    const journal = projectJournal(base, current, revision);
    const value = JSON.stringify(journal);
    if (value.length > JOURNAL_CHARACTER_LIMIT) return false;
    localStorage.setItem(JOURNAL_KEY, value);
    return true;
  } catch { return false; }
}

function applyFields<T extends object>(value: T, fields: FieldPatch): T {
  if (!fields || !fields.set || typeof fields.set !== 'object' || !Array.isArray(fields.remove)) throw new Error('변경 기록이 손상됐습니다.');
  const next = { ...value, ...fields.set } as T & Record<string, unknown>;
  fields.remove.forEach(key => { if (typeof key !== 'string') throw new Error('변경 기록이 손상됐습니다.'); delete next[key]; });
  for (const [key, mode] of [['backgroundMotion', fields.backgroundMotionMode], ['foregroundMotion', fields.foregroundMotionMode]] as const) if (mode !== undefined) {
    const motion = next[key];
    if (typeof mode !== 'string' || !motion || typeof motion !== 'object' || Array.isArray(motion) || Object.hasOwn(fields.set, key) || fields.remove.includes(key)) throw new Error('영역 연결 변경 기록이 손상됐습니다.');
    Object.assign(next, { [key]: { ...motion, mode } });
  }
  return next;
}

/** Retain validated base references so a later small edit produces a small journal. */
function shareUntouchedFields<T extends object>(base: T, validated: T, patch?: FieldPatch): T {
  const next = { ...validated } as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (!(key in base) || Object.hasOwn(patch?.set ?? {}, key) || patch?.remove.includes(key)) continue;
    const mode = key === 'backgroundMotion' ? patch?.backgroundMotionMode : key === 'foregroundMotion' ? patch?.foregroundMotionMode : undefined;
    const original = (base as Record<string, unknown>)[key];
    // A restored mode-only journal must still share the unchanged track array,
    // so another immediate toggle can produce another small journal.
    next[key] = mode !== undefined && original && typeof original === 'object' ? { ...original, mode } : original;
  }
  return next as T;
}

export async function restoreDatabaseProject(pointer: Pointer): Promise<RestoreResult> {
  let base: MotionDocument | undefined;
  let revision = pointer.revision;
  let warning: string | undefined;
  try { base = deserializeDocument(await readSnapshot(revision)); }
  catch {
    warning = '최근 저장을 읽지 못해 이전 저장을 복원했습니다. JSON으로도 백업해 주세요.';
    if (pointer.previousRevision) {
      try { base = deserializeDocument(await readSnapshot(pointer.previousRevision)); revision = pointer.previousRevision; } catch { /* Try the local backup next. */ }
    }
    if (!base) {
      const backup = localStorage.getItem(BACKUP_KEY);
      if (backup) base = deserializeDocument(backup);
    }
    if (!base) throw new Error('저장된 큰 프로젝트를 복원하지 못했습니다. 기존 데이터는 보존되어 있습니다. JSON 백업을 열어 주세요.');
  }
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (raw && raw.length <= JOURNAL_CHARACTER_LIMIT) {
      const journal = JSON.parse(raw) as Journal;
      if (journal.revision === revision) {
        if (base.schemaVersion === 2) {
          const record = journal as unknown as CompositionJournal;
          if (record.kind !== 'composition' || typeof record.segmentId !== 'string') throw new Error('장면 변경 기록이 손상됐습니다.');
          const segment = base.segments.find(item => item.id === record.segmentId);
          if (!segment) throw new Error('변경한 장면을 찾지 못했습니다.');
          const before = await decodeSegment(segment);
          const project = applyProjectJournal(before, record.chunk);
          const updated = await encodeSegment(segment, project);
          const restored = { ...(record.meta ? applyFields(base, record.meta) : base), segments: base.segments.map(item => item.id === segment.id ? updated : item) };
          const validated = validateComposition(restored);
          return { project: { ...shareUntouchedFields(base, validated, record.meta), segments: validated.segments }, baseProject: base, revision, recoveredJournal: true, warning, recoveredChunk: { segmentId: segment.id, project, baseProject: before } };
        }
        return { project: applyProjectJournal(base, journal), baseProject: base, revision, recoveredJournal: true, warning };
      }
    }
  } catch { warning = '마지막 변경 기록이 손상되어 정상 저장된 버전으로 복원했습니다.'; }
  return { project: base, baseProject: base, revision, recoveredJournal: false, warning };
}

function applyProjectJournal(base: MotionProject, journal: Journal): MotionProject {
  const patches = new Map(journal.changed.map(change => [change.id, change.fields]));
  const removed = new Set(journal.removed);
  let nodes = [...base.nodes.filter(node => !removed.has(node.id)).map(node => patches.has(node.id) ? applyFields(node, patches.get(node.id)!) : node), ...journal.added];
  if (journal.order) { const order = new Map(journal.order.map((id, index) => [id, index])); nodes = nodes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)); }
  const validated = validateProject({ ...applyFields(base, journal.meta), nodes });
  const baseNodes = new Map(base.nodes.map(node => [node.id, node]));
  const project = shareUntouchedFields(base, validated, journal.meta);
  project.nodes = validated.nodes.map(node => {
    const before = baseNodes.get(node.id);
    if (!before) return node;
    const patch = patches.get(node.id);
    return patch ? shareUntouchedFields(before, node, patch) : before;
  });
  return project;
}

function projectJournal(base: MotionProject, current: MotionProject, revision: string): Journal {
  const oldNodes = new Map(base.nodes.map(node => [node.id, node]));
  const currentIds = new Set(current.nodes.map(node => node.id));
  const changed: Journal['changed'] = [], added: MotionNode[] = [];
  for (const node of current.nodes) {
    const before = oldNodes.get(node.id);
    if (!before) added.push(node);
    else if (before !== node) changed.push({ id: node.id, fields: fieldsBetween(before, node) });
  }
  const journal: Journal = { revision, meta: fieldsBetween(base, current, new Set(['nodes'])), changed, added, removed: base.nodes.filter(node => !currentIds.has(node.id)).map(node => node.id) };
  if (base.nodes.length !== current.nodes.length || current.nodes.some((node, index) => base.nodes[index]?.id !== node.id)) journal.order = current.nodes.map(node => node.id);
  return journal;
}

interface CompositionJournal { kind: 'composition'; revision: string; segmentId: string; chunk: Journal; meta?: FieldPatch }
/** Only journal the active chunk when every other saved chunk still matches. */
export function writeCompositionJournal(base: MotionComposition, current: MotionComposition, baseChunk: MotionProject, currentChunk: MotionProject, segmentId: string, revision: string): boolean {
  try {
    if (base.id !== current.id || base.segments.length !== current.segments.length || base.segments.some((segment, index) => segment.id !== current.segments[index]?.id || segment.id !== segmentId && segment.data !== current.segments[index].data)) return false;
    const record: CompositionJournal = { kind: 'composition', revision, segmentId, chunk: projectJournal(baseChunk, currentChunk, revision), meta: fieldsBetween(base, current, new Set(['segments'])) };
    const value = JSON.stringify(record);
    if (value.length > JOURNAL_CHARACTER_LIMIT) return false;
    localStorage.setItem(JOURNAL_KEY, value);
    return true;
  } catch { return false; }
}
