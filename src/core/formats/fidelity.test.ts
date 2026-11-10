import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALL_TARGETS,
  capabilityReport,
  convert,
  interpretedCapabilities,
  normalizeForTarget,
} from './convert';
import { getTextFormat, type TextFormatId } from './registry';
import { parseTtml, serializeTtml } from './ttml';
import { parseScc } from './scc';
import { parseStl } from './stl';
import { parseItt, serializeItt } from './itt';
import { serializeAss } from './ass';
import type { Cue, SubtitleDocument } from '../model/types';

/**
 * Fidelity-proof corpus (H1, cue-forge-95k.6) — the suite that proves and markets
 * the no-style-loss claim. Each block reproduces a cited real-world conversion
 * failure (line-break corruption, colour loss, lost positioning, broken Pro
 * interchange) and asserts that within each pair's capability the style,
 * position, and line structure survive — and that genuinely-unsupported features
 * drop with an explicit warning, never silently.
 *
 * Known v1 boundary (tracked in cue-forge-z6t): TTML/iTT express only vertical
 * writing mode, not x/y placement, so this corpus does NOT claim x/y position
 * survival to TTML — only to the formats whose serializers genuinely emit it
 * (VTT cue-settings; ASS \pos/\an).
 */

const fixtureDir = resolve(process.cwd(), 'fixtures');
const readText = (rel: string) => readFileSync(resolve(fixtureDir, rel), 'utf8');
const readBytes = (rel: string) => new Uint8Array(readFileSync(resolve(fixtureDir, rel)));

const plain = (cue: Cue): string =>
  cue.lines.map((l) => l.spans.map((s) => s.text).join('')).join('\n');
const allText = (doc: SubtitleDocument) => doc.cues.map(plain);
const span0Color = (doc: SubtitleDocument) => doc.cues[0]!.lines[0]!.spans[0]!.color;

// ── 1. Line breaks survive every conversion (cited: SRT↔VTT line-break loss) ──

describe('line breaks survive conversion (cited: SRT↔VTT line-break corruption)', () => {
  const TWO_LINE = '1\n00:00:01,000 --> 00:00:04,000\n<i>First line</i>\nSecond line\n';

  it('SRT → VTT → SRT keeps two lines, the italic, and exact text', () => {
    const toVtt = convert(TWO_LINE, 'srt', 'vtt');
    expect(getTextFormat('vtt').parse(toVtt.text).cues[0]!.lines).toHaveLength(2);

    const back = getTextFormat('srt').parse(convert(toVtt.text, 'vtt', 'srt').text);
    expect(back.cues[0]!.lines).toHaveLength(2);
    expect(plain(back.cues[0]!)).toBe('First line\nSecond line');
    expect(back.cues[0]!.lines[0]!.spans.some((s) => s.italic)).toBe(true);
  });

  it('keeps a two-line cue intact across every core pair (controlled input)', () => {
    const TWO = '1\n00:00:01,000 --> 00:00:04,000\nAlpha\nBeta\n';
    const FORMATS: TextFormatId[] = ['srt', 'vtt', 'sbv', 'ass'];
    for (const from of FORMATS) {
      const inFrom = from === 'srt' ? TWO : convert(TWO, 'srt', from).text;
      for (const to of FORMATS) {
        if (from === to) continue;
        const out = getTextFormat(to).parse(convert(inFrom, from, to).text);
        expect(out.cues[0]!.lines).toHaveLength(2);
        expect(plain(out.cues[0]!)).toBe('Alpha\nBeta');
      }
    }
  });

  it('preserves a 3-line cue through an SRT → VTT → ASS → SRT chain', () => {
    const three = '1\n00:00:01,000 --> 00:00:04,000\nLine one\nLine two\nLine three\n';
    const vtt = convert(three, 'srt', 'vtt').text;
    const ass = convert(vtt, 'vtt', 'ass').text;
    const back = getTextFormat('srt').parse(convert(ass, 'ass', 'srt').text);
    expect(back.cues[0]!.lines).toHaveLength(3);
    expect(plain(back.cues[0]!)).toBe('Line one\nLine two\nLine three');
  });
});

