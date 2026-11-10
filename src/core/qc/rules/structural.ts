/**
 * Rules 7–9 (spec §5.2): `overlap`, `reversed-timing`, `empty-cue`. All three are
 * auto-fixable (7: trim the earlier cue clear of the later's start; 8: swap
 * start/end; 9: drop the empty cue).
 */

import { cueToText } from '../../model/cue';
import { positionLabelFor } from '../format';
import type { RuleDefinition, RuleViolation } from '../rule';
import { FIX_DURATION_FLOOR_MS, FIX_GAP_FLOOR_MS } from './durations';

export const overlap: RuleDefinition<'overlap'> = {
  id: 'overlap',
  fixable: true,
  evaluate(doc) {
    const position = positionLabelFor(doc);
    const out: RuleViolation[] = [];
    for (let i = 0; i + 1 < doc.cues.length; i++) {
      const cur = doc.cues[i]!;
      const next = doc.cues[i + 1]!;
      if (next.startMs < cur.endMs) {
        out.push({
          cueIndex: next.index,
          message: `Overlaps the previous cue: starts ${position(next.startMs)}, previous ends ${position(cur.endMs)}.`,
        });
      }
    }
    return out;
  },
  // Trim each earlier cue's end clear of the later cue's start, restoring the
  // conservative gap in the same move. When the trim would leave the cue below
  // the duration floor (the old clamp produced 0 ms cues, cue-forge-mz1), the
  // fix declines and the overlap stays flagged rather than trade it for a new
  // min-duration violation.
  fix(doc) {
    const cues = doc.cues.map((c) => ({ ...c }));
    for (let i = 0; i + 1 < cues.length; i++) {
      const cur = cues[i]!;
      const next = cues[i + 1]!;
      if (next.startMs >= cur.endMs) continue;
      const endMs = next.startMs - FIX_GAP_FLOOR_MS;
      if (endMs - cur.startMs >= FIX_DURATION_FLOOR_MS) cur.endMs = endMs;
    }
    return { ...doc, cues };
  },
};

export const reversedTiming: RuleDefinition<'reversed-timing'> = {
  id: 'reversed-timing',
  fixable: true,
  evaluate(doc) {
    const position = positionLabelFor(doc);
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      if (cue.endMs < cue.startMs) {
        out.push({
          cueIndex: cue.index,
          message: `End ${position(cue.endMs)} is before start ${position(cue.startMs)}.`,
        });
      }
    }
    return out;
  },
  // Swap the reversed start and end.
  fix(doc) {
    const cues = doc.cues.map((cue) =>
      cue.endMs < cue.startMs ? { ...cue, startMs: cue.endMs, endMs: cue.startMs } : cue,
    );
    return { ...doc, cues };
  },
};

export const emptyCue: RuleDefinition<'empty-cue'> = {
  id: 'empty-cue',
  fixable: true,
  evaluate(doc) {
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      if (cueToText(cue).trim() === '') {
        out.push({ cueIndex: cue.index, message: 'Cue has no text.' });
      }
    }
    return out;
  },
  // Drop empty cues and renumber the survivors so indices stay contiguous.
  fix(doc) {
    const cues = doc.cues
      .filter((cue) => cueToText(cue).trim() !== '')
      .map((cue, i) => ({ ...cue, index: i + 1 }));
    return { ...doc, cues };
  },
};
