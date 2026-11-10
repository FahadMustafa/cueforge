import { describe, expect, it } from 'vitest';
import { parseScc, serializeScc } from './scc';
import { frameToMs, msToFrame, timecodeToFrame, addOddParity, stripParity } from './cea608';
import { cueToText } from '../../model/cue';
import type { ParseWarning, SubtitleDocument } from '../../model/types';

/**
 * Hand-built SCC byte sequences (odd parity already applied). Control codes
 * (after parity strip): RCL=0x1420, EOC=0x142f, EDM=0x142c, ENM=0x142e.
 * PAC row 15 white indent-0 = 0x1460; text "Hi" = 0x48 0x69.
 */
const HEADER = 'Scenarist_SCC V1.0';

const MINIMAL = [
  HEADER,
  '',
  '00:00:01:00\t9420 9420 94e0 94e0 c8e9 942f 942f',
  '',
  '00:00:04:00\t942c 942c',
  '',
].join('\n');

describe('cea608 primitives', () => {
  it('strips odd parity from a byte', () => {
    expect(stripParity(0x94)).toBe(0x14);
    expect(stripParity(0xc8)).toBe(0x48); // 'H'
  });

  it('adds odd parity so the byte has an odd number of one-bits', () => {
    expect(addOddParity(0x14)).toBe(0x94);
    expect(addOddParity(0x20)).toBe(0x20); // already odd
    expect(addOddParity(0x48)).toBe(0xc8); // 'H'
  });

  it('parity strip is the inverse of parity add', () => {
    for (let b = 0; b < 0x80; b++) expect(stripParity(addOddParity(b))).toBe(b);
  });

  it('converts non-drop HH:MM:SS:FF to a frame index at 30fps count', () => {
    expect(timecodeToFrame('00:00:01:00')).toBe(30);
    expect(timecodeToFrame('00:00:01:15')).toBe(45);
    expect(timecodeToFrame('00:01:00:00')).toBe(1800);
  });

  it('drops 2 frames per minute (except every 10th) for drop-frame timecodes', () => {
    // 00:01:00;02 is the first valid label of minute 1 (;00/;01 dropped): real
    // frame index 1800 = nominal 1802 minus the 2 dropped frames.
    expect(timecodeToFrame('00:01:00;02')).toBe(1800);
    // The 10th minute does not drop.
    expect(timecodeToFrame('00:10:00;00')).toBe(17982);
  });

  it('converts a frame index to milliseconds on the 30000/1001 timebase', () => {
    expect(frameToMs(30)).toBe(Math.round((30 * 1001) / 30));
    expect(frameToMs(0)).toBe(0);
  });
});

