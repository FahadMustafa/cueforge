import { describe, expect, it } from 'vitest';
import { parseRuleset, validateRuleset, type Ruleset } from './ruleset.schema';

const minimal: unknown = {
  name: 'test',
  verified: false,
  rules: {
    overlap: { enabled: true, severity: 'error' },
  },
};

describe('validateRuleset', () => {
  it('accepts a minimal valid ruleset', () => {
    expect(validateRuleset(minimal)).toEqual([]);
  });

  it('accepts a ruleset exercising every rule with its params', () => {
    const full: unknown = {
      name: 'full',
      verified: false,
      reference: 'https://example.com/spec',
      rules: {
        'max-chars-per-line': { enabled: true, severity: 'warning', max: 42 },
        'max-lines-per-cue': { enabled: true, severity: 'warning', max: 2 },
        'max-cps': {
          enabled: true,
          severity: 'warning',
          max: 20,
          excludeLineBreaks: true,
          excludeRanges: [[0x064b, 0x065f]],
        },
        'min-duration': { enabled: true, severity: 'warning', ms: 833 },
        'max-duration': { enabled: true, severity: 'warning', ms: 7000 },
        'min-gap': { enabled: true, severity: 'warning', frames: 2, ms: 83 },
        overlap: { enabled: true, severity: 'error' },
        'reversed-timing': { enabled: true, severity: 'error' },
        'empty-cue': { enabled: true, severity: 'error' },
        'duplicate-cue': { enabled: true, severity: 'warning' },
        'forbidden-characters': {
          enabled: true,
          severity: 'warning',
          chars: ['\t'],
          patterns: ['  '],
        },
        'punctuation-spacing': { enabled: false, severity: 'warning' },
        'unclosed-tag': { enabled: true, severity: 'error' },
        'cue-count-monotonic-timing': { enabled: true, severity: 'error' },
        'bidi-punctuation': { enabled: true, severity: 'warning' },
        'mixed-digit-style': { enabled: true, severity: 'warning', style: 'western' },
        'latin-run-isolation': { enabled: true, severity: 'warning' },
        'arabic-line-length': { enabled: true, severity: 'warning', max: 42 },
        'kashida-strip': { enabled: true, severity: 'warning' },
      },
    };
    expect(validateRuleset(full)).toEqual([]);
  });

  it('requires numeric max on arabic-line-length', () => {
    const errs = validateRuleset({
      name: 'x',
      verified: false,
      rules: { 'arabic-line-length': { enabled: true, severity: 'warning' } },
    });
    expect(errs.some((e) => e.includes('arabic-line-length') && e.includes('max'))).toBe(true);
  });

  it('rejects an unknown digit style on mixed-digit-style', () => {
    const errs = validateRuleset({
      name: 'x',
      verified: false,
      rules: { 'mixed-digit-style': { enabled: true, severity: 'warning', style: 'roman' } },
    });
    expect(errs.some((e) => e.includes('mixed-digit-style') && e.includes('style'))).toBe(true);
  });

  it('accepts mixed-digit-style with no explicit style (defaults applied by the rule)', () => {
    expect(
      validateRuleset({
        name: 'x',
        verified: false,
        rules: { 'mixed-digit-style': { enabled: true, severity: 'warning' } },
      }),
    ).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateRuleset(null).length).toBeGreaterThan(0);
    expect(validateRuleset(42).length).toBeGreaterThan(0);
  });

  it('requires a string name', () => {
    expect(validateRuleset({ verified: false, rules: {} })).toContain('name must be a string');
  });

  it('requires a boolean verified', () => {
    expect(validateRuleset({ name: 'x', verified: 'no', rules: {} })).toContain(
      'verified must be a boolean',
    );
  });

  it('rejects an unknown rule id', () => {
    const errs = validateRuleset({
      name: 'x',
      verified: false,
      rules: { 'no-such-rule': { enabled: true, severity: 'error' } },
    });
    expect(errs.some((e) => e.includes('no-such-rule'))).toBe(true);
  });

  it('rejects an invalid severity', () => {
    const errs = validateRuleset({
      name: 'x',
      verified: false,
      rules: { overlap: { enabled: true, severity: 'fatal' } },
    });
    expect(errs.some((e) => e.includes('severity'))).toBe(true);
  });

  it('requires numeric max on max-chars-per-line', () => {
    const errs = validateRuleset({
      name: 'x',
      verified: false,
      rules: { 'max-chars-per-line': { enabled: true, severity: 'warning' } },
    });
    expect(errs.some((e) => e.includes('max-chars-per-line') && e.includes('max'))).toBe(true);
  });

  it('requires min-gap to specify ms or frames', () => {
    const errs = validateRuleset({
      name: 'x',
      verified: false,
      rules: { 'min-gap': { enabled: true, severity: 'warning' } },
    });
    expect(errs.some((e) => e.includes('min-gap'))).toBe(true);
  });

  it('rejects a non-array chars/patterns on forbidden-characters', () => {
    // A non-array here (e.g. `{}`) later gets spread by the thresholds/report UI
    // (`[...(f.chars ?? [])]`) and throws "not iterable" during render — a crafted
    // import file must fail validation instead of white-screening the app.
    const chars = validateRuleset({
      name: 'x',
      verified: false,
      rules: { 'forbidden-characters': { enabled: true, severity: 'warning', chars: {} } },
    });
    expect(chars.some((e) => e.includes('forbidden-characters'))).toBe(true);

    const patterns = validateRuleset({
      name: 'x',
      verified: false,
      rules: { 'forbidden-characters': { enabled: true, severity: 'warning', patterns: 'ab' } },
    });
    expect(patterns.some((e) => e.includes('forbidden-characters'))).toBe(true);
  });

  it('rejects non-string entries in forbidden-characters chars/patterns', () => {
    const errs = validateRuleset({
      name: 'x',
      verified: false,
      rules: { 'forbidden-characters': { enabled: true, severity: 'warning', chars: [42] } },
    });
    expect(errs.some((e) => e.includes('forbidden-characters'))).toBe(true);
  });

  it('rejects a non-array excludeRanges on max-cps', () => {
    // Spread by the CPS rule (`config.excludeRanges ?? []`) — a scalar throws inside runQc.
    const errs = validateRuleset({
      name: 'x',
      verified: false,
      rules: { 'max-cps': { enabled: true, severity: 'warning', max: 20, excludeRanges: 42 } },
    });
    expect(errs.some((e) => e.includes('max-cps'))).toBe(true);
  });

  it('rejects malformed range pairs in max-cps excludeRanges', () => {
    const errs = validateRuleset({
      name: 'x',
      verified: false,
      rules: {
        'max-cps': { enabled: true, severity: 'warning', max: 20, excludeRanges: [[1]] },
      },
    });
    expect(errs.some((e) => e.includes('max-cps'))).toBe(true);
  });
});

describe('parseRuleset', () => {
  it('returns a typed ruleset when valid', () => {
    const rs: Ruleset = parseRuleset(minimal);
    expect(rs.name).toBe('test');
    expect(rs.rules.overlap?.severity).toBe('error');
  });

  it('throws with the collected errors when invalid', () => {
    expect(() => parseRuleset({ name: 1, verified: false, rules: {} })).toThrow(/name/);
  });
});