// ── 2. Colour survives to every colour-capable format (cited: colour loss) ────

describe('colour survives within capability (cited: colour stripped on conversion)', () => {
  const RED_SRT = '1\n00:00:01,000 --> 00:00:02,000\n<font color="#FF0000">red</font>\n';

  it('SRT colour re-parses identically through SRT and TTML', () => {
    expect(span0Color(getTextFormat('srt').parse(convert(RED_SRT, 'srt', 'srt').text))).toBe(
      '#FF0000',
    );
    const { doc } = normalizeForTarget(getTextFormat('srt').parse(RED_SRT), 'ttml');
    expect(span0Color(parseTtml(serializeTtml(doc)))).toBe('#FF0000');
  });

  it('SRT → VTT expresses colour as a WebVTT class (no <font> leakage)', () => {
    const out = convert(RED_SRT, 'srt', 'vtt');
    expect(out.text).toContain('<c.color-FF0000>');
    expect(out.text).not.toContain('<font');
  });

  it('SRT → ASS synthesises the \\c colour override', () => {
    expect(convert(RED_SRT, 'srt', 'ass').text).toContain('{\\c&H0000FF&}');
  });

  it('drops colour with a warning for plain-text-only targets (SBV)', () => {
    const out = convert(RED_SRT, 'srt', 'sbv');
    expect(out.text).toContain('red');
    expect(out.warnings.some((w) => /color/i.test(w.message))).toBe(true);
  });
});

// ── 3. ASS is a lossless colour + position target (cue-forge-95k.1) ───────────

describe('ASS is a lossless colour + position target (cue-forge-95k.1)', () => {
  const styled: SubtitleDocument = {
    cues: [
      {
        index: 1,
        startMs: 1000,
        endMs: 4000,
        lines: [{ spans: [{ text: 'red', color: '#FF0000', italic: true }] }],
        position: { position: 50, line: 90, align: 'center' },
      },
    ],
    metadata: { sourceFormat: 'vtt' },
    warnings: [],
  };

  it('emits \\c colour and \\pos/\\an position, with no colour/position drop warning', () => {
    const { doc, warnings } = normalizeForTarget(styled, 'ass');
    const ass = serializeAss(doc);
    expect(ass).toContain('\\c&H0000FF&'); // #FF0000 → BGR 0000FF (here combined with \i1)
    expect(ass).toMatch(/\\pos\(\d+,\d+\)/);
    expect(ass).toMatch(/\\an\d/);
    expect(warnings.some((w) => /colou?r|position/i.test(w.message))).toBe(false);
  });
});

// ── 4. Positioning survives where the serializer emits it (cited: position loss)

describe('positioning survives within capability (cited: positioning dropped)', () => {
  const POS_VTT =
    'WEBVTT\n\n00:00:01.000 --> 00:00:04.000 line:85% position:40% align:start\nLow left\n';

  it('VTT cue settings (line / position / align) survive a VTT round-trip', () => {
    const once = getTextFormat('vtt').parse(POS_VTT);
    expect(once.cues[0]!.position).toMatchObject({ line: 85, position: 40, align: 'start' });
    const twice = getTextFormat('vtt').parse(convert(POS_VTT, 'vtt', 'vtt').text);
    expect(twice.cues[0]!.position).toMatchObject({ line: 85, position: 40, align: 'start' });
  });

  it('VTT positioning converts into an ASS \\pos/\\an override', () => {
    const { doc } = normalizeForTarget(getTextFormat('vtt').parse(POS_VTT), 'ass');
    expect(serializeAss(doc)).toMatch(/\\pos\(\d+,\d+\)/);
  });

  it('drops positioning with a warning when converting to a non-positional target (SRT)', () => {
    const out = convert(POS_VTT, 'vtt', 'srt');
    expect(out.text).toContain('Low left');
    expect(out.warnings.some((w) => /position/i.test(w.message))).toBe(true);
  });

  it('TTML keeps text alignment but flags (never silently drops) absolute x/y (cue-forge-z6t)', () => {
    const { doc, warnings } = normalizeForTarget(getTextFormat('vtt').parse(POS_VTT), 'ttml');
    // Alignment genuinely survives (tts:textAlign).
    expect(doc.cues[0]!.position?.align).toBe('start');
    // The x/y box geometry (line/position) is not preservable — and is warned, not dropped silently.
    expect(warnings.some((w) => /x\/y|placement|positioning/i.test(w.message))).toBe(true);
  });
});

