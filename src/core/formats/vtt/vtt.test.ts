import { describe, expect, it } from 'vitest';
import { parseVtt, serializeVtt } from './vtt';
import { cueToText } from '../../model/cue';

const MINIMAL = [
  'WEBVTT',
  '',
  '00:01.000 --> 00:04.000',
  'Hello world',
  '',
  '00:00:05.000 --> 00:00:06.500',
  'Second cue',
  'line two',
  '',
].join('\n');

describe('parseVtt', () => {
  it('parses MM:SS.mmm and HH:MM:SS.mmm timings to ms', () => {
    const doc = parseVtt(MINIMAL);
    expect(doc.metadata.sourceFormat).toBe('vtt');
    expect(doc.cues).toHaveLength(2);
    expect(doc.cues[0]).toMatchObject({ startMs: 1000, endMs: 4000 });
    expect(doc.cues[1]).toMatchObject({ startMs: 5000, endMs: 6500 });
    expect(cueToText(doc.cues[1]!)).toBe('Second cue\nline two');
  });

  it('preserves a cue identifier', () => {
    const doc = parseVtt('WEBVTT\n\nintro\n00:00:01.000 --> 00:00:02.000\nhi\n');
    expect(doc.cues[0]!.id).toBe('intro');
  });

  it('parses cue settings into position and preserves them verbatim', () => {
    const doc = parseVtt(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:90% position:50% align:start\nhi\n',
    );
    const pos = doc.cues[0]!.position!;
    expect(pos).toMatchObject({ line: 90, linePercent: true, position: 50, align: 'start' });
    expect(pos.raw).toBe('line:90% position:50% align:start');
  });

  it('parses vertical writing mode', () => {
    const doc = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 vertical:rl\nhi\n');
    expect(doc.cues[0]!.position!.vertical).toBe('vertical-rl');
  });

  it('preserves NOTE blocks in metadata', () => {
    const doc = parseVtt('WEBVTT\n\nNOTE this is a comment\n\n00:00:01.000 --> 00:00:02.000\nhi\n');
    expect((doc.metadata.raw as { notes: string[] }).notes).toContain('NOTE this is a comment');
    expect(doc.cues).toHaveLength(1);
  });

  it('preserves STYLE blocks in metadata', () => {
    const style = 'STYLE\n::cue { color: yellow }';
    const doc = parseVtt(`WEBVTT\n\n${style}\n\n00:00:01.000 --> 00:00:02.000\nhi\n`);
    expect((doc.metadata.raw as { styles: string[] }).styles).toContain(style);
  });

  it('preserves a voice tag as a styled span', () => {
    const doc = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Roger>Hello\n');
    expect(doc.cues[0]!.lines[0]!.spans).toEqual([{ text: 'Hello', voice: 'Roger' }]);
  });

  it('preserves header trailing text', () => {
    const doc = parseVtt('WEBVTT - My Captions\n\n00:00:01.000 --> 00:00:02.000\nhi\n');
    expect((doc.metadata.raw as { header: string }).header).toBe('WEBVTT - My Captions');
  });

  it('warns when the WEBVTT signature is missing', () => {
    const doc = parseVtt('Some Title\n\n00:00:01.000 --> 00:00:02.000\nhi\n');
    expect(doc.warnings.some((w) => w.code === 'missing-signature')).toBe(true);
    // Parsing still proceeds tolerantly.
    expect(doc.cues).toHaveLength(1);
  });

  it('accepts the bare and decorated WEBVTT signatures without warning', () => {
    for (const header of ['WEBVTT', 'WEBVTT - Title', 'WEBVTT\tkind=captions']) {
      const doc = parseVtt(`${header}\n\n00:00:01.000 --> 00:00:02.000\nhi\n`);
      expect(doc.warnings.some((w) => w.code === 'missing-signature')).toBe(false);
    }
  });

  it('flags "WEBVTTjunk" (no separator after the signature) as missing', () => {
    const doc = parseVtt('WEBVTTjunk\n\n00:00:01.000 --> 00:00:02.000\nhi\n');
    expect(doc.warnings.some((w) => w.code === 'missing-signature')).toBe(true);
  });

  it('preserves REGION blocks in metadata', () => {
    const region = 'REGION\nid:fred width:40%';
    const doc = parseVtt(`WEBVTT\n\n${region}\n\n00:00:01.000 --> 00:00:02.000\nhi\n`);
    expect((doc.metadata.raw as { regions: string[] }).regions).toContain(region);
  });

  it('parses vertical:lr, size, and tolerates unknown/integer settings', () => {
    const doc = parseVtt(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 vertical:lr size:50% region:r1 line:5 position:30 align:end\nhi\n',
    );
    expect(doc.cues[0]!.position).toMatchObject({
      vertical: 'vertical-lr',
      size: 50,
      line: 5,
      position: 30,
      align: 'end',
    });
    expect(doc.cues[0]!.position!.linePercent).toBeUndefined();
  });

  it('reads 1–2 digit fractional seconds as a fraction, not literal ms', () => {
    const doc = parseVtt('WEBVTT\n\n00:00:01.5 --> 00:00:02.50\nhi\n');
    expect(doc.cues[0]!.startMs).toBe(1500);
    expect(doc.cues[0]!.endMs).toBe(2500);
  });

  it('decodes the six WebVTT character references in cue text', () => {
    const doc = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFish &amp; chips &lrm;x\n');
    expect(doc.cues[0]!.lines[0]!.spans).toEqual([{ text: 'Fish & chips \u200Ex' }]);
  });

  it('decodes &lt; &gt; &rlm; &nbsp;', () => {
    const doc = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n&lt;a&gt;&rlm;&nbsp;b\n');
    expect(doc.cues[0]!.lines[0]!.spans).toEqual([{ text: '<a>\u200F\u00A0b' }]);
  });

  it('preserves unrecognized VTT constructs as opaque markup, not literal text', () => {
    const doc = parseVtt(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c.yellow>x</c> <00:00:01.500>k\n',
    );
    const spans = doc.cues[0]!.lines[0]!.spans;
    expect(spans.map((s) => s.text).join('')).toBe('x k');
    expect(spans.some((s) => s.opaque === '<c.yellow>')).toBe(true);
    expect(spans.some((s) => s.text.includes('<'))).toBe(false);
  });

  it('warns on a malformed timing line', () => {
    const doc = parseVtt('WEBVTT\n\nbadstart --> badend\nhi\n');
    expect(doc.warnings.some((w) => w.code === 'malformed-timing')).toBe(true);
  });

  it('warns on a block that is not a cue', () => {
    const doc = parseVtt('WEBVTT\n\nnot a cue at all\njust text\n');
    expect(doc.warnings.some((w) => w.code === 'unexpected-content')).toBe(true);
  });

  it('handles a header-only file with no blank line', () => {
    const doc = parseVtt('WEBVTT');
    expect(doc.cues).toHaveLength(0);
    expect((doc.metadata.raw as { header: string }).header).toBe('WEBVTT');
  });
});

