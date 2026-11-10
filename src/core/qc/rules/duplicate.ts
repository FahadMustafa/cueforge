/**
 * Rule 10 (spec §5.2): `duplicate-cue` — flag-only. Flags a cue whose trimmed
 * text repeats the immediately preceding cue (the common "stutter" artefact).
 * Empty cues are left to `empty-cue` so the two rules don't double-report.
 */

import { cueToText } from '../../model/cue';
import type { RuleDefinition, RuleViolation } from '../rule';

export const duplicateCue: RuleDefinition<'duplicate-cue'> = {
  id: 'duplicate-cue',
  fixable: false,
  evaluate(doc) {
    const out: RuleViolation[] = [];
    for (let i = 1; i < doc.cues.length; i++) {
      const prev = cueToText(doc.cues[i - 1]!).trim();
      const cur = cueToText(doc.cues[i]!).trim();
      if (cur !== '' && cur === prev) {
        out.push({ cueIndex: doc.cues[i]!.index, message: 'Repeats the previous cue’s text.' });
      }
    }
    return out;
  },
};
