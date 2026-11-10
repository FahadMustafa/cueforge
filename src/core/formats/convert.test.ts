import { describe, expect, it } from 'vitest';
import {
  convert,
  interpretedCapabilities,
  normalizeForTarget,
  capabilityReport,
  ALL_TARGETS,
  CAN,
  PRO_CAN,
} from './convert';
import { parseAss } from './ass';
import { parseSrt } from './srt';
import type { Cue, CuePosition, StyledSpan, SubtitleDocument } from '../model/types';

const ASS_HEAD = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

function assDoc(...d: string[]): string {
  return ASS_HEAD + '\n' + d.join('\n') + '\n';
}

describe('ASS → SRT styling mapping (spec §3)', () => {
  it('maps {\\i1}…{\\i0} to <i>…</i>', () => {
    const r = convert(
      assDoc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}italic{\\i0} plain'),
      'ass',
      'srt',
    );
    expect(r.text).toContain('<i>italic</i> plain');
  });

  it('maps bold and underline override tags', () => {
    const r = convert(
      assDoc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\b1}b{\\b0} {\\u1}u{\\u0}'),
      'ass',
      'srt',
    );
    expect(r.text).toContain('<b>b</b>');
    expect(r.text).toContain('<u>u</u>');
  });

  it('strips non-styling override tags and warns listing what was dropped', () => {
    const r = convert(
      assDoc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(960,200)\\i1}x{\\i0}'),
      'ass',
      'srt',
    );
    expect(r.text).toContain('<i>x</i>');
    expect(r.text).not.toContain('{');
    expect(r.text).not.toContain('\\pos');
    expect(r.warnings.some((w) => w.message.includes('\\pos'))).toBe(true);
  });

  it('preserves plain text exactly when converting to SBV (styling flattened)', () => {
    const r = convert(
      assDoc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}hello{\\i0} world'),
      'ass',
      'sbv',
    );
    expect(r.text).toContain('hello world');
    expect(r.text).not.toContain('<i>');
    // SBV cannot express italic — a drop warning must be emitted.
    expect(r.warnings.some((w) => /italic/i.test(w.message))).toBe(true);
  });
});

