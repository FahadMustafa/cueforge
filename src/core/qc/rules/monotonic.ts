/**
 * Rule 14 (spec §5.2): `cue-count-monotonic-timing` — cue start times must be
 * non-decreasing in document order. Flag-only (reordering is the editor's job,
 * not an automatic fix). Flags each cue whose start regresses below its
 * predecessor's.
 */

import { positionLabelFor } from '../format';
import type { RuleDefinition, RuleViolation } from '../rule';

export const cueCountMonotonicTiming: RuleDefinition<'cue-count-monotonic-timing'> = {
  id: 'cue-count-monotonic-timing',
  fixable: false,
  evaluate(doc) {
    const position = positionLabelFor(doc);
    const out: RuleViolation[] = [];
    for (let i = 1; i < doc.cues.length; i++) {
      const prev = doc.cues[i - 1]!;
      const cur = doc.cues[i]!;
      if (cur.startMs < prev.startMs) {
        out.push({
          cueIndex: cur.index,
          message: `Starts at ${position(cur.startMs)}, before the previous cue's start ${position(prev.startMs)}.`,
        });
      }
    }
    return out;
  },
};
