import { describe, expect, it } from 'vitest';
import { checkCharset } from './charset';
import { textLine, type SubtitleDocument } from '../model';

function doc(...texts: string[]): SubtitleDocument {
  return {
    cues: texts.map((t, i) => ({
      index: i + 1,
      startMs: i * 2000,
      endMs: i * 2000 + 1000,
      lines: [textLine(t)],
    })),
    metadata: { sourceFormat: 'srt' },
    warnings: [],
  };
}

const asciiOnly = (ch: string) => ch.charCodeAt(0) < 0x80;

describe('checkCharset', () => {
  it('reports zero unrepresentable characters for a clean document', () => {
    const report = checkCharset(doc('Hello there', 'General Kenobi'), asciiOnly);
    expect(report.unrepresentable).toBe(0);
    expect(report.share).toBe(0);
    expect(report.samples).toEqual([]);
  });

  it('skips whitespace and counts only visible characters', () => {
    const report = checkCharset(doc('a b\tc'), asciiOnly);
    expect(report.total).toBe(3);
  });

  it('counts unrepresentable characters with distinct samples (max 3)', () => {
    const report = checkCharset(doc('café سلام'), asciiOnly);
    expect(report.total).toBe(8);
    expect(report.unrepresentable).toBe(5); // é + 4 Arabic letters
    expect(report.samples).toHaveLength(3);
    expect(report.samples[0]).toBe('é');
    expect(new Set(report.samples).size).toBe(report.samples.length);
    expect(report.share).toBeCloseTo(5 / 8);
  });

  it('returns share 0 for an empty document', () => {
    expect(checkCharset(doc(), asciiOnly).share).toBe(0);
    expect(checkCharset(doc('   '), asciiOnly).share).toBe(0);
  });
});
