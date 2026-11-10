import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSrt, serializeSrt } from './srt';
import { cueToText } from '../../model/cue';
import { evaluate } from '../../qc/evaluate';
import { PRESETS } from '../../qc/presets';

const MINIMAL = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  'Hello world',
  '',
  '2',
  '00:00:05,000 --> 00:00:06,500',
  'Second cue',
  'line two',
  '',
].join('\n');

describe('parseSrt', () => {
  it('parses indices, timings (ms), and text', () => {
    const doc = parseSrt(MINIMAL);
    expect(doc.metadata.sourceFormat).toBe('srt');
    expect(doc.cues).toHaveLength(2);
    expect(doc.cues[0]).toMatchObject({ index: 1, startMs: 1000, endMs: 4000 });
    expect(cueToText(doc.cues[0]!)).toBe('Hello world');
    expect(doc.cues[1]).toMatchObject({ index: 2, startMs: 5000, endMs: 6500 });
    expect(cueToText(doc.cues[1]!)).toBe('Second cue\nline two');
  });

  it('preserves inline styling as spans', () => {
    const doc = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\nplain <i>ital</i> <font color="#FF0000">red</font>\n',
    );
    expect(doc.cues[0]!.lines[0]!.spans).toEqual([
      { text: 'plain ' },
      { text: 'ital', italic: true },
      { text: ' ' },
      { text: 'red', color: '#FF0000' },
    ]);
  });

  it('strips a leading BOM', () => {
    const doc = parseSrt('﻿1\n00:00:01,000 --> 00:00:02,000\nhi\n');
    expect(doc.cues).toHaveLength(1);
    expect(cueToText(doc.cues[0]!)).toBe('hi');
  });

  it('accepts CRLF input', () => {
    const doc = parseSrt('1\r\n00:00:01,000 --> 00:00:02,000\r\nhi\r\n\r\n');
    expect(doc.cues).toHaveLength(1);
    expect(cueToText(doc.cues[0]!)).toBe('hi');
  });

  it('tolerates a missing index and warns', () => {
    const doc = parseSrt('00:00:01,000 --> 00:00:02,000\nno index\n');
    expect(doc.cues[0]!.index).toBe(1);
    expect(doc.warnings.some((w) => w.code === 'missing-index')).toBe(true);
  });

  it('preserves non-sequential indices verbatim', () => {
    const doc = parseSrt(
      '5\n00:00:01,000 --> 00:00:02,000\na\n\n9\n00:00:03,000 --> 00:00:04,000\nb\n',
    );
    expect(doc.cues.map((c) => c.index)).toEqual([5, 9]);
  });

  it('tolerates an hour field above 99 and warns', () => {
    const doc = parseSrt('1\n100:00:00,000 --> 100:00:01,000\nhi\n');
    expect(doc.cues[0]!.startMs).toBe(100 * 3_600_000);
    expect(doc.warnings.some((w) => w.code === 'hour-overflow')).toBe(true);
  });

  it('warns on overlapping cues', () => {
    const doc = parseSrt(
      '1\n00:00:01,000 --> 00:00:05,000\na\n\n2\n00:00:03,000 --> 00:00:06,000\nb\n',
    );
    expect(doc.warnings.some((w) => w.code === 'overlap')).toBe(true);
  });

  it('warns on reversed timing', () => {
    const doc = parseSrt('1\n00:00:05,000 --> 00:00:01,000\nx\n');
    expect(doc.warnings.some((w) => w.code === 'reversed-timing')).toBe(true);
  });

  it('warns on an empty cue', () => {
    const doc = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\nb\n',
    );
    expect(doc.warnings.some((w) => w.code === 'empty-cue')).toBe(true);
    expect(doc.cues).toHaveLength(2);
  });

  it('tolerates extra blank lines between cues', () => {
    const doc = parseSrt(
      '\n\n1\n00:00:01,000 --> 00:00:02,000\na\n\n\n\n2\n00:00:03,000 --> 00:00:04,000\nb\n\n\n',
    );
    expect(doc.cues).toHaveLength(2);
  });

  it('warns on a malformed timing line', () => {
    const doc = parseSrt('1\nbad --> timing\nhi\n');
    expect(doc.warnings.some((w) => w.code === 'malformed-timing')).toBe(true);
    expect(doc.cues).toHaveLength(0);
  });

  it('warns on unexpected content that is neither index nor timing', () => {
    const doc = parseSrt('garbage line\nmore garbage\n');
    expect(doc.warnings.some((w) => w.code === 'unexpected-content')).toBe(true);
    expect(doc.cues).toHaveLength(0);
  });

  it('reads 1–2 digit fractional seconds as a fraction, not literal ms', () => {
    const doc = parseSrt('1\n00:00:01,5 --> 00:00:02,50\nhi\n');
    expect(doc.cues[0]!.startMs).toBe(1500);
    expect(doc.cues[0]!.endMs).toBe(2500);
  });

  it('rejects a pathological digit run before --> quickly (no regex backtracking blowup)', () => {
    const line = '1'.repeat(50000) + ' --> 00:00:01,000';
    const t0 = performance.now();
    const doc = parseSrt(`1\n${line}\nhi\n`);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(doc.warnings.some((w) => w.code === 'malformed-timing')).toBe(true);
    expect(doc.cues).toHaveLength(0);
  });

  it('keeps text after an interior blank line as part of the cue (blank = empty line)', () => {
    const doc = parseSrt(
      '1\n00:00:01,000 --> 00:00:03,000\nFirst line\n\nSecond line after blank\n\n2\n00:00:04,000 --> 00:00:05,000\nNext\n',
    );
    expect(doc.cues).toHaveLength(2);
    expect(doc.cues[0]!.lines.map((l) => l.spans.map((s) => s.text).join(''))).toEqual([
      'First line',
      '',
      'Second line after blank',
    ]);
    expect(doc.cues[0]!.lines[1]).toEqual({ spans: [] });
    expect(doc.cues[1]!.lines).toHaveLength(1);
    expect(doc.warnings.map((w) => w.code)).toEqual(['blank-line-in-cue']);
  });

  it('keeps one empty line per blank in an interior run, and is serialize-stable', () => {
    const doc = parseSrt(
      '1\n00:00:01,000 --> 00:00:03,000\na\n\n\n\nb\n\n2\n00:00:04,000 --> 00:00:05,000\nc\n',
    );
    expect(doc.cues[0]!.lines).toHaveLength(5);
    expect(parseSrt(serializeSrt(doc)).cues).toEqual(doc.cues);
    expect(serializeSrt(parseSrt(serializeSrt(doc)))).toBe(serializeSrt(doc));
  });

  it('still ends a cue at blank + a bare index-less timing line, and at EOF', () => {
    const doc = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\na\n\n00:00:03,000 --> 00:00:04,000\nb\n\n\n',
    );
    expect(doc.cues).toHaveLength(2);
    expect(doc.cues[0]!.lines).toHaveLength(1);
    expect(doc.cues[1]!.lines).toHaveLength(1);
  });

  it('treats a digits-only line not followed by timing as cue text after a blank', () => {
    const doc = parseSrt('1\n00:00:01,000 --> 00:00:02,000\na\n\n42\nb\n');
    expect(doc.cues).toHaveLength(1);
    expect(cueToText(doc.cues[0]!)).toBe('a\n\n42\nb');
  });

  it('skips leading blanks silently when text follows', () => {
    const doc = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\n\nText after leading blank\n\n2\n00:00:03,000 --> 00:00:04,000\nb\n',
    );
    expect(cueToText(doc.cues[0]!)).toBe('Text after leading blank');
    expect(doc.warnings.some((w) => w.code === 'blank-line-in-cue')).toBe(false);
  });

  it('normalizes whitespace-only blanks in an absorbed run to empty lines', () => {
    const doc = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nA\n\n\n\n   \nB\n');
    expect(doc.cues[0]!.lines).toHaveLength(6);
    expect(doc.cues[0]!.lines.slice(1, 5).every((l) => l.spans.length === 0)).toBe(true);
  });

  it('warns once per cue that absorbed a blank run', () => {
    const doc = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\ngarbage no timing\nB\n\n3\n00:00:05,000 --> 00:00:06,000\nC\n',
    );
    const w = doc.warnings.filter((x) => x.code === 'blank-line-in-cue');
    expect(w).toEqual([
      {
        code: 'blank-line-in-cue',
        message: 'Cue 1 contains a blank line; the text after it was kept as part of the cue.',
        cueIndex: 1,
        sourceLine: 4,
      },
    ]);
  });

  it('does not warn blank-line-in-cue on clean files or fixtures', () => {
    expect(parseSrt(MINIMAL).warnings.some((x) => x.code === 'blank-line-in-cue')).toBe(false);
    const dir = new URL('../../../../fixtures/srt/', import.meta.url);
    for (const f of readdirSync(dir)) {
      const doc = parseSrt(readFileSync(new URL(f, dir), 'utf8'));
      expect(
        doc.warnings.some((x) => x.code === 'blank-line-in-cue'),
        f,
      ).toBe(false);
    }
  });

  it('accepts timing without an hours field', () => {
    const doc = parseSrt('1\n00:01,000 --> 00:03,500\nhi\n');
    expect(doc.warnings).toEqual([]);
    expect(doc.cues[0]!.startMs).toBe(1000);
    expect(doc.cues[0]!.endMs).toBe(3500);
  });

  it('accepts one-digit minutes and seconds', () => {
    const doc = parseSrt('1\n00:00:6,000 --> 00:00:7,000\nhi\n\n2\n0:5:6,000 --> 0:5:7,000\nyo\n');
    expect(doc.warnings).toEqual([]);
    expect(doc.cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [6000, 7000],
      [306000, 307000],
    ]);
  });

  it('still warns malformed-timing on unparsable timing', () => {
    const doc = parseSrt('1\n123:456,000 --> 00:00:01,000\nhi\n');
    expect(doc.warnings.some((w) => w.code === 'malformed-timing')).toBe(true);
    expect(doc.cues).toHaveLength(0);
  });

  it('rejects pathological colon/digit runs in the lenient timing pattern quickly', () => {
    for (const bad of [
      '1:'.repeat(30000) + ' --> 00:01,000',
      '00:01,000 --> ' + '1:'.repeat(30000),
      '1'.repeat(50000) + ':1 --> 0:1,0',
    ]) {
      const t0 = performance.now();
      const doc = parseSrt(`1\n${bad}\nhi\n`);
      expect(performance.now() - t0).toBeLessThan(100);
      expect(doc.cues).toHaveLength(0);
    }
  });

  it('preserves a timing-line trailer and round-trips it', () => {
    const x = '1\n00:00:01,000 --> 00:00:02,000 X1:10 X2:20\nhi\n';
    const once = parseSrt(x);
    expect(once.cues[0]!.raw).toEqual({ trailer: ' X1:10 X2:20' });
    expect(parseSrt(serializeSrt(once))).toEqual(once);
  });
});

