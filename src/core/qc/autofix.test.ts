import { describe, expect, it } from 'vitest';
import { textLine } from '../model/cue';
import type { Cue, SubtitleDocument } from '../model/types';
import { autoFix } from './autofix';
import type { RuleDefinition } from './rule';
import type { Ruleset } from './ruleset.schema';
import type { QCIssue } from './types';

function cue(index: number, text: string): Cue {
  return { index, startMs: index * 1000, endMs: index * 1000 + 500, lines: [textLine(text)] };
}
function doc(cues: Cue[]): SubtitleDocument {
  return { cues, metadata: { sourceFormat: 'srt' }, warnings: [] };
}

// A fixer that uppercases every cue's text, so we can observe that it ran.
const upcaser: RuleDefinition<'forbidden-characters'> = {
  id: 'forbidden-characters',
  fixable: true,
  evaluate: (document) =>
    document.cues
      .filter((cue) => /[a-z]/.test(cue.lines[0]!.spans[0]!.text))
      .map((cue) => ({ cueIndex: cue.index, message: 'm' })),
  fix: (d) => ({
    ...d,
    cues: d.cues.map((c) => ({
      ...c,
      lines: [textLine(c.lines[0]!.spans[0]!.text.toUpperCase())],
    })),
  }),
};
const flagOnly: RuleDefinition<'duplicate-cue'> = {
  id: 'duplicate-cue',
  fixable: false,
  evaluate: () => [],
};

const registry = {
  'forbidden-characters': upcaser,
  'duplicate-cue': flagOnly,
} as unknown as Parameters<typeof autoFix>[3];

const ruleset: Ruleset = {
  name: 't',
  verified: false,
  rules: {
    'forbidden-characters': { enabled: true, severity: 'warning', chars: ['x'] },
    'duplicate-cue': { enabled: true, severity: 'warning' },
  },
};

function issue(ruleId: QCIssue['ruleId'], cueIndex: number, fixable: boolean): QCIssue {
  return { ruleId, cueIndex, severity: 'warning', message: 'm', fixable };
}

describe('autoFix', () => {
  it('applies the fixer for a fixable rule and reports the issue as fixed', () => {
    const issues = [issue('forbidden-characters', 1, true)];
    const r = autoFix(doc([cue(1, 'abc')]), issues, { ruleset }, registry);
    expect(r.doc.cues[0]!.lines[0]!.spans[0]!.text).toBe('ABC');
    expect(r.fixed).toEqual(issues);
    expect(r.unfixable).toEqual([]);
  });

  it('reports issues from a flag-only rule as unfixable and leaves the doc unchanged', () => {
    const issues = [issue('duplicate-cue', 1, false)];
    const r = autoFix(doc([cue(1, 'abc')]), issues, { ruleset }, registry);
    expect(r.doc.cues[0]!.lines[0]!.spans[0]!.text).toBe('abc');
    expect(r.unfixable).toEqual(issues);
    expect(r.fixed).toEqual([]);
  });

  it('skips a fixable rule that the caller toggled off', () => {
    const issues = [issue('forbidden-characters', 1, true)];
    const r = autoFix(doc([cue(1, 'abc')]), issues, { ruleset, enabled: [] }, registry);
    expect(r.doc.cues[0]!.lines[0]!.spans[0]!.text).toBe('abc');
    expect(r.unfixable).toEqual(issues);
  });

  it('does not mutate the input document', () => {
    const d = doc([cue(1, 'abc')]);
    autoFix(d, [issue('forbidden-characters', 1, true)], { ruleset }, registry);
    expect(d.cues[0]!.lines[0]!.spans[0]!.text).toBe('abc');
  });

  it('is deterministic across repeated runs', () => {
    const issues = [issue('forbidden-characters', 1, true)];
    const a = autoFix(doc([cue(1, 'abc')]), issues, { ruleset }, registry);
    const b = autoFix(doc([cue(1, 'abc')]), issues, { ruleset }, registry);
    expect(a.doc).toEqual(b.doc);
  });

  it('shields a protected cue from a whole-document fixer (cue-forge-n3e.7)', () => {
    // The upcaser rewrites every cue of its rule. Protecting cue 2 (an "accepted"
    // cue the operator wants kept as-is) must leave it untouched while the fixer
    // still uppercases cue 1, and must re-merge it at its original position.
    const d = doc([cue(1, 'abc'), cue(2, 'keep')]);
    const r = autoFix(
      d,
      [issue('forbidden-characters', 1, true)],
      { ruleset, protect: new Set([d.cues[1]!]) },
      registry,
    );
    expect(r.doc.cues[0]!.lines[0]!.spans[0]!.text).toBe('ABC');
    expect(r.doc.cues[1]!.lines[0]!.spans[0]!.text).toBe('keep'); // protected, unchanged
    expect(r.doc.cues.map((c) => c.index)).toEqual([1, 2]); // re-merged in place
  });
});

