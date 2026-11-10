/**
 * Rule 12 (spec §5.2): `punctuation-spacing` — no space before `.,!?;:` and a
 * space after when a word follows. Auto-fixable. Disabled in the Arabic preset,
 * where the conventions differ (handled at the preset level, not here).
 *
 * A punctuation mark between digits (`3.14`, `1,000`, `12:30`) is never a clause
 * mark. Beyond that, a `.` is exempt when a following letter does NOT begin a new
 * sentence (cue-forge-drt.6): an ellipsis (`...and`), an intra-word/domain dot
 * (`cue-forge.com`), or an initialism (`U.S.A.`, `e.g.`). Without these
 * exemptions the verified Netflix preset's one-click fix corrupted such text.
 */

import { lineToText } from '../../model/cue';
import type { CueLine, StyledSpan } from '../../model/types';
import type { RuleDefinition, RuleViolation } from '../rule';

const CLAUSE_PUNCT = '.,!?;:';

const isLetter = (c: string | undefined): boolean => c !== undefined && /\p{L}/u.test(c);

/**
 * A `.` at index `i` that should NOT be treated as a clause period, because a
 * following letter does not start a new sentence: an ellipsis dot, a domain /
 * intra-word dot (letter before, lowercase letter after), or a standalone
 * single-letter initialism (`U.`, `e.`). Only `.` is ever exempt.
 */
function isExemptDot(text: string, i: number): boolean {
  if (text[i] !== '.') return false;
  if (text[i - 1] === '.' || text[i + 1] === '.') return true; // ellipsis run
  const prev = text[i - 1];
  const next = text[i + 1];
  // Domain / intra-word: a letter precedes and a lowercase letter follows (a real
  // sentence break starts with an uppercase letter, e.g. `end.Start`).
  if (isLetter(prev) && next !== undefined && /\p{Ll}/u.test(next)) return true;
  // Initialism: a single standalone letter before the dot (`U.S.A.`, `e.g.`).
  if (isLetter(prev) && !isLetter(text[i - 2])) return true;
  return false;
}

/** True when a line has a space-before or missing-space-after punctuation issue. */
export function hasPunctuationSpacingIssue(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      const nn = text[i + 1];
      if (nn !== undefined && CLAUSE_PUNCT.includes(nn) && !isExemptDot(text, i + 1)) return true;
      continue;
    }
    if (!CLAUSE_PUNCT.includes(c) || isExemptDot(text, i)) continue;
    // Missing space only when a letter follows; a digit means a number/time.
    if (isLetter(text[i + 1])) return true;
  }
  return false;
}

/** Remove the space before clause punctuation and add one after when a word follows. */
export function fixPunctuationSpacingText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === ' ' || c === '\t') {
      // Collapse a whitespace run that sits before clause punctuation, unless the
      // mark is an exempt dot (e.g. a deliberate space before an ellipsis).
      let j = i;
      while (text[j] === ' ' || text[j] === '\t') j++;
      const nn = text[j];
      if (nn !== undefined && CLAUSE_PUNCT.includes(nn) && !isExemptDot(text, j)) {
        i = j - 1;
        continue;
      }
      out += c;
      continue;
    }
    out += c;
    if (CLAUSE_PUNCT.includes(c) && !isExemptDot(text, i) && isLetter(text[i + 1])) out += ' ';
  }
  return out;
}

/**
 * Re-space a line span-by-span so styling survives (cue-forge-xod: the old fix
 * flattened every multi-span line to one span). Lines the rule does not flag
 * are returned untouched. Intra-span issues use the plain-text repair; the two
 * cross-span cases — trailing whitespace before a span that opens with
 * punctuation, and a word span following one that ends in punctuation — are
 * repaired at the boundary without merging spans, each keeping its own style.
 */
function fixLine(line: CueLine): CueLine {
  if (!hasPunctuationSpacingIssue(lineToText(line))) return line;
  const out: StyledSpan[] = [];
  for (const span of line.spans) {
    let text = fixPunctuationSpacingText(span.text);
    // Space before punctuation at the boundary: strip the previous span's
    // trailing whitespace, dropping spans that become empty.
    while (out.length > 0 && /^[.,!?;:]/.test(text) && /[ \t]$/.test(out[out.length - 1]!.text)) {
      const prev = out[out.length - 1]!;
      prev.text = prev.text.replace(/[ \t]+$/, '');
      if (prev.text === '') out.pop();
    }
    // Missing space after punctuation at the boundary (letter follows, so the
    // number/time exemption holds just like the intra-span repair). Re-check the
    // exemption over the joined context so a domain/initialism/ellipsis dot split
    // across spans isn't wrongly spaced (cue-forge-drt.6).
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      /[.,!?;:]$/.test(prev.text) &&
      /^\p{L}/u.test(text) &&
      !isExemptDot(prev.text + text, prev.text.length - 1)
    ) {
      text = ' ' + text;
    }
    if (text !== '') out.push({ ...span, text });
  }
  return { spans: out };
}

export const punctuationSpacing: RuleDefinition<'punctuation-spacing'> = {
  id: 'punctuation-spacing',
  fixable: true,
  evaluate(doc) {
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      if (cue.lines.some((line) => hasPunctuationSpacingIssue(lineToText(line)))) {
        out.push({ cueIndex: cue.index, message: 'Incorrect spacing around punctuation.' });
      }
    }
    return out;
  },
  fix(doc) {
    const cues = doc.cues.map((cue) => ({ ...cue, lines: cue.lines.map(fixLine) }));
    return { ...doc, cues };
  },
};
