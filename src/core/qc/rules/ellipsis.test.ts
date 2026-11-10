import { describe, expect, it } from 'vitest';
import { makeSpan, textLine } from '../../model/cue';
import type { Cue, StyledSpan, SubtitleDocument } from '../../model/types';
import { ellipsisStyle, fixAsciiEllipsisText, hasAsciiEllipsis } from './ellipsis';

function docOf(text: string): SubtitleDocument {
  const cue: Cue = { index: 1, startMs: 0, endMs: 1000, lines: [textLine(text)] };
  return { cues: [cue], metadata: { sourceFormat: 'srt' }, warnings: [] };
}

/** Build a single-cue doc whose one line is made of the given styled spans. */
function docOfSpans(spans: StyledSpan[]): SubtitleDocument {
  const cue: Cue = { index: 1, startMs: 0, endMs: 1000, lines: [{ spans }] };
  return { cues: [cue], metadata: { sourceFormat: 'srt' }, warnings: [] };
}
const base = { enabled: true, severity: 'warning' } as const;

describe('hasAsciiEllipsis', () => {
  it.each([
    ['Wait...', true], // three ASCII dots — the Netflix-rejected form
    ['Wait…', false], // already the Unicode ellipsis
    ['Well....', true], // a longer run is still an ASCII ellipsis
    ['3.14', false], // decimal point
    ['End. Next.', false], // two separated single periods
    ['a..b', false], // only two dots
    ['', false],
  ])('%s -> %s', (text, expected) => {
    expect(hasAsciiEllipsis(text)).toBe(expected);
  });
});

describe('fixAsciiEllipsisText', () => {
  it('replaces a three-dot run with U+2026', () => {
    expect(fixAsciiEllipsisText('Wait...')).toBe('Wait…');
  });
  it('collapses a longer run to a single ellipsis', () => {
    expect(fixAsciiEllipsisText('Well.....')).toBe('Well…');
  });
  it('leaves an existing Unicode ellipsis untouched', () => {
    expect(fixAsciiEllipsisText('Wait… what?')).toBe('Wait… what?');
  });
  it('leaves ordinary periods untouched', () => {
    expect(fixAsciiEllipsisText('End. Next.')).toBe('End. Next.');
  });
});

describe('ellipsis-style', () => {
  it('flags a cue that uses three ASCII dots', () => {
    const v = ellipsisStyle.evaluate(docOf('Wait...'), base);
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
  });
  it('passes a cue that uses the Unicode ellipsis', () => {
    expect(ellipsisStyle.evaluate(docOf('Wait…'), base)).toEqual([]);
  });
  it('auto-fix converts ASCII dots to U+2026, preserving spans', () => {
    const fixed = ellipsisStyle.fix!(docOf('Wait...'), base);
    expect(fixed.cues[0]!.lines[0]!.spans.map((s) => s.text).join('')).toBe('Wait…');
  });
  it('is auto-fixable', () => {
    expect(ellipsisStyle.fixable).toBe(true);
  });

  // cue-forge-zxw.7: a dot run straddling a StyledSpan boundary was missed when
  // detection ran per-span; it now evaluates the whole line via lineToText.
  it('flags a dot run that straddles a span boundary', () => {
    const v = ellipsisStyle.evaluate(docOfSpans([makeSpan('Wait.'), makeSpan('..')]), base);
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
  });

  it('does not flag single periods split across spans', () => {
    // "End." + "Next." -> "End.Next." has no run of three.
    expect(ellipsisStyle.evaluate(docOfSpans([makeSpan('End.'), makeSpan('Next.')]), base)).toEqual(
      [],
    );
  });

  it('auto-fix collapses a straddling run to one ellipsis, preserving styling', () => {
    const fixed = ellipsisStyle.fix!(
      docOfSpans([makeSpan('a..'), makeSpan('.b', { bold: true })]),
      base,
    );
    const spans = fixed.cues[0]!.lines[0]!.spans;
    expect(spans.map((s) => s.text).join('')).toBe('a…b');
    // The trailing "b" keeps its bold styling; the ellipsis is owned by span 1.
    expect(spans[spans.length - 1]).toMatchObject({ text: 'b', bold: true });
  });

  it('auto-fix drops a span fully consumed by a boundary collapse', () => {
    const fixed = ellipsisStyle.fix!(
      docOfSpans([makeSpan('Wait.', { italic: true }), makeSpan('..')]),
      base,
    );
    const spans = fixed.cues[0]!.lines[0]!.spans;
    expect(spans.map((s) => s.text).join('')).toBe('Wait…');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ italic: true });
  });
});
