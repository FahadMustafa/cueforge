import { describe, expect, it } from 'vitest';
import { textLine } from '../model/cue';
import type { Cue, CueLine, SubtitleDocument } from '../model/types';
import { autoFix } from './autofix';
import { evaluate } from './evaluate';
import { PRESETS } from './presets';

/**
 * Cross-rule auto-fix invariant (spec §5.1, CLAUDE.md): fixing one rule's
 * violations must introduce **zero new issues** — for every built-in preset,
 * re-running the full QC after `autoFix` may not raise any rule's issue count.
 *
 * Counts (not (ruleId, cueIndex) pairs) are compared because a legitimate fix
 * can remove a cue and renumber the survivors (empty-cue), which shifts later
 * issues to lower indices without adding any (cue-forge-sgh).
 *
 * Fixers cannot see other rules' thresholds (a fixer receives only its own
 * config), so the timing fixers use conservative floors; these fixtures are the
 * regression net for that contract (cue-forge-mz1).
 */

function cue(index: number, startMs: number, endMs: number, text = `cue ${index}`): Cue {
  return { index, startMs, endMs, lines: [textLine(text)] };
}
function styledCue(index: number, startMs: number, endMs: number, lines: CueLine[]): Cue {
  return { index, startMs, endMs, lines };
}
function docOf(cues: Cue[]): SubtitleDocument {
  return { cues, metadata: { sourceFormat: 'srt' }, warnings: [] };
}

/** Factories so each preset run gets a fresh document. */
const FIXTURES: Record<string, () => SubtitleDocument> = {
  // cue-forge-mz1 (a): fixing the gap must not push either cue below
  // min-duration (the old fix produced 0–817 ms under netflix-latin).
  'zero gap between two near-minimum cues': () =>
    docOf([cue(1, 0, 900, 'first'), cue(2, 900, 2000, 'second')]),

  // cue-forge-mz1 (b): clamping this overlap would yield a 0 ms cue; it must
  // stay flagged instead.
  'full overlap that would clamp to a zero-length cue': () =>
    docOf([cue(1, 5000, 6500, 'one'), cue(2, 5000, 8000, 'two')]),

  'moderate overlap with room to trim': () =>
    docOf([cue(1, 0, 5000, 'one'), cue(2, 4000, 9000, 'two')]),

  // min-duration extension is gap-limited: it must not butt the cue against
  // the next one and create a min-gap violation.
  'too-short cue close to its successor': () =>
    docOf([cue(1, 0, 400, 'hi'), cue(2, 600, 2000, 'next one')]),

  // Cross-rule constraint a per-rule floor cannot encode: the min-gap fix moves
  // the next cue's start forward, shortening it — a cue already near the CPS
  // limit (19 chars / 1 s = 19 CPS under netflix-latin's 20) tips over the
  // limit. The engine must revert such a fix instead (zero-new-issues).
  'min-gap shift that would tip the next cue over the CPS limit': () =>
    docOf([cue(1, 0, 1000, 'nineteen chars text'), cue(2, 1000, 2000, 'nineteen chars text')]),

  'reversed cue between healthy neighbours': () =>
    docOf([cue(1, 0, 2000, 'before'), cue(2, 6000, 3000, 'reversed'), cue(3, 7000, 9000, 'end')]),

  'empty trailing cue': () => docOf([cue(1, 0, 1500, 'text'), cue(2, 2000, 3500, '')]),

  // cue-forge-sgh: a mid-document empty cue. Deleting it renumbers cue 3 (which
  // carries a flag-only, un-fixable max-lines issue) down to index 2 — that
  // renumbered issue must not read as "new" and revert the empty-cue fix.
  'empty cue mid-document, later cue keeps a flag-only issue': () =>
    docOf([
      cue(1, 0, 1500, 'alpha'),
      cue(2, 2000, 3500, ''),
      styledCue(3, 4000, 6000, [textLine('one'), textLine('two'), textLine('three')]),
    ]),

  'unclosed tag alongside structured styling': () =>
    docOf([
      styledCue(1, 0, 2000, [
        { spans: [{ text: 'styled', italic: true }, { text: ' <i>broken' }] },
      ]),
    ]),

  'punctuation issue across styled spans': () =>
    docOf([
      styledCue(1, 0, 2000, [
        { spans: [{ text: 'Hello ' }, { text: 'world', italic: true }, { text: ' ,bad' }] },
      ]),
    ]),

  'kashida-stretched Arabic cue': () => docOf([cue(1, 0, 2000, 'مرحبـــا بالعالم')]),

  'combined nasty document': () =>
    docOf([
      cue(1, 0, 900, 'alpha'),
      cue(2, 900, 2000, 'beta'),
      cue(3, 2500, 2900, 'gamma .oops'),
      cue(4, 4000, 9000, 'delta'),
      cue(5, 8000, 12000, 'epsilon'),
      styledCue(6, 12100, 13500, [{ spans: [{ text: '<i>unclosed zeta' }] }]),
      cue(7, 14000, 15500, ''),
    ]),
};

describe('auto-fix zero-new-issues invariant', () => {
  for (const [presetName, preset] of Object.entries(PRESETS)) {
    for (const [fixtureName, makeDoc] of Object.entries(FIXTURES)) {
      it(`${presetName}: ${fixtureName}`, () => {
        const doc = makeDoc();
        const before = evaluate(doc, preset);
        const { doc: fixedDoc } = autoFix(doc, before, { ruleset: preset });
        const after = evaluate(fixedDoc, preset);

        const countByRule = (issues: typeof before): Map<string, number> => {
          const m = new Map<string, number>();
          for (const i of issues) m.set(i.ruleId, (m.get(i.ruleId) ?? 0) + 1);
          return m;
        };
        const beforeCounts = countByRule(before);
        const grown = [...countByRule(after)]
          .filter(([rule, n]) => n > (beforeCounts.get(rule) ?? 0))
          .map(([rule, n]) => `${rule}: ${beforeCounts.get(rule) ?? 0} -> ${n}`);
        expect(grown).toEqual([]);
      });
    }
  }
});
