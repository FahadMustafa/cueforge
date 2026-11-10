import { describe, expect, it } from 'vitest';
import { parseAss, serializeAss } from './ass';

const HEADER = `[Script Info]
; A test script
Title: Demo
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

function doc(...dialogues: string[]): string {
  return HEADER + '\n' + dialogues.join('\n') + '\n';
}

describe('parseAss', () => {
  it('parses a Dialogue line into a cue with millisecond timing', () => {
    const d = parseAss(doc('Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello world'));
    expect(d.cues).toHaveLength(1);
    expect(d.cues[0]!.startMs).toBe(1000);
    expect(d.cues[0]!.endMs).toBe(4000);
    expect(d.cues[0]!.lines).toEqual([{ spans: [{ text: 'Hello world' }] }]);
  });

  it('reads centisecond precision (.50 = 500ms)', () => {
    const d = parseAss(doc('Dialogue: 0,0:00:01.05,0:00:02.50,Default,,0,0,0,,x'));
    expect(d.cues[0]!.startMs).toBe(1050);
    expect(d.cues[0]!.endMs).toBe(2500);
  });

  it('preserves the Style field as a styleRef', () => {
    const d = parseAss(doc('Dialogue: 0,0:00:01.00,0:00:02.00,Title,,0,0,0,,x'));
    expect(d.cues[0]!.styleRefs).toEqual(['Title']);
  });

  it('splits \\N into separate visual lines', () => {
    const d = parseAss(
      doc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,line one\\Nline two'),
    );
    expect(d.cues[0]!.lines).toEqual([
      { spans: [{ text: 'line one' }] },
      { spans: [{ text: 'line two' }] },
    ]);
  });

  it('keeps override blocks as opaque markup attached to the following text', () => {
    const d = parseAss(
      doc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}hi{\\i0} there'),
    );
    expect(d.cues[0]!.lines).toEqual([
      {
        spans: [
          { text: 'hi', opaque: '{\\i1}' },
          { text: ' there', opaque: '{\\i0}' },
        ],
      },
    ]);
  });

  it('preserves the verbatim header and event field list in metadata.raw', () => {
    const d = parseAss(doc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x'));
    const raw = d.metadata.raw as { header: string; eventFields: string[] };
    expect(raw.header).toContain('[Script Info]');
    expect(raw.header).toContain('Style: Default,Arial');
    expect(raw.eventFields).toEqual([
      'Layer',
      'Start',
      'End',
      'Style',
      'Name',
      'MarginL',
      'MarginR',
      'MarginV',
      'Effect',
      'Text',
    ]);
  });

  it('warns on reversed timing', () => {
    const d = parseAss(doc('Dialogue: 0,0:00:05.00,0:00:02.00,Default,,0,0,0,,x'));
    expect(d.warnings.some((w) => w.code === 'reversed-timing')).toBe(true);
  });

  it('stops event parsing at a trailing section header (no warning spam)', () => {
    const d = parseAss(
      doc(
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello',
        '',
        '[Fonts]',
        'fontname: chaucer_B0.ttf',
        '$3*A&,9P,R$2T<F0H1@5Q.0"S2P1`R-Q*S0V/Q-S+@5R.S.@7T0V0R.U/T1S0Q3T',
      ),
    );
    expect(d.cues).toHaveLength(1);
    expect(d.warnings.filter((w) => w.code === 'malformed-timing')).toHaveLength(0);
    expect(d.warnings.filter((w) => w.code === 'unexpected-content')).toHaveLength(0);
  });

  it('detects SSA v4 (Marked field, [V4 Styles]) and tags sourceFormat', () => {
    const ssa = `[Script Info]
ScriptType: v4.00

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding
Style: Default,Arial,20,16777215,255,0,0,0,0,1,2,0,2,10,10,10,0,1

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0000,0000,0000,,Hello
`;
    const d = parseAss(ssa);
    expect(d.metadata.sourceFormat).toBe('ssa');
    expect(d.cues[0]!.lines).toEqual([{ spans: [{ text: 'Hello' }] }]);
  });
});

