import { describe, expect, it } from 'vitest';
import type { SubtitleDocument, SubtitleFormat } from '../model/types';
import { parseSrt, serializeSrt } from './srt/srt';
import { parseVtt, serializeVtt } from './vtt/vtt';
import { parseSbv, serializeSbv } from './sbv/sbv';
import { convert } from './convert';

/**
 * Regression for cue-forge-3jz.10: a cue with an interior empty CueLine
 * (spans:[]) must survive serialize → parse without being split into two cues.
 * Such cues do not come from M1 parsers but arise from M2 conversions (e.g. an
 * ASS `a\N\Nb`). Blank-line-delimited formats need a safe encoding for the
 * interior blank (spec §6.3 #2).
 */

function docWithInteriorBlank(format: SubtitleFormat): SubtitleDocument {
  return {
    cues: [
      {
        index: 1,
        startMs: 1000,
        endMs: 2000,
        lines: [{ spans: [{ text: 'a' }] }, { spans: [] }, { spans: [{ text: 'b' }] }],
      },
    ],
    metadata: { sourceFormat: format },
    warnings: [],
  };
}

const CASES = [
  { id: 'srt', serialize: serializeSrt, parse: parseSrt },
  { id: 'vtt', serialize: serializeVtt, parse: parseVtt },
  { id: 'sbv', serialize: serializeSbv, parse: parseSbv },
] as const;

describe('interior empty line survives serialize → parse', () => {
  for (const c of CASES) {
    it(`${c.id} keeps the cue intact (no split)`, () => {
      const doc = docWithInteriorBlank(c.id);
      const back = c.parse(c.serialize(doc));
      expect(back.cues).toHaveLength(1);
      expect(back.cues[0]!.lines).toEqual(doc.cues[0]!.lines);
    });
  }
});

describe('ASS interior \\N\\N converts without corrupting the cue', () => {
  const ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a\\N\\Nb
`;

  for (const to of ['srt', 'vtt', 'sbv'] as const) {
    it(`ass → ${to} preserves a single cue with three lines`, () => {
      const out = convert(ASS, 'ass', to);
      const back = CASES.find((c) => c.id === to)!.parse(out.text);
      expect(back.cues).toHaveLength(1);
      expect(back.cues[0]!.lines.map((l) => l.spans.map((s) => s.text).join(''))).toEqual([
        'a',
        '',
        'b',
      ]);
    });
  }
});
