/**
 * Rule 13 (spec §5.2): `unclosed-tag`. Inline styling is normally structured into
 * spans at parse time, but literal markup can survive in a span's text (editor
 * input, or markup a format can't model). This rule re-scans each cue's text with
 * the shared inline parser and flags any opening tag the parser cannot balance.
 * Auto-fixable (re-serialize with balanced tags). Tags are balanced across all
 * lines of a cue, since formatting may span the cue's visual lines.
 */

import { parseInline, parseStyledLines, serializeStyledLines } from '../../formats/inline';
import { cueToText } from '../../model/cue';
import type { RuleDefinition, RuleViolation } from '../rule';

export const unclosedTag: RuleDefinition<'unclosed-tag'> = {
  id: 'unclosed-tag',
  fixable: true,
  evaluate(doc) {
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      const { warnings } = parseInline(cueToText(cue));
      if (warnings.some((w) => w.code === 'unclosed-tag')) {
        out.push({ cueIndex: cue.index, message: 'Contains an unclosed formatting tag.' });
      }
    }
    return out;
  },
  // Serialize the structured spans back to markup (cueToText would silently drop
  // their style flags, cue-forge-lnj), then re-parse: existing styling survives
  // and the balance pass turns an unclosed opener into styling that runs to the
  // end of the cue. Cues carrying opaque markup (preserved VTT constructs) use
  // VTT mode for the round-trip — default mode would silently drop the opaque
  // spans. VTT mode only when needed: it escapes `&`/`<`, which would corrupt
  // plain SRT text (and turn the literal unclosed tag into escaped text, so for
  // opaque cues the fix declines and the issue stays flagged).
  fix(doc) {
    const cues = doc.cues.map((cue) => {
      const vtt = cue.lines.some((l) => l.spans.some((s) => s.opaque !== undefined));
      const opts = { vtt };
      const { warnings, lines } = parseStyledLines(serializeStyledLines(cue.lines, opts), opts);
      return warnings.some((w) => w.code === 'unclosed-tag') ? { ...cue, lines } : cue;
    });
    return { ...doc, cues };
  },
};
