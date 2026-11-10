import { describe, expect, it } from 'vitest';
import type { SubtitleDocument } from '../model/types';
import { shiftCues, linearScale, convertFrameRate, canonicalFps, STANDARD_FPS } from './timing';

/**
 * Timing-tool suite (spec §4.1 #2, §6.3 #4): shift, linear scale, and frame-rate
 * conversion with known-answer assertions, negative-shift clamping at 0, and an
 * fps round-trip error under 1 ms per cue.
 */

function doc(...cues: [number, number][]): SubtitleDocument {
  return {
    cues: cues.map(([startMs, endMs], i) => ({
      index: i + 1,
      startMs,
      endMs,
      lines: [{ spans: [{ text: `cue ${i + 1}` }] }],
    })),
    metadata: { sourceFormat: 'srt' },
    warnings: [],
  };
}

function times(d: SubtitleDocument): [number, number][] {
  return d.cues.map((c) => [c.startMs, c.endMs]);
}

describe('shiftCues', () => {
  it.each([NaN, Infinity, -Infinity])('rejects a non-finite offset (%s)', (offset) => {
    expect(() => shiftCues(doc([1000, 2000]), offset)).toThrow(RangeError);
  });

  it('rounds fractional offsets to integer milliseconds', () => {
    expect(times(shiftCues(doc([1000, 2000]), 0.6))).toEqual([[1001, 2001]]);
  });

  it('rejects arithmetic overflow before clamping negative times', () => {
    expect(() => shiftCues(doc([-Number.MAX_VALUE, 0]), -Number.MAX_VALUE)).toThrow(RangeError);
  });

  it('adds a positive offset to every cue', () => {
    expect(times(shiftCues(doc([1000, 4000], [5000, 6500]), 1500))).toEqual([
      [2500, 5500],
      [6500, 8000],
    ]);
  });

  it('clamps negative results at 0 (spec §6.3 #4)', () => {
    expect(times(shiftCues(doc([1000, 4000], [500, 1500]), -2000))).toEqual([
      [0, 2000],
      [0, 0],
    ]);
  });

  it('does not mutate the source document', () => {
    const d = doc([1000, 2000]);
    shiftCues(d, 500);
    expect(times(d)).toEqual([[1000, 2000]]);
  });

  it('preserves cue content and metadata', () => {
    const out = shiftCues(doc([1000, 2000]), 10);
    expect(out.cues[0]!.lines).toEqual([{ spans: [{ text: 'cue 1' }] }]);
    expect(out.metadata.sourceFormat).toBe('srt');
  });
});

describe('linearScale (anchor retime)', () => {
  it.each([0, 4000])('rejects a collapsed or reversed target mapping (%s)', (target) => {
    const source = doc([1000, 2000]);
    expect(() =>
      linearScale(source, { fromMs: 0, toMs: target }, { fromMs: 4000, toMs: 0 }),
    ).toThrow(/positive|order/i);
    expect(times(source)).toEqual([[1000, 2000]]);
  });

  it.each(['fromMs', 'toMs'] as const)('rejects non-finite %s in either anchor', (field) => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const first = { fromMs: 0, toMs: 0, [field]: value };
      const second = { fromMs: 4000, toMs: 4000, [field]: value };
      expect(() => linearScale(doc(), first, { fromMs: 4000, toMs: 4000 })).toThrow(RangeError);
      expect(() => linearScale(doc(), { fromMs: 0, toMs: 0 }, second)).toThrow(RangeError);
    }
  });

  it('accepts anchors supplied in descending order when their mapping is positive', () => {
    expect(
      times(linearScale(doc([1000, 2000]), { fromMs: 4000, toMs: 8000 }, { fromMs: 0, toMs: 0 })),
    ).toEqual([[2000, 4000]]);
  });

  it('rejects overflowing anchor arithmetic and unsafe output times', () => {
    expect(() =>
      linearScale(
        doc(),
        { fromMs: -Number.MAX_VALUE, toMs: 0 },
        { fromMs: Number.MAX_VALUE, toMs: 1 },
      ),
    ).toThrow(RangeError);
    expect(() =>
      linearScale(doc([1000, 2000]), { fromMs: 0, toMs: 0 }, { fromMs: 1, toMs: Number.MAX_VALUE }),
    ).toThrow(RangeError);
    expect(() =>
      linearScale(
        doc([Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]),
        { fromMs: 0, toMs: 0 },
        { fromMs: 1, toMs: 2 },
      ),
    ).toThrow(RangeError);
  });

  it('stretches by mapping two anchor points', () => {
    // (0→0) and (1000→2000): slope 2.
    const out = linearScale(doc([500, 1000]), { fromMs: 0, toMs: 0 }, { fromMs: 1000, toMs: 2000 });
    expect(times(out)).toEqual([[1000, 2000]]);
  });

  it('is identity when anchors map onto themselves', () => {
    const out = linearScale(
      doc([1000, 2000], [3000, 4000]),
      { fromMs: 1000, toMs: 1000 },
      { fromMs: 4000, toMs: 4000 },
    );
    expect(times(out)).toEqual([
      [1000, 2000],
      [3000, 4000],
    ]);
  });

  it('compresses with a fractional slope', () => {
    // (0→0) and (2000→1000): slope 0.5.
    const out = linearScale(
      doc([1000, 2000]),
      { fromMs: 0, toMs: 0 },
      { fromMs: 2000, toMs: 1000 },
    );
    expect(times(out)).toEqual([[500, 1000]]);
  });

  it('clamps results at 0', () => {
    // (1000→0) and (2000→1000): slope 1, intercept -1000.
    const out = linearScale(
      doc([500, 1500]),
      { fromMs: 1000, toMs: 0 },
      { fromMs: 2000, toMs: 1000 },
    );
    expect(times(out)).toEqual([[0, 500]]);
  });

  it('throws when the two anchors share the same source time', () => {
    expect(() =>
      linearScale(doc([0, 1]), { fromMs: 1000, toMs: 0 }, { fromMs: 1000, toMs: 1 }),
    ).toThrow();
  });
});

