import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import type { Cue, CueLine, SubtitleDocument } from '../../model/types';
import { emptyCue, overlap, reversedTiming } from './structural';

function cue(
  index: number,
  startMs: number,
  endMs: number,
  lines: CueLine[] = [textLine('x')],
): Cue {
  return { index, startMs, endMs, lines };
}
function docOf(cues: Cue[], frameRate?: number, dropFrame?: boolean): SubtitleDocument {
  return {
    cues,
    metadata: {
      sourceFormat: dropFrame === undefined ? 'srt' : 'scc',
      frameRate,
      ...(dropFrame === undefined ? {} : { raw: { dropFrame } }),
    },
    warnings: [],
  };
}
/** The exact NTSC rate the SCC parser records (not the canonical 29.97 label). */
const NTSC_FPS = 30000 / 1001;
const base = { enabled: true, severity: 'error' } as const;

describe('overlap', () => {
  it('flags a cue that starts before the previous one ends', () => {
    const v = overlap.evaluate(docOf([cue(1, 0, 1000), cue(2, 900, 2000)]), base);
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(2);
  });
  it('allows back-to-back cues (start equals previous end)', () => {
    expect(overlap.evaluate(docOf([cue(1, 0, 1000), cue(2, 1000, 2000)]), base)).toEqual([]);
  });
  it('renders positions as timecode when the document declares a frame rate', () => {
    const v = overlap.evaluate(docOf([cue(1, 0, 1000), cue(2, 900, 2000)], 25), base);
    expect(v[0]!.message).toBe(
      'Overlaps the previous cue: starts 00:00:00:23 (900 ms), previous ends 00:00:01:00 (1000 ms).',
    );
  });
  it('renders positions as plain ms when no frame rate is declared', () => {
    const v = overlap.evaluate(docOf([cue(1, 0, 1000), cue(2, 900, 2000)]), base);
    expect(v[0]!.message).toBe('Overlaps the previous cue: starts 900 ms, previous ends 1000 ms.');
  });
  it('renders non-drop timecode when the source declares dropFrame: false (SCC NDF, w28.9)', () => {
    // 60060 ms = frame 1800 (NDF 00:01:00:00, DF 00:01:00;02) — the labels diverge here.
    const v = overlap.evaluate(docOf([cue(1, 0, 60060), cue(2, 900, 2000)], NTSC_FPS, false), base);
    expect(v[0]!.message).toBe(
      'Overlaps the previous cue: starts 00:00:00:27 (900 ms), previous ends 00:01:00:00 (60060 ms).',
    );
  });
  it('renders drop-frame timecode when the source declares dropFrame: true (SCC DF)', () => {
    const v = overlap.evaluate(docOf([cue(1, 0, 60060), cue(2, 900, 2000)], NTSC_FPS, true), base);
    expect(v[0]!.message).toBe(
      'Overlaps the previous cue: starts 00:00:00;27 (900 ms), previous ends 00:01:00;02 (60060 ms).',
    );
  });
  it('is auto-fixable', () => {
    expect(overlap.fixable).toBe(true);
  });
});

describe('reversed-timing', () => {
  it('flags a cue ending before it starts', () => {
    const v = reversedTiming.evaluate(docOf([cue(1, 1000, 500)]), base);
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
  });
  it('passes a well-ordered cue', () => {
    expect(reversedTiming.evaluate(docOf([cue(1, 0, 1000)]), base)).toEqual([]);
  });
  it('renders positions as timecode when the document declares a frame rate', () => {
    const v = reversedTiming.evaluate(docOf([cue(1, 1000, 500)], 25), base);
    expect(v[0]!.message).toBe('End 00:00:00:13 (500 ms) is before start 00:00:01:00 (1000 ms).');
  });
  it('honours the source drop-frame mode (w28.9)', () => {
    const ndf = reversedTiming.evaluate(docOf([cue(1, 60060, 500)], NTSC_FPS, false), base);
    expect(ndf[0]!.message).toBe(
      'End 00:00:00:15 (500 ms) is before start 00:01:00:00 (60060 ms).',
    );
    const df = reversedTiming.evaluate(docOf([cue(1, 60060, 500)], NTSC_FPS, true), base);
    expect(df[0]!.message).toBe('End 00:00:00;15 (500 ms) is before start 00:01:00;02 (60060 ms).');
  });
  it('is auto-fixable', () => {
    expect(reversedTiming.fixable).toBe(true);
  });
});

describe('empty-cue', () => {
  it('flags a cue whose only line is empty', () => {
    const v = emptyCue.evaluate(docOf([cue(1, 0, 1000, [textLine('')])]), base);
    expect(v).toHaveLength(1);
  });
  it('flags a cue with no lines', () => {
    expect(emptyCue.evaluate(docOf([cue(1, 0, 1000, [])]), base)).toHaveLength(1);
  });
  it('flags a whitespace-only cue', () => {
    expect(emptyCue.evaluate(docOf([cue(1, 0, 1000, [textLine('   ')])]), base)).toHaveLength(1);
  });
  it('passes a cue with text', () => {
    expect(emptyCue.evaluate(docOf([cue(1, 0, 1000, [textLine('hi')])]), base)).toEqual([]);
  });
  it('is auto-fixable', () => {
    expect(emptyCue.fixable).toBe(true);
  });
});
