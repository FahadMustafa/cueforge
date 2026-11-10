import type { SubtitleDocument } from '../model/types';
import {
  DROP_FRAME_FPS,
  durationFrames,
  isDropFrameFamily,
  msToTimecode,
  supportsDropFrame,
} from '../timing/timecode';

/**
 * Shared frame-aware labels for QC rule messages (cue-forge-d9b.1). Positions
 * render as `HH:MM:SS:FF` timecode with the raw ms as a secondary, durations and
 * gaps as a frame count with ms secondary — but only when the document declares a
 * frame rate. Without one, both degrade to the plain `N ms` form QC has always
 * used.
 *
 * Drop-frame (cue-forge-w28.9): per SMPTE ST 12-1, 29.97 material can be
 * drop-frame OR non-drop, and some sources record which (the SCC parser stores
 * `metadata.raw.dropFrame`). When the source is explicit the label honours it —
 * an NDF SCC's QC messages use the same colon timecodes as the user's file.
 * When the mode is unknown, the historical convention holds: the canonical
 * 29.97 label defaults to drop-frame, everything else to non-drop.
 */

/**
 * The source document's declared drop-frame mode, when it recorded one
 * (currently only the SCC parser does, via `metadata.raw.dropFrame`).
 * `undefined` means "unknown" and keeps {@link positionLabelFor}'s default.
 */
export function docDropFrame(doc: Pick<SubtitleDocument, 'metadata'>): boolean | undefined {
  const df = doc.metadata.raw?.['dropFrame'];
  return typeof df === 'boolean' ? df : undefined;
}

/**
 * Doc-bound position labels: reads the document's frame rate and explicit
 * drop-frame mode (see {@link docDropFrame}) once and returns an
 * `(ms) => string` renderer. Rules that print absolute positions should call
 * this at the top of `evaluate` rather than threading fps/dropFrame by hand —
 * the raw form's optional drop-frame arg is easy to omit, which silently falls
 * back to the "29.97 ⇒ DF" convention and mislabels explicit-NDF SCC docs.
 */
export function positionLabelFor(doc: Pick<SubtitleDocument, 'metadata'>): (ms: number) => string {
  const fps = doc.metadata.frameRate;
  const dropFrame = docDropFrame(doc);
  return (ms) => positionLabel(ms, fps, dropFrame);
}

/**
 * An absolute time position: `HH:MM:SS:FF (N ms)` when fps known, else `N ms`.
 * `dropFrame` is the source's explicit mode (see {@link docDropFrame}); it only
 * applies at 29.97-family rates and defaults to the historical convention
 * (29.97 ⇒ DF) when undefined.
 *
 * Internal on purpose: use {@link positionLabelFor}, which derives both args
 * from the document and can't be called with a half-threaded pairing.
 */
function positionLabel(ms: number, fps?: number, dropFrame?: boolean): string {
  if (fps === undefined) return `${ms} ms`;
  const family = isDropFrameFamily(fps);
  const df = family && (dropFrame ?? supportsDropFrame(fps));
  // Normalize the family to the canonical label so msToTimecode takes the SCC
  // 30000/1001 path (same frame arithmetic, but it can render `;` when df).
  return `${msToTimecode(ms, family ? DROP_FRAME_FPS : fps, df)} (${ms} ms)`;
}

/** A duration or gap: `N frames (N ms)` when fps known, else `N ms`. */
export function durationLabel(ms: number, fps?: number): string {
  if (fps === undefined) return `${ms} ms`;
  const frames = durationFrames(ms, fps);
  return `${frames} ${frames === 1 ? 'frame' : 'frames'} (${ms} ms)`;
}
