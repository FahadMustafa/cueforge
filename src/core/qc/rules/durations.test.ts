import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import type { Cue, SubtitleDocument } from '../../model/types';
import { maxDuration, minDuration, minGap, requiredGapMs } from './durations';

function cue(index: number, startMs: number, endMs: number): Cue {
  return { index, startMs, endMs, lines: [textLine('x')] };
}
function docOf(cues: Cue[], frameRate?: number): SubtitleDocument {
  return { cues, metadata: { sourceFormat: 'srt', frameRate }, warnings: [] };
}
const base = { enabled: true, severity: 'warning' } as const;

describe('min-duration', () => {
  it('flags a cue shorter than min', () => {
    const v = minDuration.evaluate(docOf([cue(1, 0, 500)]), { ...base, ms: 700 });
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/500.*700/);
  });
  it('passes a cue exactly at min', () => {
    expect(minDuration.evaluate(docOf([cue(1, 0, 700)]), { ...base, ms: 700 })).toEqual([]);
  });
  it('renders the duration in frames when the document declares a frame rate', () => {
    const v = minDuration.evaluate(docOf([cue(1, 0, 500)], 25), { ...base, ms: 700 });
    expect(v[0]!.message).toBe('Duration 13 frames (500 ms) is below 18 frames (700 ms).');
  });
  it('ignores reversed cues (reversed-timing rule owns those)', () => {
    expect(minDuration.evaluate(docOf([cue(1, 700, 0)]), { ...base, ms: 700 })).toEqual([]);
  });
  it('is auto-fixable', () => {
    expect(minDuration.fixable).toBe(true);
  });
});

describe('max-duration', () => {
  it('flags a cue longer than max', () => {
    const v = maxDuration.evaluate(docOf([cue(1, 0, 9000)]), { ...base, ms: 8000 });
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/9000.*8000/);
  });
  it('passes a cue exactly at max', () => {
    expect(maxDuration.evaluate(docOf([cue(1, 0, 8000)]), { ...base, ms: 8000 })).toEqual([]);
  });
  it('renders the duration in frames when the document declares a frame rate', () => {
    const v = maxDuration.evaluate(docOf([cue(1, 0, 9000)], 25), { ...base, ms: 8000 });
    expect(v[0]!.message).toBe('Duration 225 frames (9000 ms) exceeds 200 frames (8000 ms).');
  });
  it('is auto-fixable', () => {
    expect(maxDuration.fixable).toBe(true);
  });
});

describe('requiredGapMs', () => {
  it('uses ms when no frame rate is available', () => {
    expect(requiredGapMs({ ...base, ms: 83, frames: 2 }, undefined)).toBe(83);
  });
  it('computes from frames at the document frame rate', () => {
    expect(requiredGapMs({ ...base, frames: 2, ms: 83 }, 25)).toBe(80);
  });
});

describe('min-gap', () => {
  it('flags consecutive cues closer than the required gap', () => {
    const v = minGap.evaluate(docOf([cue(1, 0, 1000), cue(2, 1050, 2000)]), { ...base, ms: 83 });
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(2);
  });
  it('passes cues at least the required gap apart', () => {
    expect(
      minGap.evaluate(docOf([cue(1, 0, 1000), cue(2, 1100, 2000)]), { ...base, ms: 83 }),
    ).toEqual([]);
  });
  it('does not flag overlapping cues (the overlap rule owns those)', () => {
    expect(
      minGap.evaluate(docOf([cue(1, 0, 1000), cue(2, 990, 2000)]), { ...base, ms: 83 }),
    ).toEqual([]);
  });
  it('uses the frame-based gap when the document declares a frame rate', () => {
    // 2 frames @ 25fps = 80ms; a 50ms gap is too small.
    const v = minGap.evaluate(docOf([cue(1, 0, 1000), cue(2, 1050, 2000)], 25), {
      ...base,
      frames: 2,
      ms: 83,
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toBe('Gap before this cue is 1 frame (50 ms); minimum 2 frames (80 ms).');
  });
  it('renders the gap in plain ms when no frame rate is declared', () => {
    const v = minGap.evaluate(docOf([cue(1, 0, 1000), cue(2, 1050, 2000)]), { ...base, ms: 83 });
    expect(v[0]!.message).toBe('Gap before this cue is 50 ms; minimum 83 ms.');
  });
  it('is auto-fixable', () => {
    expect(minGap.fixable).toBe(true);
  });
});
