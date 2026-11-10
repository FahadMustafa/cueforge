import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import type { Cue, CueLine, SubtitleDocument } from '../../model/types';
import { unclosedTag } from './tags';

function docOf(lines: CueLine[]): SubtitleDocument {
  const cue: Cue = { index: 1, startMs: 0, endMs: 1000, lines };
  return { cues: [cue], metadata: { sourceFormat: 'srt' }, warnings: [] };
}
const base = { enabled: true, severity: 'error' } as const;

describe('unclosed-tag', () => {
  it('flags a cue whose text has an unclosed formatting tag', () => {
    const v = unclosedTag.evaluate(docOf([textLine('hello <i>world')]), base);
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
  });
  it('passes a cue with balanced tags', () => {
    expect(unclosedTag.evaluate(docOf([textLine('<i>ok</i>')]), base)).toEqual([]);
  });
  it('balances tags across the lines of one cue', () => {
    expect(
      unclosedTag.evaluate(docOf([textLine('<i>line one'), textLine('line two</i>')]), base),
    ).toEqual([]);
  });
  it('passes plain text', () => {
    expect(unclosedTag.evaluate(docOf([textLine('plain text')]), base)).toEqual([]);
  });
  it('is auto-fixable', () => {
    expect(unclosedTag.fixable).toBe(true);
  });
});

describe('unclosed-tag fix vs VTT opaque markup', () => {
  it('keeps the opaque markup of a cue that also carries a literal unclosed <i>', () => {
    const lines: CueLine[] = [{ spans: [{ text: 'x', opaque: '<c.x>' }, { text: ' <i>broken' }] }];
    const fixed = unclosedTag.fix!(docOf(lines), base);
    const spans = fixed.cues[0]!.lines.flatMap((l) => l.spans);
    expect(spans.some((s) => s.opaque === '<c.x>')).toBe(true);
  });

  it('does not turn a literal & into &amp; when fixing a plain cue', () => {
    const fixed = unclosedTag.fix!(docOf([textLine('A & B <i>x')]), base);
    const spans = fixed.cues[0]!.lines.flatMap((l) => l.spans);
    const text = spans.map((s) => s.text).join('');
    expect(text).toContain('A & B ');
    expect(text).not.toContain('&amp;');
    // The unclosed <i> is balanced into structured styling running to cue end.
    expect(spans.some((s) => s.italic)).toBe(true);
  });
});
