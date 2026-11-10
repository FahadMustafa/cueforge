import { describe, expect, it } from 'vitest';
import { parseItt, serializeItt } from './itt';
import { parseTtml } from '../ttml';
import { textLine } from '../../model/cue';
import { frameDurationMs } from '../../timing/timecode';
import type { Cue, SubtitleDocument } from '../../model/types';

/**
 * Apple iTunes Timed Text (.itt) is a constrained TTML profile, so the codec
 * reuses the TTML parser/serializer. These cases validate against a realistic
 * iTT sample (head with styling/layout, a region, SMPTE frame timecodes) rather
 * than reading the spec, and assert the export emits the iTT profile.
 */
const REAL_ITT = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ttp:timeBase="media" ttp:frameRate="25" tts:extent="100% 100%" xml:lang="en">
  <head>
    <styling>
      <style xml:id="normal" tts:color="white" tts:fontStyle="normal" tts:fontWeight="normal"/>
      <style xml:id="emphasis" tts:fontStyle="italic"/>
    </styling>
    <layout>
      <region xml:id="bottom" tts:origin="10% 80%" tts:extent="80% 20%" tts:displayAlign="after" tts:textAlign="center"/>
    </layout>
  </head>
  <body region="bottom">
    <div>
      <p begin="00:00:01:00" end="00:00:04:00" style="normal">Hello world</p>
      <p begin="00:00:05:12" end="00:00:06:13" style="normal">Second line<br/>and a third</p>
      <p begin="00:00:08:00" end="00:00:10:00"><span style="emphasis" tts:fontStyle="italic">Italic</span> then plain</p>
    </div>
  </body>
