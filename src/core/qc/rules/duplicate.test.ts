import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import type { Cue, SubtitleDocument } from '../../model/types';
import { duplicateCue } from './duplicate';

function cue(index: number, text: string): Cue {
  return { index, startMs: index * 1000, endMs: index * 1000 + 900, lines: [textLine(text)] };
}
function docOf(cues: Cue[]): SubtitleDocument {
  return { cues, metadata: { sourceFormat: 'srt' }, warnings: [] };
}
const base = { enabled: true, severity: 'warning' } as const;

describe('duplicate-cue', () => {
  it('flags a cue whose text repeats the previous cue', () => {
    const v = duplicateCue.evaluate(docOf([cue(1, 'hello'), cue(2, 'hello')]), base);
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(2);
  });
  it('ignores differing consecutive cues', () => {
    expect(duplicateCue.evaluate(docOf([cue(1, 'hello'), cue(2, 'world')]), base)).toEqual([]);
  });
  it('only compares adjacent cues', () => {
    const v = duplicateCue.evaluate(docOf([cue(1, 'a'), cue(2, 'b'), cue(3, 'a')]), base);
    expect(v).toEqual([]);
  });
  it('does not treat empty cues as duplicates (empty-cue owns those)', () => {
    expect(duplicateCue.evaluate(docOf([cue(1, ''), cue(2, '')]), base)).toEqual([]);
  });
  it('is not auto-fixable', () => {
    expect(duplicateCue.fixable).toBe(false);
  });
});
