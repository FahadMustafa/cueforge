import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import type { Cue, CueLine, SubtitleDocument } from '../../model/types';
import { maxCps } from './cps';

function docOf(lines: CueLine[], startMs = 0, endMs = 1000): SubtitleDocument {
  const cue: Cue = { index: 1, startMs, endMs, lines };
  return { cues: [cue], metadata: { sourceFormat: 'srt' }, warnings: [] };
}

const base = { enabled: true, severity: 'warning' } as const;

describe('max-cps', () => {
  it('flags a cue whose chars-per-second exceeds max', () => {
    // 21 chars over 1.0s = 21 cps.
    const v = maxCps.evaluate(docOf([textLine('a'.repeat(21))]), { ...base, max: 20 });
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/21.*20/);
  });

  it('passes a cue exactly at max', () => {
    expect(maxCps.evaluate(docOf([textLine('a'.repeat(20))]), { ...base, max: 20 })).toEqual([]);
  });

  it('excludes line breaks from the count by default', () => {
    // 11 + 10 chars across two lines = 21 chars, but the newline is not counted.
    const v = maxCps.evaluate(docOf([textLine('a'.repeat(11)), textLine('a'.repeat(10))]), {
      ...base,
      max: 21,
    });
    expect(v).toEqual([]);
  });

  it('counts the line break when excludeLineBreaks is false', () => {
    const v = maxCps.evaluate(docOf([textLine('a'.repeat(11)), textLine('a'.repeat(10))]), {
      ...base,
      max: 21,
      excludeLineBreaks: false,
    });
    expect(v).toHaveLength(1); // 21 chars + 1 newline = 22 cps > 21
  });

  it('excludes characters in the configured ranges (Arabic diacritics)', () => {
    // 20 base letters + 2 fatha (U+064E) diacritics; diacritics excluded → 20 cps.
    const text = 'ا'.repeat(20) + 'ََ';
    const v = maxCps.evaluate(docOf([textLine(text)]), {
      ...base,
      max: 20,
      excludeRanges: [[0x064b, 0x065f]],
    });
    expect(v).toEqual([]);
  });

  it('skips a zero-duration cue instead of dividing by zero', () => {
    expect(maxCps.evaluate(docOf([textLine('abc')], 500, 500), { ...base, max: 1 })).toEqual([]);
  });

  it('is auto-fixable (CPS assist extends the cue into the available gap)', () => {
    expect(maxCps.fixable).toBe(true);
    expect(typeof maxCps.fix).toBe('function');
  });
});

/**
 * CPS assist (cue-forge-n3e.4): extend a too-fast cue's end forward to exactly
 * the duration that brings reading speed down to the max, capped by the gap to
 * the next cue (minus the gap floor) and a conservative max-duration ceiling.
 * Declines (leaves the cue untouched) when it cannot reach that end.
 */
function docOfMany(cues: Cue[]): SubtitleDocument {
  return { cues, metadata: { sourceFormat: 'srt' }, warnings: [] };
}
function cueOf(index: number, startMs: number, endMs: number, text: string): Cue {
  return { index, startMs, endMs, lines: [textLine(text)] };
}

describe('max-cps fix (CPS assist)', () => {
  it('extends a too-fast cue into open space so reading speed drops to the max', () => {
    // 30 chars / 1.0 s = 30 cps (max 20). Needs 30/20 = 1.5 s → end 1500.
    const doc = docOfMany([cueOf(1, 0, 1000, 'a'.repeat(30)), cueOf(2, 5000, 6000, 'next')]);
    const out = maxCps.fix!(doc, { ...base, max: 20 });
    expect(out.cues[0]!.endMs).toBe(1500);
    // The fix resolves the violation.
    expect(maxCps.evaluate(out, { ...base, max: 20 })).toEqual([]);
  });

  it('does not mutate the input document', () => {
    const doc = docOfMany([cueOf(1, 0, 1000, 'a'.repeat(30)), cueOf(2, 5000, 6000, 'next')]);
    maxCps.fix!(doc, { ...base, max: 20 });
    expect(doc.cues[0]!.endMs).toBe(1000);
  });

  it('declines when the next cue leaves no room (gap floor)', () => {
    // next starts 1000 ms after this cue's start; gap limit 1000-100=900 < needed 1500.
    const doc = docOfMany([cueOf(1, 0, 1000, 'a'.repeat(30)), cueOf(2, 1000, 2000, 'next')]);
    const out = maxCps.fix!(doc, { ...base, max: 20 });
    expect(out.cues[0]!.endMs).toBe(1000);
  });

  it('declines when extending would overlap the next cue', () => {
    // next starts before this cue would need to end.
    const doc = docOfMany([cueOf(1, 0, 2000, 'a'.repeat(60)), cueOf(2, 1500, 3000, 'next')]);
    const out = maxCps.fix!(doc, { ...base, max: 20 });
    expect(out.cues[0]!.endMs).toBe(2000);
  });

  it('extends the last cue (no successor) up to the needed end', () => {
    // 100 chars / 1.0 s = 100 cps (max 20). Needs 100/20 = 5 s → end 5000 (<= 7000 ceiling).
    const doc = docOfMany([cueOf(1, 0, 1000, 'a'.repeat(100))]);
    const out = maxCps.fix!(doc, { ...base, max: 20 });
    expect(out.cues[0]!.endMs).toBe(5000);
  });

  it('declines when the needed end exceeds the conservative max-duration ceiling', () => {
    // 200 chars / 1.0 s = 200 cps. Needs 10 s, beyond the 7000 ms ceiling → decline.
    const doc = docOfMany([cueOf(1, 0, 1000, 'a'.repeat(200))]);
    const out = maxCps.fix!(doc, { ...base, max: 20 });
    expect(out.cues[0]!.endMs).toBe(1000);
  });

  it('counts only non-excluded characters when sizing the extension', () => {
    // 40 base letters + 40 fatha; diacritics excluded → 40 counted chars.
    // 40/20 = 2 s → end 2000.
    const text = 'ا'.repeat(40) + 'َ'.repeat(40);
    const doc = docOfMany([cueOf(1, 0, 1000, text), cueOf(2, 9000, 10000, 'next')]);
    const out = maxCps.fix!(doc, { ...base, max: 20, excludeRanges: [[0x064b, 0x065f]] });
    expect(out.cues[0]!.endMs).toBe(2000);
  });

  it('leaves cues already at or under the limit untouched', () => {
    const doc = docOfMany([cueOf(1, 0, 1000, 'a'.repeat(15)), cueOf(2, 5000, 6000, 'next')]);
    const out = maxCps.fix!(doc, { ...base, max: 20 });
    expect(out.cues[0]!.endMs).toBe(1000);
  });

  it('skips zero-duration cues', () => {
    const doc = docOfMany([cueOf(1, 500, 500, 'abc'), cueOf(2, 5000, 6000, 'next')]);
    const out = maxCps.fix!(doc, { ...base, max: 1 });
    expect(out.cues[0]!.endMs).toBe(500);
  });
});
