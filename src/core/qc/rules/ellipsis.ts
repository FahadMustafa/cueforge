/**
 * Rule `ellipsis-style` (cue-forge-sdv.15): flag a three-dot ASCII ellipsis
 * (`...`) and require the single Unicode ellipsis U+2026 (`…`). Netflix's timed-
 * text style guides call for the ellipsis character, and their delivery QC auto-
 * rejects three consecutive periods — so this serves the compliance-QC moat.
 * Auto-fixable: any run of three or more consecutive periods collapses to one
 * `…`. Detection and fix both operate on the whole visual line (cue-forge-zxw.7)
 * so a run straddling a StyledSpan boundary is caught, while inline styling
 * survives — the fix rebuilds spans from per-character ownership.
 */

import { lineToText } from '../../model/cue';
import type { CueLine, StyledSpan } from '../../model/types';
import type { RuleDefinition, RuleViolation } from '../rule';

/** Three or more consecutive ASCII periods, anywhere in the text. */
const ASCII_ELLIPSIS = /\.{3,}/;

/** True when the text contains a run of three or more consecutive periods. */
export function hasAsciiEllipsis(text: string): boolean {
  return ASCII_ELLIPSIS.test(text);
}

/** Collapse every run of three or more consecutive periods to a single `…`. */
export function fixAsciiEllipsisText(text: string): string {
  return text.replace(/\.{3,}/g, '…');
}

/**
 * Repair a line so inline styling survives (cf. punctuation-spacing). Dot runs
 * can straddle a StyledSpan boundary (cue-forge-zxw.7), so the collapse walks
 * the line's characters — each tagged with its owning span — instead of fixing
 * per span. A run of three or more periods becomes one `…` owned by the first
 * dot's span; spans left empty by a boundary collapse are dropped, so a run
 * split across spans still yields a single ellipsis with the correct style.
 */
function fixLine(line: CueLine): CueLine {
  if (!hasAsciiEllipsis(lineToText(line))) return line;
  const chars: { ch: string; span: number }[] = [];
  line.spans.forEach((span, i) => {
    for (const ch of span.text) chars.push({ ch, span: i });
  });

  const kept: { ch: string; span: number }[] = [];
  for (let i = 0; i < chars.length; ) {
    if (chars[i]!.ch !== '.') {
      kept.push(chars[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < chars.length && chars[j]!.ch === '.') j++;
    if (j - i >= 3) kept.push({ ch: '…', span: chars[i]!.span });
    else for (let k = i; k < j; k++) kept.push(chars[k]!);
    i = j;
  }

  const spans: StyledSpan[] = [];
  let cur = -1;
  for (const { ch, span } of kept) {
    if (span === cur) spans[spans.length - 1]!.text += ch;
    else {
      spans.push({ ...line.spans[span]!, text: ch });
      cur = span;
    }
  }
  return { spans };
}

export const ellipsisStyle: RuleDefinition<'ellipsis-style'> = {
  id: 'ellipsis-style',
  fixable: true,
  evaluate(doc) {
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      if (cue.lines.some((line) => hasAsciiEllipsis(lineToText(line)))) {
        out.push({
          cueIndex: cue.index,
          message: 'Use the ellipsis character (…) instead of three dots.',
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
