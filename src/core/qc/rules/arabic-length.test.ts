import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import type { Cue, SubtitleDocument } from '../../model/types';
import { arabicLineLength } from './arabic-length';

function docOf(...lines: string[]): SubtitleDocument {
  const cue: Cue = { index: 1, startMs: 0, endMs: 2000, lines: lines.map(textLine) };
  return { cues: [cue], metadata: { sourceFormat: 'srt' }, warnings: [] };
}
const cfg = (max: number) => ({ enabled: true as const, severity: 'warning' as const, max });

describe('arabic-line-length', () => {
  it('counts Arabic diacritics as zero-width', () => {
    // "مَدْرَسَة" is 5 visible letters with 4 harakat; under a max of 5 it is clean.
    expect(arabicLineLength.evaluate(docOf('مَدْرَسَة'), cfg(5))).toEqual([]);
  });

  it('flags a line whose visible length exceeds max', () => {
    const v = arabicLineLength.evaluate(docOf('abcdef'), cfg(5));
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
    expect(v[0]!.message).toContain('6');
  });

  it('reports the offending line number for multi-line cues', () => {
    const v = arabicLineLength.evaluate(docOf('ok', 'toolong!!'), cfg(5));
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toContain('Line 2');
  });

  it('does not count invisible bidi marks toward length', () => {
    expect(arabicLineLength.evaluate(docOf('ab‏c‎'), cfg(3))).toEqual([]);
  });

  it('is flag-only (not auto-fixable)', () => {
    expect(arabicLineLength.fixable).toBe(false);
    expect(typeof arabicLineLength.fix).toBe('undefined');
  });
});
