/**
 * Rule 16 (spec §5.3): `mixed-digit-style` — flag a document that mixes digit
 * families (Western `012`, Arabic-Indic `٠١٢`, Extended Arabic-Indic `۰۱۲`). The
 * check is document-wide: a document consistently using one family is fine, even
 * if that family differs from the fix target. Cues carrying a digit outside the
 * document's dominant family are flagged. The fix normalizes every digit to the
 * configured `style` (default Western). Auto-fixable.
 */

import { cueToText, lineToText } from '../../model/cue';
import type { CueLine } from '../../model/types';
import { convertDigits, digitStyle, type DigitStyle } from '../../rtl';
import type { RuleDefinition, RuleViolation } from '../rule';
import type { MixedDigitStyleConfig } from '../ruleset.schema';

/** Tally each digit family's occurrences across some text. */
function countByStyle(text: string): Map<DigitStyle, number> {
  const counts = new Map<DigitStyle, number>();
  for (const ch of text) {
    const style = digitStyle(ch.codePointAt(0)!);
    if (style) counts.set(style, (counts.get(style) ?? 0) + 1);
  }
  return counts;
}

/** Most-used digit family in the document, or null when it has no digits. */
function dominantStyle(counts: Map<DigitStyle, number>): DigitStyle | null {
  let best: DigitStyle | null = null;
  let bestN = 0;
  for (const [style, n] of counts) {
    if (n > bestN) {
      best = style;
      bestN = n;
    }
  }
  return best;
}

function convertLine(line: CueLine, target: DigitStyle): CueLine {
  return { spans: line.spans.map((s) => ({ ...s, text: convertDigits(s.text, target) })) };
}

export const mixedDigitStyle: RuleDefinition<'mixed-digit-style'> = {
  id: 'mixed-digit-style',
  fixable: true,
  evaluate(doc) {
    const docCounts = countByStyle(doc.cues.map(cueToText).join('\n'));
    if (docCounts.size < 2) return []; // one family (or none) — nothing mixed
    const dominant = dominantStyle(docCounts);

    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      const cueText = cue.lines.map(lineToText).join('\n');
      const hasOffStyle = [...cueText].some((ch) => {
        const style = digitStyle(ch.codePointAt(0)!);
        return style !== null && style !== dominant;
      });
      if (hasOffStyle) {
        out.push({ cueIndex: cue.index, message: 'Cue mixes Western and Arabic-Indic digits.' });
      }
    }
    return out;
  },
  fix(doc, config: MixedDigitStyleConfig) {
    const target = config.style ?? 'western';
    const cues = doc.cues.map((cue) => ({
      ...cue,
      lines: cue.lines.map((line) => convertLine(line, target)),
    }));
    return { ...doc, cues };
  },
};
