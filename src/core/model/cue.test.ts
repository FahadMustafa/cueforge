import { describe, expect, it } from 'vitest';
import { cueDurationMs, cueToText, lineToText, makeSpan, textLine } from './cue';
import type { Cue } from './types';

describe('makeSpan', () => {
  it('makes a plain span', () => {
    expect(makeSpan('hi')).toEqual({ text: 'hi' });
  });

  it('applies styling', () => {
    expect(makeSpan('hi', { italic: true, color: '#FF0000' })).toEqual({
      text: 'hi',
      italic: true,
      color: '#FF0000',
    });
  });
});

describe('textLine', () => {
  it('wraps plain text in a single unstyled span', () => {
    expect(textLine('hello')).toEqual({ spans: [{ text: 'hello' }] });
  });
});

describe('lineToText', () => {
  it('concatenates span text in order', () => {
    const line = { spans: [makeSpan('Hello '), makeSpan('world', { bold: true })] };
    expect(lineToText(line)).toBe('Hello world');
  });
});

describe('cueToText', () => {
  it('joins visual lines with newlines', () => {
    const cue: Cue = {
      index: 1,
      startMs: 0,
      endMs: 1000,
      lines: [textLine('line one'), textLine('line two')],
    };
    expect(cueToText(cue)).toBe('line one\nline two');
  });
});

describe('cueDurationMs', () => {
  it('returns end minus start', () => {
    expect(cueDurationMs({ index: 1, startMs: 1000, endMs: 3500, lines: [] })).toBe(2500);
  });

  it('is negative for reversed timing', () => {
    expect(cueDurationMs({ index: 1, startMs: 3000, endMs: 1000, lines: [] })).toBe(-2000);
  });
});