describe('conversion does not leak the source header into the target', () => {
  it('ASS → VTT emits a WEBVTT header, not [Script Info]', () => {
    const r = convert(assDoc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hi'), 'ass', 'vtt');
    expect(r.text.startsWith('WEBVTT')).toBe(true);
    expect(r.text).not.toContain('[Script Info]');
  });
});

describe('SRT → ASS', () => {
  it('emits italic override tags and a default ASS header', () => {
    const r = convert('1\n00:00:01,000 --> 00:00:02,000\n<i>hi</i>\n', 'srt', 'ass');
    expect(r.text).toContain('[Events]');
    expect(r.text).toContain('{\\i1}hi{\\i0}');
  });

  it('preserves color as a \\c BGR tag (ASS is now a colour target — no drop warning)', () => {
    const r = convert(
      '1\n00:00:01,000 --> 00:00:02,000\n<font color="#FF0000">red</font>\n',
      'srt',
      'ass',
    );
    expect(r.text).toContain('{\\c&H0000FF&}red');
    expect(r.warnings.some((w) => /color/i.test(w.message))).toBe(false);
  });
});

describe('VTT character references across conversion', () => {
  it('VTT → SRT yields the decoded literal text', () => {
    const r = convert(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFish &amp; chips &lrm;x\n',
      'vtt',
      'srt',
    );
    expect(r.text).toContain('Fish & chips \u200Ex');
    expect(r.text).not.toContain('&amp;');
  });

  it('SRT → VTT escapes a literal & in the text', () => {
    const r = convert('1\n00:00:01,000 --> 00:00:02,000\nA & B\n', 'srt', 'vtt');
    expect(r.text).toContain('A &amp; B');
  });
});

describe('unrecognized VTT constructs across conversion (spec §6.3 #2)', () => {
  const SRC =
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c.yellow>x</c> <ruby>a<rt>b</rt></ruby> <00:00:01.500>k\n';

  it('VTT → SRT strips them (inner text kept, timestamps dropped) and warns', () => {
    const r = convert(SRC, 'vtt', 'srt');
    expect(r.text).toContain('x ab k');
    expect(r.text).not.toContain('<c.yellow>');
    expect(r.text).not.toContain('<ruby>');
    expect(r.text).not.toContain('<00:00:01.500>');
    expect(
      r.warnings.some((w) => w.code === 'capability-dropped' && /WebVTT/i.test(w.message)),
    ).toBe(true);
  });

  it('VTT → ASS strips them too (they must not leak into Dialogue text)', () => {
    const r = convert(SRC, 'vtt', 'ass');
    expect(r.text).not.toContain('<c.yellow>');
    expect(r.text).toContain('x ab k');
  });
});

describe('VTT opaque markup must not go through the ASS interpretation pass', () => {
  it('VTT → VTT keeps <c>/<ruby> markup verbatim with zero warnings', () => {
    const src =
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c.yellow>x</c> <ruby>a<rt>b</rt></ruby>\n';
    const r = convert(src, 'vtt', 'vtt');
    expect(r.text).toContain('<c.yellow>x</c>');
    expect(r.text).toContain('<ruby>a<rt>b</rt></ruby>');
    expect(r.warnings).toEqual([]);
  });

  it('VTT → VTT keeps a literal backslash-n when another cue carries opaque markup', () => {
    const src =
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c.x>styled</c>\n\n00:00:03.000 --> 00:00:04.000\npath C:\\nuke\n';
    const r = convert(src, 'vtt', 'vtt');
    expect(r.text).toContain('path C:\\nuke');
  });

  it('VTT → SRT keeps a literal backslash-n in cue text', () => {
    const src =
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c.x>styled</c>\n\n00:00:03.000 --> 00:00:04.000\npath C:\\nuke\n';
    const r = convert(src, 'vtt', 'srt');
    expect(r.text).toContain('path C:\\nuke');
  });
});

describe('capability matrix honesty (voice / color)', () => {
  it('CAN.srt does not advertise voice', () => {
    expect(CAN.srt.has('voice')).toBe(false);
  });

  it('VTT → SRT drops the voice tag (text kept) with a warning', () => {
    const r = convert('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Roger>hi\n', 'vtt', 'srt');
    expect(r.text).toContain('hi');
    expect(r.text).not.toContain('<v');
    expect(r.warnings.some((w) => /voice/i.test(w.message))).toBe(true);
  });

  it('SRT → VTT serializes named colors as <c.name> spans (valid WebVTT)', () => {
    const r = convert(
      '1\n00:00:01,000 --> 00:00:02,000\n<font color="red">x</font>\n',
      'srt',
      'vtt',
    );
    expect(r.text).toContain('<c.red>x</c>');
    expect(r.text).not.toContain('<font');
  });

  it('SRT → VTT serializes hex colors as <c.color-RRGGBB> spans', () => {
    const r = convert(
      '1\n00:00:01,000 --> 00:00:02,000\n<font color="#FF0000">x</font>\n',
      'srt',
      'vtt',
    );
    expect(r.text).toContain('<c.color-FF0000>x</c>');
  });
});

describe('ASS Comment events across conversion', () => {
  const SRC = assDoc(
    'Comment: 0,0:00:00.50,0:00:00.90,Default,,0,0,0,,a hidden note',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,visible',
  );

  it('ASS → SRT drops Comment events with one warning', () => {
    const r = convert(SRC, 'ass', 'srt');
    expect(r.text).toContain('visible');
    expect(r.text).not.toContain('a hidden note');
    expect(r.warnings.filter((w) => /comment event/i.test(w.message))).toHaveLength(1);
  });

  it('ASS → ASS conversion keeps Comment events', () => {
    const r = convert(SRC, 'ass', 'ass');
    expect(r.text).toContain('Comment: ');
    expect(r.text).toContain('a hidden note');
  });
});

describe('ASS \\n and \\h escapes across conversion', () => {
  it('maps \\n to a line break for SRT (WrapStyle-agnostic)', () => {
    const r = convert(
      assDoc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,first\\nsecond'),
      'ass',
      'srt',
    );
    expect(r.text).toContain('first\r\nsecond');
    expect(r.text).not.toContain('\\n');
  });

  it('maps \\h to a no-break space for SRT', () => {
    const r = convert(
      assDoc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,x\\hy'),
      'ass',
      'srt',
    );
    expect(r.text).toContain('x\u00A0y');
    expect(r.text).not.toContain('\\h');
  });
});

describe('interpretedCapabilities', () => {
  it('treats ASS \\i1 opaque markup as the italic capability', () => {
    const doc = parseAss(assDoc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}x{\\i0}'));
    expect(interpretedCapabilities(doc).has('italic')).toBe(true);
  });
  it('treats an unmapped ASS tag as the override capability', () => {
    const doc = parseAss(assDoc('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(1,2)}x'));
    expect(interpretedCapabilities(doc).has('override')).toBe(true);
  });
  it('reports inline color from SRT', () => {
    const doc = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n<font color="red">x</font>\n');
    expect(interpretedCapabilities(doc).has('color')).toBe(true);
  });
  it('CAN[sbv] is empty (plain text only)', () => {
    expect(CAN.sbv.size).toBe(0);
  });
});

describe('normalizeForTarget with Pro targets (spec §4.2)', () => {
  const styled = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n<b><font color="red">x</font></b>\n');

  it('warns about bold for SCC (italic/underline/color only)', () => {
    const { doc, warnings } = normalizeForTarget(styled, 'scc');
    expect(warnings.some((w) => /bold/.test(w.message))).toBe(true);
    expect(warnings.some((w) => /color/.test(w.message))).toBe(false);
    // Colour is expressible, so the span keeps it.
    expect(doc.cues[0]!.lines[0]!.spans[0]!.color).toBe('red');
  });

  it('strips colour for STL (italic/underline only) and warns', () => {
    const { doc, warnings } = normalizeForTarget(styled, 'stl');
    expect(warnings.some((w) => /color/.test(w.message))).toBe(true);
    expect(doc.cues[0]!.lines[0]!.spans[0]!.color).toBeUndefined();
  });

  it('keeps bold and colour for TTML (no capability warnings)', () => {
    const { warnings } = normalizeForTarget(styled, 'ttml');
    expect(warnings).toEqual([]);
  });

  it('declares capability sets for every Pro format', () => {
    expect(PRO_CAN.ttml.has('bold')).toBe(true);
    expect(PRO_CAN.scc.has('bold')).toBe(false);
    expect(PRO_CAN.stl.has('color')).toBe(false);
  });
});

describe('capabilityReport (loss-matrix core, H1)', () => {
  /** Minimal one-cue document carrying the given span styling and cue position. */
  function styledDoc(span: Partial<StyledSpan>, position?: CuePosition): SubtitleDocument {
    const cue: Cue = {
      index: 1,
      startMs: 0,
      endMs: 1000,
      lines: [{ spans: [{ text: 'x', ...span }] }],
    };
    if (position) cue.position = position;
    return { cues: [cue], metadata: { sourceFormat: 'srt' }, warnings: [] };
  }

  function entry(report: ReturnType<typeof capabilityReport>, target: string) {
    return report.find((e) => e.target === target)!;
  }

  it('reports colour preserved on colour-capable targets and dropped on the rest', () => {
    const report = capabilityReport(styledDoc({ color: 'red' }));
    expect(entry(report, 'srt')).toMatchObject({ preserved: ['color'], dropped: [] });
    expect(entry(report, 'ttml')).toMatchObject({ preserved: ['color'], dropped: [] });
    expect(entry(report, 'sbv')).toMatchObject({ preserved: [], dropped: ['color'] });
    expect(entry(report, 'stl')).toMatchObject({ preserved: [], dropped: ['color'] });
  });

  it('reports position preserved only on vtt/ass/ttml', () => {
    const report = capabilityReport(styledDoc({}, { position: 50, line: 50, align: 'center' }));
    for (const t of ['vtt', 'ass', 'ttml']) {
      expect(entry(report, t).preserved).toContain('position');
    }
    for (const t of ['srt', 'sbv', 'scc', 'stl']) {
      expect(entry(report, t).dropped).toContain('position');
    }
  });

  it('reports voice preserved only on vtt', () => {
    const report = capabilityReport(styledDoc({ voice: 'Bob' }));
    expect(entry(report, 'vtt').preserved).toContain('voice');
    for (const t of ['srt', 'sbv', 'ass', 'ttml', 'scc', 'stl']) {
      expect(entry(report, t).dropped).toContain('voice');
    }
  });

  it('reports an unmapped ASS override as preserved only on ass', () => {
    const report = capabilityReport(styledDoc({ opaque: '{\\pos(1,2)}' }));
    expect(entry(report, 'ass').preserved).toContain('override');
    expect(entry(report, 'srt').dropped).toContain('override');
  });

  it('partitions all used capabilities into preserved ∪ dropped for every target', () => {
    const doc = styledDoc({ bold: true, color: 'red', voice: 'Bob' }, { position: 10, line: 10 });
    const used = [...interpretedCapabilities(doc)].sort();
    for (const e of capabilityReport(doc)) {
      expect([...e.preserved, ...e.dropped].sort()).toEqual(used);
      // Preserved are exactly the target-expressible used capabilities.
      const can = e.target in CAN ? CAN[e.target as 'srt'] : PRO_CAN[e.target as 'ttml'];
      expect(e.preserved.every((c) => can.has(c))).toBe(true);
      expect(e.dropped.every((c) => !can.has(c))).toBe(true);
    }
  });

  it('covers every target by default (4 core + 8 Pro) and honours a custom subset', () => {
    expect(capabilityReport(styledDoc({ color: 'red' }))).toHaveLength(ALL_TARGETS.length);
    expect(ALL_TARGETS).toHaveLength(12);
    const subset = capabilityReport(styledDoc({ color: 'red' }), ['vtt', 'stl']);
    expect(subset.map((e) => e.target)).toEqual(['vtt', 'stl']);
  });

  it('yields empty preserved and dropped for an unstyled document', () => {
    for (const e of capabilityReport(styledDoc({}))) {
      expect(e.preserved).toEqual([]);
      expect(e.dropped).toEqual([]);
    }
  });
});

describe('SRT {\\anN} alignment tags across conversion (cue-forge-qcvu.3)', () => {
  const srt = (n: number, timing = '00:00:01,000 --> 00:00:03,000') =>
    `1\n${timing}\n{\\an${n}}Top text\n`;
  const VTT_SETTINGS: Record<number, string> = {
    1: 'align:left',
    2: 'align:center',
    3: 'align:right',
    4: 'line:50% align:left',
    5: 'line:50% align:center',
    6: 'line:50% align:right',
    7: 'line:0 align:left',
    8: 'line:0 align:center',
    9: 'line:0 align:right',
  };

  it('SRT → SRT keeps the tag and warns about nothing', () => {
    const { text, warnings } = convert(srt(8), 'srt', 'srt');
    expect(text).toContain('{\\an8}Top text');
    expect(warnings).toEqual([]);
  });

  it('SRT → VTT maps every N to cue settings, without the literal tag or a native-drop warning', () => {
    for (let n = 1; n <= 9; n++) {
      const { text, warnings } = convert(srt(n), 'srt', 'vtt');
      expect(text).toContain(`00:00:01.000 --> 00:00:03.000 ${VTT_SETTINGS[n]}\nTop text\n`);
      expect(text).not.toContain('{\\an');
      expect(warnings).toEqual([]);
    }
  });

  it('SRT → ASS emits the same {\\anN} for all nine values', () => {
    for (let n = 1; n <= 9; n++) {
      const { text, warnings } = convert(srt(n), 'srt', 'ass');
      expect(text).toMatch(new RegExp(`^Dialogue: .*,\\{\\\\an${n}\\}Top text\\r?$`, 'm'));
      expect(warnings).toEqual([]);
    }
  });

  it('SRT → SBV drops the placement with a specific position warning', () => {
    const { text, warnings } = convert(srt(8), 'srt', 'sbv');
    expect(text).toContain('Top text');
    expect(text).not.toContain('{\\an');
    expect(warnings.map((w) => w.message)).toEqual([
      'Target "sbv" cannot express position ({\\an} placement on 1 cue(s)); it was dropped.',
    ]);
  });

  it('a timing-line trailer is still reported as a dropped native reference', () => {
    const { warnings } = convert(srt(8, '00:00:01,000 --> 00:00:03,000 X1:10'), 'srt', 'vtt');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/native "srt"/);
  });

  it('TTML targets keep alignment and flag only the lost vertical placement', () => {
    const { doc, warnings } = normalizeForTarget(parseSrt(srt(8)), 'ttml');
    expect(doc.cues[0]!.position).toEqual({ line: 0, align: 'center' });
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/not exact x\/y placement; 1 cue\(s\)/),
    ]);
  });

  it('does not synthesize {\\anN} when a positioned VTT cue becomes SRT', () => {
    const { text } = convert(
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000 line:0 align:center\nTop text\n',
      'vtt',
      'srt',
    );
    expect(text).not.toContain('{\\an');
  });
});
