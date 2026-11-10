import type { Cue, SubtitleDocument } from './model/types';

/**
 * Automatic repair-on-import (spec §4.1.5). BOM stripping and encoding
 * normalization happen earlier at the decode boundary; this pure transform
 * fixes the parsed document: renumber indices, normalize timestamps (floor to
 * integer ms, clamp negatives to 0), and fix reversed start/end. Each change is
 * reported as a {@link RepairAction} so the UI can surface it.
 */

export type RepairCode = 'renumber' | 'normalize-timing' | 'fix-reversed';

export interface RepairAction {
  code: RepairCode;
  message: string;
  cueIndex?: number;
}

export interface RepairOptions {
  renumber?: boolean;
  normalizeTiming?: boolean;
  fixReversed?: boolean;
}

export interface RepairResult {
  doc: SubtitleDocument;
  repairs: RepairAction[];
}

export function repairDocument(doc: SubtitleDocument, options: RepairOptions = {}): RepairResult {
  const { renumber = true, normalizeTiming = true, fixReversed = true } = options;
  const repairs: RepairAction[] = [];
  let renumbered = false;

  const cues: Cue[] = doc.cues.map((c, i) => {
    let startMs = c.startMs;
    let endMs = c.endMs;

    if (normalizeTiming) {
      const ns = Math.max(0, Math.floor(startMs));
      const ne = Math.max(0, Math.floor(endMs));
      if (ns !== startMs || ne !== endMs) {
        repairs.push({
          code: 'normalize-timing',
          message: `Normalized timing of cue ${c.index}.`,
          cueIndex: c.index,
        });
        startMs = ns;
        endMs = ne;
      }
    }

    if (fixReversed && endMs < startMs) {
      [startMs, endMs] = [endMs, startMs];
      repairs.push({
        code: 'fix-reversed',
        message: `Swapped reversed start/end of cue ${c.index}.`,
        cueIndex: c.index,
      });
    }

    const index = renumber ? i + 1 : c.index;
    const changed = renumber && index !== c.index;
    if (changed) renumbered = true;

    // Retain the original caption number the first time renumbering moves it, so
    // the UI can reconcile our `#N` with the source file's numbering (q7q). The
    // spread carries an existing sourceIndex forward, so this is idempotent.
    const out: Cue = { ...c, index, startMs, endMs };
    if (changed && out.sourceIndex === undefined) out.sourceIndex = c.index;
    return out;
  });

  if (renumbered) {
    repairs.push({ code: 'renumber', message: 'Renumbered cue indices sequentially.' });
  }

  return { doc: { ...doc, cues }, repairs };
}
