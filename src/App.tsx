import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { ArrowDownToLine, ArrowLeftRight, ArrowUpRight, Braces, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, CircleAlert, Code2, Copy, Eye, EyeOff, FileJson, Film, Focus, Layers2, LoaderCircle, LockKeyhole, Maximize2, MousePointer2, Pause, Play, Plus, Redo2, RotateCcw, Search, Settings2, SkipBack, SkipForward, Square, Trash2, Type, Undo2, UnlockKeyhole, Upload, WandSparkles, X } from 'lucide-react';
import type { AnalysisJob, MotionComposition, MotionDocument, MotionNode, MotionProject, MotionTemporal, NodeType } from './types';
import { analyzeVideo, cancelJob, getDemoVideo, getJob } from './api';
import type { AnalysisQuality } from './api';
import { createDemoProject } from './demo';
import { createProjectRenderer, createCompositionPlayer, decodeSegment, encodeSegment, getFrameTime, MAX_DOCUMENT_BYTES, MAX_PROJECT_NODES, parseDocument, validateDocument, downloadHtml, downloadProject, downloadZip } from './engine';
import { ColorField, NumberField, TextField } from './components/Fields';
import { onCanvas, selectionTime, similarFillIds, withSolidFill } from './components/editorUtils';
import { ClipSelectionDialog, type ClipRange, type PendingVideo } from './components/ClipSelectionDialog';
import { readVideoMetadata } from './components/videoMetadata';
import { readInitialSave, restoreDatabaseProject, saveBrowserProject, writeProjectJournal, writeCompositionJournal } from './components/browserProjectStore';
import { AnalysisQualitySelector } from './components/AnalysisQualitySelector';
import { hasTextWarp, PerspectiveTextNotice, PerspectiveTextPanel } from './components/PerspectiveTextPanel';
import { loadTextFont, measureTextBox, textFont, textMetricSignature, TEXT_REFIT_FIELDS } from './components/textMetrics';
import { ELEMENT_PAGE_SIZE, ElementPager, timelineMarkers } from './components/ElementPager';
import { TemporalPreview, type PreviewBackgroundStatus, type PreviewForegroundStatus } from './components/TemporalPreview';
import { BackgroundMotionControl, backgroundRegions } from './components/BackgroundMotionControl';
import { MotionConnectionControls, foregroundRegions } from './components/MotionConnectionControls';

