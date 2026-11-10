import { describe, expect, it } from 'vitest';
import { parseInline, parseStyledLines, serializeInline, serializeStyledLines } from './inline';
import type { CueLine, StyledSpan } from '../model/types';

describe('parseInline', () => {
  it('returns one plain span for unstyled text', () => {
    expect(parseInline('hello').spans).toEqual([{ text: 'hello' }]);
  });

  it('parses italic / bold / underline', () => {
    expect(parseInline('<i>a</i>').spans).toEqual([{ text: 'a', italic: true }]);
    expect(parseInline('<b>a</b>').spans).toEqual([{ text: 'a', bold: true }]);
    expect(parseInline('<u>a</u>').spans).toEqual([{ text: 'a', underline: true }]);
  });

  it('parses nested styles and surrounding plain runs', () => {
    expect(parseInline('x<i>a<b>c</b></i>y').spans).toEqual([
      { text: 'x' },
      { text: 'a', italic: true },
      { text: 'c', italic: true, bold: true },
      { text: 'y' },
    ]);
  });

  it('parses font color (double, single, and unquoted)', () => {
    expect(parseInline('<font color="#FF0000">a</font>').spans).toEqual([
      { text: 'a', color: '#FF0000' },
    ]);
    expect(parseInline("<font color='red'>a</font>").spans).toEqual([{ text: 'a', color: 'red' }]);
    expect(parseInline('<font color=red>a</font>').spans).toEqual([{ text: 'a', color: 'red' }]);
  });

  it('is case-insensitive on tag names', () => {
    expect(parseInline('<I>a</I>').spans).toEqual([{ text: 'a', italic: true }]);
  });

  it('keeps a non-tag < as literal text', () => {
    expect(parseInline('3 < 4 > 2').spans).toEqual([{ text: '3 < 4 > 2' }]);
  });

  it('warns on an unclosed tag but still styles the text', () => {
    const r = parseInline('<i>a');
    expect(r.spans).toEqual([{ text: 'a', italic: true }]);
    expect(r.warnings).toContainEqual({ code: 'unclosed-tag', tag: 'i' });
  });

  it('warns on a stray closing tag', () => {
    const r = parseInline('a</i>');
    expect(r.warnings).toContainEqual({ code: 'stray-close-tag', tag: 'i' });
  });

  it('parses a voice tag and does not warn when left unclosed (valid VTT)', () => {
    const r = parseInline('<v Roger>hi');
    expect(r.spans).toEqual([{ text: 'hi', voice: 'Roger' }]);
    expect(r.warnings).toEqual([]);
  });

  it('parses a voice tag with classes, preserving them in the name', () => {
    expect(parseInline('<v.loud Bob>yo</v>').spans).toEqual([{ text: 'yo', voice: '.loud Bob' }]);
  });

  it('keeps an unrecognized VTT class tag as literal text', () => {
    expect(parseInline('<c.yellow>x</c>').spans).toEqual([{ text: '<c.yellow>x</c>' }]);
  });

  it('warns on a stray closing font tag', () => {
    expect(parseInline('a</font>').warnings).toContainEqual({
      code: 'stray-close-tag',
      tag: 'font',
    });
  });

  it('warns on a stray closing voice tag', () => {
    expect(parseInline('a</v>').warnings).toContainEqual({ code: 'stray-close-tag', tag: 'v' });
  });

  it('round-trips an empty-name voice tag', () => {
    expect(parseInline('<v>x</v>').spans).toEqual([{ text: 'x', voice: '' }]);
    expect(serializeInline([{ text: 'x', voice: '' }])).toBe('<v>x</v>');
  });

  it('warns on an unclosed font tag', () => {
    expect(parseInline('<font color="red">a').warnings).toContainEqual({
      code: 'unclosed-tag',
      tag: 'font',
    });
  });
});

describe('serializeInline', () => {
  it('emits plain text unchanged', () => {
    expect(serializeInline([{ text: 'hello' }])).toBe('hello');
  });

  it('wraps styles and round-trips through parseInline', () => {
    const spans: StyledSpan[] = [
      { text: 'x' },
      { text: 'a', italic: true },
      { text: 'c', italic: true, bold: true },
      { text: 'r', color: '#00FF00' },
      { text: 'spoken', voice: 'Roger' },
    ];
    expect(parseInline(serializeInline(spans)).spans).toEqual(spans);
  });
});

describe('styled lines', () => {
  it('splits a multi-line block into lines', () => {
    const { lines } = parseStyledLines('line one\nline two');
    expect(lines).toEqual<CueLine[]>([
      { spans: [{ text: 'line one' }] },
      { spans: [{ text: 'line two' }] },
    ]);
  });

  it('carries a style across a line break', () => {
    const { lines } = parseStyledLines('<i>a\nb</i>');
    expect(lines).toEqual<CueLine[]>([
      { spans: [{ text: 'a', italic: true }] },
      { spans: [{ text: 'b', italic: true }] },
    ]);
  });

  it('round-trips styled multi-line text via re-parse', () => {
    const block = '<i>a\nb</i>';
    const first = parseStyledLines(block).lines;
    const round = parseStyledLines(serializeStyledLines(first)).lines;
    expect(round).toEqual(first);
  });

  it('preserves an empty middle line', () => {
    const { lines } = parseStyledLines('a\n\nb');
    expect(lines).toEqual<CueLine[]>([
      { spans: [{ text: 'a' }] },
      { spans: [] },
      { spans: [{ text: 'b' }] },
    ]);
  });
});