describe('parseScc', () => {
  it('parses a minimal pop-on caption: text and pop-on timing', () => {
    const doc = parseScc(MINIMAL);
    expect(doc.metadata.sourceFormat).toBe('scc');
    expect(doc.cues).toHaveLength(1);
    expect(cueToText(doc.cues[0]!)).toBe('Hi');
  });

  it('starts the caption at the EOC frame and ends it at the EDM frame', () => {
    const doc = parseScc(MINIMAL);
    // EOC is the 6th word (index 5) of the line at frame 30 -> frame 35.
    expect(doc.cues[0]!.startMs).toBe(frameToMs(35));
    // EDM at line 00:00:04:00 -> frame 120.
    expect(doc.cues[0]!.endMs).toBe(frameToMs(120));
  });

  it('records the drop-frame flag in metadata.raw', () => {
    const df = parseScc(
      [
        HEADER,
        '',
        '00:00:01;00\t9420 9420 94e0 94e0 c8e9 942f 942f',
        '',
        '00:00:04;00\t942c 942c',
      ].join('\n'),
    );
    expect((df.metadata.raw as { dropFrame?: boolean }).dropFrame).toBe(true);
    const ndf = parseScc(MINIMAL);
    expect((ndf.metadata.raw as { dropFrame?: boolean }).dropFrame).toBe(false);
  });

  it('records the canonical 29.97 frame rate so drop-frame + the fps picker recognise it (cue-forge-pm8)', () => {
    // The SCC timebase is the exact 30000/1001, but supportsDropFrame and the
    // Studio fps picker key on the STANDARD_FPS literals — an un-snapped rate
    // silently disabled the drop-frame toggle for imported SCC docs (w28.9).
    // Snap at the parse boundary, consistent with the ttml/itt parsers.
    expect(parseScc(MINIMAL).metadata.frameRate).toBe(29.97);
  });

  it('keeps timing ms-identical through the canonical-fps snap (round-trip, cue-forge-pm8)', () => {
    const df = parseScc(
      [
        HEADER,
        '',
        '00:00:01;00\t9420 9420 94e0 94e0 c8e9 942f 942f',
        '',
        '00:00:04;00\t942c 942c',
      ].join('\n'),
    );
    const reparsed = parseScc(serializeScc(df));
    expect(reparsed.metadata.frameRate).toBe(29.97);
    expect(reparsed.cues.map((c) => [c.startMs, c.endMs])).toEqual(
      df.cues.map((c) => [c.startMs, c.endMs]),
    );
  });

  it('ignores a doubled control code (acts once)', () => {
    // RCL/EOC/EDM all doubled in MINIMAL; still exactly one cue with clean text.
    const doc = parseScc(MINIMAL);
    expect(doc.cues).toHaveLength(1);
    expect(cueToText(doc.cues[0]!)).toBe('Hi');
  });

  it('treats a PAC on a new row as a line break (two-row pop-on)', () => {
    // Row 14 PAC = 0x14 0x40 -> parity 9440; Row 15 PAC = 0x14 0x60 -> 94e0.
    // "Hi" on row 14, "Yo" on row 15. Y=0x59->0xd9, o=0x6f->0xef.
    const src = [
      HEADER,
      '',
      '00:00:01:00\t9420 9420 9440 9440 c8e9 94e0 94e0 d9ef 942f 942f',
      '',
      '00:00:04:00\t942c 942c',
    ].join('\n');
    const doc = parseScc(src);
    expect(doc.cues[0]!.lines).toHaveLength(2);
    expect(cueToText(doc.cues[0]!)).toBe('Hi\nYo');
  });

  it('applies italics from a mid-row code to following text', () => {
    // Mid-row italics = 0x11 0x2e -> parity 0x91 0xae. Text "Hi" after it.
    const src = [
      HEADER,
      '',
      '00:00:01:00\t9420 9420 94e0 94e0 91ae 91ae c8e9 942f 942f',
      '',
      '00:00:04:00\t942c 942c',
    ].join('\n');
    const doc = parseScc(src);
    const spans = doc.cues[0]!.lines[0]!.spans;
    expect(spans.some((s) => s.italic && s.text.includes('Hi'))).toBe(true);
  });

  it('warns when no Scenarist header is present', () => {
    const doc = parseScc('00:00:01:00\t9420 9420 942f 942f');
    expect(doc.warnings.some((w) => w.code === 'unexpected-content')).toBe(true);
  });

  it('parses roll-up captions (parse-only): text between carriage returns becomes a cue', () => {
    // RU2=9425, CR=94ad, text "Hi"=c8e9, "Yo"=d9ef.
    const src = [
      HEADER,
      '',
      '00:00:01:00\t9425 9425 c8e9 94ad 94ad',
      '',
      '00:00:03:00\t9425 9425 d9ef 94ad 94ad',
    ].join('\n');
    const doc = parseScc(src);
    expect(doc.cues).toHaveLength(2);
    expect(cueToText(doc.cues[0]!)).toBe('Hi');
    expect(cueToText(doc.cues[1]!)).toBe('Yo');
  });

  it('decodes the basic character substitutions (e.g. 0x2A -> á)', () => {
    // 0x2a -> parity 0xaa, paired with 0x80 (parity null) -> just "á".
    const src = [
      HEADER,
      '',
      '00:00:01:00\t9420 9420 94e0 94e0 aa80 942f 942f',
      '',
      '00:00:04:00\t942c 942c',
    ].join('\n');
    const doc = parseScc(src);
    expect(cueToText(doc.cues[0]!)).toBe('á');
  });

  it('ignores CC2 text bytes while channel 2 is active (cue-forge-c0h)', () => {
    // CC1 builds "Hi", then a CC2 RCL (0x1C 0x20 -> 1c20) switches the data
    // channel; the following text bytes ("XX" = 5858) belong to CC2 and must
    // not bleed into the CC1 buffer. The CC1 EOC (942f) re-arms channel 1.
    const src = [
      HEADER,
      '',
      '00:00:01:00\t9420 9420 94e0 94e0 c8e9 1c20 1c20 5858 942f 942f',
      '',
      '00:00:04:00\t942c 942c',
    ].join('\n');
    const doc = parseScc(src);
    expect(doc.cues).toHaveLength(1);
    expect(cueToText(doc.cues[0]!)).toBe('Hi');
  });

  it('does not feed field-2 (0x15-prefixed) controls into the CC1 state machine (cue-forge-c0h)', () => {
    // 0x15 0x2F is the CC3 (field 2) EOC, not CC1: it must not flip the
    // pop-on buffer early. Only the real CC1 EOC (942f, word index 7) does.
    const src = [
      HEADER,
      '',
      '00:00:01:00\t9420 9420 94e0 94e0 c8e9 152f 152f 942f 942f',
      '',
      '00:00:04:00\t942c 942c',
    ].join('\n');
    const doc = parseScc(src);
    expect(doc.cues).toHaveLength(1);
    expect(cueToText(doc.cues[0]!)).toBe('Hi');
    // EOC is the word at index 7 of the line at frame 30 -> frame 37.
    expect(doc.cues[0]!.startMs).toBe(frameToMs(37));
  });

  it('decodes an extended character by replacing the preceding fallback char (cue-forge-12v)', () => {
    // Fallback "u" (0x75 -> 7580) followed by extended ü (0x12 0x25 -> 9225,
    // doubled): the extended char REPLACES the preceding character.
    const src = [
      HEADER,
      '',
      '00:00:01:00\t9420 9420 94e0 94e0 7580 9225 9225 942f 942f',
      '',
      '00:00:04:00\t942c 942c',
    ].join('\n');
    const doc = parseScc(src);
    expect(cueToText(doc.cues[0]!)).toBe('ü');
  });

  it('applies an extended character to roll-up text too', () => {
    // RU2 (9425), 'u' (7580), extended ü (9225 doubled), CR (94ad) flushes.
    const src = [HEADER, '', '00:00:01:00\t9425 9425 7580 9225 9225 94ad 94ad'].join('\n');
    const doc = parseScc(src);
    expect(cueToText(doc.cues[0]!)).toBe('ü');
  });

  it('ignores channel-2 extended characters (0x1A/0x1B prefixes)', () => {
    // CC2 extended ü = 0x1a 0x25 (odd parity already) -> 1a25; must not touch the CC1 text.
    const src = [
      HEADER,
      '',
      '00:00:01:00\t9420 9420 94e0 94e0 c8e9 1a25 1a25 942f 942f',
      '',
      '00:00:04:00\t942c 942c',
    ].join('\n');
    const doc = parseScc(src);
    expect(cueToText(doc.cues[0]!)).toBe('Hi');
  });
});

