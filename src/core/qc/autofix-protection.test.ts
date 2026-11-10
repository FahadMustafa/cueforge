import { describe, expect, it } from 'vitest';
import { cueToText, textLine } from '../model/cue';
import type { Cue, SubtitleDocument } from '../model/types';
import { autoFix } from './autofix';
import { evaluate } from './evaluate';
import type { RuleDefinition } from './rule';
import { RULES } from './rules';
import type { Ruleset } from './ruleset.schema';

function cue(index: number, startMs: number, endMs: number, text: string): Cue {
  return { index, startMs, endMs, lines: [textLine(text)] };
}

function document(cues: Cue[]): SubtitleDocument {
  return { cues, metadata: { sourceFormat: 'srt' }, warnings: [] };
}

function ruleset(rules: Ruleset['rules']): Ruleset {
  return { name: 'protection-regression', verified: false, rules };
}

const durationRules = ruleset({
  'min-duration': { enabled: true, severity: 'error', ms: 833 },
  'min-gap': { enabled: true, severity: 'error', ms: 100 },
  overlap: { enabled: true, severity: 'error' },
});

describe('protected visible cues remain immutable timing neighbors', () => {
  it('caps a duration extension at the protected next cue rather than overlapping it', () => {
    const input = document([cue(1, 0, 200, 'a'), cue(2, 400, 1500, 'accepted')]);
    const before = structuredClone(input);
    const output = autoFix(input, evaluate(input, durationRules), {
      ruleset: durationRules,
      enabled: ['min-duration'],
      protect: new Set([input.cues[1]!]),
    });
    expect(output.doc.cues[0]!.endMs).toBe(300);
    expect(output.doc.cues[1]).toEqual(before.cues[1]);
    expect(evaluate(output.doc, durationRules).map((issue) => issue.ruleId)).toEqual([
      'min-duration',
    ]);
    expect(input).toEqual(before);
  });

  it('keeps an accepted neighbor visible to CPS assist while fixing another cue with room', () => {
    const preset = ruleset({
      'max-cps': { enabled: true, severity: 'error', max: 10 },
      overlap: { enabled: true, severity: 'error' },
    });
    const input = document([
      cue(1, 0, 200, 'abcdefghij'),
      cue(2, 400, 1500, 'accepted'),
      cue(3, 1700, 1800, 'freecue'),
    ]);
    const output = autoFix(input, evaluate(input, preset), {
      ruleset: preset,
      protect: new Set([input.cues[1]!]),
    });
    expect(output.doc.cues[0]!.endMs).toBe(200);
    expect(output.doc.cues[1]).toEqual(input.cues[1]);
    expect(output.doc.cues[2]!.endMs).toBe(2400);
    expect(evaluate(output.doc, preset).map((issue) => issue.ruleId)).toEqual(['max-cps']);
  });

  it('does not move a protected previous cue when fixing an overlapping successor', () => {
    const preset = ruleset({ overlap: { enabled: true, severity: 'error' } });
    const input = document([cue(1, 0, 2000, 'accepted'), cue(2, 1500, 3000, 'later')]);
    const output = autoFix(input, evaluate(input, preset), {
      ruleset: preset,
      protect: new Set([input.cues[0]!]),
    });
    expect(output.doc).toEqual(input);
  });
});

