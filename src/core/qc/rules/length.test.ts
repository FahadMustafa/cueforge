import { describe, expect, it } from 'vitest';
import { lineToText, textLine } from '../../model/cue';
import type { Cue, CueLine, SubtitleDocument } from '../../model/types';
import { maxCharsPerLine, maxLinesPerCue } from './length';
import { evaluate } from '../evaluate';
import { autoFix } from '../autofix';
import type { RuleRegistry } from '../rule';
import type { Ruleset } from '../ruleset.schema';

function docOf(lines: CueLine[]): SubtitleDocument {
  const cue: Cue = { index: 1, startMs: 0, endMs: 1000, lines };
  return { cues: [cue], metadata: { sourceFormat: 'srt' }, warnings: [] };
}

describe('max-chars-per-line', () => {
  it('flags a line longer than max, naming the cue', () => {
    const v = maxCharsPerLine.evaluate(docOf([textLine('123456')]), {
      enabled: true,
      severity: 'warning',
      max: 5,
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
    expect(v[0]!.message).toMatch(/6.*5/);
  });

  it('passes a line at exactly max', () => {
    expect(
      maxCharsPerLine.evaluate(docOf([textLine('12345')]), {
        enabled: true,
        severity: 'warning',
        max: 5,
      }),
    ).toEqual([]);
  });

  it('reports each over-long line of a multi-line cue separately', () => {
    const v = maxCharsPerLine.evaluate(
      docOf([textLine('123456'), textLine('12'), textLine('7890123')]),
      {
        enabled: true,
        severity: 'warning',
        max: 5,
      },
    );
    expect(v).toHaveLength(2);
  });

  it('counts a surrogate-pair emoji as one character', () => {
    expect(
      maxCharsPerLine.evaluate(docOf([textLine('😀😀')]), {
        enabled: true,
        severity: 'warning',
        max: 2,
      }),
    ).toEqual([]);
  });

  it('is auto-fixable', () => {
    expect(maxCharsPerLine.fixable).toBe(true);
  });
});

describe('max-lines-per-cue', () => {
  it('flags a cue with more visual lines than max', () => {
    const v = maxLinesPerCue.evaluate(docOf([textLine('a'), textLine('b'), textLine('c')]), {
      enabled: true,
      severity: 'warning',
      max: 2,
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/3.*2/);
  });

  it('passes a cue at exactly max', () => {
    expect(
      maxLinesPerCue.evaluate(docOf([textLine('a'), textLine('b')]), {
        enabled: true,
        severity: 'warning',
        max: 2,
      }),
    ).toEqual([]);
  });

  it('is not auto-fixable', () => {
    expect(maxLinesPerCue.fixable).toBe(false);
  });
});

// The whole-document `fix` re-wraps EVERY over-long line and the zero-new-issues
// guard reverts it entirely when wrapping pushes ANY cue past max-lines. But
// fix-one now re-wraps ONLY the clicked cue via the cue-scoped `fixCue`
// (cue-forge-zxw.12), so a good cue lands even when an unrelated cue is unfixable,
// and `fixableInContext` — which drives the Fix button — gives a PER-CUE verdict.
describe('max-chars-per-line cue-scoped fix (cue-forge-zxw.12)', () => {
  // max-chars 10, max-lines 2 (netflix-latin shape).
  const ruleset: Ruleset = {
    name: 't',
    verified: false,
    rules: {
      'max-chars-per-line': { enabled: true, severity: 'warning', max: 10 },
      'max-lines-per-cue': { enabled: true, severity: 'warning', max: 2 },
    },
  };
  const registry: Partial<RuleRegistry> = {
    'max-chars-per-line': maxCharsPerLine,
    'max-lines-per-cue': maxLinesPerCue,
  };
  // Cue A wraps to 2 lines (<= max-lines) — fixable. Cue B wraps to 3 lines
  // (> max-lines), so wrapping it is reverted by the guard.
  const cueA: Cue = { index: 1, startMs: 0, endMs: 1000, lines: [textLine('hello world')] };
  const cueB: Cue = {
    index: 2,
    startMs: 1000,
    endMs: 2000,
    lines: [textLine('aaaaa bbbbb ccccc')],
  };
  const doc: SubtitleDocument = {
    cues: [cueA, cueB],
    metadata: { sourceFormat: 'srt' },
    warnings: [],
  };

  it('gives a per-cue verdict: clean-wrapping cue A is fixable, breaching cue B is not', () => {
    const predicate = maxCharsPerLine.fixableInContext!(doc, ruleset);
    expect(predicate({ cueIndex: 1, message: '' })).toBe(true);
    expect(predicate({ cueIndex: 2, message: '' })).toBe(false);
  });

  it('marks a cue fixable when its wrap breaches no cap', () => {
    const clean: SubtitleDocument = {
      cues: [cueA, { ...cueB, lines: [textLine('short one')] }],
      metadata: { sourceFormat: 'srt' },
      warnings: [],
    };
    const predicate = maxCharsPerLine.fixableInContext!(clean, ruleset);
    expect(predicate({ cueIndex: 1, message: '' })).toBe(true);
    expect(predicate({ cueIndex: 2, message: '' })).toBe(true);
  });

  it('keeps a cue ALREADY over max-lines fixable (pre-existing, not a new breach)', () => {
    // Cue B is already 3 short lines (a pre-existing max-lines issue), so wrapping
    // it does not INCREASE its line count — the guard would not revert.
    const already: SubtitleDocument = {
      cues: [cueA, { ...cueB, lines: [textLine('a'), textLine('b'), textLine('c')] }],
      metadata: { sourceFormat: 'srt' },
      warnings: [],
    };
    const predicate = maxCharsPerLine.fixableInContext!(already, ruleset);
    expect(predicate({ cueIndex: 1, message: '' })).toBe(true);
    expect(predicate({ cueIndex: 2, message: '' })).toBe(true);
  });

  it('fixCue re-wraps only the given cue', () => {
    const fixed = maxCharsPerLine.fixCue!(cueA, ruleset.rules['max-chars-per-line']!);
    expect(fixed.lines.map(lineToText)).toEqual(['hello', 'world']);
  });

  it('fix-one lands cue A even though cue B is unfixable, leaving cue B untouched', () => {
    const issues = evaluate(doc, ruleset, registry);
    const cueAIssue = issues.find((i) => i.ruleId === 'max-chars-per-line' && i.cueIndex === 1)!;
    const result = autoFix(
      doc,
      [cueAIssue],
      { ruleset, enabled: ['max-chars-per-line'] },
      registry,
    );
    expect(result.fixed).toHaveLength(1);
    expect(result.doc.cues[0]!.lines.map(lineToText)).toEqual(['hello', 'world']);
    expect(result.doc.cues[1]!.lines.map(lineToText)).toEqual(['aaaaa bbbbb ccccc']);
    // The button verdict agrees with the real outcome (no dead button, guard intact).
    expect(cueAIssue.effectivelyFixable).toBe(true);
  });

  it('fix-one still declines cue B (guard reverts the wrap that breaches max-lines)', () => {
    const issues = evaluate(doc, ruleset, registry);
    const cueBIssue = issues.find((i) => i.ruleId === 'max-chars-per-line' && i.cueIndex === 2)!;
    const result = autoFix(
      doc,
      [cueBIssue],
      { ruleset, enabled: ['max-chars-per-line'] },
      registry,
    );
    expect(result.fixed).toHaveLength(0);
    expect(result.doc.cues[1]!.lines.map(lineToText)).toEqual(['aaaaa bbbbb ccccc']);
    expect(cueBIssue.effectivelyFixable).toBe(false);
  });
});
