import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import type { Cue, SubtitleDocument } from '../../model/types';
import { cueCountMonotonicTiming } from './monotonic';

function cue(index: number, startMs: number): Cue {
  return { index, startMs, endMs: startMs + 900, lines: [textLine('x')] };
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

describe('cue-count-monotonic-timing', () => {
  it('passes strictly increasing starts', () => {
    expect(
      cueCountMonotonicTiming.evaluate(docOf([cue(1, 0), cue(2, 1000), cue(3, 2000)]), base),
    ).toEqual([]);
  });
  it('allows equal consecutive starts (non-decreasing)', () => {
    expect(
      cueCountMonotonicTiming.evaluate(docOf([cue(1, 0), cue(2, 1000), cue(3, 1000)]), base),
    ).toEqual([]);
  });
  it('flags the cue whose start goes backwards', () => {
    const v = cueCountMonotonicTiming.evaluate(
      docOf([cue(1, 0), cue(2, 2000), cue(3, 1000)]),
      base,
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(3);
  });
  it('renders positions as timecode when the document declares a frame rate', () => {
    const v = cueCountMonotonicTiming.evaluate(
      docOf([cue(1, 0), cue(2, 2000), cue(3, 1000)], 25),
      base,
    );
    expect(v[0]!.message).toBe(
      "Starts at 00:00:01:00 (1000 ms), before the previous cue's start 00:00:02:00 (2000 ms).",
    );
  });
  it('honours the source drop-frame mode (w28.9)', () => {
    // 60060 ms = frame 1800: NDF 00:01:00:00 vs DF 00:01:00;02.
    const cues = [cue(1, 0), cue(2, 60060), cue(3, 1000)];
    const ndf = cueCountMonotonicTiming.evaluate(docOf(cues, NTSC_FPS, false), base);
    expect(ndf[0]!.message).toBe(
      "Starts at 00:00:01:00 (1000 ms), before the previous cue's start 00:01:00:00 (60060 ms).",
    );
    const df = cueCountMonotonicTiming.evaluate(docOf(cues, NTSC_FPS, true), base);
    expect(df[0]!.message).toBe(
      "Starts at 00:00:01;00 (1000 ms), before the previous cue's start 00:01:00;02 (60060 ms).",
    );
  });
  it('is not auto-fixable', () => {
    expect(cueCountMonotonicTiming.fixable).toBe(false);
  });
});
