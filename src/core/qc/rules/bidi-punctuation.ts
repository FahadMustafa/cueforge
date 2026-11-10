/**
 * Rule 15 (spec §5.3): `bidi-punctuation` — in an RTL line, trailing neutral
 * sentence punctuation (`.`, `!`, `?`, `؟`, …) has no strong direction, so under
 * a left-to-right base direction it renders on the wrong side of the line. The fix
 * inserts a Right-to-Left Mark (U+200F) immediately after the punctuation, giving
 * the neutral a strong-RTL neighbour so it anchors to the correct side.
 * Auto-fixable.
 */

import { lineToText } from '../../model/cue';
import type { CueLine } from '../../model/types';
import { RLM, hasRtl } from '../../rtl';
import type { RuleDefinition, RuleViolation } from '../rule';

/** Neutral sentence-final punctuation that flips when unanchored in RTL text. */
const SENTENCE_PUNCT = new Set([...'.!?:;،؛؟…']);

/** Index of the last non-whitespace code point, or -1 when the text is blank. */
function lastContentIndex(chars: string[]): number {
  let i = chars.length - 1;
  while (i >= 0 && /\s/.test(chars[i]!)) i--;
  return i;
}

/** True when an RTL line ends in unanchored neutral sentence punctuation. */
export function hasBidiPunctuationIssue(text: string): boolean {
  if (!hasRtl(text)) return false;
  const chars = [...text];
  const i = lastContentIndex(chars);
  if (i < 0) return false;
  if (chars[i] === RLM) return false; // already anchored
  return SENTENCE_PUNCT.has(chars[i]!);
}

/** Insert an RLM right after the trailing sentence-punctuation run. */
export function fixBidiPunctuationText(text: string): string {
  if (!hasBidiPunctuationIssue(text)) return text;
  const chars = [...text];
  const i = lastContentIndex(chars);
  chars.splice(i + 1, 0, RLM);
  return chars.join('');
}

/** Append the RLM to the last span so styling is preserved. */
function fixLine(line: CueLine): CueLine {
  if (!hasBidiPunctuationIssue(lineToText(line))) return line;
  const spans = line.spans.map((s) => ({ ...s }));
  const last = spans[spans.length - 1];
  if (last) last.text += RLM;
  return { spans };
}

export const bidiPunctuation: RuleDefinition<'bidi-punctuation'> = {
  id: 'bidi-punctuation',
  fixable: true,
  evaluate(doc) {
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      if (cue.lines.some((line) => hasBidiPunctuationIssue(lineToText(line)))) {
        out.push({
          cueIndex: cue.index,
          message:
            'Sentence-final punctuation may render on the wrong side without a right-to-left mark (RLM).',
        });
      }
    }
    return out;
  },
  fix(doc) {
    const cues = doc.cues.map((cue) => ({ ...cue, lines: cue.lines.map(fixLine) }));
    return { ...doc, cues };
  },
};
