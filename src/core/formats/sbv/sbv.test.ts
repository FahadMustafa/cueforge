import { describe, expect, it } from 'vitest';
import { parseSbv, serializeSbv } from './sbv';
import { cueToText } from '../../model/cue';

const MINIMAL = [
  '0:00:01.000,0:00:04.000',
  'Hello world',
  '',
  '0:00:05.000,0:00:06.500',
  'Second cue',
  'line two',
  '',
].join('\n');

describe('parseSbv', () => {
  it('parses comma-separated timings and text', () => {
    const doc = parseSbv(MINIMAL);
    expect(doc.metadata.sourceFormat).toBe('sbv');
    expect(doc.cues).toHaveLength(2);
    expect(doc.cues[0]).toMatchObject({ startMs: 1000, endMs: 4000 });
    expect(cueToText(doc.cues[0]!)).toBe('Hello world');
    expect(cueToText(doc.cues[1]!)).toBe('Second cue\nline two');
  });

  it('treats markup as literal plain text (no inline styling)', () => {
    const doc = parseSbv('0:00:01.000,0:00:02.000\n<i>not italic</i>\n');
    expect(doc.cues[0]!.lines[0]!.spans).toEqual([{ text: '<i>not italic</i>' }]);
  });

  it('reads 1–2 digit fractional seconds as a fraction, not literal ms', () => {
    const doc = parseSbv('0:00:01.5,0:00:02.50\nhi\n');
    expect(doc.cues[0]!.startMs).toBe(1500);
    expect(doc.cues[0]!.endMs).toBe(2500);
  });

  it('warns on malformed timing', () => {
    const doc = parseSbv('0:00:01.000 0:00:02.000\nhi\n');
    expect(doc.warnings.some((w) => w.code === 'malformed-timing')).toBe(true);
  });

  it('warns on reversed timing', () => {
    const doc = parseSbv('0:00:05.000,0:00:01.000\nx\n');
    expect(doc.warnings.some((w) => w.code === 'reversed-timing')).toBe(true);
  });

  it('warns on an empty cue', () => {
    const doc = parseSbv('0:00:01.000,0:00:02.000\n\n0:00:03.000,0:00:04.000\nb\n');
    expect(doc.warnings.some((w) => w.code === 'empty-cue')).toBe(true);
  });

  it('strips a leading BOM', () => {
    const doc = parseSbv('﻿0:00:01.000,0:00:02.000\nhi\n');
    expect(doc.cues).toHaveLength(1);
    expect(cueToText(doc.cues[0]!)).toBe('hi');
  });

  it('warns on overlapping cues', () => {
    const doc = parseSbv('0:00:01.000,0:00:05.000\na\n\n0:00:03.000,0:00:06.000\nb\n');
    expect(doc.warnings.some((w) => w.code === 'overlap')).toBe(true);
  });
});

describe('serializeSbv', () => {
  it('emits H:MM:SS.mmm,H:MM:SS.mmm timing lines', () => {
    const out = serializeSbv(parseSbv(MINIMAL));
    expect(out).toContain('0:00:01.000,0:00:04.000\nHello world');
  });

  it('round-trips: parse(serialize(parse(x))) deep-equals parse(x)', () => {
    const once = parseSbv(MINIMAL);
    const twice = parseSbv(serializeSbv(once));
    expect(twice).toEqual(once);
  });
});