// ── 5. SCC CEA-608 styling round-trips (cited: SCC 608 mangled) ───────────────

describe('SCC CEA-608 styling survives conversion (cited: SCC 608 styling loss)', () => {
  it('SCC → SRT keeps the visible text and maps mid-row italics to <i>', () => {
    const scc = parseScc(readText('scc/edge.scc'));
    expect(scc.cues.some((c) => c.lines.some((l) => l.spans.some((s) => s.italic)))).toBe(true);

    const { doc } = normalizeForTarget(scc, 'srt');
    const srt = getTextFormat('srt').serialize(doc);
    expect(allText(getTextFormat('srt').parse(srt))).toEqual(allText(scc));
    expect(srt).toContain('<i>');
  });
});

// ── 6. iTT round-trips and converts to free formats (cue-forge-95k.5) ─────────

describe('Apple iTT round-trips and exports to free formats (cue-forge-95k.5)', () => {
  it('iTT parse → serialize → parse preserves cues, timing, and text', () => {
    const once = parseItt(readText('itt/edge.itt'));
    const twice = parseItt(serializeItt(once));
    expect(twice.cues.map((c) => [c.startMs, c.endMs])).toEqual(
      once.cues.map((c) => [c.startMs, c.endMs]),
    );
    expect(allText(twice)).toEqual(allText(once));
  });

  it('iTT → SRT preserves cue count and visible text', () => {
    const itt = parseItt(readText('itt/typical.itt'));
    const { doc } = normalizeForTarget(itt, 'srt');
    const back = getTextFormat('srt').parse(getTextFormat('srt').serialize(doc));
    expect(back.cues).toHaveLength(itt.cues.length);
    expect(allText(back)).toEqual(allText(itt));
  });
});

// ── 7. Pro import → free export loses nothing within capability (cited) ───────

describe('Pro import → free export is lossless within capability (cited)', () => {
  const sources: [string, SubtitleDocument][] = [
    ['ttml', parseTtml(readText('ttml/minimal.ttml'))],
    ['scc', parseScc(readText('scc/minimal.scc'))],
    ['stl', parseStl(readBytes('stl/minimal.stl'))],
    ['itt', parseItt(readText('itt/minimal.itt'))],
  ];

  for (const [label, source] of sources) {
    for (const to of ['srt', 'vtt'] as const) {
      it(`${label} → ${to} preserves cue count and visible text`, () => {
        const { doc } = normalizeForTarget(source, to);
        const back = getTextFormat(to).parse(getTextFormat(to).serialize(doc));
        expect(back.cues).toHaveLength(source.cues.length);
        expect(allText(back)).toEqual(allText(source));
      });
    }
  }
});

// ── 8. Capability transparency: nothing drops silently ───────────────────────

describe('capability transparency: every dropped feature is warned (never silent)', () => {
  const rich: SubtitleDocument = {
    cues: [
      {
        index: 1,
        startMs: 1000,
        endMs: 4000,
        lines: [
          {
            spans: [
              { text: 'red ', color: '#FF0000', italic: true },
              { text: 'bold', bold: true },
            ],
          },
        ],
        position: { position: 50, line: 90, align: 'center' },
      },
    ],
    metadata: { sourceFormat: 'vtt' },
    warnings: [],
  };

  it('exercises italic + bold + colour + position', () => {
    expect([...interpretedCapabilities(rich)].sort()).toEqual([
      'bold',
      'color',
      'italic',
      'position',
    ]);
  });

  it('warns for every capability a target cannot express, across every target', () => {
    for (const target of ALL_TARGETS) {
      const dropped = capabilityReport(rich, [target])[0]!.dropped;
      const { warnings } = normalizeForTarget(rich, target);
      for (const cap of dropped) {
        expect(warnings.some((w) => w.message.includes(cap))).toBe(true);
      }
    }
  });
});
