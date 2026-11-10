import { frameToMs, frameToTimecode, msToFrame } from '../formats/scc/cea608';

/**
 * Shared fps/timecode formatter (cue-forge-d9b.1). The single source of truth
 * for converting integer milliseconds to frames and `HH:MM:SS:FF` timecode, used
 * by the QC engine, the cue table, Sync, and the Studio timeline. Lives in core
 * so pure (framework-free) surfaces — QC rule messages — can import it too.
 *
 * The 29.97 (30000/1001) timebase delegates to the SCC CEA-608 primitives so
 * drop-frame timecode and the continuous frame count stay byte-for-byte
 * consistent with the SCC codec.
 */

/** The 29.97 (30000/1001) timebase is the only standard fps with drop-frame timecode. */
export const DROP_FRAME_FPS = 29.97;

/** True only for 29.97, where drop-frame timecode applies. */
export function supportsDropFrame(fps: number): boolean {
  return fps === DROP_FRAME_FPS;
}

/**
 * True for the 29.97 NTSC family: the canonical 29.97 label *or* the exact
 * 30000/1001 rate (≈29.97002997) that the SCC parser records verbatim
 * (cue-forge-w28.9). Per SMPTE ST 12-1 this family can carry drop-frame or
 * non-drop timecode, so callers with an explicit drop-frame hint (e.g. SCC's
 * `metadata.raw.dropFrame`) use this to decide whether the hint applies, while
 * {@link supportsDropFrame} keeps its narrow "29.97 defaults to DF" meaning.
 */
export function isDropFrameFamily(fps: number): boolean {
  return Math.abs(fps - DROP_FRAME_FPS) < 0.001;
}

/** Exact frames-per-second by timebase (23.976 → 24000/1001, 29.97 → 30000/1001). */
const EXACT_FPS: Record<number, number> = {
  23.976: 24000 / 1001,
  24: 24,
  25: 25,
  29.97: 30000 / 1001,
  30: 30,
};

/** Nominal integer fps used for the timecode FF field (23.976 → 24, 29.97 → 30). */
const NOMINAL_FPS: Record<number, number> = {
  23.976: 24,
  24: 24,
  25: 25,
  29.97: 30,
  30: 30,
};

/** Duration of one frame in ms on the given fps's exact timebase. */
export function frameDurationMs(fps: number): number {
  const exact = EXACT_FPS[fps] ?? fps;
  return 1000 / exact;
}

/** Nearest frame index for a ms value; 29.97 delegates to the SCC 30000/1001 mapping. */
export function msToFrameGeneral(ms: number, fps: number): number {
  if (fps === DROP_FRAME_FPS) return msToFrame(ms);
  const exact = EXACT_FPS[fps] ?? fps;
  return Math.round((ms * exact) / 1000);
}

/** Ms at the start of a frame index; 29.97 delegates to the SCC 30000/1001 mapping. */
export function frameToMsGeneral(frame: number, fps: number): number {
  if (fps === DROP_FRAME_FPS) return frameToMs(frame);
  const exact = EXACT_FPS[fps] ?? fps;
  return Math.round((frame * 1000) / exact);
}

/**
 * Whole frames spanned by a *duration* (or gap) of `ms` at `fps`. A duration
 * starts at frame 0, so this is the same arithmetic as {@link msToFrameGeneral}
 * but named for the duration/gap use site (QC min/max-duration, min-gap, the cue
 * table duration cell). 29.97 uses the continuous SCC frame count.
 */
export function durationFrames(ms: number, fps: number): number {
  return msToFrameGeneral(ms, fps);
}

/**
 * Move `ms` by exactly one frame in `dir`, clamping at frame 0. Drop-frame is
 * accepted for API symmetry but does not change the ms result — it is a timecode
 * labeling scheme over the same continuous 30000/1001 frame count.
 */
export function stepFrame(ms: number, fps: number, _dropFrame: boolean, dir: 1 | -1): number {
  const frame = msToFrameGeneral(ms, fps);
  const next = Math.max(0, frame + dir);
  return frameToMsGeneral(next, fps);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Format `ms` as a timecode for `fps`. 29.97 (DF/non-DF) delegates to the SCC formatter. */
export function msToTimecode(ms: number, fps: number, dropFrame: boolean): string {
  if (fps === DROP_FRAME_FPS) {
    return frameToTimecode(msToFrame(ms), dropFrame);
  }
  const nominal = NOMINAL_FPS[fps] ?? Math.round(fps);
  const frame = msToFrameGeneral(ms, fps);
  const ff = frame % nominal;
  const totalSeconds = Math.floor(frame / nominal);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

/**
 * Milliseconds for a 29.97 drop-frame timecode's HH:MM:SS:FF fields, the inverse
 * of {@link msToTimecode}'s drop path. Drop-frame skips the first two frame
 * numbers of every minute except every tenth to keep the label near wall-clock;
 * this rebuilds the absolute frame count and maps it on the 30000/1001 timebase.
 * Used to decode iTT/TTML timecodes whose drop mode is declared via
 * `ttp:dropMode` rather than a `;` separator (cue-forge-sdv.17).
 */
export function dropFrameTimecodeToMs(h: number, m: number, s: number, f: number): number {
  const totalMinutes = h * 60 + m;
  const dropped = 2 * (totalMinutes - Math.floor(totalMinutes / 10));
  const frame = (totalMinutes * 60 + s) * 30 + f - dropped;
  return frameToMs(frame);
}
