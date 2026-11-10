import { describe, expect, it } from 'vitest';
import { textLine } from '../model/cue';
import type { SubtitleDocument } from '../model/types';
import { autoFix } from './autofix';
import { evaluate } from './evaluate';
import type { RuleDefinition } from './rule';
import type { Ruleset } from './ruleset.schema';

const ruleset: Ruleset = {
  name: 'Counting',
  verified: false,
  rules: { 'min-duration': { enabled: true, severity: 'error', ms: 833 } },
};

function document(...times: [number, number][]): SubtitleDocument {
  return {
    cues: times.map(([startMs, endMs], position) => ({
      index: position + 1,
      startMs,
      endMs,
      lines: [textLine('A')],
    })),
    metadata: { sourceFormat: 'srt' },
    warnings: [],
  };
}

describe('auto-fix resolution counts', () => {
  it('does not count a cloned but unchanged cue as fixed', () => {
    const source = document([0, 200], [300, 1500]);
    const issues = evaluate(source, ruleset);
    const result = autoFix(source, issues, { ruleset });
    expect(result.fixed).toEqual([]);
    expect(result.unfixable).toEqual(issues);
    expect(result.resolvedCount).toBe(0);
    expect(result.changed).toBe(false);
    expect(result.doc).toBe(source);
  });

  it('keeps a partial improvement without claiming the issue is resolved', () => {
    const source = document([0, 200], [500, 1500]);
    const issues = evaluate(source, ruleset);
    const result = autoFix(source, issues, { ruleset });
    expect(result.doc.cues[0]!.endMs).toBe(400);
    expect(result.fixed).toEqual([]);
    expect(result.unfixable).toEqual(issues);
    expect(result.resolvedCount).toBe(0);
    expect(result.changed).toBe(true);
    expect(evaluate(result.doc, ruleset)).toHaveLength(1);
  });

  it('counts only the resolved cue in a mixed successful and declined operation', () => {
    const source = document([0, 200], [300, 1500], [2000, 2200]);
    const issues = evaluate(source, ruleset);
    const result = autoFix(source, issues, { ruleset });
    expect(result.fixed).toEqual([issues[1]]);
    expect(result.unfixable).toEqual([issues[0]]);
    expect(result.resolvedCount).toBe(1);
  });

  it('counts all actual resolutions, including another rule cleared by the selected fix', () => {
    const source = document([0, 200]);
    source.cues[0]!.lines = [textLine('Some text')];
    const preset: Ruleset = {
      ...ruleset,
      rules: { ...ruleset.rules, 'max-cps': { enabled: true, severity: 'error', max: 20 } },
    };
    const issues = evaluate(source, preset);
    const target = issues.filter((issue) => issue.ruleId === 'min-duration');
    const result = autoFix(source, target, { ruleset: preset, enabled: ['min-duration'] });
    expect(issues).toHaveLength(2);
    expect(result.fixed).toEqual(target);
    expect(result.resolvedCount).toBe(2);
    expect(evaluate(result.doc, preset)).toEqual([]);
  });

  it('reconciles final outcomes when a later fixer resolves an earlier declined issue and renumbers cues', () => {
    const source = document([0, 200], [300, 300], [2000, 4000]);
    source.cues[1]!.lines = [textLine('')];
    const preset: Ruleset = {
      ...ruleset,
      rules: { ...ruleset.rules, 'empty-cue': { enabled: true, severity: 'error' } },
    };
    const result = autoFix(source, evaluate(source, preset), { ruleset: preset });
    const remaining = evaluate(result.doc, preset);
    expect(result.doc.cues.map((cue) => cue.index)).toEqual([1, 2]);
    expect(result.fixed.map((issue) => issue.ruleId)).toEqual(['min-duration', 'empty-cue']);
    expect(result.unfixable.map((issue) => issue.cueIndex)).toEqual([1]);
    expect(result.resolvedCount).toBe(2);
    expect(remaining).toHaveLength(1);
  });

  it('counts multiplicity on one cue rather than treating every accepted fixer call as resolved', () => {
    const source = document([0, 1000]);
    source.cues[0]!.lines = [textLine('xxx')];
    const rule: RuleDefinition<'forbidden-characters'> = {
      id: 'forbidden-characters',
      fixable: true,
      evaluate: (doc) =>
        [...doc.cues[0]!.lines[0]!.spans[0]!.text].map(() => ({ cueIndex: 1, message: 'x' })),
      fix: (doc) => ({ ...doc, cues: doc.cues.map((cue) => ({ ...cue, lines: [textLine('x')] })) }),
    };
    const preset: Ruleset = {
      ...ruleset,
      rules: { 'forbidden-characters': { enabled: true, severity: 'error', chars: ['x'] } },
    };
    const registry = { 'forbidden-characters': rule };
    const issues = evaluate(source, preset, registry);
    const result = autoFix(source, issues, { ruleset: preset }, registry);
    expect(result.fixed).toHaveLength(2);
    expect(result.unfixable).toHaveLength(1);
    expect(result.resolvedCount).toBe(2);
  });

  it('identifies the resolved occurrence even when the unresolved occurrence is listed first', () => {
    const source = document([0, 1000]);
    source.cues[0]!.lines = [textLine('xy')];
    const rule: RuleDefinition<'forbidden-characters'> = {
      id: 'forbidden-characters',
      fixable: true,
      evaluate: (doc) =>
        [...doc.cues[0]!.lines[0]!.spans[0]!.text]
          .reverse()
          .map((message) => ({ cueIndex: 1, message })),
      fix: (doc) => ({ ...doc, cues: doc.cues.map((cue) => ({ ...cue, lines: [textLine('y')] })) }),
    };
    const preset: Ruleset = {
      ...ruleset,
      rules: { 'forbidden-characters': { enabled: true, severity: 'error', chars: ['x', 'y'] } },
    };
    const registry = { 'forbidden-characters': rule };
    const issues = evaluate(source, preset, registry);
    const result = autoFix(source, issues, { ruleset: preset }, registry);
    expect(result.fixed.map((issue) => issue.message)).toEqual(['x']);
    expect(result.unfixable.map((issue) => issue.message)).toEqual(['y']);
    expect(result.resolvedCount).toBe(1);
  });
});
