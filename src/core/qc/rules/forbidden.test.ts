import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import type { Cue, SubtitleDocument } from '../../model/types';
import { forbiddenCharacters } from './forbidden';

function docOf(text: string): SubtitleDocument {
  const cue: Cue = { index: 1, startMs: 0, endMs: 1000, lines: [textLine(text)] };
  return { cues: [cue], metadata: { sourceFormat: 'srt' }, warnings: [] };
}
const base = { enabled: true, severity: 'warning' } as const;

describe('forbidden-characters', () => {
  it('flags a forbidden literal character', () => {
    const v = forbiddenCharacters.evaluate(docOf('a\tb'), { ...base, chars: ['\t'] });
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
  });
  it('flags a forbidden substring pattern', () => {
    const v = forbiddenCharacters.evaluate(docOf('a  b'), { ...base, patterns: ['  '] });
    expect(v).toHaveLength(1);
  });
  it('passes clean text', () => {
    expect(
      forbiddenCharacters.evaluate(docOf('a b'), { ...base, chars: ['\t'], patterns: ['  '] }),
    ).toEqual([]);
  });
  it('reports each distinct forbidden token once per cue', () => {
    const v = forbiddenCharacters.evaluate(docOf('a\tb  c'), {
      ...base,
      chars: ['\t'],
      patterns: ['  '],
    });
    expect(v).toHaveLength(2);
  });
  it('does nothing when no chars or patterns are configured', () => {
    expect(forbiddenCharacters.evaluate(docOf('a\tb  c'), base)).toEqual([]);
  });
  it('is auto-fixable', () => {
    expect(forbiddenCharacters.fixable).toBe(true);
  });
});
