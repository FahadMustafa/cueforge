import { describe, expect, it } from 'vitest';
import { textLine } from '../model/cue';
import type { Cue, SubtitleDocument } from '../model/types';
import { evaluate } from './evaluate';
import { maxCharsPerLine, maxLinesPerCue } from './rules/length';
import type { RuleDefinition } from './rule';
import type { Ruleset } from './ruleset.schema';

function cue(index: number, startMs: number, endMs: number, text = 'hello'): Cue {
  return { index, startMs, endMs, lines: [textLine(text)] };
}

function multilineCue(index: number, lines: string[]): Cue {
  return { index, startMs: 0, endMs: 1000, lines: lines.map((t) => textLine(t)) };
}

function doc(cues: Cue[]): SubtitleDocument {
  return { cues, metadata: { sourceFormat: 'srt' }, warnings: [] };
}

// Two stand-in rules so the engine is tested independently of the real catalog.
const alwaysOverlap: RuleDefinition<'overlap'> = {
  id: 'overlap',
  fixable: true,
  evaluate: (d) => d.cues.map((c) => ({ cueIndex: c.index, message: 'overlaps' })),
};
const docLevel: RuleDefinition<'cue-count-monotonic-timing'> = {
  id: 'cue-count-monotonic-timing',
  fixable: false,
  evaluate: () => [{ cueIndex: -1, message: 'not monotonic' }],
};

const registry = {
  overlap: alwaysOverlap,
  'cue-count-monotonic-timing': docLevel,
} as unknown as Parameters<typeof evaluate>[2];

describe('evaluate', () => {
  it('runs an enabled rule and stamps ruleId, severity and fixable onto each issue', () => {
    const rs: Ruleset = {
      name: 't',
      verified: false,
      rules: { overlap: { enabled: true, severity: 'error' } },
    };
    const issues = evaluate(doc([cue(1, 0, 1000)]), rs, registry);
    expect(issues).toEqual([
      { ruleId: 'overlap', cueIndex: 1, severity: 'error', message: 'overlaps', fixable: true },
    ]);
  });

  it('skips rules that are absent from the ruleset', () => {
    const rs: Ruleset = { name: 't', verified: false, rules: {} };
    expect(evaluate(doc([cue(1, 0, 1000)]), rs, registry)).toEqual([]);
  });

  it('skips rules explicitly disabled', () => {
    const rs: Ruleset = {
      name: 't',
      verified: false,
      rules: { overlap: { enabled: false, severity: 'error' } },
    };
    expect(evaluate(doc([cue(1, 0, 1000)]), rs, registry)).toEqual([]);
  });

  it('carries each rule its own configured severity', () => {
    const rs: Ruleset = {
      name: 't',
      verified: false,
      rules: {
        overlap: { enabled: true, severity: 'warning' },
        'cue-count-monotonic-timing': { enabled: true, severity: 'error' },
      },
    };
    const issues = evaluate(doc([cue(1, 0, 1000)]), rs, registry);
    expect(issues.find((i) => i.ruleId === 'overlap')?.severity).toBe('warning');
    expect(issues.find((i) => i.ruleId === 'cue-count-monotonic-timing')?.severity).toBe('error');
  });

  it('skips non-Dialogue cues (ASS Comment events are not visible subtitles)', () => {
    const rs: Ruleset = {
      name: 't',
      verified: false,
      rules: { overlap: { enabled: true, severity: 'error' } },
    };
    const comment: Cue = { ...cue(1, 0, 0, 'note'), raw: { kind: 'Comment', fields: {} } };
    const dialogue: Cue = { ...cue(2, 0, 1000), raw: { kind: 'Dialogue', fields: {} } };
    const issues = evaluate(doc([comment, dialogue]), rs, registry);
    expect(issues.map((i) => i.cueIndex)).toEqual([2]);
  });

  it('orders issues by cue index so the report groups per cue', () => {
    const rs: Ruleset = {
      name: 't',
      verified: false,
      rules: {
        overlap: { enabled: true, severity: 'error' },
        'cue-count-monotonic-timing': { enabled: true, severity: 'error' },
      },
    };
    const issues = evaluate(doc([cue(1, 0, 1000), cue(2, 500, 1500)]), rs, registry);
    expect(issues.map((i) => i.cueIndex)).toEqual([-1, 1, 2]);
  });
});

describe('evaluate — effectivelyFixable (contextual fixability, cue-forge-8b4)', () => {
  const lengthRegistry = {
    'max-chars-per-line': maxCharsPerLine,
    'max-lines-per-cue': maxLinesPerCue,
  } as unknown as Parameters<typeof evaluate>[2];

  function rs(maxChars: number, maxLines?: number): Ruleset {
    return {
      name: 't',
      verified: false,
      rules: {
        'max-chars-per-line': { enabled: true, severity: 'warning', max: maxChars },
        ...(maxLines !== undefined
          ? { 'max-lines-per-cue': { enabled: true, severity: 'warning', max: maxLines } }
          : {}),
      },
    };
  }

  it('flags a max-chars issue NOT effectively fixable when wrapping would exceed max-lines', () => {
    // 2 lines (== max-lines 2) with an over-long line 1: wrapping it adds a 3rd line.
    const atMax = multilineCue(1, ['hello world', 'ok']);
    const issue = evaluate(doc([atMax]), rs(10, 2), lengthRegistry).find(
      (i) => i.ruleId === 'max-chars-per-line' && i.cueIndex === 1,
    );
    expect(issue?.fixable).toBe(true);
    expect(issue?.effectivelyFixable).toBe(false);
  });

  it('keeps a max-chars issue effectively fixable when the cue has room to wrap (1 line -> 2)', () => {
    const spare = multilineCue(2, ['hello world']); // wraps to 2 lines, <= max-lines 2
    const issue = evaluate(doc([spare]), rs(10, 2), lengthRegistry).find(
      (i) => i.ruleId === 'max-chars-per-line' && i.cueIndex === 2,
    );
    expect(issue?.effectivelyFixable).toBe(true);
  });

  it('treats max-chars as effectively fixable when no max-lines cap is enforced', () => {
    const atMax = multilineCue(1, ['hello world', 'ok']);
    const issue = evaluate(doc([atMax]), rs(10), lengthRegistry).find(
      (i) => i.ruleId === 'max-chars-per-line' && i.cueIndex === 1,
    );
    expect(issue?.effectivelyFixable).toBe(true);
  });

  it('does not annotate effectivelyFixable for rules without a contextual predicate', () => {
    const rs2: Ruleset = {
      name: 't',
      verified: false,
      rules: { overlap: { enabled: true, severity: 'error' } },
    };
    expect(evaluate(doc([cue(1, 0, 1000)]), rs2, registry)[0]).not.toHaveProperty(
      'effectivelyFixable',
    );
  });
});
