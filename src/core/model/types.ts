/**
 * Canonical internal data model (spec §2).
 *
 * Every parser converts a source format *to* a {@link SubtitleDocument}; every
 * serializer converts *from* one. Conversion between any two formats is
 * parse → (optional transforms) → serialize — never a format-to-format shortcut.
 *
 * All timing is stored as integer milliseconds.
 */

export type SubtitleFormat =
  | 'srt'
  | 'vtt'
  | 'sbv'
  | 'ass'
  | 'ssa'
  | 'ttml'
  | 'scc'
  | 'stl'
  | 'itt'
  | 'imsc101'
  | 'imsc11'
  | 'mcc'
  | 'ebuttd';

/**
 * A run of text sharing the same inline styling. Text per visual line is a list
 * of spans so styling (italic/bold/underline/color/voice) is preserved.
 */
export interface StyledSpan {
  text: string;
  italic?: boolean;
  bold?: boolean;
  underline?: boolean;
  /** Color token preserved verbatim (e.g. "#FF0000", "red", "&H0000FF&"). */
  color?: string;
  /** VTT voice name (`<v Name>`). */
  voice?: string;
  /**
   * Markup preserved but not interpreted (e.g. ASS override blocks `{\pos(..)}`)
   * when converting to a format that cannot express it. Kept for round-trip.
   */
  opaque?: string;
}

/** One visual line of a cue. */
export interface CueLine {
  spans: StyledSpan[];
}

export type CueAlign = 'start' | 'center' | 'end' | 'left' | 'right';
export type WritingDirection = 'horizontal' | 'vertical-rl' | 'vertical-lr';

/** Vertical/horizontal placement, where the source format expresses it. */
export interface CuePosition {
  /** VTT line setting; number (line index or %) or 'auto'. */
  line?: number | 'auto';
  /** Whether {@link line} is a percentage rather than a line index. */
  linePercent?: boolean;
  /** Horizontal position (percentage). */
  position?: number;
  align?: CueAlign;
  /** Region/box size (percentage). */
  size?: number;
  vertical?: WritingDirection;
  /** Original cue-setting tokens preserved verbatim for lossless round-trip. */
  raw?: string;
}

export interface Cue {
  index: number;
  /**
   * Process-unique cue identity that survives index renumbering (cue-forge-9ww.7).
   * Assigned by the app at import and minted by cue-creating ops; `index` is
   * renumbered to 1..n on every structural edit, so the UI tracks a durable
   * selection by `uid` (not position or index) to avoid drift. App-layer only —
   * never serialized to any output format.
   */
  uid?: string;
  /**
   * The cue's original source caption number, retained when repair-on-import
   * renumbers {@link index} to a contiguous 1..n sequence (cue-forge-q7q). Set
   * only when renumbering actually changed the number, so the UI can reconcile
   * our `#N` with an operator's reference list (e.g. a conform/QC sheet keyed on
   * the delivery file's original numbering). Undefined when source == canonical.
   */
  sourceIndex?: number;
  /** Start time in integer milliseconds. */
  startMs: number;
  /** End time in integer milliseconds. */
  endMs: number;
  lines: CueLine[];
  position?: CuePosition;
  /** ASS/TTML style references, preserved. */
  styleRefs?: string[];
  /** Format-specific cue identifier (e.g. a WebVTT cue id) preserved verbatim. */
  id?: string;
  /** Format-specific payload needed for lossless round-trip. */
  raw?: unknown;
}

export interface DocMetadata {
  sourceFormat: SubtitleFormat;
  /** Frames per second, when the source declares or implies one. */
  frameRate?: number;
  /** Primary language tag (e.g. "ar", "en"). */
  language?: string;
  /** Verbatim header/section payload preserved per format for round-trip. */
  raw?: Record<string, unknown>;
}

export type WarningCode =
  | 'missing-index'
  | 'non-numeric-index'
  | 'overlap'
  | 'reversed-timing'
  | 'empty-cue'
  | 'malformed-timing'
  | 'unexpected-content'
  | 'unclosed-tag'
  | 'hour-overflow'
  | 'missing-signature'
  | (string & {});

/** Anything tolerated-but-suspect during parse (spec §2). */
export interface ParseWarning {
  code: WarningCode;
  message: string;
  /** Index of the offending cue, when applicable. */
  cueIndex?: number;
  /** 1-based source line number, when known. */
  sourceLine?: number;
}

export interface SubtitleDocument {
  cues: Cue[];
  metadata: DocMetadata;
  warnings: ParseWarning[];
}
