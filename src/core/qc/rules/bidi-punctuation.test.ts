import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import { RLM } from '../../rtl';
import type { Cue, SubtitleDocument } from '../../model/types';
import {
  bidiPunctuation,
  hasBidiPunctuationIssue,
  fixBidiPunctuationText,
} from './bidi-punctuation';

function docOf(...lines: string[]): SubtitleDocument {
  const cue: Cue = { index: 1, startMs: 0, endMs: 2000, lines: lines.map(textLine) };
  return { cues: [cue], metadata: { sourceFormat: 'srt' }, warnings: [] };
}
const base = { enabled: true, severity: 'warning' } as const;

describe('hasBidiPunctuationIssue', () => {
  it.each([
    ['RTL line ending in a neutral period', 'مرحبا بالعالم.', true],
    ['RTL line ending in ! ', 'توقف!', true],
    ['RTL line ending in Arabic question mark', 'كيف حالك؟', true],
    ['already anchored by RLM', `مرحبا.${RLM}`, false],
    ['no trailing punctuation', 'مرحبا بالعالم', false],
    ['pure Latin line', 'Hello world.', false],
    ['empty', '', false],
  ])('%s', (_label, text, expected) => {
    expect(hasBidiPunctuationIssue(text)).toBe(expected);
  });
});

describe('fixBidiPunctuationText', () => {
  it('inserts an RLM after the trailing punctuation', () => {
    expect(fixBidiPunctuationText('مرحبا.')).toBe(`مرحبا.${RLM}`);
  });
  it('is idempotent', () => {
    const once = fixBidiPunctuationText('مرحبا؟');
    expect(fixBidiPunctuationText(once)).toBe(once);
  });
  it('leaves a clean line untouched', () => {
    expect(fixBidiPunctuationText('Hello.')).toBe('Hello.');
  });
});

describe('bidi-punctuation rule', () => {
  it('flags a cue with the issue and is fixable', () => {
    expect(bidiPunctuation.fixable).toBe(true);
    const v = bidiPunctuation.evaluate(docOf('مرحبا.'), base);
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
    // The message spells out the RLM acronym once (cue-forge-w28.16).
    expect(v[0]!.message).toContain('right-to-left mark (RLM)');
  });

  it('fix resolves the issue (rule re-check is clean)', () => {
    const fixed = bidiPunctuation.fix!(docOf('مرحبا.', 'توقف!'), base);
    expect(bidiPunctuation.evaluate(fixed, base)).toEqual([]);
  });
});