describe('autoFix and non-Dialogue (ASS Comment) events', () => {
  function timedCue(
    index: number,
    startMs: number,
    endMs: number,
    text: string,
    kind: string,
  ): Cue {
    return {
      index,
      startMs,
      endMs,
      lines: [textLine(text)],
      raw: { kind, fields: {} },
    };
  }

  it('keeps an empty Comment event when fixing empty-cue issues', () => {
    const rs: Ruleset = {
      name: 't',
      verified: false,
      rules: { 'empty-cue': { enabled: true, severity: 'error' } },
    };
    const d = doc([
      timedCue(1, 0, 1000, 'hi', 'Dialogue'),
      timedCue(2, 2000, 2500, '', 'Comment'),
      timedCue(3, 3000, 3500, '', 'Dialogue'),
    ]);
    const r = autoFix(d, [issue('empty-cue', 3, true)], { ruleset: rs });
    // The empty Dialogue is dropped; the (also empty) Comment survives in place.
    expect(r.doc.cues).toHaveLength(2);
    const kinds = r.doc.cues.map((c) => (c.raw as { kind: string }).kind);
    expect(kinds).toEqual(['Dialogue', 'Comment']);
    expect(r.doc.cues[1]!.startMs).toBe(2000);
  });

  it('does not let an invisible Comment cue trigger min-gap shifts', () => {
    const rs: Ruleset = {
      name: 't',
      verified: false,
      rules: { 'min-gap': { enabled: true, severity: 'warning', ms: 83 } },
    };
    const d = doc([
      timedCue(1, 0, 1000, 'a', 'Dialogue'),
      timedCue(2, 1000, 1000, 'note', 'Comment'), // 0-length, butted against cue 1
      timedCue(3, 1200, 3000, 'b', 'Dialogue'),
      timedCue(4, 3050, 5000, 'd', 'Dialogue'), // genuine 50 ms gap violation
    ]);
    const r = autoFix(d, [issue('min-gap', 4, true)], { ruleset: rs });
    expect(r.doc.cues).toHaveLength(4);
    // Cue 1 must NOT be trimmed to make room before the invisible comment.
    expect(r.doc.cues[0]!.endMs).toBe(1000);
    // The comment itself is untouched and stays in its original position.
    expect(r.doc.cues[1]!.startMs).toBe(1000);
    expect((r.doc.cues[1]!.raw as { kind: string }).kind).toBe('Comment');
    // The real violation between cues 3 and 4 is still fixed.
    expect(r.doc.cues[3]!.startMs).toBe(3083);
  });
});

describe('autoFix zero-new-issues guard (engine-level revert)', () => {
  // A fixer that upcases the text — and a rule that flags uppercase 'X'. The
  // fix turns clean text into a violation the rule did not flag before, so
  // the engine must revert it and classify the original issue as unfixable.
  const trapRule: RuleDefinition<'forbidden-characters'> = {
    id: 'forbidden-characters',
    fixable: true,
    evaluate: (d) =>
      d.cues
        .filter((c) => c.lines[0]!.spans[0]!.text.includes('X'))
        .map((c) => ({ cueIndex: c.index, message: 'X is forbidden' })),
    fix: (d) => ({
      ...d,
      cues: d.cues.map((c) => ({
        ...c,
        lines: [textLine(c.lines[0]!.spans[0]!.text.toUpperCase())],
      })),
    }),
  };
  const trapRegistry = { 'forbidden-characters': trapRule } as unknown as Parameters<
    typeof autoFix
  >[3];

  it('reverts a fix that introduces a new (ruleId, cueIndex) issue and reports it unfixable', () => {
    const issues = [issue('forbidden-characters', 1, true)];
    const r = autoFix(doc([cue(1, 'x marks the spot')]), issues, { ruleset }, trapRegistry);
    expect(r.doc.cues[0]!.lines[0]!.spans[0]!.text).toBe('x marks the spot');
    expect(r.fixed).toEqual([]);
    expect(r.unfixable).toEqual(issues);
  });

  it('keeps a fix whose issues were already flagged before it ran', () => {
    // 'X already' is flagged before the fix runs; upcasing keeps the same
    // issue, so the fix stands even though the cue text changed.
    const issues = [issue('forbidden-characters', 1, true)];
    const r = autoFix(doc([cue(1, 'X already')]), issues, { ruleset }, trapRegistry);
    expect(r.doc.cues[0]!.lines[0]!.spans[0]!.text).toBe('X ALREADY');
    expect(r.fixed).toEqual([]);
    expect(r.unfixable).toEqual(issues);
    expect(r.changed).toBe(true);
    expect(r.resolvedCount).toBe(0);
  });

  // cue-forge-sgh: deleting a mid-document empty cue renumbers the survivors, so
  // a pre-existing issue on a later cue reappears at a lower index. The guard
  // must not mistake that renumbered issue for a new one and revert the fix.
  it('applies a mid-document empty-cue fix even when a later cue carries an issue', () => {
    const rs: Ruleset = {
      name: 't',
      verified: false,
      rules: {
        'empty-cue': { enabled: true, severity: 'error' },
        'max-chars-per-line': { enabled: true, severity: 'warning', max: 20 },
      },
    };
    const d = doc([
      cue(1, 'short ok'),
      cue(2, ''), // empty, mid-document
      cue(3, 'this single line is way past twenty chars'), // pre-existing max-chars
    ]);
    const r = autoFix(d, [issue('empty-cue', 2, true)], { ruleset: rs, enabled: ['empty-cue'] });

    // The empty cue is gone and the survivors are renumbered contiguously.
    expect(r.doc.cues).toHaveLength(2);
    expect(r.doc.cues.map((c) => c.lines[0]!.spans[0]!.text)).toEqual([
      'short ok',
      'this single line is way past twenty chars',
    ]);
    expect(r.fixed).toEqual([issue('empty-cue', 2, true)]);
    expect(r.unfixable).toEqual([]);
  });
});