/** Build a minimal pop-on document for serializer tests. */
function popon(lines: string[][], startMs: number, endMs: number): SubtitleDocument {
  return {
    cues: [
      {
        index: 1,
        startMs,
        endMs,
        lines: lines.map((spans) => ({ spans: spans.map((text) => ({ text })) })),
      },
    ],
    metadata: { sourceFormat: 'scc', raw: { dropFrame: false, header: HEADER } },
    warnings: [],
  };
}

describe('serializeScc', () => {
  it('emits the Scenarist header', () => {
    expect(serializeScc(popon([['Hi']], 1168, 4004))).toContain('Scenarist_SCC V1.0');
  });

  it('round-trips a minimal pop-on caption (text + timing)', () => {
    const doc = parseScc(MINIMAL);
    const reparsed = parseScc(serializeScc(doc));
    expect(reparsed.cues).toHaveLength(1);
    expect(cueToText(reparsed.cues[0]!)).toBe('Hi');
    expect(reparsed.cues[0]!.startMs).toBe(doc.cues[0]!.startMs);
    expect(reparsed.cues[0]!.endMs).toBe(doc.cues[0]!.endMs);
  });

  it('preserves the drop-frame flag through a round-trip', () => {
    const df = parseScc(
      [
        HEADER,
        '',
        '00:00:01;00\t9420 9420 94e0 94e0 c8e9 942f 942f',
        '',
        '00:00:04;00\t942c 942c',
      ].join('\n'),
    );
    const reparsed = parseScc(serializeScc(df));
    expect((reparsed.metadata.raw as { dropFrame?: boolean }).dropFrame).toBe(true);
  });

  it('round-trips a two-row caption with italics', () => {
    const src = [
      HEADER,
      '',
      '00:00:01:00\t9420 9420 9440 9440 c8e9 94e0 94e0 91ae 91ae d9ef 942f 942f',
      '',
      '00:00:04:00\t942c 942c',
    ].join('\n');
    const doc = parseScc(src);
    const reparsed = parseScc(serializeScc(doc));
    expect(reparsed.cues[0]!.lines).toHaveLength(2);
    expect(cueToText(reparsed.cues[0]!)).toBe(cueToText(doc.cues[0]!));
    // italics on the row-15 "Yo" survive.
    const row15 = reparsed.cues[0]!.lines[1]!;
    expect(row15.spans.some((s) => s.italic)).toBe(true);
  });

  it('transliterates out-of-charset characters', () => {
    // The ellipsis and en dash have no CEA-608 encoding (curly quotes and the
    // em dash now round-trip via the extended character sets, cue-forge-12v).
    const doc = popon([['…ok–x']], 1168, 4004);
    const out = serializeScc(doc);
    const reparsed = parseScc(out);
    expect(cueToText(reparsed.cues[0]!)).toBe('...ok-x');
  });

  it("'café' survives serialize → parse (cue-forge-12v)", () => {
    const reparsed = parseScc(serializeScc(popon([['café']], 1168, 4004)));
    expect(cueToText(reparsed.cues[0]!)).toBe('café');
  });

  it('round-trips extended characters via fallback + extended code (cue-forge-12v)', () => {
    // Spanish/French set (0x12) and Portuguese/German set (0x13).
    const text = 'Ü ü Ä ä «É» ß å —“ok”';
    const reparsed = parseScc(serializeScc(popon([[text]], 1168, 8000)));
    expect(cueToText(reparsed.cues[0]!)).toBe(text);
  });

  it('round-trips a special character and an odd-length run', () => {
    const doc = popon([['a♪']], 1168, 4004);
    const reparsed = parseScc(serializeScc(doc));
    expect(cueToText(reparsed.cues[0]!)).toBe('a♪');
  });

  it('round-trips a coloured run via a mid-row colour code', () => {
    const doc: SubtitleDocument = {
      cues: [
        {
          index: 1,
          startMs: 1168,
          endMs: 4004,
          lines: [{ spans: [{ text: 'go', color: 'red' }] }],
        },
      ],
      metadata: { sourceFormat: 'scc', raw: { dropFrame: false, header: HEADER } },
      warnings: [],
    };
    const reparsed = parseScc(serializeScc(doc));
    expect(reparsed.cues[0]!.lines[0]!.spans.some((s) => s.color === 'red')).toBe(true);
  });

  it('clamps adjacent captions so transmissions never collide (cue-forge-0zz)', () => {
    const doc: SubtitleDocument = {
      cues: [
        {
          index: 1,
          startMs: 1000,
          endMs: 2000,
          lines: [{ spans: [{ text: 'First caption here' }] }],
        },
        {
          index: 2,
          startMs: 2100, // 100ms after cue 1 ends
          endMs: 3000,
          lines: [{ spans: [{ text: 'Second caption follows' }] }],
        },
      ],
      metadata: { sourceFormat: 'scc', raw: { dropFrame: false, header: HEADER } },
      warnings: [],
    };
    const warnings: ParseWarning[] = [];
    const out = serializeScc(doc, warnings);

    // Every line's word stream must start after the previous line's stream ended.
    const lines = out.split('\n').filter((l) => l.includes('\t'));
    let prevEnd = -1;
    for (const line of lines) {
      const [tc, body] = line.split('\t') as [string, string];
      const frame = timecodeToFrame(tc);
      expect(frame).toBeGreaterThan(prevEnd);
      prevEnd = frame + body.trim().split(/\s+/).length - 1;
    }

    // Density was resolved by dropping the first cue's EDM; that is reported.
    expect(warnings.some((w) => w.message.includes('too dense'))).toBe(true);

    // Both captions decode intact and the second still pops on at its start frame.
    const reparsed = parseScc(out);
    expect(reparsed.cues).toHaveLength(2);
    expect(cueToText(reparsed.cues[0]!)).toBe('First caption here');
    expect(cueToText(reparsed.cues[1]!)).toBe('Second caption follows');
    expect(reparsed.cues[1]!.startMs).toBe(frameToMs(msToFrame(2100)));
  });

  it('accepts a delayed EOC when the stream cannot fit before the start frame', () => {
    const doc: SubtitleDocument = {
      cues: [
        {
          index: 1,
          startMs: 0,
          endMs: 400,
          lines: [{ spans: [{ text: 'A rather long opening caption' }] }],
        },
        {
          index: 2,
          startMs: 300, // its transmission cannot complete by frame 9
          endMs: 1500,
          lines: [{ spans: [{ text: 'An equally long second caption' }] }],
        },
      ],
      metadata: { sourceFormat: 'scc', raw: { dropFrame: false, header: HEADER } },
      warnings: [],
    };
    const warnings: ParseWarning[] = [];
    const out = serializeScc(doc, warnings);
    expect(warnings.some((w) => w.code === 'captions-too-dense' && w.cueIndex === 2)).toBe(true);

    // Still decodable, in order, with no transmission collisions.
    const lines = out.split('\n').filter((l) => l.includes('\t'));
    let prevEnd = -1;
    for (const line of lines) {
      const [tc, body] = line.split('\t') as [string, string];
      const frame = timecodeToFrame(tc);
      expect(frame).toBeGreaterThan(prevEnd);
      prevEnd = frame + body.trim().split(/\s+/).length - 1;
    }
    const reparsed = parseScc(out);
    expect(reparsed.cues.map((c) => cueToText(c))).toEqual([
      'A rather long opening caption',
      'An equally long second caption',
    ]);
  });

  it('serializes with default header and non-drop timecodes when raw metadata is absent', () => {
    const doc: SubtitleDocument = {
      cues: [{ index: 1, startMs: 2000, endMs: 3000, lines: [{ spans: [{ text: 'Hi' }] }] }],
      metadata: { sourceFormat: 'scc' },
      warnings: [],
    };
    const out = serializeScc(doc);
    expect(out).toContain('Scenarist_SCC V1.0');
    expect(out).not.toContain(';'); // non-drop separators
    expect(cueToText(parseScc(out).cues[0]!)).toBe('Hi');
  });

  it('emits explicit EDM lines and no warnings when cues are far apart', () => {
    const doc: SubtitleDocument = {
      cues: [
        { index: 1, startMs: 2000, endMs: 3500, lines: [{ spans: [{ text: 'One' }] }] },
        { index: 2, startMs: 6000, endMs: 7500, lines: [{ spans: [{ text: 'Two' }] }] },
      ],
      metadata: { sourceFormat: 'scc', raw: { dropFrame: false, header: HEADER } },
      warnings: [],
    };
    const warnings: ParseWarning[] = [];
    const out = serializeScc(doc, warnings);
    expect(warnings).toHaveLength(0);
    const reparsed = parseScc(out);
    expect(reparsed.cues[0]!.endMs).toBe(frameToMs(msToFrame(3500)));
    expect(reparsed.cues[1]!.endMs).toBe(frameToMs(msToFrame(7500)));
  });

  it('wraps a line longer than 32 characters', () => {
    const long = 'one two three four five six seven eight'; // > 32 chars
    const doc = popon([[long]], 1168, 8000);
    const reparsed = parseScc(serializeScc(doc));
    // Every emitted row is within the 32-char limit.
    for (const line of reparsed.cues[0]!.lines) {
      expect(cueToText({ ...reparsed.cues[0]!, lines: [line] }).length).toBeLessThanOrEqual(32);
    }
    expect(reparsed.cues[0]!.lines.length).toBeGreaterThan(1);
  });
});