describe('full merged candidates are validated using stable cue identities', () => {
  it.each(['missing', 'duplicate', 'unknown'] as const)(
    'rejects a fixer with %s internal cue identities',
    (failure) => {
      const preset = ruleset({ 'min-duration': { enabled: true, severity: 'error', ms: 833 } });
      const malformedFix: RuleDefinition<'min-duration'> = {
        ...RULES['min-duration'],
        fix: (input) => {
          const first = input.cues[0]!;
          const internalIdentity = Object.getOwnPropertySymbols(first)[0]!;
          const replacement =
            failure === 'missing' ? cue(1, 0, 833, 'short') : { ...first, [internalIdentity]: 999 };
          return { ...input, cues: failure === 'duplicate' ? [first, first] : [replacement] };
        },
      };
      const registry = { ...RULES, 'min-duration': malformedFix };
      const input = document([cue(1, 0, 200, 'short')]);
      const issues = evaluate(input, preset, registry);
      const output = autoFix(input, issues, { ruleset: preset }, registry);
      expect(output.doc).toEqual(input);
      expect(output.fixed).toEqual([]);
      expect(output.unfixable).toEqual(issues);
      expect(output.doc.cues.flatMap(Object.getOwnPropertySymbols)).toEqual([]);
    },
  );

  it('does not invoke cue-local fixers for protected cues', () => {
    const preset = ruleset({
      'forbidden-characters': { enabled: true, severity: 'error', chars: ['x'] },
    });
    const fixedIndices: number[] = [];
    const localFix: RuleDefinition<'forbidden-characters'> = {
      ...RULES['forbidden-characters'],
      fixCue: (current) => {
        fixedIndices.push(current.index);
        return { ...current, lines: [textLine('X')] };
      },
    };
    const registry = { ...RULES, 'forbidden-characters': localFix };
    const input = document([cue(1, 0, 1000, 'x'), cue(2, 2000, 3000, 'x')]);
    const output = autoFix(
      input,
      evaluate(input, preset, registry),
      {
        ruleset: preset,
        protect: new Set([input.cues[0]!]),
      },
      registry,
    );
    expect(fixedIndices).toEqual([2]);
    expect(output.doc.cues[0]).toBe(input.cues[0]);
    expect(output.doc.cues.map(cueToText)).toEqual(['x', 'X']);
  });

  it.each([true, false])(
    'rejects a new overlap on another cue even when total counts are unchanged (protected=%s)',
    (protectLast) => {
      const preset = ruleset({
        'max-duration': { enabled: true, severity: 'error', ms: 1000 },
        overlap: { enabled: true, severity: 'error' },
      });
      const swappingFix: RuleDefinition<'max-duration'> = {
        ...RULES['max-duration'],
        fix: (input) => ({
          ...input,
          cues: input.cues.map((current) =>
            current.index === 1
              ? { ...current, endMs: 900 }
              : current.index === 3
                ? { ...current, endMs: 2600 }
                : current,
          ),
        }),
      };
      const registry = { ...RULES, 'max-duration': swappingFix };
      const input = document([
        cue(1, 0, 1100, 'first'),
        cue(2, 1000, 1900, 'second'),
        cue(3, 2000, 2200, 'third'),
        cue(4, 2500, 3000, 'last'),
      ]);
      const issues = evaluate(input, preset, registry).filter(
        (issue) => issue.ruleId === 'max-duration',
      );
      const output = autoFix(
        input,
        issues,
        {
          ruleset: preset,
          protect: protectLast ? new Set([input.cues[3]!]) : undefined,
        },
        registry,
      );
      expect(output.doc).toEqual(input);
      expect(output.fixed).toEqual([]);
      expect(output.unfixable).toEqual(issues);
    },
  );

  it('validates newly adjacent visible cues after empty-cue deletion with a comment restored', () => {
    const preset = ruleset({
      'empty-cue': { enabled: true, severity: 'error' },
      'min-gap': { enabled: true, severity: 'error', ms: 100 },
    });
    const input = document([
      { ...cue(1, 0, 0, 'note'), raw: { kind: 'Comment' } },
      cue(2, 0, 1000, 'before'),
      cue(3, 500, 600, ''),
      cue(4, 1050, 2000, 'accepted'),
    ]);
    const issues = evaluate(input, preset).filter((issue) => issue.ruleId === 'empty-cue');
    const output = autoFix(input, issues, { ruleset: preset, protect: new Set([input.cues[3]!]) });
    expect(output.doc).toEqual(input);
    expect(output.unfixable).toEqual(issues);
  });

  it.each([undefined, 'same-app-uid'])(
    'targets the original cue after an earlier fixer renumbers it (uid=%s)',
    (uid) => {
      const preset = ruleset({
        'empty-cue': { enabled: true, severity: 'error' },
        'forbidden-characters': { enabled: true, severity: 'error', chars: ['x'] },
      });
      const localFix: RuleDefinition<'forbidden-characters'> = {
        ...RULES['forbidden-characters'],
        fixCue: (current) => ({ ...current, lines: [textLine(cueToText(current).toUpperCase())] }),
      };
      const registry = { ...RULES, 'forbidden-characters': localFix };
      const input = document([
        cue(1, 0, 1000, ''),
        { ...cue(2, 2000, 3000, 'x'), uid, sourceIndex: 42 },
        { ...cue(3, 4000, 5000, 'keep'), uid },
      ]);
      const output = autoFix(
        input,
        evaluate(input, preset, registry),
        { ruleset: preset },
        registry,
      );
      expect(output.doc.cues.map(cueToText)).toEqual(['X', 'keep']);
      expect(output.doc.cues.map((current) => current.index)).toEqual([1, 2]);
      expect(output.doc.cues[0]!.sourceIndex).toBe(42);
      expect(output.doc.cues.map((current) => current.uid)).toEqual([uid, uid]);
      expect(output.doc.cues.flatMap(Object.getOwnPropertySymbols)).toEqual([]);
    },
  );
});

describe('protected and hidden cues survive structural fixes', () => {
  const preset = ruleset({ 'empty-cue': { enabled: true, severity: 'error' } });

  it('keeps Comment #1 while deleting empty #2 and reindexes the full result', () => {
    const comment = { ...cue(1, 0, 0, ''), raw: { kind: 'Comment' } };
    const input = document([comment, cue(2, 500, 700, ''), cue(3, 1000, 2000, 'visible')]);
    const output = autoFix(input, evaluate(input, preset), { ruleset: preset });
    expect(output.doc.cues.map((current) => current.index)).toEqual([1, 2]);
    expect(output.doc.cues[0]).toEqual(comment);
    expect(output.doc.cues.map(cueToText)).toEqual(['', 'visible']);
  });

  it('preserves comment order relative to surviving cues after earlier deletions', () => {
    const input = document([
      cue(1, 0, 100, ''),
      { ...cue(2, 0, 0, 'note one'), raw: { kind: 'Comment' } },
      cue(3, 1000, 2000, 'visible one'),
      { ...cue(4, 0, 0, 'note two'), raw: { kind: 'Comment' } },
      cue(5, 3000, 4000, 'visible two'),
    ]);
    const output = autoFix(input, evaluate(input, preset), { ruleset: preset });
    expect(output.doc.cues.map(cueToText)).toEqual([
      'note one',
      'visible one',
      'note two',
      'visible two',
    ]);
    expect(output.doc.cues.map((current) => current.index)).toEqual([1, 2, 3, 4]);
  });

  it('restores a protected empty cue after the whole-document fixer tries to remove it', () => {
    const input = document([
      cue(1, 0, 100, ''),
      cue(2, 200, 300, ''),
      cue(3, 1000, 2000, 'visible'),
    ]);
    const protectedCue = input.cues[1]!;
    const issues = evaluate(input, preset).filter((issue) => issue.cueIndex === 1);
    const output = autoFix(input, issues, { ruleset: preset, protect: new Set([protectedCue]) });
    expect(output.doc.cues).toEqual([
      { ...protectedCue, index: 1 },
      { ...input.cues[2]!, index: 2 },
    ]);
    expect(output.doc.cues.flatMap(Object.getOwnPropertySymbols)).toEqual([]);
  });
});