describe('convertFrameRate', () => {
  it.each([0, -24, NaN, Infinity, -Infinity, 0.00001, Number.MAX_VALUE])(
    'rejects an invalid source or target frame rate (%s)',
    (fps) => {
      expect(() => convertFrameRate(doc([1000, 2000]), fps, 25)).toThrow(RangeError);
      expect(() => convertFrameRate(doc([1000, 2000]), 25, fps)).toThrow(RangeError);
    },
  );

  it('24 → 25 speeds the timeline up by 24/25', () => {
    expect(times(convertFrameRate(doc([1000, 2000]), 24, 25))).toEqual([[960, 1920]]);
  });

  it('25 → 24 slows it back down by 25/24', () => {
    expect(times(convertFrameRate(doc([960, 1920]), 25, 24))).toEqual([[1000, 2000]]);
  });

  it('uses the exact 1001 fraction for 23.976 → 24', () => {
    // ratio = (24000/1001) / 24 = 1000/1001, so 1001 ms → 1000 ms exactly.
    expect(times(convertFrameRate(doc([1001, 2002]), 23.976, 24))).toEqual([[1000, 2000]]);
  });

  it('updates metadata.frameRate to the target', () => {
    expect(convertFrameRate(doc([1000, 2000]), 24, 25).metadata.frameRate).toBe(25);
  });

  it('round-trips every standard fps pair with < 1 ms error per cue', () => {
    const base = doc(
      ...Array.from({ length: 50 }, (_, i): [number, number] => [i * 2000, i * 2000 + 1800]),
    );
    for (const from of STANDARD_FPS) {
      for (const to of STANDARD_FPS) {
        const back = convertFrameRate(convertFrameRate(base, from, to), to, from);
        for (let i = 0; i < base.cues.length; i++) {
          expect(Math.abs(back.cues[i]!.startMs - base.cues[i]!.startMs)).toBeLessThanOrEqual(1);
          expect(Math.abs(back.cues[i]!.endMs - base.cues[i]!.endMs)).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('timing input validation', () => {
  it.each([
    [NaN, 2000],
    [1000, Infinity],
    [2000, 1000],
  ])('rejects invalid cue timing %s..%s', (start, end) => {
    const source = doc([start, end]);
    expect(() => shiftCues(source, 0)).toThrow(RangeError);
    expect(() => linearScale(source, { fromMs: 0, toMs: 0 }, { fromMs: 1, toMs: 1 })).toThrow(
      RangeError,
    );
    expect(() => convertFrameRate(source, 24, 25)).toThrow(RangeError);
  });
});

describe('canonicalFps (cue-forge-zxw.11)', () => {
  it('snaps the exact NTSC rates to their standard labels', () => {
    expect(canonicalFps(30000 / 1001)).toBe(29.97);
    expect(canonicalFps(24000 / 1001)).toBe(23.976);
  });

  it('leaves exact standard rates unchanged', () => {
    for (const fps of STANDARD_FPS) expect(canonicalFps(fps)).toBe(fps);
  });

  it('leaves a genuinely non-standard rate unchanged', () => {
    expect(canonicalFps(50)).toBe(50);
    expect(canonicalFps(15)).toBe(15);
  });
});
