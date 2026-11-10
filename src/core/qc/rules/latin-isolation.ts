/**
 * Rule 17 (spec §5.3): `latin-run-isolation` — a Latin word or number embedded in
 * an RTL line must be isolated with directional marks, otherwise neutral
 * characters next to it (punctuation, digits) flip to the wrong side. The fix
 * brackets each Latin run with a Left-to-Right Mark (U+200E) on both ends. Runs
 * already isolated are left alone, so the fix is idempotent. Auto-fixable.
 */

import { lineToText } from '../../model/cue';
import type { CueLine } from '../../model/types';
import { LRM, hasRtl } from '../../rtl';
import type { RuleDefinition, RuleViolation } from '../rule';

// A run starts with a Latin letter or a Western digit; binders (. ' ’ & : / -)
// only count when sandwiched between two run characters, so a trailing sentence
// period is never swallowed into the run.
const RUN = String.raw`(?:\p{Script=Latin}|[0-9])`;
const LATIN_RUN_RE = new RegExp(`${RUN}(?:[.'’&:/-]?${RUN})*`, 'gu');

/** Bracket every not-yet-isolated Latin run with an LRM on each side. */
export function isolateLatinRuns(text: string): string {
  return text.replace(LATIN_RUN_RE, (m: string, offset: number) => {
    const left = text[offset - 1] === LRM ? '' : LRM;
    const right = text[offset + m.length] === LRM ? '' : LRM;
    return left + m + right;
  });
}

/** True when an RTL line carries a Latin run that is not LRM-isolated. */
function lineNeedsIsolation(line: CueLine): boolean {
  if (!hasRtl(lineToText(line))) return false;
  return line.spans.some((s) => isolateLatinRuns(s.text) !== s.text);
}

export const latinRunIsolation: RuleDefinition<'latin-run-isolation'> = {
  id: 'latin-run-isolation',
  fixable: true,
  evaluate(doc) {
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      if (cue.lines.some(lineNeedsIsolation)) {
        out.push({
          cueIndex: cue.index,
          message: 'Latin text inside an RTL line is not isolated with a left-to-right mark (LRM).',
        });
      }
    }
    return out;
  },
  fix(doc) {
    const cues = doc.cues.map((cue) => ({
      ...cue,
      lines: cue.lines.map((line) =>
        hasRtl(lineToText(line))
          ? { spans: line.spans.map((s) => ({ ...s, text: isolateLatinRuns(s.text) })) }
          : line,
      ),
    }));
    return { ...doc, cues };
  },
};
