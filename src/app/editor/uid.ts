import type { Cue, SubtitleDocument } from '../../core/model';

/**
 * Stable cue identity for durable selection (cue-forge-9ww.7). Structural edits
 * renumber `cue.index` to a contiguous 1..n sequence, so neither the array
 * position nor the index is a stable handle for "the cue the operator selected".
 * A `uid` is: assigned to every cue at import ({@link assignUids}), minted by the
 * cue-creating ops (split / timeline create), and preserved by every other
 * transform's object spread. The Editor stores the selection by uid and resolves
 * the row at render, dropping the highlight when the cue is gone.
 */

/** A process-unique cue uid. */
export function newUid(): string {
  return crypto.randomUUID();
}

/**
 * Give every cue a uid, preserving any it already has (idempotent). Returns the
 * same document reference when no cue needed one, so it never churns identity.
 */
export function assignUids(doc: SubtitleDocument): SubtitleDocument {
  let changed = false;
  const cues = doc.cues.map((c) => {
    if (c.uid !== undefined) return c;
    changed = true;
    return { ...c, uid: newUid() };
  });
  return changed ? { ...doc, cues } : doc;
}

/** Row position of the cue with `uid`, or -1 if it is absent. */
export function indexOfUid(cues: readonly Cue[], uid: string | null): number {
  if (uid == null) return -1;
  return cues.findIndex((c) => c.uid === uid);
}

/** The uid of the cue at row `pos`, or null when `pos` is null/out of range. */
export function uidAt(cues: readonly Cue[], pos: number | null): string | null {
  if (pos == null) return null;
  return cues[pos]?.uid ?? null;
}
