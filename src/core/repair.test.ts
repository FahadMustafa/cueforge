import { describe, expect, it } from 'vitest';
import { repairDocument } from './repair';
import type { Cue, SubtitleDocument } from './model/types';

function doc(cues: Cue[]): SubtitleDocument {
  return { cues, metadata: { sourceFormat: 'srt' }, warnings: [] };
}
const cue = (over: Partial<Cue>): Cue => ({
  index: 1,
  startMs: 0,
  endMs: 1000,
  lines: [],
  ...over,
});

describe('repairDocument', () => {
  it('renumbers indices sequentially from 1', () => {
    const r = repairDocument(
      doc([cue({ index: 5 }), cue({ index: 9, startMs: 2000, endMs: 3000 })]),
    );
    expect(r.doc.cues.map((c) => c.index)).toEqual([1, 2]);
    expect(r.repairs.some((a) => a.code === 'renumber')).toBe(true);
  });

  it('preserves the original caption number in sourceIndex when renumbering changes it (q7q)', () => {
    const r = repairDocument(
      doc([cue({ index: 5 }), cue({ index: 9, startMs: 2000, endMs: 3000 })]),
    );
    expect(r.doc.cues.map((c) => c.index)).toEqual([1, 2]);
    expect(r.doc.cues.map((c) => c.sourceIndex)).toEqual([5, 9]);
  });

  it('leaves sourceIndex unset when renumbering does not change the number', () => {
    const r = repairDocument(
      doc([cue({ index: 1 }), cue({ index: 2, startMs: 2000, endMs: 3000 })]),
    );
    expect(r.doc.cues.map((c) => c.sourceIndex)).toEqual([undefined, undefined]);
  });

  it('keeps the original sourceIndex across a second repair (idempotent)', () => {
    const once = repairDocument(doc([cue({ index: 8 })])).doc;
    const twice = repairDocument(once).doc;
    expect(twice.cues[0]!.index).toBe(1);
    expect(twice.cues[0]!.sourceIndex).toBe(8); // the original number, not re-derived
  });

  it('floors fractional timestamps and clamps negatives to 0', () => {
    const r = repairDocument(doc([cue({ startMs: -50, endMs: 1000.9 })]));
    expect(r.doc.cues[0]).toMatchObject({ startMs: 0, endMs: 1000 });
    expect(r.repairs.some((a) => a.code === 'normalize-timing')).toBe(true);
  });

  it('swaps reversed start/end', () => {
    const r = repairDocument(doc([cue({ startMs: 3000, endMs: 1000 })]));
    expect(r.doc.cues[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
    expect(r.repairs.some((a) => a.code === 'fix-reversed')).toBe(true);
  });

  it('is a no-op on a clean document', () => {
    const clean = doc([cue({ index: 1 }), cue({ index: 2, startMs: 2000, endMs: 3000 })]);
    const r = repairDocument(clean);
    expect(r.repairs).toEqual([]);
    expect(r.doc).toEqual(clean);
  });

  it('does not mutate the input document', () => {
    const input = doc([cue({ index: 9 })]);
    repairDocument(input);
    expect(input.cues[0]!.index).toBe(9);
  });

  it('respects disabled options', () => {
    const r = repairDocument(doc([cue({ index: 5, startMs: 3000, endMs: 1000 })]), {
      renumber: false,
      fixReversed: false,
    });
    expect(r.doc.cues[0]).toMatchObject({ index: 5, startMs: 3000, endMs: 1000 });
    expect(r.repairs).toEqual([]);
  });
});
