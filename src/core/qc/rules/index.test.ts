import { describe, expect, it } from 'vitest';
import { RULE_IDS } from '../ruleset.schema';
import { RULES } from './index';

describe('rule catalog', () => {
  it('defines every rule id from the schema', () => {
    for (const id of RULE_IDS) {
      expect(RULES[id], id).toBeDefined();
      expect(RULES[id].id).toBe(id);
    }
  });

  it('matches the spec auto-fixable classification (spec §5.2)', () => {
    const fixable = new Set(
      Object.values(RULES)
        .filter((r) => r.fixable)
        .map((r) => r.id),
    );
    expect(fixable).toEqual(
      new Set([
        'max-chars-per-line',
        'max-cps',
        'min-duration',
        'max-duration',
        'min-gap',
        'overlap',
        'reversed-timing',
        'empty-cue',
        'forbidden-characters',
        'punctuation-spacing',
        'unclosed-tag',
        'bidi-punctuation',
        'mixed-digit-style',
        'latin-run-isolation',
        'kashida-strip',
        'ellipsis-style',
      ]),
    );
  });

  it('defines a fix exactly when a rule is fixable', () => {
    for (const id of RULE_IDS) {
      const rule = RULES[id];
      expect(typeof rule.fix === 'function', id).toBe(rule.fixable);
    }
  });
});
