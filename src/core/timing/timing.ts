import type { Cue, SubtitleDocument } from '../model/types';

/**
 * Timing tools (spec §4.1 #2): shift by an offset, linear (anchor) retime, and
 * frame-rate conversion. Every operation is pure — it returns a new
 * {@link SubtitleDocument} and never mutates its input — and clamps resulting
 * times at 0 (negative times are not representable, spec §2 / §6.3 #4).
 */

/** Standard broadcast/film frame rates supported for conversion (spec §4.1 #2). */
export const STANDARD_FPS = [23.976, 24, 25, 29.97, 30] as const;

/**
 * Snap a computed frame rate to the nearest standard label (cue-forge-zxw.11).
 * Parsers derive the exact effective NTSC rate (30·1000/1001 = 29.97002997…),
 * but the timecode helpers, drop-frame detection, and the fps pickers key on the
 * canonical 29.97/23.976 literals in {@link STANDARD_FPS}, so an un-snapped rate
 * silently labels drop-frame docs as non-drop and defaults the Studio picker to
 * 25. Snapping at the parse boundary keeps those lookups working — it only
 * relabels the rate, so callers must not reuse the result for ms conversion
 * (that would drift the timing).
 */
export function canonicalFps(fps: number): number {
  for (const std of STANDARD_FPS) {
    if (Math.abs(fps - std) < 0.02) return std;
  }
  return fps;
}

/** A single point in a linear retime: source time → desired output time. */
export interface Anchor {
  fromMs: number;
  toMs: number;
}

const clamp0 = (ms: number): number => {
  if (!Number.isFinite(ms)) {
    throw new RangeError('Resulting cue times are out of range. Choose a smaller timing change.');
  }
  return ms < 0 ? 0 : ms;
};

/** Apply a per-time transform to every cue, returning a new document. */
function mapCueTimes(doc: SubtitleDocument, fn: (ms: number) => number): SubtitleDocument {
  const cues: Cue[] = doc.cues.map((cue) => {
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.endMs < cue.startMs) {
      throw new RangeError('Cue times must be finite, with the end at or after the start.');
    }
    const startMs = fn(cue.startMs);
    const endMs = fn(cue.endMs);
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs < startMs) {
      throw new RangeError('Resulting cue times are out of range. Choose a smaller timing change.');
    }
    return { ...cue, startMs, endMs };
  });
  return { ...doc, cues };
}

/** Shift every cue by `offsetMs` (may be negative); results clamp at 0. */
export function shiftCues(doc: SubtitleDocument, offsetMs: number): SubtitleDocument {
  if (!Number.isFinite(offsetMs)) {
    throw new RangeError('The shift offset must be a finite number of milliseconds.');
  }
  return mapCueTimes(doc, (ms) => clamp0(Math.round(ms + offsetMs)));
}

export function linearRate(first: Anchor, second: Anchor): number {
  if (![first.fromMs, first.toMs, second.fromMs, second.toMs].every(Number.isFinite)) {
    throw new RangeError('All anchor times must be finite numbers of milliseconds.');
  }
  const sourceSpan = second.fromMs - first.fromMs;
  if (sourceSpan === 0) {
    throw new RangeError('The two anchors need distinct source times.');
  }
  const targetSpan = second.toMs - first.toMs;
  const rate = targetSpan / sourceSpan;
  if (
    !Number.isFinite(sourceSpan) ||
    !Number.isFinite(targetSpan) ||
    !Number.isFinite(rate) ||
    rate <= 0
  ) {
    throw new RangeError(
      'Target times must be distinct and follow the same order as source times (a finite positive rate).',
    );
  }
  return rate;
}

/**
 * Linearly retime so that `a.fromMs → a.toMs` and `b.fromMs → b.toMs`, applying
 * the same affine map to every cue (spec §4.1 #2). Requires finite anchors and
 * a positive rate; rejects invalid cue timing or unsafe integer-ms results.
 */
export function linearScale(doc: SubtitleDocument, a: Anchor, b: Anchor): SubtitleDocument {
  const slope = linearRate(a, b);
  return mapCueTimes(doc, (ms) => clamp0(Math.round(a.toMs + slope * (ms - a.fromMs))));
}

/** Exact rational form of a frame rate, so 23.976/29.97 keep the 1001 factor. */
function fpsRational(fps: number): { num: number; den: number } {
  if (fps === 23.976) return { num: 24000, den: 1001 };
  if (fps === 29.97) return { num: 30000, den: 1001 };
  // Integer rates (24/25/30) and any other value: treat as exact whole/decimal.
  return Number.isInteger(fps) ? { num: fps, den: 1 } : { num: Math.round(fps * 1000), den: 1000 };
}

/** Round `t * num / den` to the nearest integer using exact integer arithmetic. */
function scaleRounded(t: number, num: number, den: number): number {
  const x = t * num;
  const q = Math.floor(x / den);
  const r = x - q * den;
  return r * 2 >= den ? q + 1 : q;
}

/**
 * Convert frame rate from `fromFps` to `toFps` in any direction (spec §4.1 #2).
 * Frame numbers are preserved, so times scale by fromFps/toFps; round-trip error
 * stays under 1 ms per cue (spec §6.3 #4). Records the new rate in metadata.
 */
export function convertFrameRate(
  doc: SubtitleDocument,
  fromFps: number,
  toFps: number,
): SubtitleDocument {
  if (![fromFps, toFps].every((fps) => Number.isFinite(fps) && fps > 0)) {
    throw new RangeError('Source and target frame rates must be finite positive numbers.');
  }
  const from = fpsRational(fromFps);
  const to = fpsRational(toFps);
  // time_new = time_old * (fromNum/fromDen) / (toNum/toDen).
  const num = from.num * to.den;
  const den = from.den * to.num;
  if (![num, den].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('Frame rates are out of range. Choose supported frame rates.');
  }
  const scaled = mapCueTimes(doc, (ms) => clamp0(scaleRounded(ms, num, den)));
  return { ...scaled, metadata: { ...scaled.metadata, frameRate: toFps } };
}