type CompareMode = 'split' | 'render' | 'overlay' | 'difference';
type MobilePanel = 'layers' | 'inspector' | null;
const NODE_LABELS: Record<NodeType, string> = { rect: '사각형', ellipse: '타원', path: '벡터', text: '텍스트', line: '선' };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const formatTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}.${Math.floor((seconds % 1) * 100).toString().padStart(2, '0')}`;
const preferredNode = (project: MotionProject) => project.nodes.find(node => node.type === 'text' && hasTextWarp(node)) ?? project.nodes.find(node => node.type === 'text') ?? project.nodes[0];

function NodeIcon({ type, size = 15 }: { type: NodeType; size?: number }) {
  if (type === 'text') return <Type size={size} />;
  if (type === 'ellipse') return <Circle size={size} />;
  if (type === 'rect') return <Square size={size} />;
  if (type === 'line') return <span className="line-glyph" aria-hidden="true">╱</span>;
  return <WandSparkles size={size} />;
}

export default function App() {
  const [initialSave] = useState(readInitialSave);
  const [project, setProject] = useState<MotionProject>(() => initialSave.project?.schemaVersion === 1 ? initialSave.project : createDemoProject());
  const [composition, setComposition] = useState<MotionComposition | null>(initialSave.project?.schemaVersion === 2 ? initialSave.project : null);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [chunkLoading, setChunkLoading] = useState(false);
  const [restoring, setRestoring] = useState(Boolean(initialSave.pointer || initialSave.project?.schemaVersion === 2));
  const [time, setTime] = useState(0.8);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => preferredNode(project)?.id);
  const [mode, setMode] = useState<CompareMode>('split');
  const [onion, setOnion] = useState(false);
  const [showOcclusion, setShowOcclusion] = useState(false);
  const [previewBackgroundStatus, setPreviewBackgroundStatus] = useState<PreviewBackgroundStatus | undefined>();
  const [previewForegroundStatus, setPreviewForegroundStatus] = useState<PreviewForegroundStatus | undefined>();
  const [preserveAspect, setPreserveAspect] = useState(true);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [analysisQuality, setAnalysisQuality] = useState<AnalysisQuality>('standard');
  const [runningQuality, setRunningQuality] = useState<AnalysisQuality>('standard');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saveState, setSaveState] = useState('이 브라우저에 저장됨');
  const [storageError, setStorageError] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [elementSearch, setElementSearch] = useState('');
  const [currentOnly, setCurrentOnly] = useState(false);
  const [textOnly, setTextOnly] = useState(false);
  const [elementPage, setElementPage] = useState(0);
  const [showBulkFill, setShowBulkFill] = useState(false);
  const [bulkFill, setBulkFill] = useState('#c9f68b');
  const [showWarnings, setShowWarnings] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  const [sourceError, setSourceError] = useState(false);
  const [pendingVideo, setPendingVideo] = useState<PendingVideo | null>(null);
  const [stageBounds, setStageBounds] = useState({ width: 700, height: 320 });
  const undoStack = useRef<MotionProject[]>([]);
  const redoStack = useRef<MotionProject[]>([]);
  const projectRef = useRef(project);
  const compositionRef = useRef(composition);
  const activeSegmentRef = useRef<string | null>(null);
  const playerRef = useRef<ReturnType<typeof createCompositionPlayer> | null>(null);
  const chunkDirty = useRef(false);
  const chunkLoadingRef = useRef(false);
  const previewPendingRef = useRef(false);
  const previewOverride = useRef<{ player: ReturnType<typeof createCompositionPlayer>; project: MotionProject } | null>(null);
  const navigationVersion = useRef(0);
  const loadTimeRef = useRef<(next: number) => Promise<void>>(async () => {});
  const savedDocument = useRef<MotionDocument>(initialSave.project ?? project);
  const savedActiveChunk = useRef<{ segmentId: string; project: MotionProject; revision: string } | null>(null);
  const projectContext = useRef(0);
  const pendingTextFits = useRef(new Map<string, { token: number; task: Promise<void> }>());
  const textFitSequence = useRef(0);
  const pendingEncode = useRef<{ project: MotionProject; promise: Promise<MotionComposition> } | null>(null);
  const openingProject = useRef<MotionProject | null>(project);
  const dirtyProject = useRef(!initialSave.pointer && initialSave.project?.schemaVersion !== 2);
  const restoringRef = useRef(Boolean(initialSave.pointer || initialSave.project?.schemaVersion === 2));
  const editRevision = useRef(0);
  const saveGeneration = useRef(0);
  const savedProject = useRef(project);
  const savedRevision = useRef<string | undefined>(initialSave.pointer?.revision);
  const restoration = useRef<ReturnType<typeof restoreDatabaseProject> | null>(null);
  const timeRef = useRef(time);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const dragCount = useRef(0);
  const activeRequest = useRef(0);
  const importRequest = useRef(0);
  const mountedRef = useRef(true);
  const requestPhase = useRef<'idle' | 'preparing' | 'metadata' | 'uploading' | 'polling'>('idle');
  const metadataAbort = useRef<AbortController | null>(null);
  const pendingVideoRef = useRef<PendingVideo | null>(null);
  const currentJobId = useRef<string | null>(null);
  const busyRef = useRef(false);
  const cancelledRequest = useRef(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const stagesRef = useRef<HTMLDivElement>(null);
  const layerListRef = useRef<HTMLDivElement>(null);
  const timelineTracksRef = useRef<HTMLDivElement>(null);
  const preparedFrame = useRef<{ project: MotionProject; renderer: ReturnType<typeof createProjectRenderer> } | null>(null);
  const renderProject = useMemo(() => preparedFrame.current?.project === project ? preparedFrame.current.renderer : createProjectRenderer(project), [project]);
  const activeSegment = composition?.segments.find(segment => segment.id === activeSegmentId);
  const segmentOffset = activeSegment?.start ?? 0;
  const documentDuration = composition?.duration ?? project.duration;
  const temporal = composition?.temporal ?? (!composition ? project.temporal : undefined);
  const localTime = clamp(getFrameTime(temporal, documentDuration, time) - segmentOffset, 0, project.duration);
  const backgroundMotion = composition?.backgroundMotion ?? (!composition ? project.backgroundMotion : undefined);
  const foregroundMotion = composition?.foregroundMotion ?? (!composition ? project.foregroundMotion : undefined);
  const backgroundSections = useMemo(() => backgroundMotion ? backgroundRegions(backgroundMotion, documentDuration, temporal?.cuts ?? []) : [], [backgroundMotion, documentDuration, temporal]);
  const activeBackgroundSection = backgroundSections.find((section, index) => time >= section.start && (time < section.end || index === backgroundSections.length - 1));
  const foregroundSections = useMemo(() => foregroundMotion ? foregroundRegions(foregroundMotion, documentDuration, temporal?.cuts ?? []) : [], [foregroundMotion, documentDuration, temporal]);
  const activeForegroundSection = foregroundSections.find((section, index) => time >= section.start && (time < section.end || index === foregroundSections.length - 1));
  const smoothingAvailable = !composition || Boolean(composition.temporal);
  const documentSource = composition?.source ?? project.source;
  const navigationScenes = composition?.segments ?? project.scenes;
  const currentSceneIndex = navigationScenes.findIndex((scene, index) => time >= scene.start && (time < scene.end || index === navigationScenes.length - 1));
  const selected = useMemo(() => project.nodes.find(node => node.id === selectedId), [project.nodes, selectedId]);
  const busy = starting || job?.status === 'queued' || job?.status === 'processing';
  const warnings = composition?.analysis?.warnings ?? project.analysis?.warnings ?? [];
  const reviewCount = useMemo(() => project.nodes.filter(node => node.evidence?.needsReview).length, [project.nodes]);
  const searchedNodes = useMemo(() => {
    const query = elementSearch.trim().toLocaleLowerCase();
    return project.nodes.map((node, index) => ({ node, index })).filter(({ node }) => (!textOnly || node.type === 'text') && (!query || `${node.name} ${node.text ?? ''}`.toLocaleLowerCase().includes(query)));
  }, [project.nodes, elementSearch, textOnly]);
  const filteredNodes = useMemo(() => currentOnly ? searchedNodes.filter(({ node }) => onCanvas(node, localTime, project, renderProject.evaluate)) : searchedNodes, [searchedNodes, currentOnly, localTime, project, renderProject]);
  const pageCount = Math.max(1, Math.ceil(filteredNodes.length / ELEMENT_PAGE_SIZE));
  const visiblePage = Math.min(elementPage, pageCount - 1);
  const pagedNodes = filteredNodes.slice(visiblePage * ELEMENT_PAGE_SIZE, (visiblePage + 1) * ELEMENT_PAGE_SIZE);
  const selectedFilteredIndex = filteredNodes.findIndex(({ node }) => node.id === selectedId);
  useEffect(() => { if (selectedFilteredIndex >= 0) setElementPage(Math.floor(selectedFilteredIndex / ELEMENT_PAGE_SIZE)); }, [selectedId, selectedFilteredIndex]);
  useEffect(() => { setElementPage(selectedFilteredIndex < 0 ? 0 : Math.floor(selectedFilteredIndex / ELEMENT_PAGE_SIZE)); }, [elementSearch, currentOnly, textOnly]);
  useEffect(() => { setElementPage(page => Math.min(page, pageCount - 1)); }, [pageCount]);
  useEffect(() => {
    layerListRef.current?.querySelector('.layer-row.selected')?.scrollIntoView({ block: 'nearest' });
    timelineTracksRef.current?.querySelector('.timeline-track.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, visiblePage]);
  const changeElementPage = (page: number) => {
    setElementPage(page);
    if (layerListRef.current) layerListRef.current.scrollTop = 0;
    if (timelineTracksRef.current) timelineTracksRef.current.parentElement!.scrollTop = 0;
  };
  const similarIds = useMemo(() => selected ? similarFillIds(project.nodes, selected.fill) : new Set<string>(), [project.nodes, selected?.fill]);

  useEffect(() => { setShowBulkFill(false); setShowOcclusion(false); setPreserveAspect(true); }, [selectedId]);
  useEffect(() => { if (selected) setBulkFill(selected.fill); }, [selectedId, selected?.fill]);

  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; activeRequest.current += 1; busyRef.current = false; metadataAbort.current?.abort(); navigationVersion.current++; playerRef.current?.dispose(); if (pendingVideoRef.current) URL.revokeObjectURL(pendingVideoRef.current.url); pendingVideoRef.current = null; };
  }, []);
  useEffect(() => { setSourceError(false); }, [documentSource?.url]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      for (const font of project.fonts ?? []) void document.fonts.load(`${font.style ?? 'normal'} ${font.weight ?? 400} 48px "${font.family}"`, '한글 심포니 ABCDEFG').catch(() => {});
    });
    return () => cancelAnimationFrame(frame);
  }, [project.fonts]);
  useEffect(() => {
    const area = stagesRef.current;
    if (!area) return;
    const observer = new ResizeObserver(entries => { const rect = entries[0].contentRect; setStageBounds({ width: rect.width, height: rect.height }); });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 4500); return () => window.clearTimeout(timer); }, [toast]);
  const flushActiveChunk = useCallback(async (): Promise<MotionDocument> => {
    await Promise.all([...pendingTextFits.current.values()].map(item => item.task));
    const book = compositionRef.current;
    if (!book) return projectRef.current;
    if (!chunkDirty.current || !activeSegmentRef.current) return book;
    const snapshot = projectRef.current;
    if (pendingEncode.current?.project === snapshot) return pendingEncode.current.promise;
    const segment = book.segments.find(item => item.id === activeSegmentRef.current)!;
    const promise = encodeSegment(segment, snapshot).then(encoded => {
      const current = compositionRef.current;
      if (current !== book) return book;
      const next = { ...current, segments: current.segments.map(item => item.id === segment.id ? encoded : item) };
      if (projectRef.current === snapshot && activeSegmentRef.current === segment.id) {
        compositionRef.current = next;
        setComposition(next);
        chunkDirty.current = false;
        playerRef.current?.dispose();
        playerRef.current = createCompositionPlayer(next);
      }
      return next;
    });
    pendingEncode.current = { project: snapshot, promise };
    try { return await promise; } finally { if (pendingEncode.current?.promise === promise) pendingEncode.current = null; }
  }, []);

  const journalCurrent = useCallback(() => {
    if (!savedRevision.current) return false;
    if (!compositionRef.current && savedDocument.current.schemaVersion === 1) return writeProjectJournal(savedProject.current, projectRef.current, savedRevision.current);
    const baseline = savedActiveChunk.current;
    return Boolean(compositionRef.current && savedDocument.current.schemaVersion === 2 && baseline && baseline.segmentId === activeSegmentRef.current && baseline.revision === savedRevision.current && writeCompositionJournal(savedDocument.current, compositionRef.current, baseline.project, projectRef.current, baseline.segmentId, baseline.revision));
  }, []);

  const persistProject = useCallback(async () => {
    if (!dirtyProject.current || restoringRef.current) return;
    const revision = editRevision.current;
    const generation = ++saveGeneration.current;
    const activeSnapshot = projectRef.current;
    const segmentId = activeSegmentRef.current;
    const isCurrent = () => mountedRef.current && editRevision.current === revision && saveGeneration.current === generation;
    journalCurrent();
    try {
      // Keep the schema-1 path synchronous up to localStorage, including page exit.
      const snapshot = compositionRef.current ? await flushActiveChunk() : projectRef.current;
      if (!isCurrent()) return;
      const result = await saveBrowserProject(snapshot, isCurrent, savedRevision.current);
      if (!result || !isCurrent()) return;
      dirtyProject.current = false;
      savedProject.current = activeSnapshot;
      savedDocument.current = snapshot;
      savedRevision.current = result.revision;
      savedActiveChunk.current = segmentId && result.revision ? { segmentId, project: activeSnapshot, revision: result.revision } : null;
      setSaveState('이 브라우저에 저장됨'); setStorageError(false);
    } catch {
      if (isCurrent()) { setSaveState('자동 저장 불가 · JSON을 내려받으세요'); setStorageError(true); }
    }
  }, [flushActiveChunk, journalCurrent]);

  useEffect(() => {
    if (restoring || !dirtyProject.current) return;
    setSaveState('저장 중');
    const timer = window.setTimeout(persistProject, 450);
    return () => window.clearTimeout(timer);
  }, [project, composition, persistProject, restoring]);

  useEffect(() => {
    if (!initialSave.pointer && initialSave.project?.schemaVersion !== 2) return;
    let active = true;
    const revision = editRevision.current;
    const restore = initialSave.pointer
      ? (restoration.current ??= restoreDatabaseProject(initialSave.pointer))
      : Promise.resolve({ project: initialSave.project!, baseProject: initialSave.project!, revision: undefined, recoveredJournal: false, warning: undefined, recoveredChunk: undefined });
    void restore.then(async result => {
      if (!active || !mountedRef.current || editRevision.current !== revision) return;
      savedDocument.current = result.baseProject;
      savedRevision.current = result.revision;
      dirtyProject.current = result.recoveredJournal;
      let next: MotionProject;
      if (result.project.schemaVersion === 2) {
        const book = result.project;
        const player = createCompositionPlayer(book);
        const frame = await player.seek(0);
        if (!frame || !active || !mountedRef.current || editRevision.current !== revision) { player.dispose(); return; }
        playerRef.current?.dispose(); playerRef.current = player;
        compositionRef.current = book; setComposition(book);
        projectContext.current++;
        activeSegmentRef.current = frame.segment.id; setActiveSegmentId(frame.segment.id);
        next = result.recoveredChunk?.segmentId === frame.segment.id ? result.recoveredChunk.project : frame.project;
        preparedFrame.current = { project: next, renderer: frame.renderer };
        openingProject.current = null;
        setTime(0); timeRef.current = 0;
        if (result.revision && result.baseProject.schemaVersion === 2) {
          const baselineSegment = result.baseProject.segments.find(segment => segment.id === frame.segment.id)!;
          const baseline = result.recoveredChunk?.segmentId === frame.segment.id ? result.recoveredChunk.baseProject : baselineSegment.data === frame.segment.data ? next : await decodeSegment(baselineSegment);
          if (active) savedActiveChunk.current = { segmentId: frame.segment.id, project: baseline, revision: result.revision };
        }
      } else {
        next = result.project;
        openingProject.current = next;
        timeRef.current = Math.min(0.8, next.duration / 2); setTime(timeRef.current);
      }
      if (!active || !mountedRef.current) return;
      projectRef.current = next; savedProject.current = result.baseProject.schemaVersion === 1 ? result.baseProject : next; setProject(next);
      setSelectedId(preferredNode(next)?.id);
      if (result.warning) setError(result.warning);
      else if (result.recoveredJournal) setToast('마지막 편집 내용까지 복원했습니다.');
    }).catch(cause => { if (active && mountedRef.current) setError(cause instanceof Error ? cause.message : '프로젝트를 복원하지 못했습니다.'); }).finally(() => {
      if (active && mountedRef.current) { restoration.current = null; restoringRef.current = false; setRestoring(false); }
    });
    return () => { active = false; };
  }, [initialSave]);

  useEffect(() => {
    const flushOnExit = () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (dirtyProject.current && !restoringRef.current && journalCurrent()) return;
      void persistProject();
    };
    window.addEventListener('pagehide', flushOnExit);
    window.addEventListener('beforeunload', flushOnExit);
    return () => { window.removeEventListener('pagehide', flushOnExit); window.removeEventListener('beforeunload', flushOnExit); };
  }, [persistProject, journalCurrent]);

  const commit = useCallback((update: MotionProject | ((previous: MotionProject) => MotionProject)) => {
    if (restoringRef.current || chunkLoadingRef.current) return;
    const current = projectRef.current;
    const next = typeof update === 'function' ? update(current) : update;
    if (next === current) return;
    undoStack.current = [...undoStack.current.slice(-59), current];
    redoStack.current = [];
    projectRef.current = next;
    dirtyProject.current = true;
    if (compositionRef.current) chunkDirty.current = true;
    editRevision.current += 1;
    setProject(next);
    setHistoryVersion(version => version + 1);
  }, []);

  const undo = useCallback(() => {
    if (restoringRef.current || chunkLoadingRef.current) return;
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(projectRef.current);
    projectRef.current = previous;
    dirtyProject.current = true;
    if (compositionRef.current) chunkDirty.current = true;
    editRevision.current += 1;
    setProject(previous);
    setHistoryVersion(version => version + 1);
  }, []);

  const redo = useCallback(() => {
    if (restoringRef.current || chunkLoadingRef.current) return;
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(projectRef.current);
    projectRef.current = next;
    dirtyProject.current = true;
    if (compositionRef.current) chunkDirty.current = true;
    editRevision.current += 1;
    setProject(next);
    setHistoryVersion(version => version + 1);
  }, []);

  loadTimeRef.current = async (next: number) => {
    const book = compositionRef.current;
    if (!book) return;
    const request = ++navigationVersion.current;
    const at = getFrameTime(book.temporal, book.duration, next);
    const wanted = book.segments.find(segment => segment.end - at > 8 * Number.EPSILON * Math.max(1, Math.abs(at), segment.end)) ?? book.segments[book.segments.length - 1];
    if (wanted.id === activeSegmentRef.current && !chunkLoadingRef.current) return;
    chunkLoadingRef.current = true; setChunkLoading(true);
    try {
      await Promise.all([...pendingTextFits.current.values()].map(item => item.task));
      if (chunkDirty.current) await persistProject();
      if (request !== navigationVersion.current || !mountedRef.current) return;
      // A failed save must not discard the edited scene when navigating away.
      if (chunkDirty.current) await flushActiveChunk();
      if (request !== navigationVersion.current || !mountedRef.current) return;
      playerRef.current ??= createCompositionPlayer(compositionRef.current!);
      const frame = await playerRef.current.seek(next);
      if (!frame || request !== navigationVersion.current || !mountedRef.current) return;
      preparedFrame.current = { project: frame.project, renderer: frame.renderer };
      projectRef.current = frame.project; setProject(frame.project);
      projectContext.current++;
        activeSegmentRef.current = frame.segment.id; setActiveSegmentId(frame.segment.id);
      chunkDirty.current = false;
      openingProject.current = null;
      setSelectedId(preferredNode(frame.project)?.id);
      undoStack.current = []; redoStack.current = []; setHistoryVersion(version => version + 1);
      setElementPage(0);
      const base = savedDocument.current;
      const baseSegment = base.schemaVersion === 2 ? base.segments.find(segment => segment.id === frame.segment.id) : undefined;
      savedActiveChunk.current = savedRevision.current && baseSegment?.data === frame.segment.data ? { segmentId: frame.segment.id, project: frame.project, revision: savedRevision.current } : null;
    } catch (cause) {
      if (request === navigationVersion.current) {
        setError(cause instanceof Error ? cause.message : '장면을 열 수 없습니다.'); setPlaying(false);
        const active = compositionRef.current?.segments.find(segment => segment.id === activeSegmentRef.current);
        if (active) { const safeTime = active.start + Math.min(projectRef.current.duration / 2, 0.8); timeRef.current = safeTime; setTime(safeTime); }
      }
    } finally {
      if (request === navigationVersion.current) { chunkLoadingRef.current = false; setChunkLoading(false); }
    }
  };

  const seek = useCallback((next: number) => {
    const value = clamp(next, 0, compositionRef.current?.duration ?? projectRef.current.duration);
    timeRef.current = value; setTime(value);
    if (compositionRef.current) void loadTimeRef.current(value);
  }, []);

  useEffect(() => {
    if (openingProject.current !== project) return;
    openingProject.current = null;
    const node = preferredNode(project);
    if (node && (timeRef.current < node.start || timeRef.current >= node.end)) seek(selectionTime(node, project, renderProject.evaluate));
  }, [project, renderProject, seek]);

  const selectNode = (node: MotionNode) => {
    if (chunkLoadingRef.current) return;
    setSelectedId(node.id);
    setPlaying(false);
    const offset = compositionRef.current?.segments.find(segment => segment.id === activeSegmentRef.current)?.start ?? 0;
    if (timeRef.current - offset < node.start || timeRef.current - offset >= node.end) seek(offset + selectionTime(node, projectRef.current, renderProject.evaluate));
  };

  const togglePlay = useCallback(() => {
    setPlaying(previous => { if (!previous && timeRef.current >= (compositionRef.current?.duration ?? projectRef.current.duration)) seek(0); return !previous; });
  }, [seek]);

  const setTemporalMode = async (mode: MotionTemporal['mode']) => {
    if (restoringRef.current || chunkLoadingRef.current || mode === 'blend' && !smoothingAvailable) return;
    setPlaying(false);
    if (!compositionRef.current) {
      const previous = projectRef.current;
      const next: MotionProject = { ...previous, temporal: { sampleFps: previous.temporal?.sampleFps ?? previous.fps, cuts: previous.temporal?.cuts ?? [], mode } };
      try { validateDocument({ ...next, nodes: [], fonts: undefined }); commit(next); }
      catch (cause) { setError(cause instanceof Error ? cause.message : '연결 설정을 적용할 수 없습니다.'); }
      return;
    }
    // Finish the active edit before changing document metadata. In particular,
    // never replace the in-memory edited chunk with its older encoded payload.
    chunkLoadingRef.current = true; setChunkLoading(true);
    const request = ++navigationVersion.current;
    try {
      await flushActiveChunk();
      if (!mountedRef.current || request !== navigationVersion.current) return;
      const book = compositionRef.current!;
      const next: MotionComposition = { ...book, temporal: { sampleFps: book.temporal?.sampleFps ?? book.fps, cuts: book.temporal?.cuts ?? [], mode } };
      const nextPlayer = createCompositionPlayer(next);
      compositionRef.current = next; setComposition(next);
      playerRef.current?.dispose(); playerRef.current = nextPlayer;
      previewOverride.current = null;
      dirtyProject.current = true; editRevision.current++;
      setSaveState('저장 중');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '연결 설정을 변경하지 못했습니다. 편집 내용은 유지됩니다.'); }
    finally {
      if (request === navigationVersion.current) {
        chunkLoadingRef.current = false; setChunkLoading(false);
        // A held observation can belong to the preceding storage chunk.
        void loadTimeRef.current(timeRef.current);
      }
    }
  };

  const toggleSmoothing = () => setTemporalMode(temporal?.mode === 'blend' ? 'off' : 'blend');
  const frameRedraw = temporal?.mode === 'frames';
  const toggleFrameRedraw = () => setTemporalMode(frameRedraw ? 'off' : 'frames');

  const toggleRegionalMotion = async (kind: 'backgroundMotion' | 'foregroundMotion') => {
    if (restoringRef.current || chunkLoadingRef.current) return;
    setPlaying(false);
    if (!compositionRef.current) {
      const previous = projectRef.current;
      const motion = previous[kind];
      if (!motion) return;
      commit({ ...previous, [kind]: { ...motion, mode: motion.mode === 'on' ? 'off' : 'on' } });
      return;
    }
    chunkLoadingRef.current = true; setChunkLoading(true);
    const request = ++navigationVersion.current;
    try {
      await flushActiveChunk();
      if (!mountedRef.current || request !== navigationVersion.current) return;
      const book = compositionRef.current!;
      const motion = book[kind];
      if (!motion) return;
      const next: MotionComposition = { ...book, [kind]: { ...motion, mode: motion.mode === 'on' ? 'off' : 'on' } };
      const player = createCompositionPlayer(next);
      compositionRef.current = next; setComposition(next);
      playerRef.current?.dispose(); playerRef.current = player;
      previewOverride.current = null;
      dirtyProject.current = true; editRevision.current++;
      setSaveState('저장 중');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '영역 연결 설정을 변경하지 못했습니다. 편집 내용은 유지됩니다.'); }
    finally { if (request === navigationVersion.current) { chunkLoadingRef.current = false; setChunkLoading(false); } }
  };

  useEffect(() => {
    if (!playing) return;
    let previousAt = performance.now();
    let playhead = timeRef.current;
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = (now - previousAt) / 1000;
      previousAt = now;
      // Decode and SVG preparation are part of playback. Keep the current
      // picture while they finish rather than jumping ahead by their latency.
      if (chunkLoadingRef.current || previewPendingRef.current) { frame = requestAnimationFrame(tick); return; }
      const next = playhead + elapsed;
      playhead = next;
      if (next >= documentDuration) { seek(documentDuration); setPlaying(false); return; }
      seek(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, documentDuration, seek]);

  useEffect(() => {
    const pauseWhenHidden = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden);
  }, []);

  useEffect(() => {
    if (time > documentDuration) seek(documentDuration);
    if (selectedId && !project.nodes.some(node => node.id === selectedId)) setSelectedId(project.nodes[0]?.id);
  }, [project, selectedId, time, documentDuration, seek]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (Math.abs(video.currentTime - time) > (playing ? 0.12 : 0.005)) video.currentTime = time;
  }, [time, playing, mode]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing && !chunkLoading) void video.play().catch(() => { /* Render playback remains available when a source cannot play. */ });
    else video.pause();
  }, [playing, chunkLoading, documentSource?.url, mode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (pendingVideoRef.current || restoringRef.current) return;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Space' && target.closest('button, a, [role="button"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPlaying(false); seek(timeRef.current + (event.key === 'ArrowRight' ? 1 : -1) / projectRef.current.fps); }
      else if (event.key === 'Escape') { setMobilePanel(null); setShowExport(false); setShowAdd(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [redo, undo, togglePlay, seek]);

  const replaceProject = useCallback(async (next: MotionDocument, message: string) => {
    const request = ++navigationVersion.current;
    projectContext.current++;
    chunkLoadingRef.current = false; setChunkLoading(false);
    setPlaying(false);
    if (next.schemaVersion === 2) {
      restoringRef.current = true; setRestoring(true);
      const player = createCompositionPlayer(next);
      try {
        const frame = await player.seek(0);
        if (!frame || request !== navigationVersion.current || !mountedRef.current) { player.dispose(); return; }
        playerRef.current?.dispose(); playerRef.current = player;
        compositionRef.current = next; setComposition(next);
        projectContext.current++;
        activeSegmentRef.current = frame.segment.id; setActiveSegmentId(frame.segment.id);
        preparedFrame.current = { project: frame.project, renderer: frame.renderer };
        projectRef.current = frame.project; setProject(frame.project);
        openingProject.current = null; chunkDirty.current = false;
        undoStack.current = []; redoStack.current = []; setHistoryVersion(version => version + 1);
        dirtyProject.current = true; editRevision.current++;
        timeRef.current = 0; setTime(0);
        setSelectedId(preferredNode(frame.project)?.id);
        savedActiveChunk.current = null;
      } catch (cause) { player.dispose(); throw cause; }
      finally { if (request === navigationVersion.current) { restoringRef.current = false; setRestoring(false); } }
    } else {
      compositionRef.current = null; setComposition(null);
      activeSegmentRef.current = null; setActiveSegmentId(null);
      playerRef.current?.dispose(); playerRef.current = null;
      chunkDirty.current = false; chunkLoadingRef.current = false; setChunkLoading(false);
      openingProject.current = next; commit(next);
      seek(Math.min(0.8, next.duration / 2));
      setSelectedId(preferredNode(next)?.id);
    }
    setError(null); setToast(message); setSourceError(false);
    setElementSearch(''); setCurrentOnly(false); setTextOnly(false); setElementPage(0);
  }, [commit, seek]);

  const isCurrentRequest = (request: number) => mountedRef.current && request === activeRequest.current;

  const finishRequest = (request: number) => {
    if (!isCurrentRequest(request)) return;
    // Invalidate in-flight polls and cancellation responses before allowing another upload.
    activeRequest.current += 1;
    requestPhase.current = 'idle';
    currentJobId.current = null;
    busyRef.current = false;
    setStarting(false);
    setCancelling(false);
  };

  const runAnalysis = async (file: File, preparedRequest?: number, clip?: ClipRange, quality: AnalysisQuality = analysisQuality) => {
    if (preparedRequest !== undefined ? !isCurrentRequest(preparedRequest) : busyRef.current) return;
    if (file.size > 100 * 1024 * 1024) { setError('100MB 이하의 영상을 선택해 주세요.'); return; }
    if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v)$/i.test(file.name)) { setError('MP4, WebM, MOV 형식의 영상 파일을 선택해 주세요. 프로젝트는 JSON 가져오기를 이용해 주세요.'); return; }
    const request = preparedRequest ?? ++activeRequest.current;
    busyRef.current = true;
    cancelledRequest.current = false;
    requestPhase.current = 'uploading';
    currentJobId.current = null;
    setStarting(true);
    setCancelling(false);
    setJob(null);
    setError(null);
    setPlaying(false);
    setRunningQuality(quality);
    try {
      let current = await analyzeVideo(file, { ...clip, quality, sampleFps: quality === 'high' ? 24 : undefined });
      if (!isCurrentRequest(request)) {
        // The component may have unmounted while the upload was being accepted.
        void cancelJob(current.id).catch(() => {});
        return;
      }
      currentJobId.current = current.id;
      requestPhase.current = 'polling';
      if (cancelledRequest.current) {
        current = await cancelJob(current.id);
        if (!isCurrentRequest(request)) return;
        current = { ...current, status: 'cancelled', project: undefined };
      }
      setJob(current);
      setStarting(false);
      while (current.status === 'queued' || current.status === 'processing') {
        await new Promise(resolve => window.setTimeout(resolve, 750));
        if (!isCurrentRequest(request)) return;
        current = await getJob(current.id);
        if (!isCurrentRequest(request)) return;
        setJob(current);
      }
      if (cancelledRequest.current || current.status === 'cancelled') {
        setJob({ ...current, status: 'cancelled', project: undefined });
        setToast('분석을 취소했습니다. 편집 중인 프로젝트는 유지됩니다.');
      } else if (current.status === 'completed' && current.project) {
        const result = validateDocument(current.project);
        await replaceProject(result, result.schemaVersion === 2 ? `${result.segments.length}개 장면을 하나의 타임라인으로 재구성했습니다.` : `${result.nodes.length}개 요소를 재구성했습니다. 원본과 비교하며 다듬어 보세요.`);
        setMode('split');
      } else if (current.status === 'failed') setError(current.error || '영상을 분석하지 못했습니다. 다른 영상을 선택해 주세요.');
    } catch (cause) {
      if (!isCurrentRequest(request)) return;
      const message = cause instanceof Error ? cause.message : '분석 중 오류가 발생했습니다.';
      setError(message);
      setJob(previous => previous ? { ...previous, status: 'failed', error: message } : null);
    } finally { finishRequest(request); }
  };

  const dismissClip = () => {
    if (pendingVideoRef.current) URL.revokeObjectURL(pendingVideoRef.current.url);
    pendingVideoRef.current = null;
    setPendingVideo(null);
  };

  const prepareUpload = async (file: File) => {
    if (busyRef.current || pendingVideoRef.current || restoringRef.current) return;
    if (file.size > 100 * 1024 * 1024) { setError('100MB 이하의 영상을 선택해 주세요.'); return; }
    if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v)$/i.test(file.name)) { setError('MP4, WebM, MOV 형식의 영상 파일을 선택해 주세요. 프로젝트는 JSON 가져오기를 이용해 주세요.'); return; }
    const request = ++activeRequest.current;
    const quality = analysisQuality;
    const controller = new AbortController();
    metadataAbort.current = controller;
    busyRef.current = true;
    requestPhase.current = 'metadata';
    cancelledRequest.current = false;
    currentJobId.current = null;
    setStarting(true);
    setCancelling(false);
    setJob(null);
    setError(null);
    setPlaying(false);
    let url: string | undefined;
    try {
      url = URL.createObjectURL(file);
      const metadata = await readVideoMetadata(url, controller.signal);
      if (!isCurrentRequest(request)) return;
      if (metadata.duration < 0.2) throw new Error('0.2초 이상의 영상을 선택해 주세요.');
      if (metadata.duration > 30) {
        const pending = { file, url, ...metadata };
        pendingVideoRef.current = pending;
        setPendingVideo(pending);
        url = undefined; // The dialog now owns this object URL until close or confirmation.
      } else {
        URL.revokeObjectURL(url);
        url = undefined;
        await runAnalysis(file, request, undefined, quality);
      }
    } catch (cause) {
      if (!isCurrentRequest(request)) return;
      setError(cause instanceof Error ? cause.message : '영상 정보를 읽을 수 없습니다.');
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (metadataAbort.current === controller) metadataAbort.current = null;
      finishRequest(request);
    }
  };

  const confirmClip = (range: ClipRange) => {
    const source = pendingVideoRef.current;
    if (!source || busyRef.current) return;
    dismissClip();
    void runAnalysis(source.file, undefined, range);
  };

  const loadDemoVideo = async () => {
    if (busyRef.current || pendingVideoRef.current || restoringRef.current) return;
    const request = ++activeRequest.current;
    const quality = analysisQuality;
    busyRef.current = true;
    cancelledRequest.current = false;
    requestPhase.current = 'preparing';
    currentJobId.current = null;
    setStarting(true);
    setCancelling(false);
    setJob(null);
    setError(null);
    try {
      const demo = await getDemoVideo();
      if (!isCurrentRequest(request)) return;
      const response = await fetch(demo.url);
      if (!isCurrentRequest(request)) return;
      if (!response.ok) throw new Error('예제 영상을 가져오지 못했습니다. 분석 서버 연결을 확인해 주세요.');
      const blob = await response.blob();
      if (!isCurrentRequest(request)) return;
      // Preparation and analysis share the same request identity and cancellation lifetime.
      await runAnalysis(new File([blob], demo.name, { type: blob.type || 'video/mp4' }), request, undefined, quality);
    } catch (cause) {
      if (!isCurrentRequest(request)) return;
      setError(cause instanceof Error ? cause.message : '예제를 불러오지 못했습니다.');
    } finally { finishRequest(request); }
  };

  const cancelAnalysis = async () => {
    if (!busyRef.current) return;
    const request = activeRequest.current;
    cancelledRequest.current = true;
    setCancelling(true);
    if (requestPhase.current === 'preparing' || requestPhase.current === 'metadata') {
      metadataAbort.current?.abort();
      setJob(null);
      setToast('영상 준비를 취소했습니다.');
      finishRequest(request);
      return;
    }
    // During upload, runAnalysis will cancel as soon as the server returns its job ID.
    const jobId = currentJobId.current;
    if (!jobId) return;
    try {
      const cancelled = await cancelJob(jobId);
      if (!isCurrentRequest(request)) return;
      setJob({ ...cancelled, status: 'cancelled', project: undefined });
      setToast('분석을 취소했습니다. 편집 중인 프로젝트는 유지됩니다.');
      finishRequest(request);
    } catch (cause) {
      if (!isCurrentRequest(request)) return;
      cancelledRequest.current = false;
      setError(cause instanceof Error ? cause.message : '분석 취소 요청에 실패했습니다.');
      setCancelling(false);
    }
  };

  const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || restoringRef.current) return;
    const request = ++importRequest.current;
    try {
      if (file.size > MAX_DOCUMENT_BYTES) throw new Error('프로젝트 JSON은 256MB 이하로 선택해 주세요. 단일 장면은 96MB까지 지원합니다.');
      const json = await file.text();
      if (request !== importRequest.current || !mountedRef.current) return;
      const next = parseDocument(json);
      await replaceProject(next, '프로젝트를 가져왔습니다.');
    } catch (cause) { if (request === importRequest.current && mountedRef.current) setError(cause instanceof Error ? cause.message : '올바른 프로젝트 JSON 파일이 아닙니다.'); }
  };

  const patchNode = (patch: Partial<MotionNode>, id = selectedId) => {
    if (!id || restoringRef.current || chunkLoadingRef.current) return;
    const original = projectRef.current.nodes.find(node => node.id === id);
    if (!original) return;
    const candidate = { ...original, ...patch };
    const needsFit = hasTextWarp(candidate) && TEXT_REFIT_FIELDS.some(field => Object.hasOwn(patch, field) && patch[field] !== original[field]);
    const apply = (previous: MotionProject, value: Partial<MotionNode>) => ({ ...previous, nodes: previous.nodes.map(node => node.id === id ? value.fill !== undefined ? withSolidFill({ ...node, ...value }, value.fill) : { ...node, ...value } : node) });
    if (needsFit && document.fonts.check(textFont(candidate), candidate.text?.replace(/\n/g, '') || '한글 Mg')) {
      try { pendingTextFits.current.delete(id); commit(previous => apply(previous, { ...patch, textBox: measureTextBox(candidate) })); return; }
      catch (cause) { setError(cause instanceof Error ? cause.message : '글자 크기를 측정하지 못했습니다.'); }
    }
    // Commit the requested edit immediately, including before a page-exit flush.
    commit(previous => apply(previous, patch));
    if (!needsFit) return;
    const signature = textMetricSignature(candidate);
    const context = projectContext.current;
    const token = ++textFitSequence.current;
    const task = loadTextFont(candidate).then(() => {
      if (!mountedRef.current || projectContext.current !== context || pendingTextFits.current.get(id)?.token !== token) return;
      const current = projectRef.current.nodes.find(node => node.id === id);
      if (!current || textMetricSignature(current) !== signature) return;
      const textBox = measureTextBox(candidate);
      const fit = (snapshot: MotionProject) => {
        const node = snapshot.nodes.find(item => item.id === id);
        return node && textMetricSignature(node) === signature ? apply(snapshot, { textBox }) : snapshot;
      };
      const next = fit(projectRef.current);
      // Derived measurements belong to the original text edit, not another undo step.
      undoStack.current = undoStack.current.map(fit);
      redoStack.current = redoStack.current.map(fit);
      projectRef.current = next; setProject(next);
      dirtyProject.current = true; if (compositionRef.current) chunkDirty.current = true;
      editRevision.current++;
    }).catch(cause => {
      if (mountedRef.current && projectContext.current === context && pendingTextFits.current.get(id)?.token === token) setError(cause instanceof Error ? cause.message : '글꼴을 불러오지 못했습니다.');
    }).finally(() => { if (pendingTextFits.current.get(id)?.token === token) pendingTextFits.current.delete(id); });
    pendingTextFits.current.set(id, { token, task });
  };

  const resizeNode = (axis: 'width' | 'height', value: number) => {
    if (!selected || selected.locked) return;
    if (hasTextWarp(selected) && preserveAspect && selected.width > 0 && selected.height > 0) {
      const scale = Math.min(value / selected[axis], 65536 / selected.width, 65536 / selected.height);
      patchNode({ width: selected.width * scale, height: selected.height * scale });
    } else patchNode({ [axis]: value });
  };

  const applySimilarFill = () => {
    if (!selected || selected.locked || !showBulkFill) return;
    const ids = similarFillIds(projectRef.current.nodes, selected.fill);
    const changed = projectRef.current.nodes.filter(node => ids.has(node.id) && (node.fill !== bulkFill || node.gradient || node.paintRegions?.length || node.keyframes.some(frame => frame.fill || frame.gradient || frame.paintRegions?.length)));
    if (!changed.length) return;
    commit(previous => ({ ...previous, nodes: previous.nodes.map(node => ids.has(node.id) && !node.locked ? withSolidFill(node, bulkFill) : node) }));
    setToast(`잠긴 요소를 제외한 ${changed.length}개 요소의 채우기를 변경했습니다.`);
  };

  const addNode = (type: 'text' | 'rect' | 'ellipse') => {
    if (projectRef.current.nodes.length >= MAX_PROJECT_NODES) { setError(`현재 편집 구간에는 요소를 최대 ${MAX_PROJECT_NODES.toLocaleString('ko-KR')}개까지 담을 수 있습니다. 요소를 삭제한 뒤 추가해 주세요.`); return; }
    const id = `node-${crypto.randomUUID()}`;
    const node: MotionNode = { id, name: type === 'text' ? '새 텍스트' : type === 'rect' ? '새 사각형' : '새 원', type, x: project.width * 0.35, y: project.height * 0.4, width: type === 'text' ? project.width * 0.4 : project.width * 0.15, height: project.height * 0.2, rotation: 0, opacity: 1, fill: type === 'text' ? '#ffffff' : '#cdfa7c', stroke: 'none', strokeWidth: 0, start: 0, end: project.duration, hidden: false, locked: false, keyframes: [], ...(type === 'text' ? { text: '새로운 아이디어', fontSize: Math.round(project.width / 22), fontFamily: 'sans-serif', fontWeight: 700 } : {}) };
    commit(previous => ({ ...previous, nodes: [...previous.nodes, node] }));
    setSelectedId(id);
    setShowAdd(false);
    setMobilePanel('inspector');
  };

  const duplicateNode = () => {
    if (!selected || selected.locked) return;
    if (projectRef.current.nodes.length >= MAX_PROJECT_NODES) { setError(`현재 편집 구간에는 요소를 최대 ${MAX_PROJECT_NODES.toLocaleString('ko-KR')}개까지 담을 수 있습니다. 요소를 삭제한 뒤 복제해 주세요.`); return; }
    const copy = { ...structuredClone(selected), id: `node-${crypto.randomUUID()}`, name: `${selected.name} 복사`, x: selected.x + 16, y: selected.y + 16 };
    commit(previous => ({ ...previous, nodes: [...previous.nodes, copy] }));
    setSelectedId(copy.id);
  };

  const removeNode = () => {
    if (!selected || selected.locked) return;
    commit(previous => ({ ...previous, nodes: previous.nodes.filter(node => node.id !== selected.id) }));
  };

  const exportFile = async (format: 'html' | 'json' | 'zip') => {
    setShowExport(false);
    try {
      const document = await flushActiveChunk();
      if (format === 'html') await downloadHtml(document);
      else if (format === 'json') await downloadProject(document);
      else await downloadZip(document);
      setToast(`${format.toUpperCase()} 파일을 내려받았습니다.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '파일을 내보내지 못했습니다.'); }
  };

  const dropVideo = (event: DragEvent) => {
    event.preventDefault();
    dragCount.current = 0;
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void prepareUpload(file);
  };

  const resolvePreview = useCallback((globalTime: number) => {
    const options = { selectedId, showOcclusion, onionTimes: onion ? [Math.max(0, globalTime - segmentOffset - 0.25), Math.min(project.duration, globalTime - segmentOffset + 0.25)] : undefined };
    if (!compositionRef.current) return renderProject.framePair(globalTime, options);
    const player = playerRef.current ??= createCompositionPlayer(compositionRef.current);
    if (chunkDirty.current && activeSegmentRef.current && (previewOverride.current?.player !== player || previewOverride.current.project !== project)) {
      player.setProjectOverride(activeSegmentRef.current, project);
      previewOverride.current = { player, project };
    }
    const result = player.framePair(globalTime, options);
    return result instanceof Promise ? result.catch(cause => {
      // Autosave can replace the compressed book while an older preview is
      // still decoding. The replacement resolver will paint the current edit.
      if (player !== playerRef.current) return null;
      throw cause;
    }) : result;
  }, [renderProject, project, composition, selectedId, showOcclusion, onion, segmentOffset]);
  const previewPending = useCallback((pending: boolean) => { previewPendingRef.current = pending; }, []);
  const previewBackground = useCallback((status: PreviewBackgroundStatus | undefined) => setPreviewBackgroundStatus(status), []);
  const previewForeground = useCallback((status: PreviewForegroundStatus | undefined) => setPreviewForegroundStatus(status), []);
  const previewError = useCallback((cause: unknown) => { setPlaying(false); setError(cause instanceof Error ? cause.message : '미리보기를 준비하지 못했습니다.'); }, []);
  const selectFromCanvas = (event: ReactMouseEvent) => {
    const target = (event.target as Element).closest('[data-node-id]');
    // Near a storage boundary the dominant endpoint can belong to the next
    // chunk. Open that editable chunk when its visible element is selected.
    const endpoint = target?.closest<HTMLElement>('.temporal-frame');
    const endpointTime = Number(endpoint?.dataset.sampleTime);
    const id = target?.getAttribute('data-node-id');
    const book = compositionRef.current;
    const endpointSegment = book && Number.isFinite(endpointTime) ? book.segments.find(segment => segment.end - endpointTime > 8 * Number.EPSILON * Math.max(1, Math.abs(endpointTime), segment.end)) ?? book.segments[book.segments.length - 1] : undefined;
    if (endpointSegment && endpointSegment.id !== activeSegmentRef.current && endpoint && id) {
      setPlaying(false); timeRef.current = endpointTime; setTime(endpointTime);
      void loadTimeRef.current(endpointTime).then(() => {
        if (mountedRef.current && timeRef.current === endpointTime && projectRef.current.nodes.some(item => item.id === id)) setSelectedId(id);
      });
      return;
    }
    const node = id && project.nodes.find(item => item.id === id);
    if (node) selectNode(node);
  };
  const stageStyle = { aspectRatio: `${project.width} / ${project.height}` };
  const fittedStageWidth = Math.max(48, Math.min((stageBounds.width - (mode === 'split' ? 16 : 0)) / (mode === 'split' ? 2 : 1), Math.max(50, stageBounds.height - 48) * project.width / project.height));
  const stageItemStyle = { width: `${fittedStageWidth}px` };
  const percent = (time / documentDuration) * 100;
  const ticks = Array.from({ length: 9 }, (_, index) => (index / 8) * documentDuration);
  const sourceAvailable = Boolean(documentSource?.url) && !sourceError;
  const comparisonAvailable = sourceAvailable || mode === 'split' || mode === 'render';
  const backgroundControl = backgroundMotion ? {
    enabled: !frameRedraw && backgroundMotion.mode === 'on', disabled: frameRedraw || chunkLoading || restoring, regions: backgroundSections,
    activeId: activeBackgroundSection?.id, currentSupported: previewBackgroundStatus?.supported,
    note: frameRedraw ? '프레임 다시 그리기: 관측 도형을 사용합니다. 연결 데이터는 보존됩니다.' : backgroundMotion.mode === 'off' ? '배경 수식 데이터를 보존합니다. 기존 연결 방식으로 표시합니다.' : previewBackgroundStatus?.supported === false && activeBackgroundSection?.kind !== 'fallback' ? '현재 시각은 기존 프레임 연결로 표시합니다.' : undefined,
    onToggle: () => void toggleRegionalMotion('backgroundMotion'), onSeek: (next: number) => { setPlaying(false); seek(next); },
  } : undefined;
  const observationPosition = time * (temporal?.sampleFps ?? project.fps);
  const foregroundControl = foregroundMotion ? {
    enabled: !frameRedraw && foregroundMotion.mode === 'on', disabled: frameRedraw || chunkLoading || restoring, regions: foregroundSections,
    activeId: activeForegroundSection?.id, currentSupported: previewForegroundStatus?.supported,
    note: frameRedraw ? '프레임 다시 그리기: 관측 도형을 사용합니다. 연결 데이터는 보존됩니다.' : foregroundMotion.mode === 'off' ? '전경 수식 데이터를 보존합니다. 기존 연결 방식으로 표시합니다.' : previewForegroundStatus?.supported && Math.abs(observationPosition - Math.round(observationPosition)) < 1e-6 ? '원래 관측 화면을 유지합니다. 그 사이에서 지정한 전경 위치를 연결합니다.' : undefined,
    onToggle: () => void toggleRegionalMotion('foregroundMotion'), onSeek: (next: number) => { setPlaying(false); seek(next); },
  } : undefined;
  // Referenced so the toolbar reacts after a ref-based history mutation.
  void historyVersion;

  const sourceContent = <>
    {documentSource?.url && <video ref={videoRef} className="source-video" src={documentSource.url} muted playsInline preload="auto" onLoadedMetadata={event => { event.currentTarget.currentTime = Math.min(timeRef.current, event.currentTarget.duration); }} onError={() => setSourceError(true)} />}
    {!sourceAvailable && <div className="source-empty"><div className="source-empty-mark"><Film size={23} strokeWidth={1.4} /><span /></div><strong>{sourceError ? '원본 영상을 찾을 수 없어요' : '움직임의 시작, 원본 영상'}</strong><p>{sourceError ? '프로젝트 요소와 HTML 출력은 계속 사용할 수 있습니다.' : '짧은 모션그래픽을 올리고\n편집 가능한 요소로 재구성하세요.'}</p><button className="button quiet" disabled={busy} onClick={() => videoInput.current?.click()}><Upload size={14} />영상 선택</button></div>}
  </>;

  return <div className={`app-shell ${dragging ? 'is-dragging' : ''}`} onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragCount.current += 1; setDragging(true); } }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDragLeave={event => { event.preventDefault(); dragCount.current -= 1; if (dragCount.current <= 0) setDragging(false); }} onDrop={dropVideo}>
    <input data-testid="upload-input" ref={videoInput} className="visually-hidden" type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v" aria-label="영상 파일 업로드" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void prepareUpload(file); }} />
    <input data-testid="import-input" ref={jsonInput} className="visually-hidden" type="file" accept="application/json,.json" aria-label="프로젝트 JSON 가져오기" onChange={event => void importJson(event)} />
    <header className="app-header" inert={restoring}>
      <a className="brand" href="#" onClick={event => event.preventDefault()} aria-label="새김 Saegim"><span className="brand-symbol"><span /><span /></span><span>SAEGIM<span className="brand-slash">/</span>새김</span><span className="version-badge">BETA</span></a>
      <div className="header-divider" />
      <div className="header-project"><span className="project-status-dot" /><span>{composition?.name ?? project.name}</span><ChevronDown size={12} /></div>
      <div className="header-actions"><span className="saved-status"><CheckCircle2 size={12} />{saveState}</span><button className="icon-button mobile-layers-toggle" title="요소 패널" aria-label="요소 패널" onClick={() => setMobilePanel(mobilePanel === 'layers' ? null : 'layers')}><Layers2 size={17} /></button><button className="icon-button mobile-inspector-toggle" title="속성 패널" aria-label="속성 패널" onClick={() => setMobilePanel(mobilePanel === 'inspector' ? null : 'inspector')}><Settings2 size={17} /></button><button className="button json-import" onClick={() => jsonInput.current?.click()} disabled={busy}><FileJson size={14} /><span>프로젝트 열기</span></button><div className="export-control"><button className="button primary" onClick={() => setShowExport(!showExport)} aria-expanded={showExport}><ArrowDownToLine size={15} /><span>내보내기</span><ChevronDown size={13} /></button>{showExport && <><button className="popover-dismiss" aria-label="내보내기 메뉴 닫기" onClick={() => setShowExport(false)} /><div className="menu export-menu"><div className="menu-heading">브라우저 밖에서도, 그대로</div><button data-testid="export-html" onClick={() => void exportFile('html')}><Code2 size={16} /><span><strong>독립 HTML</strong><small>설치 없이 열리는 웹 애니메이션</small></span><ArrowUpRight size={14} /></button><button onClick={() => void exportFile('zip')}><Braces size={16} /><span><strong>소스 ZIP</strong><small>HTML과 편집용 프로젝트</small></span><ArrowUpRight size={14} /></button><button data-testid="export-project" onClick={() => void exportFile('json')}><FileJson size={16} /><span><strong>프로젝트 JSON</strong><small>다음 작업을 위한 편집 데이터</small></span><ArrowUpRight size={14} /></button></div></>}</div></div>
    </header>

    <div className="workspace-heading"><div><span className="eyebrow">VIDEO TO WEB</span><h1>움직임을, 편집 가능한 코드로.</h1></div><div className="workflow-indicator"><span className={busy ? 'active' : ''}><i>1</i>영상 분석</span><span className="workflow-line" /><span className={!busy ? 'active' : ''}><i>2</i>비교 & 편집</span><span className="workflow-line" /><span><i>3</i>HTML 출력</span></div></div>

    {storageError && <div data-testid="storage-warning" className="storage-warning" role="alert"><CircleAlert size={16} /><span>자동 저장에 실패했습니다. 현재 작업을 보존하려면 다시 저장하거나 JSON으로 백업하세요.</span><div><button className="button small" aria-label="프로젝트 저장 다시 시도" onClick={persistProject}>저장 다시 시도</button><button className="button small" aria-label="저장 실패 프로젝트 JSON 백업" onClick={() => void exportFile('json')}><FileJson size={12} />JSON 백업</button></div></div>}
    {error && <div className="error-banner" role="alert"><CircleAlert size={16} /><span>{error}</span><button className="icon-button" aria-label="오류 닫기" onClick={() => setError(null)}><X size={15} /></button></div>}
    {busy && <div className="analysis-banner" role="status"><LoaderCircle size={17} className="spinning" /><div className="analysis-message"><strong>{starting ? requestPhase.current === 'metadata' ? '영상 정보 확인 중' : '영상 준비 중' : job?.stage || '영상 분석 중'}</strong><span>{requestPhase.current === 'metadata' ? '영상 길이를 확인하고 있습니다.' : runningQuality === 'high' ? '정밀 분석 · 더 세밀한 윤곽과 음영을 재구성합니다.' : '빠른 분석 · 텍스트와 도형의 움직임을 추적합니다.'}</span></div><div className="analysis-progress"><div style={{ width: `${clamp(job?.progress ?? 3, 0, 100)}%` }} /></div><span className="mono">{Math.round(job?.progress ?? 0)}%</span><button className="button small" onClick={() => void cancelAnalysis()} disabled={cancelling}>{cancelling ? '취소 중…' : '취소'}</button></div>}

    <main className="editor-grid" inert={restoring}>
      {mobilePanel && <button className="panel-scrim" aria-label="패널 닫기" onClick={() => setMobilePanel(null)} />}
      <aside className={`layers-panel side-panel ${mobilePanel === 'layers' ? 'mobile-open' : ''}`}>
        <div className="panel-heading"><h2>프로젝트</h2><button className="icon-button panel-close" aria-label="요소 패널 닫기" onClick={() => setMobilePanel(null)}><X size={15} /></button><span className="micro-label">LOCAL WORKSPACE</span></div>
        <button className="upload-tile" aria-label="영상 업로드" onClick={() => videoInput.current?.click()} disabled={busy}><div className="upload-icon"><Upload size={18} strokeWidth={1.5} /></div><strong>영상 업로드</strong><span>파일을 놓거나 클릭하세요</span><small>MP4 · WebM · MOV / 최대 100MB</small></button>
        <AnalysisQualitySelector value={analysisQuality} onChange={setAnalysisQuality} disabled={busy || Boolean(pendingVideo)} />
        <button data-testid="sample-analyze" className="demo-action" onClick={() => void loadDemoVideo()} disabled={busy}><span><Play size={11} fill="currentColor" />예제 영상으로 분석해 보기</span><ArrowUpRight size={13} /></button>
        <div className="layer-section-heading"><div><h2>요소</h2><span className="count-badge">{project.nodes.length.toString().padStart(2, '0')}</span></div><div className="add-control"><button className="icon-button" aria-label="요소 추가" title="요소 추가" onClick={() => setShowAdd(!showAdd)}><Plus size={15} /></button>{showAdd && <div className="menu add-menu">{(['text', 'rect', 'ellipse'] as const).map(type => <button key={type} onClick={() => addNode(type)}><NodeIcon type={type} /><span>{NODE_LABELS[type]} 추가</span></button>)}</div>}</div></div>
        <div className="layer-filters"><label className="element-search"><Search size={12} /><input aria-label="요소 검색" placeholder="이름 또는 텍스트 검색" value={elementSearch} onChange={event => setElementSearch(event.target.value)} />{elementSearch && <button className="icon-button" aria-label="요소 검색 지우기" onClick={() => setElementSearch('')}><X size={11} /></button>}</label><div><label className="current-filter"><input type="checkbox" aria-label="현재 화면만" checked={currentOnly} onChange={event => setCurrentOnly(event.target.checked)} /><span>현재 화면만</span></label><label className="current-filter layer-text-filter"><input type="checkbox" aria-label="문구만" checked={textOnly} onChange={event => setTextOnly(event.target.checked)} /><span>문구만</span></label><span className="filter-count">{filteredNodes.length} / {project.nodes.length}</span></div></div>
        {composition && <div className="scene-context"><strong>{activeSegment?.name}</strong><br />현재 장면의 요소 · {segmentOffset.toFixed(1)}–{activeSegment?.end.toFixed(1)}초</div>}
        <ElementPager page={visiblePage} count={filteredNodes.length} onChange={changeElementPage} />
        <div ref={layerListRef} className="layer-list" role="list" aria-label="프로젝트 요소 목록">
          {pagedNodes.map(({ node, index }) => <div key={node.id} className={`layer-row ${selectedId === node.id ? 'selected' : ''} ${node.hidden ? 'hidden-node' : ''}`} role="listitem"><button className="layer-select" onClick={() => { selectNode(node); setMobilePanel(null); }} aria-label={`${node.name} 선택`} aria-pressed={selectedId === node.id}><span className="layer-type"><NodeIcon type={node.type} /></span><span className="layer-copy"><strong className={textOnly ? 'text-content' : undefined} title={node.text}>{textOnly && node.type === 'text' ? node.text || '빈 텍스트' : node.name}</strong><small>{hasTextWarp(node) ? '원근 텍스트' : NODE_LABELS[node.type]}<span>·</span>{textOnly ? `${(node.start + segmentOffset).toFixed(1)}–${(node.end + segmentOffset).toFixed(1)}초` : `${node.keyframes.length} 키프레임`}</small></span><span className="layer-index">{(index + 1).toString().padStart(2, '0')}</span></button><div className="layer-row-actions"><button className="icon-button" title={node.hidden ? '요소 표시' : '요소 숨기기'} aria-label={`${node.name} ${node.hidden ? '표시' : '숨기기'}`} onClick={() => patchNode({ hidden: !node.hidden }, node.id)}>{node.hidden ? <EyeOff size={13} /> : <Eye size={13} />}</button><button className={`icon-button ${node.locked ? 'is-locked' : ''}`} title={node.locked ? '잠금 해제' : '잠금'} aria-label={`${node.name} ${node.locked ? '잠금 해제' : '잠금'}`} onClick={() => patchNode({ locked: !node.locked }, node.id)}>{node.locked ? <LockKeyhole size={12} /> : <UnlockKeyhole size={12} />}</button></div></div>)}
          {!filteredNodes.length && <div className="empty-layers">{project.nodes.length ? <>조건에 맞는 요소가 없습니다.<br /><button className="filter-reset" onClick={() => { setElementSearch(''); setCurrentOnly(false); setTextOnly(false); }}>검색과 필터 초기화</button></> : <>아직 요소가 없습니다.<br />+ 버튼으로 요소를 추가하세요.</>}</div>}
        </div>
        <div className="layers-footer"><div><span className="status-dot" />{documentSource ? '분석 결과 · 편집 가능' : '편집용 예제 프로젝트'}</div><p>{documentSource ? `${project.analysis?.sampleCount ?? '—'}개 프레임에서 추출한 요소입니다.` : '지금 재생하고 수정해 보세요.\n실제 변환은 영상 업로드로 시작합니다.'}</p><button onClick={() => replaceProject(createDemoProject(), '편집용 예제 프로젝트를 열었습니다.')} disabled={busy}><RotateCcw size={11} />편집 예제 다시 열기</button></div>
      </aside>

      <section className="center-panel">
        <div className="canvas-toolbar"><div className="preview-title"><Focus size={15} /><span>미리보기</span><span className="dimensions mono">{project.width} × {project.height}</span></div><div className="compare-switch" role="group" aria-label="비교 모드"><button className={mode === 'split' ? 'active' : ''} title="나란히 보기" aria-label="나란히 보기" onClick={() => setMode('split')}><ArrowLeftRight size={13} /><span>나란히</span></button><button className={mode === 'render' ? 'active' : ''} title="재현 화면만 보기" aria-label="재현 화면만 보기" onClick={() => setMode('render')}><Code2 size={13} /><span>재현</span></button><button className={mode === 'overlay' ? 'active' : ''} title="원본 위에 재현 화면을 반투명하게 표시" aria-label="겹쳐 보기" disabled={!sourceAvailable} onClick={() => setMode('overlay')}><Layers2 size={13} /><span>겹치기</span></button><button className={mode === 'difference' ? 'active' : ''} title="원본과 재현 화면의 픽셀 차이" aria-label="차이 보기" disabled={!sourceAvailable} onClick={() => setMode('difference')}><span className="difference-icon">◐</span><span>차이</span></button></div></div>

        <div className={`preview-workspace mode-${mode}`} ref={previewRef}>
          <div className="preview-meta"><span><span className="status-dot" />{documentSource ? 'SOURCE LINKED' : 'EDITABLE DEMO'}</span><span className="mono">{project.fps} FPS <span>/</span> {documentDuration.toFixed(1)} SEC</span></div>
          <div ref={stagesRef} className={`preview-stages ${mode === 'split' ? 'is-split' : ''}`}>
            {mode === 'split' && <div className="preview-item" style={stageItemStyle}><div className="preview-label"><span><i className="source-label-dot" />원본 영상</span><small>{documentSource ? 'SOURCE' : '업로드 대기'}</small></div><div className="preview-stage original-stage" style={stageStyle}>{sourceContent}</div><div className="stage-caption"><Film size={11} /><span title={documentSource?.name}>{documentSource?.name || '영상 업로드 후 연결됩니다'}</span></div></div>}
            <div className="preview-item" style={stageItemStyle}><div className="preview-label"><span><i className="render-label-dot" />{mode === 'overlay' ? '원본 + 재현 · 50%' : mode === 'difference' ? '원본과의 차이' : 'HTML 재현'}</span><small>{mode === 'difference' ? '검정일수록 일치' : 'LIVE RENDER'}</small></div><div className={`preview-stage rendered-stage ${mode}`} style={stageStyle} onClick={selectFromCanvas}>{(mode === 'overlay' || mode === 'difference') && sourceContent}<TemporalPreview time={time} resolve={resolvePreview} onPending={previewPending} onError={previewError} onBackgroundStatus={previewBackground} onForegroundStatus={previewForeground} />{!comparisonAvailable && <span className="comparison-unavailable">원본 영상이 필요합니다.</span>}</div><div className="stage-caption"><Code2 size={12} /><span>{project.nodes.length}개 편집 가능한 요소</span><span className="vector-badge">SVG + CSS + JS</span></div></div>
          </div>
          {chunkLoading && <div className="scene-pending-cover" role="status"><LoaderCircle className="spinning" size={17} />장면을 준비하고 있습니다</div>}<div className="canvas-bottom"><span><MousePointer2 size={12} />요소를 선택하고 속성을 조정하세요</span><div><button className={`canvas-action ${onion ? 'active' : ''}`} title="이전과 다음 0.25초 프레임을 겹쳐 움직임 확인" aria-label="잔상 표시" aria-pressed={onion} onClick={() => setOnion(!onion)}><Layers2 size={13} /><span>잔상</span></button><button className="canvas-action" title="미리보기 전체 화면" aria-label="미리보기 전체 화면" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void previewRef.current?.requestFullscreen().catch(() => setToast('이 브라우저에서는 전체 화면을 지원하지 않습니다.')); }}><Maximize2 size={13} /><span>맞춤</span></button></div></div>
        </div>

        {foregroundControl ? <MotionConnectionControls background={backgroundControl} foreground={foregroundControl} /> : backgroundControl && <BackgroundMotionControl {...backgroundControl} />}
        <div className="playback-bar"><div className="history-actions"><button className="icon-button" aria-label="실행 취소" title="실행 취소 (⌘Z / Ctrl+Z)" disabled={!undoStack.current.length} onClick={undo}><Undo2 size={15} /></button><button className="icon-button" aria-label="다시 실행" title="다시 실행 (⇧⌘Z / Ctrl+Shift+Z)" disabled={!redoStack.current.length} onClick={redo}><Redo2 size={15} /></button></div><div className="transport"><button className="icon-button" aria-label="이전 프레임" title="이전 프레임 (←)" onClick={() => { setPlaying(false); seek(time - 1 / project.fps); }}><SkipBack size={15} /></button><button className={`play-button ${playing ? 'is-playing' : ''}`} aria-label={playing ? '일시정지' : '재생'} title="재생 / 일시정지 (Space)" onClick={togglePlay}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><button className="icon-button" aria-label="다음 프레임" title="다음 프레임 (→)" onClick={() => { setPlaying(false); seek(time + 1 / project.fps); }}><SkipForward size={15} /></button><span className="time-display mono"><strong>{formatTime(time)}</strong><span>/</span>{formatTime(documentDuration)}</span></div><div className="playback-settings"><button className={`smoothing-toggle ${frameRedraw ? 'active' : ''}`} aria-label="프레임 다시 그리기" aria-pressed={frameRedraw} disabled={chunkLoading || restoring} title="관측 시각의 도형과 텍스트로 SVG를 매 프레임 다시 그립니다." onClick={() => void toggleFrameRedraw()}><span className="toggle-track"><i /></span><span>프레임 다시 그리기</span></button><button className={`smoothing-toggle ${temporal?.mode === 'blend' ? 'active' : ''}`} aria-label="부드러운 연결" aria-pressed={temporal?.mode === 'blend'} disabled={!smoothingAvailable || chunkLoading} title={smoothingAvailable ? '같은 장면의 관측 프레임을 부드럽게 겹칩니다. 장면 전환은 유지합니다.' : '실제 장면 전환 정보가 포함된 프로젝트에서 사용할 수 있습니다.'} onClick={() => void toggleSmoothing()}><span className="toggle-track"><i /></span><span>부드러운 연결</span></button><div className="playback-meta mono">{Math.round(time * project.fps).toString().padStart(3, '0')}<span>FRAME</span></div></div></div>

        <div className={`timeline ${navigationScenes.length > 1 ? 'has-scenes' : ''}`}><div className="timeline-heading"><h2>타임라인</h2><span>프레임 단위로 정밀하게</span><span className="timeline-key"><i />키프레임</span><ElementPager timeline page={visiblePage} count={filteredNodes.length} onChange={changeElementPage} /></div>{navigationScenes.length > 1 && <div className="scene-navigator"><label htmlFor="scene-select">장면 이동</label><button className="icon-button" aria-label="이전 장면" disabled={currentSceneIndex <= 0} onClick={() => { setPlaying(false); seek(navigationScenes[currentSceneIndex - 1].start + 1 / project.fps); }}><ChevronLeft size={14} /></button><select id="scene-select" aria-label="장면 이동" value={navigationScenes[currentSceneIndex]?.id ?? ''} onChange={event => { const scene = navigationScenes.find(item => item.id === event.target.value); if (scene) { setPlaying(false); seek(scene.start + 1 / project.fps); } }}>{navigationScenes.map((scene, index) => <option key={scene.id} value={scene.id}>{index + 1}. {scene.name} · {scene.start.toFixed(1)}–{scene.end.toFixed(1)}초</option>)}</select><button className="icon-button" aria-label="다음 장면" disabled={currentSceneIndex >= navigationScenes.length - 1} onClick={() => { setPlaying(false); seek(navigationScenes[currentSceneIndex + 1].start + 1 / project.fps); }}><ChevronRight size={14} /></button><span>{currentSceneIndex + 1} / {navigationScenes.length}</span>{chunkLoading && <span className="scene-loading"><LoaderCircle className="spinning" />준비 중</span>}</div>}<div className="timeline-scroll"><div className="timeline-ruler-row"><div className="timeline-label">요소 / 시간</div><div className="timeline-ruler"><div className="ruler-ticks">{ticks.map((tick, index) => <span key={index} style={{ left: `${index * 12.5}%` }}>{tick.toFixed(1)}s</span>)}</div><input data-testid="timeline-slider" className="timeline-scrubber" aria-label="재생 위치" type="range" min={0} max={documentDuration} step={1 / project.fps} value={time} onChange={event => { setPlaying(false); seek(Number(event.target.value)); }} /></div></div><div ref={timelineTracksRef} className="timeline-tracks">{pagedNodes.map(({ node, index }) => <div key={node.id} className={`timeline-track ${selectedId === node.id ? 'selected' : ''} ${node.hidden ? 'hidden-node' : ''}`}><button className="timeline-label" aria-label={`${node.name} 타임라인 선택`} onClick={() => selectNode(node)}><NodeIcon type={node.type} size={12} /><span>{node.name}</span></button><div className="track-lane" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setPlaying(false); seek(((event.clientX - rect.left) / rect.width) * documentDuration); }}><button className={`track-segment track-color-${index % 4}`} style={{ left: `${(node.start + segmentOffset) / documentDuration * 100}%`, width: `${Math.max(0.5, (node.end - node.start) / documentDuration * 100)}%` }} onClick={event => { event.stopPropagation(); selectNode(node); }} title={`${node.name}: ${(node.start + segmentOffset).toFixed(2)}–${(node.end + segmentOffset).toFixed(2)}초`}><span>{node.name}</span>{timelineMarkers(node.keyframes).map((keyframe, frameIndex) => <i key={frameIndex} style={{ left: `${clamp((keyframe.time - node.start) / Math.max(0.01, node.end - node.start) * 100, 1, 99)}%` }} />)}</button><div className="track-playhead" style={{ left: `${percent}%` }} /></div></div>)}{!filteredNodes.length && <div className="timeline-empty">{project.nodes.length ? '검색과 현재 화면 필터에 맞는 요소가 없습니다.' : '요소를 추가하면 타임라인에 표시됩니다.'}</div>}</div></div></div>
      </section>

      <aside inert={chunkLoading} className={`inspector-panel side-panel ${mobilePanel === 'inspector' ? 'mobile-open' : ''}`}><div className="panel-heading"><h2>속성</h2><div className="inspector-heading-actions"><span className="micro-label">INSPECTOR</span><button className="icon-button panel-close" aria-label="속성 패널 닫기" onClick={() => setMobilePanel(null)}><X size={15} /></button></div></div>
        {selected ? <div className="inspector-scroll" key={selected.id}><div className="selection-summary"><div className="selection-icon"><NodeIcon type={selected.type} size={20} /></div><div><strong>{selected.name}</strong><span>{hasTextWarp(selected) ? '원근 텍스트' : NODE_LABELS[selected.type]}<i />{selected.keyframes.length} 키프레임</span></div><button className={`icon-button ${selected.locked ? 'is-locked' : ''}`} aria-label={selected.locked ? '선택 요소 잠금 해제' : '선택 요소 잠금'} title={selected.locked ? '잠금 해제' : '잠금'} onClick={() => patchNode({ locked: !selected.locked })}>{selected.locked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</button></div>
          {hasTextWarp(selected) && <PerspectiveTextNotice />}
          {selected.locked && <div className="locked-notice"><LockKeyhole size={13} />수정하려면 잠금을 해제하세요.</div>}
          <div className="inspector-section"><div className="section-title"><h3>기본 속성</h3><span>01</span></div><TextField label="요소 이름" value={selected.name} disabled={selected.locked} onChange={name => patchNode({ name })} />{selected.type === 'text' && <><TextField label="텍스트" multiline value={selected.text ?? ''} disabled={selected.locked} onChange={text => patchNode({ text })} /><TextField label="글꼴" value={selected.fontFamily ?? 'sans-serif'} disabled={selected.locked} onChange={fontFamily => patchNode({ fontFamily })} /><div className="field-grid"><NumberField label="글자 크기" value={selected.fontSize ?? 32} min={1} max={2000} suffix="px" disabled={selected.locked} onChange={fontSize => patchNode({ fontSize })} /><NumberField label="글자 굵기" value={selected.fontWeight ?? 400} min={100} max={900} step={100} disabled={selected.locked} onChange={fontWeight => patchNode({ fontWeight })} /></div></>}</div>
          {hasTextWarp(selected) && <PerspectiveTextPanel node={selected} preserveAspect={preserveAspect} onPreserveAspectChange={setPreserveAspect} showOcclusion={showOcclusion} onShowOcclusionChange={setShowOcclusion} onPatch={patchNode} />}
          <div className="inspector-section"><div className="section-title"><h3>위치와 크기</h3><span>02</span></div><div className="field-grid"><NumberField label="X 위치" value={selected.x} suffix="px" disabled={selected.locked} onChange={x => patchNode({ x })} /><NumberField label="Y 위치" value={selected.y} suffix="px" disabled={selected.locked} onChange={y => patchNode({ y })} /><NumberField label="너비" value={selected.width} min={1} suffix="px" disabled={selected.locked} onChange={width => resizeNode('width', width)} /><NumberField label="높이" value={selected.height} min={1} suffix="px" disabled={selected.locked} onChange={height => resizeNode('height', height)} /><NumberField label="회전" value={selected.rotation} min={-360000} max={360000} suffix="°" disabled={selected.locked} onChange={rotation => patchNode({ rotation })} /><NumberField label="불투명도" value={Math.round(selected.opacity * 100)} min={0} max={100} suffix="%" disabled={selected.locked} onChange={opacity => patchNode({ opacity: opacity / 100 })} /></div><p className="field-hint">키프레임 움직임에 적용되는 기준값입니다.</p></div>
          <div className="inspector-section"><div className="section-title"><h3>스타일</h3><span>03</span></div>{(selected.gradient || selected.paintRegions?.length || selected.keyframes.some(frame => frame.fill || frame.gradient || frame.paintRegions?.length)) && <p className="perspective-control-note">색상을 직접 바꾸면 추정된 색상·음영 변화를 단색으로 통일합니다.</p>}<ColorField label="채우기" value={selected.fill} disabled={selected.locked} onChange={fill => patchNode({ fill })} /><div className="bulk-fill"><label className="bulk-fill-toggle"><input type="checkbox" aria-label="비슷한 색상 함께 변경" checked={showBulkFill} disabled={selected.locked} onChange={event => setShowBulkFill(event.target.checked)} /><span>비슷한 색상 함께 변경</span><strong>{similarIds.size}개</strong></label>{showBulkFill && <div className="bulk-fill-controls"><p>{composition ? '현재 장면의 비슷한 채우기 색상' : '전체 프로젝트의 비슷한 채우기 색상'}<br />RGB 거리 ≤ 24 · 잠긴 요소 제외</p><ColorField label="일괄 변경할 색상" value={bulkFill} disabled={selected.locked} onChange={setBulkFill} /><button className="button small" aria-label="색상 일괄 적용" disabled={selected.locked || !similarIds.size || !project.nodes.some(node => similarIds.has(node.id) && (node.fill !== bulkFill || node.gradient || node.paintRegions?.length || node.keyframes.some(frame => frame.fill || frame.gradient || frame.paintRegions?.length)))} onClick={applySimilarFill}>{similarIds.size}개 요소에 적용</button></div>}</div><div className="field-grid"><ColorField label="선 색상" value={selected.stroke} disabled={selected.locked} onChange={stroke => patchNode({ stroke })} /><NumberField label="선 두께" value={selected.strokeWidth} min={0} max={10000} suffix="px" disabled={selected.locked} onChange={strokeWidth => patchNode({ strokeWidth })} /></div>{selected.type === 'rect' && <NumberField label="모서리 반경" value={selected.borderRadius ?? 0} min={0} suffix="px" disabled={selected.locked} onChange={borderRadius => patchNode({ borderRadius })} />}</div>
          <div className="inspector-section"><div className="section-title"><h3>표시 구간</h3><span>04</span></div><div className="field-grid"><NumberField label="시작 시간" value={selected.start + segmentOffset} min={segmentOffset} max={Math.max(segmentOffset, selected.end + segmentOffset - 1 / project.fps)} step={1 / project.fps} suffix="s" disabled={selected.locked} onChange={start => patchNode({ start: start - segmentOffset })} /><NumberField label="종료 시간" value={selected.end + segmentOffset} min={selected.start + segmentOffset + 1 / project.fps} max={project.duration + segmentOffset} step={1 / project.fps} suffix="s" disabled={selected.locked} onChange={end => patchNode({ end: end - segmentOffset })} /></div></div>
          {selected.evidence && <div className={`evidence-note ${selected.evidence.needsReview ? 'needs-review' : ''}`}><div>{selected.evidence.needsReview ? <CircleAlert size={13} /> : <CheckCircle2 size={13} />}<strong>{selected.evidence.needsReview ? '직접 확인이 필요한 요소' : '분석 근거'}</strong></div><p>{selected.evidence.note || `${selected.evidence.observations}개 관측 프레임 · ${selected.evidence.method}`}</p></div>}
          <div className="inspector-node-actions"><button className="button small" disabled={selected.locked} onClick={duplicateNode}><Copy size={12} />복제</button><button className="button small danger-button" disabled={selected.locked} onClick={removeNode}><Trash2 size={12} />삭제</button></div>
        </div> : <div className="inspector-empty"><MousePointer2 size={26} strokeWidth={1.3} /><strong>편집할 요소를 선택하세요</strong><span>미리보기 또는 요소 목록에서 선택할 수 있습니다.</span></div>}
        <div className="project-inspector"><span>캔버스 배경</span><input type="color" aria-label="캔버스 배경 색상" value={/^#[0-9a-f]{6}$/i.test(project.background) ? project.background : '#101211'} onChange={event => commit(previous => ({ ...previous, background: event.target.value, backgroundKeyframes: undefined }))} /></div>
      </aside>
    </main>

    <footer className="app-footer" inert={restoring}><span><i />로컬에서 분석하고, 웹으로 내보내기</span><button className={warnings.length || reviewCount ? 'has-warnings' : ''} onClick={() => setShowWarnings(!showWarnings)}><CircleAlert size={12} />{warnings.length || reviewCount ? `분석 참고 ${warnings.length} · 확인할 요소 ${reviewCount}` : '재구성 안내'}<ChevronDown size={11} /></button><span className="footer-shortcuts"><kbd>Space</kbd>재생<kbd>← →</kbd>프레임 이동</span></footer>
    {showWarnings && <div className="review-panel"><div><strong>재구성 안내</strong><button className="icon-button" aria-label="분석 안내 닫기" onClick={() => setShowWarnings(false)}><X size={14} /></button></div><p>원본의 픽셀을 텍스트와 벡터 요소로 추정한 초안입니다. 겹침, 글꼴, 복잡한 효과는 원본과 비교하여 보정해 주세요. 오디오는 포함하지 않습니다.</p>{warnings.length > 0 && <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}{reviewCount > 0 && <span>{reviewCount}개 요소의 속성 패널에서 분석 근거를 확인할 수 있습니다.</span>}</div>}
    {restoring && <div className="restore-overlay" role="status" aria-live="polite"><LoaderCircle className="spinning" size={25} /><strong>저장된 프로젝트를 복원하고 있습니다</strong><span>복원이 끝나면 바로 편집할 수 있습니다.</span></div>}
    {pendingVideo && <ClipSelectionDialog source={pendingVideo} quality={analysisQuality} onQualityChange={setAnalysisQuality} onCancel={dismissClip} onConfirm={confirmClip} />}
    {toast && <div className="toast" role="status"><Check size={15} /><span>{toast}</span><button aria-label="알림 닫기" onClick={() => setToast(null)}><X size={13} /></button></div>}
    {dragging && <div className="drop-overlay"><div><Upload size={34} strokeWidth={1.5} /><h2>움직임을 여기에 놓아주세요.</h2><p>텍스트, 도형, 아이콘을 편집 가능한 웹 요소로 변환합니다.</p><span>MP4 · WebM · MOV / 최대 100MB · 전체 영상 최대 60초</span></div></div>}
  </div>;
}
