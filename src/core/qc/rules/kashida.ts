/**
 * Rule 19 (spec §5.3): `kashida-strip` — flag tatweel/kashida (U+0640) used as
 * visual padding and remove it on fix. Tatweel only elongates the joining stroke;
 * it carries no meaning, so stripping it never changes the word. Auto-fixable.
 */

import { lineToText } from '../../model/cue';
import type { CueLine } from '../../model/types';
import { isTatweel, stripTatweel } from '../../rtl';
import type { RuleDefinition, RuleViolation } from '../rule';

function lineHasTatweel(line: CueLine): boolean {
  return [...lineToText(line)].some((ch) => isTatweel(ch.codePointAt(0)!));
}

/** Drop every tatweel from each span, preserving styling. */
function stripLine(line: CueLine): CueLine {
  return { spans: line.spans.map((s) => ({ ...s, text: stripTatweel(s.text) })) };
}

export const kashidaStrip: RuleDefinition<'kashida-strip'> = {
  id: 'kashida-strip',
  fixable: true,
  evaluate(doc) {
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      if (cue.lines.some(lineHasTatweel)) {
        out.push({ cueIndex: cue.index, message: 'Text contains tatweel (kashida) padding.' });
      }
    }
    return out;
  },
  fix(doc) {
    const cues = doc.cues.map((cue) => ({ ...cue, lines: cue.lines.map(stripLine) }));
    return { ...doc, cues };
  },
};