</tt>
`;

const rawless = (doc: SubtitleDocument): SubtitleDocument => ({
  cues: doc.cues,
  metadata: { sourceFormat: 'itt' },
  warnings: [],
});

describe('parseItt (Apple iTunes Timed Text)', () => {
  it('parses a real iTT sample: cues, SMPTE frame timecodes, lines, and styling', () => {
    const doc = parseItt(REAL_ITT);
    expect(doc.metadata.sourceFormat).toBe('itt');
    expect(doc.metadata.language).toBe('en');
    expect(doc.cues).toHaveLength(3);
    // 25 fps: 00:00:01:00 = 1000 ms; 00:00:05:12 = 5000 + 12/25*1000 = 5480 ms.
    expect(doc.cues[0]!.startMs).toBe(1000);
    expect(doc.cues[0]!.endMs).toBe(4000);
    expect(doc.cues[1]!.startMs).toBe(5480);
    expect(doc.cues[1]!.lines).toHaveLength(2); // <br/> splits the visual lines
    expect(doc.cues[2]!.lines[0]!.spans.some((s) => s.italic)).toBe(true);
  });
});

describe('serializeItt', () => {
  it('emits the iTT TTML profile (SMPTE timeBase + fixed cellResolution)', () => {
    const out = serializeItt(rawless(parseItt(REAL_ITT)));
    expect(out).toContain('<tt ');
    expect(out).toContain('http://www.w3.org/ns/ttml');
    expect(out).toContain('ttp:timeBase="smpte"');
    expect(out).toContain('ttp:cellResolution=');
  });

  it('round-trips cues, timing, and visible text through the canonical model', () => {
    const doc = parseItt(REAL_ITT);
    const reparsed = parseItt(serializeItt(doc));
    expect(reparsed.cues.map((c) => [c.startMs, c.endMs])).toEqual(
      doc.cues.map((c) => [c.startMs, c.endMs]),
    );
    expect(reparsed.cues.map((c) => c.lines.flatMap((l) => l.spans.map((s) => s.text)))).toEqual(
      doc.cues.map((c) => c.lines.flatMap((l) => l.spans.map((s) => s.text))),
    );
    expect(reparsed.cues[2]!.lines[0]!.spans.some((s) => s.italic)).toBe(true);
  });

  it('produces output the generic TTML parser also accepts (iTT is a TTML profile)', () => {
    const ttml = parseTtml(serializeItt(rawless(parseItt(REAL_ITT))));
    expect(ttml.cues).toHaveLength(3);
  });
});

/**
 * cue-forge-sdv.13: Apple iTunes/FCP/Compressor ingest expects the SMPTE time
 * model — `ttp:timeBase="smpte"`, an explicit `ttp:frameRate` (with a
 * frameRateMultiplier + dropMode for NTSC rates), and frame-based `HH:MM:SS:FF`
 * timecodes. The old serializer reused the media-clock TTML path (ms clock, no
 * frameRate), a known ingest-rejection cause.
 */
function ittDoc(startMs: number, endMs: number, frameRate?: number): SubtitleDocument {
  const cue: Cue = { index: 1, startMs, endMs, lines: [textLine('Hi')] };
  const metadata: SubtitleDocument['metadata'] = { sourceFormat: 'itt' };
  if (frameRate !== undefined) metadata.frameRate = frameRate;
  return { cues: [cue], metadata, warnings: [] };
}

describe('serializeItt SMPTE timing (cue-forge-sdv.13)', () => {
  it('declares smpte timeBase and a default 24 fps frame rate when the doc has none', () => {
    const out = serializeItt(ittDoc(1000, 4000));
    expect(out).toContain('ttp:timeBase="smpte"');
    expect(out).toContain('ttp:frameRate="24"');
  });

  it('emits frame-based HH:MM:SS:FF timecodes, not millisecond clock values', () => {
    const out = serializeItt(ittDoc(1000, 4000));
    expect(out).toContain('begin="00:00:01:00"');
    expect(out).toContain('end="00:00:04:00"');
    expect(out).not.toMatch(/begin="00:00:01\.000"/);
  });

  it('honours the document frame rate for both the attr and the FF field', () => {
    // 25 fps: 5480 ms = 5 s + 12/25 s → frame 12.
    const out = serializeItt(ittDoc(5480, 6000, 25));
    expect(out).toContain('ttp:frameRate="25"');
    expect(out).toContain('begin="00:00:05:12"');
  });

  it('adds frameRateMultiplier for the 23.976 NTSC rate', () => {
    const out = serializeItt(ittDoc(0, 1000, 23.976));
    expect(out).toContain('ttp:frameRate="24"');
    expect(out).toContain('ttp:frameRateMultiplier="1000 1001"');
  });

  it('marks 29.97 as drop-frame (multiplier + dropNTSC) with colon-separated frames', () => {
    const out = serializeItt(ittDoc(0, 1000, 29.97));
    expect(out).toContain('ttp:frameRate="30"');
    expect(out).toContain('ttp:frameRateMultiplier="1000 1001"');
    expect(out).toContain('ttp:dropMode="dropNTSC"');
    // TTML clock-time uses ':' for the frames field; drop is signalled by dropMode.
    expect(out).not.toContain(';');
  });

  it('round-trips a frame-aligned doc through parse → serialize → parse', () => {
    const doc = ittDoc(5480, 6520, 25);
    const reparsed = parseItt(serializeItt(doc));
    expect(reparsed.cues.map((c) => [c.startMs, c.endMs])).toEqual([[5480, 6520]]);
    expect(reparsed.metadata.frameRate).toBe(25);
  });
});

/**
 * cue-forge-sdv.17: closing the 29.97 drop-frame gap. serializeItt already emits
 * dropNTSC drop-frame timecodes; the parser must decode them via ttp:dropMode
 * (the '\:'-separated frames field can't reveal drop on its own), and the
 * serializer must recognise the parser's exact NTSC rate (30·1000/1001) as
 * canonical 29.97 so a parsed drop-frame doc re-serializes identically.
 */
describe('iTT drop-frame decode (cue-forge-sdv.17)', () => {
  const DF_ITT = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:timeBase="smpte" ttp:frameRate="30" ttp:frameRateMultiplier="1000 1001" ttp:dropMode="dropNTSC">
  <body><div>
    <p begin="00:10:00:00" end="00:10:01:00">x</p>
  </div></body>
</tt>`;

  it('decodes a drop-frame timecode via ttp:dropMode (10:00:00 resyncs to wall clock)', () => {
    // Drop-frame realigns to real time every 10 min, so 00:10:00:00 ≈ 600 s.
    // A media/non-drop read would give a flat 600000; drop decoding gives 599999.
    const doc = parseItt(DF_ITT);
    expect(doc.cues[0]!.startMs).toBe(599999);
  });

  it('re-serializes a parsed 29.97 drop-frame doc identically (idempotent)', () => {
    const out = serializeItt(ittDoc(65432, 70000, 29.97));
    expect(out).toContain('ttp:dropMode="dropNTSC"');
    // Parser reads the frames back to what was written, so a second pass is stable.
    expect(serializeItt(parseItt(out))).toBe(out);
  });
});

/**
 * cue-forge-drt.3: a SMPTE non-drop timecode at a fractional NTSC rate counts
 * frames at the nominal integer rate, so the HH:MM:SS fields are a frame-count
 * display, NOT wall-clock seconds. The old parser read them as media-clock
 * seconds (ignoring ttp:timeBase="smpte"), losing 0.1% — ~3.6 s/hour — and was
 * non-idempotent: every open→save of a 23.976/29.97-NDF iTT drifted further.
 */