describe('serializeSrt', () => {
  it('emits index / timecode / text blocks with CRLF', () => {
    const doc = parseSrt(MINIMAL);
    const out = serializeSrt(doc);
    expect(out).toContain('1\r\n00:00:01,000 --> 00:00:04,000\r\nHello world');
    expect(out).toContain('2\r\n00:00:05,000 --> 00:00:06,500\r\nSecond cue\r\nline two');
  });

  it('round-trips: parse(serialize(parse(x))) deep-equals parse(x)', () => {
    const styled =
      '1\n00:01:02,003 --> 00:01:05,000\n<i>a\nb</i>\n\n2\n00:00:05,000 --> 00:00:06,500\nplain <b>bold</b>\n';
    const once = parseSrt(styled);
    const twice = parseSrt(serializeSrt(once));
    expect(twice).toEqual(once);
  });
});

describe('SRT {\\anN} alignment tags (cue-forge-qcvu.3)', () => {
  const tagged = (an: string, text: string) => `1\n00:00:01,000 --> 00:00:03,000\n${an}${text}\n`;

  it('strips a leading {\\anN} from the cue text and keeps N on cue.raw', () => {
    const doc = parseSrt(tagged('{\\an8}', 'Top text\nline two'));
    expect(cueToText(doc.cues[0]!)).toBe('Top text\nline two');
    expect(doc.cues[0]!.raw).toEqual({ an: 8 });
    expect(doc.warnings).toEqual([]);
  });

  it('keeps the timing-line trailer alongside the tag', () => {
    const doc = parseSrt('1\n00:00:01,000 --> 00:00:02,000 X1:10\n{\\an7}hi\n');
    expect(doc.cues[0]!.raw).toEqual({ trailer: ' X1:10', an: 7 });
  });

  it('leaves non-leading, out-of-range and other ASS blocks as literal text', () => {
    for (const text of [
      'a {\\an8}b',
      '{\\an0}x',
      '{\\an10}x',
      '{\\pos(10,10)}x',
      '<i>{\\an8}x</i>',
    ]) {
      const doc = parseSrt(tagged('', text));
      expect(doc.cues[0]!.raw).toBeUndefined();
      expect(cueToText(doc.cues[0]!)).toBe(text.replace(/<\/?i>/g, ''));
    }
  });

  it('round-trips every N (and the trailer) through serializeSrt', () => {
    for (let n = 1; n <= 9; n++) {
      const src = `1\n00:00:01,000 --> 00:00:02,000 X1:10\n{\\an${n}}<i>hi</i>\nthere\n`;
      const once = parseSrt(src);
      const out = serializeSrt(once);
      expect(out).toContain(`X1:10\r\n{\\an${n}}<i>hi</i>\r\nthere\r\n`);
      expect(parseSrt(out)).toEqual(once);
    }
  });

  it('round-trips a tag-only cue', () => {
    const once = parseSrt(tagged('{\\an8}', ''));
    expect(once.cues[0]!.raw).toEqual({ an: 8 });
    expect(parseSrt(serializeSrt(once)).cues).toEqual(once.cues);
  });

  it('is invisible to QC: a tagged 42-char line reports exactly what the untagged one does', () => {
    const text = 'Exactly forty-two characters on this line';
    const issues = evaluate(parseSrt(tagged('{\\an8}', text)), PRESETS['netflix-latin']);
    expect(issues).toEqual(evaluate(parseSrt(tagged('', text)), PRESETS['netflix-latin']));
    expect(issues.some((i) => i.ruleId === 'max-chars-per-line')).toBe(false);
    // 41 counted chars / 2 s — previously 23.5 cps with the 6-char tag counted.
    expect(issues.find((i) => i.ruleId === 'max-cps')?.message).toBe(
      'Reading speed is 20.5 cps (max 20).',
    );
  });
});
