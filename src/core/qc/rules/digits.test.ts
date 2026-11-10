import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import type { Cue, SubtitleDocument } from '../../model/types';
import { mixedDigitStyle } from './digits';

function docOf(...texts: string[]): SubtitleDocument {
  const cues: Cue[] = texts.map((t, i) => ({
    index: i + 1,
    startMs: i * 1000,
    endMs: i * 1000 + 1000,
    lines: t.split('\n').map(textLine),
  }));
  return { cues, metadata: { sourceFormat: 'srt' }, warnings: [] };
}
const cfg = (style?: 'western' | 'arabic-indic' | 'extended-arabic-indic') => ({
  enabled: true as const,
  severity: 'warning' as const,
  ...(style ? { style } : {}),
});
const cueText = (doc: SubtitleDocument, i: number): string =>
  doc.cues[i]!.lines.map((l) => l.spans.map((s) => s.text).join('')).join('\n');

describe('mixed-digit-style', () => {
  it('passes a document that uses one digit family consistently', () => {
    expect(mixedDigitStyle.evaluate(docOf('سنة ٢٠٢٤', 'صفحة ٥'), cfg())).toEqual([]);
  });

  it('passes a document with no digits at all', () => {
    expect(mixedDigitStyle.evaluate(docOf('مرحبا', 'بالعالم'), cfg())).toEqual([]);
  });

  it('flags the cue holding the minority digit family', () => {
    const v = mixedDigitStyle.evaluate(docOf('سنة ٢٠٢٤ ٢٠٢٥', 'page 5'), cfg());
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(2);
  });

  it('flags a single cue that itself mixes families', () => {
    const v = mixedDigitStyle.evaluate(docOf('رقم ١٢٣ و 4'), cfg());
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
  });

  it('is auto-fixable and normalizes the whole document to the chosen style', () => {
    expect(mixedDigitStyle.fixable).toBe(true);
    const fixed = mixedDigitStyle.fix!(docOf('سنة ٢٠٢٤ ٢٠٢٥', 'page 5'), cfg('western'));
    expect(cueText(fixed, 0)).toBe('سنة 2024 2025');
    expect(cueText(fixed, 1)).toBe('page 5');
    expect(mixedDigitStyle.evaluate(fixed, cfg('western'))).toEqual([]);
  });

  it('normalizes to arabic-indic when configured', () => {
    const fixed = mixedDigitStyle.fix!(docOf('سنة ٢٠٢٤', 'page 5'), cfg('arabic-indic'));
    expect(cueText(fixed, 1)).toBe('page ٥');
    expect(mixedDigitStyle.evaluate(fixed, cfg('arabic-indic'))).toEqual([]);
  });

  it('defaults the fix target to western when no style is configured', () => {
    const fixed = mixedDigitStyle.fix!(docOf('page ٥ and 6'), cfg());
    expect(cueText(fixed, 0)).toBe('page 5 and 6');
  });
});