describe('SMPTE non-drop NTSC timing (cue-forge-drt.3)', () => {
  it('decodes a 29.97 non-drop SMPTE timecode as frame-counted, not wall-clock', () => {
    const itt = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:timeBase="smpte" ttp:frameRate="30" ttp:frameRateMultiplier="1000 1001">
  <body><div><p begin="01:00:00:00" end="01:00:01:00">x</p></div></body>
</tt>`;
    // 1h of frames (3600·30 = 108000) on the exact 30000/1001 timebase = 3,603,600 ms,
    // not a flat 3,600,000 (the media-clock misread the old parser produced).
    expect(parseItt(itt).cues[0]!.startMs).toBe(3_603_600);
  });

  it('emits and reads back a 23.976 one-hour begin timecode as 00:59:56:10', () => {
    const out = serializeItt(ittDoc(3_600_000, 3_601_000, 23.976));
    expect(out).toContain('begin="00:59:56:10"');
    // Decodes back near 3.6M (frame-quantised), not the ~3.5964M media misread.
    expect(parseItt(out).cues[0]!.startMs).toBeGreaterThan(3_599_000);
  });

  it('round-trips a 23.976 one-hour cue within a frame and is idempotent', () => {
    const doc = ittDoc(3_600_000, 3_601_000, 23.976);
    const out1 = serializeItt(doc);
    const reparsed = parseItt(out1);
    const oneFrame = Math.ceil(frameDurationMs(23.976));
    expect(Math.abs(reparsed.cues[0]!.startMs - 3_600_000)).toBeLessThanOrEqual(oneFrame);
    // Re-serialising the reparsed doc yields the identical timecodes (no drift).
    expect(serializeItt(reparsed)).toBe(out1);
  });
});

/**
 * cue-forge-zxw.1: the SMPTE override must OWN the whole ttp: timing set. A
 * source whose raw <tt> still carries stale NTSC timing attrs (e.g. after a
 * frame-rate conversion away from 23.976/29.97) must not leak the source's
 * frameRateMultiplier/dropMode into a non-NTSC export — that emits contradictory
 * parameters an ingest pipeline rejects.
 */
describe('serializeItt clears stale source timing params (cue-forge-zxw.1)', () => {
  const ntscSourced = (frameRate: number): SubtitleDocument => ({
    cues: [{ index: 1, startMs: 1000, endMs: 4000, lines: [textLine('Hi')] }],
    metadata: {
      sourceFormat: 'itt',
      frameRate,
      raw: {
        ttAttrs: {
          xmlns: 'http://www.w3.org/ns/ttml',
          'xmlns:ttp': 'http://www.w3.org/ns/ttml#parameter',
          'ttp:timeBase': 'media',
          'ttp:frameRate': '30',
          'ttp:frameRateMultiplier': '1000 1001',
          'ttp:dropMode': 'dropNTSC',
        },
      },
    },
    warnings: [],
  });

  it('does not leak NTSC multiplier/dropMode into a 25 fps export', () => {
    const out = serializeItt(ntscSourced(25));
    expect(out).toContain('ttp:timeBase="smpte"');
    expect(out).toContain('ttp:frameRate="25"');
    expect(out).not.toContain('ttp:frameRateMultiplier');
    expect(out).not.toContain('ttp:dropMode');
  });
});

/**
 * cue-forge-zxw.1: a `frameRate=30 + dropMode` source (nominal 30, drop-frame
 * labelled, no multiplier) must round-trip within one frame. The old serializer
 * derived the drop-frame formatter flag from SMPTE_RATES membership (false at 30)
 * while a stale/emitted dropMode still labelled the <tt> as drop, so the non-drop
 * timecodes were re-read as drop-frame and drifted ~2 frames (67 ms).
 */
describe('iTT 30fps + dropMode round-trips within one frame (cue-forge-zxw.1)', () => {
  const df30 = (tc: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:timeBase="smpte" ttp:frameRate="30" ttp:dropMode="dropNTSC">
  <body><div><p begin="${tc}" end="${tc}">x</p></div></body>
</tt>`;

  it('keeps each cue within one frame across parse → serialize → parse', () => {
    const oneFrame = Math.ceil(frameDurationMs(30)); // ~34 ms
    for (const tc of ['00:00:59:00', '00:00:59:02', '00:01:30:15', '00:05:00:00', '00:09:59:29']) {
      const first = parseItt(df30(tc));
      const second = parseItt(serializeItt(first));
      const drift = Math.abs(second.cues[0]!.startMs - first.cues[0]!.startMs);
      expect(drift).toBeLessThanOrEqual(oneFrame);
    }
  });
});