describe('serializeAss', () => {
  it('round-trips a basic document (parse∘serialize∘parse is stable)', () => {
    const src = doc(
      'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello world',
      'Dialogue: 0,0:00:05.00,0:00:06.50,Default,,0,0,0,,{\\i1}two{\\i0}\\Nlines',
    );
    const once = parseAss(src);
    const twice = parseAss(serializeAss(once));
    expect(twice.cues).toEqual(once.cues);
    expect(twice.metadata).toEqual(once.metadata);
  });

  it('emits CRLF line endings (ASS convention)', () => {
    const out = serializeAss(parseAss(doc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x')));
    expect(out).toContain('\r\n');
    expect(out).toContain('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x');
  });

  it('round-trips trailing sections ([Fonts], [Graphics], …) verbatim', () => {
    const src = doc(
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello',
      '',
      '[Fonts]',
      'fontname: chaucer_B0.ttf',
      '$3*A&,9P,R$2T<F0H1@5Q.0"S2P1`R-Q*S0V/Q-S+@5R.S.@7T0V0R.U/T1S0Q3T',
      '',
      '[Aegisub Project Garbage]',
      'Audio File: ep01.mkv',
    );
    const once = parseAss(src);
    const out = serializeAss(once);
    expect(out).toContain('[Fonts]');
    expect(out).toContain('[Aegisub Project Garbage]');
    const twice = parseAss(out);
    expect(twice.cues).toEqual(once.cues);
    expect(twice.metadata).toEqual(once.metadata);
    expect(twice.warnings.filter((w) => w.code === 'malformed-timing')).toHaveLength(0);
  });

  it('preserves a Comment event verbatim through parse → serialize', () => {
    const src = doc(
      'Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,,note to self',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello',
    );
    const out = serializeAss(parseAss(src));
    expect(out).toContain('Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,,note to self');
  });

  it('emits override tags for italic/bold spans that have no opaque markup (foreign docs)', () => {
    const d = parseAss(doc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x'));
    d.cues[0]!.lines = [{ spans: [{ text: 'word', italic: true }] }];
    const out = serializeAss(d);
    expect(out).toContain('{\\i1}word{\\i0}');
  });
});

describe('serializeAss colour + position synthesis (H1 hero: ASS as a lossless target)', () => {
  // The test HEADER declares PlayResX 1920, PlayResY 1080.
  function styledDoc() {
    return parseAss(doc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x'));
  }

  it('emits a \\c BGR colour tag from a hex span.color', () => {
    const d = styledDoc();
    d.cues[0]!.lines = [{ spans: [{ text: 'red', color: '#FF0000' }] }];
    expect(serializeAss(d)).toContain('{\\c&H0000FF&}red');
  });

  it('emits a \\c BGR colour tag from a named span.color', () => {
    const d = styledDoc();
    d.cues[0]!.lines = [{ spans: [{ text: 'blue', color: 'blue' }] }];
    expect(serializeAss(d)).toContain('{\\c&HFF0000&}blue'); // #0000FF → BGR FF0000
  });

  it('resets colour with a bare \\c when a following span has none', () => {
    const d = styledDoc();
    d.cues[0]!.lines = [{ spans: [{ text: 'red', color: '#FF0000' }, { text: ' plain' }] }];
    expect(serializeAss(d)).toContain('{\\c&H0000FF&}red{\\c} plain');
  });

  it('synthesises \\pos(x,y) and an alignment tag from cue.position', () => {
    const d = styledDoc();
    d.cues[0]!.position = { position: 50, line: 90, align: 'center' };
    const out = serializeAss(d);
    expect(out).toContain('\\pos(960,972)'); // 50% × 1920, 90% × 1080
    expect(out).toContain('\\an2'); // centre + bottom
  });

  it('does not emit \\pos without explicit numeric coordinates', () => {
    const d = styledDoc();
    d.cues[0]!.position = { line: 'auto', align: 'center' };
    expect(serializeAss(d)).not.toContain('\\pos(');
  });

  it('round-trips colour + position as preserved markup (serialize → parse → serialize)', () => {
    const d = styledDoc();
    d.cues[0]!.position = { position: 25, line: 10, align: 'left' };
    d.cues[0]!.lines = [{ spans: [{ text: 'hi', color: '#00FF00' }] }];
    const second = serializeAss(parseAss(serializeAss(d)));
    expect(second).toContain('{\\c&H00FF00&}'); // #00FF00 → BGR 00FF00
    expect(second).toContain('\\pos(480,108)'); // 25% × 1920, 10% × 1080
  });
});
