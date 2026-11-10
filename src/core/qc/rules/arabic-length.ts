/**
 * Rule 18 (spec §5.3): `arabic-line-length` — the same max-length check as rule 1,
 * but length is measured with {@link visibleLength}: Arabic diacritics (harakat)
 * and invisible bidi/format marks have zero advance width, so a fully-vowelled
 * Arabic line is not wrongly flagged for characters the viewer never sees.
 * Flag-only — re-wrapping is rule 1's job (`max-chars-per-line`).
 */

import { lineToText } from '../../model/cue';
import { visibleLength } from '../../rtl';
import type { RuleDefinition, RuleViolation } from '../rule';
import type { ArabicLineLengthConfig } from '../ruleset.schema';

export const arabicLineLength: RuleDefinition<'arabic-line-length'> = {
  id: 'arabic-line-length',
  fixable: false,
  evaluate(doc, config: ArabicLineLengthConfig) {
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      cue.lines.forEach((line, i) => {
        const len = visibleLength(lineToText(line));
        if (len > config.max) {
          out.push({
            cueIndex: cue.index,
            message: `Line ${i + 1} is ${len} characters (max ${config.max}).`,
          });
        }
      });
    }
    return out;
  },
};
