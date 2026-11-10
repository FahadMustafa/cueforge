import { describe, expect, it } from 'vitest';
import { validateRuleset } from '../ruleset.schema';
import { PRESETS, type PresetName } from './index';

const names: PresetName[] = ['generic', 'netflix-latin', 'youtube', 'netflix-arabic'];

describe('QC presets', () => {
  it('ships every named preset', () => {
    for (const n of names) expect(PRESETS[n]).toBeDefined();
  });

  it('every preset is a valid ruleset', () => {
    for (const n of names) expect(validateRuleset(PRESETS[n])).toEqual([]);
  });

  it('each preset name matches its key', () => {
    for (const n of names) expect(PRESETS[n].name).toBe(n);
  });

  it('carries the spec §5.4 seed values', () => {
    expect(PRESETS['generic'].rules['max-chars-per-line']?.max).toBe(45);
    expect(PRESETS['netflix-latin'].rules['max-chars-per-line']?.max).toBe(42);
    expect(PRESETS['youtube'].rules['max-chars-per-line']?.max).toBe(60);
    expect(PRESETS['netflix-latin'].rules['min-gap']?.frames).toBe(2);
  });

  it('tunes netflix-arabic for RTL (spec §5.3/§5.4)', () => {
    const ar = PRESETS['netflix-arabic'];
    // Arabic conventions differ — Latin punctuation-spacing is turned off.
    expect(ar.rules['punctuation-spacing']?.enabled).toBe(false);
    // CPS must not count Arabic diacritics (U+064B–U+065F).
    expect(ar.rules['max-cps']?.excludeRanges).toContainEqual([0x064b, 0x065f]);
    // The five Arabic/RTL rules ship enabled.
    expect(ar.rules['bidi-punctuation']?.enabled).toBe(true);
    expect(ar.rules['mixed-digit-style']?.enabled).toBe(true);
    expect(ar.rules['latin-run-isolation']?.enabled).toBe(true);
    expect(ar.rules['arabic-line-length']?.max).toBe(42);
    expect(ar.rules['kashida-strip']?.enabled).toBe(true);
  });

  it('cites a real external reference where one exists, never our own repo', () => {
    for (const n of names) {
      const ref = PRESETS[n].reference;
      if (ref !== undefined) {
        expect(ref).toMatch(/^https?:\/\//);
        // A user-facing "reference" must be an external authority, not a link
        // into our own source repo (cue-forge-... regression, found 2026-06-30).
        expect(ref).not.toMatch(/github\.com\/[^/]*cue-?forge/i);
      }
    }
    // Verified presets must cite the platform spec they were verified against.
    expect(PRESETS['netflix-latin'].reference).toMatch(/^https?:\/\//);
    expect(PRESETS['netflix-arabic'].reference).toMatch(/^https?:\/\//);
    // The generic preset is our own baseline — no external standard, so no link.
    expect(PRESETS['generic'].reference).toBeUndefined();
  });

  it('marks the Netflix presets verified against the spec, youtube/generic draft (cue-forge-n3e.8/.12)', () => {
    // netflix-latin's six thresholds were confirmed against primary Netflix
    // Timed Text Style Guide sources (research + adversarial verification).
    expect(PRESETS['netflix-latin'].verified).toBe(true);
    // netflix-arabic (cue-forge-n3e.12): the language-specific values (42 CPL,
    // 2 lines, 20 CPS adult) are in the Arabic guide, which defers timing to the
    // general Subtitle Timing Guidelines — where the 2-frame minimum gap is
    // stated as language-independent ("applicable to any frame rate"). All six
    // thresholds now trace to a primary Netflix source, so it is verified.
    expect(PRESETS['netflix-arabic'].verified).toBe(true);
    // youtube/generic stay draft: no platform spec to verify against.
    expect(PRESETS['generic'].verified).toBe(false);
    expect(PRESETS['youtube'].verified).toBe(false);
  });

  it('points netflix-arabic at the Arabic guide, not the Thai one (cue-forge-n3e.8 fix)', () => {
    expect(PRESETS['netflix-arabic'].reference).toContain('215517947');
  });
});
