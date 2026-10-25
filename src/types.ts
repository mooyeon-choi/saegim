export type NodeType = 'rect' | 'ellipse' | 'path' | 'text' | 'line';
export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold';
export interface WarpPoint { u: number; x: number; y: number }
/** Normalized node coordinates (0..1000), paired at the same ascending u (0..1). */
export interface TextWarp { top: WarpPoint[]; bottom: WarpPoint[] }
export interface GradientStop { offset: number; color: string }
export type FillGradient = { type: 'linear'; x1: number; y1: number; x2: number; y2: number; stops: GradientStop[] }
  | { type: 'radial'; cx: number; cy: number; r: number; fx?: number; fy?: number; stops: GradientStop[] };
export interface EmbeddedFont { family: string; mimeType: 'font/ttf' | 'font/otf' | 'font/woff2'; data: string; weight?: number; style?: 'normal' | 'italic'; license?: string }
/** Opt-in back-to-front fill stack; only the silhouette alpha is softened, in project pixels. */
export interface StackBoundary { featherPx: number; cornerRadiusPx?: number }
/** Fill-only repaint clipped in normalized node coordinates (0..1000), with even-odd holes. */
/** With stackBoundary, translucent regions composite over an opaque base. */
export interface PaintRegion { path: string; fill: string; gradient?: FillGradient | null; featherPx?: number }

/** Absolute timeline seconds; transforms are relative to node base properties. */
export interface MotionKeyframe {
  time: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  easing?: Easing;
  /** Observed SVG contour, normalized to 0..1000, held until the next sampled contour. */
  path?: string;
  fill?: string;
  gradient?: FillGradient | null;
  /** Held per observation; [] clears node-level paint regions. */
  paintRegions?: PaintRegion[];
  /** Held per observation; null restores legacy coverage composition. */
  stackBoundary?: StackBoundary | null;
  textWarp?: TextWarp;
  occlusionPath?: string;
  textReveal?: number;
}

export interface MotionNode {
  id: string;
  name: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  borderRadius?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  letterSpacing?: number;
  fontStyle?: 'normal' | 'italic';
  textFit?: 'width';
  /** Fixed glyph source box measured with baseline=0 at the calibration fontSize. */
  textBox?: { x: number; y: number; width: number; height: number; advance?: number };
  textWarp?: TextWarp;
  textReveal?: number;
  /** Black occluding contour in normalized node coordinates, held per observation. */
  occlusionPath?: string;
  gradient?: FillGradient;
  paintRegions?: PaintRegion[];
  /** Optional source-over fill layers with one final silhouette alpha. Non-text only. */
  stackBoundary?: StackBoundary;
  /** SVG path data in a 0 0 1000 1000 coordinate system. */
  path?: string;
  start: number;
  end: number;
  hidden: boolean;
  locked: boolean;
  keyframes: MotionKeyframe[];
  evidence?: { method: string; observations: number; needsReview: boolean; note?: string };
}

export interface MotionScene { id: string; name: string; start: number; end: number }
/** frames redraws one observation, blend connects observations, off evaluates continuous time.
 * Cuts use local/global seconds in projects/compositions respectively. */
export interface MotionTemporal { mode: 'blend' | 'off' | 'frames'; sampleFps: number; cuts: number[] }
export type AffineMatrix = [number, number, number, number, number, number];
/** A validated, static vector observation. No media, fonts, text or nested projects. */
export interface BackgroundAnchor { background: string; nodes: MotionNode[] }
export interface BackgroundMotionTrack {
  id: string;
  /** Local seconds in a project; global seconds in a composition. End is exclusive. */
  start: number; end: number; anchorTime: number;
  /** Fixed safe region in project pixels. Feather fades inward, never outside this polygon. */
  polygon: [number, number][];
  featherPx: number;
  /** Smoothstep overlay attachment/release within the supported window, in seconds. */
  fadeIn?: number; fadeOut?: number;
  keys: { time: number; matrix: AffineMatrix; gain?: [number, number, number]; bias?: [number, number, number] }[];
  interpolation: 'linear' | 'pchip';
  /** Descending cubic powers of dt in seconds, one coefficient tuple per interval. */
  pchip?: { breakpoints: number[]; channels: Record<'a' | 'b' | 'c' | 'd' | 'e' | 'f', [number, number, number, number][]> & Partial<Record<'gainR' | 'gainG' | 'gainB' | 'biasR' | 'biasG' | 'biasB', [number, number, number, number][]>> };
  anchor: BackgroundAnchor;
}
export interface BackgroundMotion { mode: 'on' | 'off'; tracks: BackgroundMotionTrack[] }
/** A local alignment between two adjacent observations, never a path morph. */
export interface ForegroundMotionTrack {
  id: string;
  /** Local seconds in a project, global seconds in a composition. */
  start: number; end: number;
  polygon: [number, number][];
  featherPx: number;
  /** Source-pixel affine transform from the first observation to the second. */
  forward: AffineMatrix;
  /** Local appearance blend: beta(midpoint)=0.5; geometry still uses timeline alpha. */
  appearance?: { midpoint: number; sharpness: number };
  /** Preserve this fully observed endpoint where the other leaves its viewport. Requires appearance. */
  viewportFallback?: 'from' | 'to';
  label?: string;
}
export interface ForegroundMotion { mode: 'on' | 'off'; tracks: ForegroundMotionTrack[] }
export interface MotionProject {
  schemaVersion: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  background: string;
  temporal?: MotionTemporal;
  backgroundMotion?: BackgroundMotion;
  foregroundMotion?: ForegroundMotion;
  fonts?: EmbeddedFont[];
  backgroundKeyframes?: { time: number; color: string }[];
  nodes: MotionNode[];
  scenes: MotionScene[];
  source?: { name: string; url: string; width: number; height: number; duration: number; fps: number };
  analysis?: { engine: string; sampleCount: number; warnings: string[]; createdAt: string };
}

export interface AnalysisJob {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  stage: string;
  error?: string;
  project?: MotionDocument;
}

/** An independently compressed, local-time schema 1 project. No source media is embedded. */
export interface MotionSegment {
  id: string;
  name: string;
  start: number;
  end: number;
  encoding: 'gzip-base64';
  data: string;
  uncompressedBytes: number;
  nodeCount: number;
}
export interface MotionComposition {
  schemaVersion: 2;
  id: string;
  name: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  background: string;
  temporal?: MotionTemporal;
  backgroundMotion?: BackgroundMotion;
  foregroundMotion?: ForegroundMotion;
  segments: MotionSegment[];
  source?: MotionProject['source'];
  analysis?: MotionProject['analysis'];
}
export type MotionDocument = MotionProject | MotionComposition;