describe('serializeVtt', () => {
  it('emits a WEBVTT header and LF newlines', () => {
    const out = serializeVtt(parseVtt(MINIMAL));
    expect(out.startsWith('WEBVTT')).toBe(true);
    expect(out).not.toContain('\r');
    expect(out).toContain('00:00:01.000 --> 00:00:04.000');
  });

  it('escapes & and < in cue text and re-encodes &lrm;/&rlm;', () => {
    const doc = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA & B\n');
    doc.cues[0]!.lines[0]!.spans[0]!.text = 'A & B < C \u200E\u200F';
    expect(serializeVtt(doc)).toContain('A &amp; B &lt; C &lrm;&rlm;');
  });

  it('synthesizes cue-settings tokens from structured fields when raw is absent', () => {
    const doc = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n');
    doc.cues[0]!.position = { align: 'center', line: 90, linePercent: true, position: 50 };
    expect(serializeVtt(doc)).toContain(
      '00:00:01.000 --> 00:00:02.000 line:90% position:50% align:center',
    );
  });

  it('prefers verbatim raw settings over synthesized tokens', () => {
    const doc = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start line:90%\nhi\n');
    expect(serializeVtt(doc)).toContain('00:00:01.000 --> 00:00:02.000 align:start line:90%');
  });
});

describe('vtt character references and unknown constructs round-trip', () => {
  it('round-trips "Fish &amp; chips &lrm;x" byte-identically in cue text', () => {
    const src = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFish &amp; chips &lrm;x\n\n';
    expect(serializeVtt(parseVtt(src))).toBe(src);
  });

  it('keeps <c>, <ruby>/<rt>, <lang> and timestamp tags verbatim for VTT → VTT', () => {
    const text = '<c.yellow>x</c> <ruby>a<rt>b</rt></ruby> <lang en>hi</lang> <00:00:01.500>k';
    const src = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${text}\n\n`;
    const once = parseVtt(src);
    expect(serializeVtt(once)).toBe(src);
    expect(parseVtt(serializeVtt(once)).cues).toEqual(once.cues);
  });
});

describe('vtt round-trip', () => {
  it('parse(serialize(parse(x))) deep-equals parse(x)', () => {
    const x = [
      'WEBVTT - Title',
      '',
      'STYLE',
      '::cue { color: yellow }',
      '',
      'NOTE a note',
      '',
      'intro',
      '00:00:01.000 --> 00:00:04.000 line:90% align:start',
      '<v Roger>Hello <i>there</i>',
      '',
      '00:00:05.000 --> 00:00:06.500',
      'plain <b>bold</b>',
      '',
    ].join('\n');
    const once = parseVtt(x);
    const twice = parseVtt(serializeVtt(once));
    expect(twice).toEqual(once);
  });
});
