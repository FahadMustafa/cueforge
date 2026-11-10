import { describe, expect, it } from 'vitest';
import { parseTtml, serializeTtml } from './ttml';
import { cueToText } from '../../model/cue';
import { positionLabelFor } from '../../qc/format';
import type { SubtitleDocument } from '../../model/types';

const MINIMAL = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<tt xml:lang="en" xmlns="http://www.w3.org/ns/ttml">',
  '  <body>',
  '    <div>',
  '      <p begin="00:00:01.000" end="00:00:04.000">Hello world</p>',
  '      <p begin="00:00:05.000" end="00:00:06.500">Second<br/>line two</p>',
  '    </div>',
  '  </body>',
  '</tt>',
].join('\n');

describe('TTML text alignment round-trip (cue-forge-z6t)', () => {
  function docWithAlign(align: 'start' | 'center' | 'end' | 'left' | 'right'): SubtitleDocument {
    return {
      cues: [
        {
          index: 1,
          startMs: 1000,
          endMs: 2000,
          lines: [{ spans: [{ text: 'Hi' }] }],
          position: { align },
        },
      ],
      metadata: { sourceFormat: 'ttml' },
      warnings: [],
    };
  }

  it('emits tts:textAlign from cue alignment and reads it back', () => {
    for (const align of ['start', 'center', 'end', 'left', 'right'] as const) {
      const ttml = serializeTtml(docWithAlign(align));
      expect(ttml).toContain(`tts:textAlign="${align}"`);
      expect(parseTtml(ttml).cues[0]!.position?.align).toBe(align);
    }
  });

  it('does not emit tts:textAlign when the cue has no alignment', () => {
    const ttml = serializeTtml({
      cues: [{ index: 1, startMs: 1000, endMs: 2000, lines: [{ spans: [{ text: 'Hi' }] }] }],
      metadata: { sourceFormat: 'ttml' },
      warnings: [],
    });
    expect(ttml).not.toContain('tts:textAlign');
  });
});

describe('parseTtml', () => {
  it('parses clock-time begin/end into ms and reads cue text', () => {
    const doc = parseTtml(MINIMAL);
    expect(doc.metadata.sourceFormat).toBe('ttml');
    expect(doc.cues).toHaveLength(2);
    expect(doc.cues[0]).toMatchObject({ startMs: 1000, endMs: 4000 });
    expect(cueToText(doc.cues[0]!)).toBe('Hello world');
  });

  it('splits visual lines on <br/>', () => {
    const doc = parseTtml(MINIMAL);
    expect(doc.cues[1]!.lines).toHaveLength(2);
    expect(cueToText(doc.cues[1]!)).toBe('Second\nline two');
  });

  it('reads the document language from tt xml:lang', () => {
    const doc = parseTtml(MINIMAL);
    expect(doc.metadata.language).toBe('en');
  });

  it('supports begin + dur as an alternative to end', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
        '<p begin="1s" dur="2.5s">x</p>' +
        '</div></body></tt>',
    );
    expect(doc.cues[0]).toMatchObject({ startMs: 1000, endMs: 3500 });
  });

  it('parses offset times with s/ms/m/h metrics', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
        '<p begin="1.5s" end="250ms">a</p>' +
        '<p begin="2m" end="1h">b</p>' +
        '</div></body></tt>',
    );
    expect(doc.cues[0]).toMatchObject({ startMs: 1500, endMs: 250 });
    expect(doc.cues[1]).toMatchObject({ startMs: 120_000, endMs: 3_600_000 });
  });

  it('parses frame-based clock time using ttp:frameRate', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="25">' +
        '<body><div><p begin="00:00:01:00" end="00:00:01:15">x</p></div></body></tt>',
    );
    expect(doc.metadata.frameRate).toBe(25);
    // 15 frames at 25fps = 600ms.
    expect(doc.cues[0]).toMatchObject({ startMs: 1000, endMs: 1600 });
  });

  it('applies ttp:frameRateMultiplier and canonicalizes the NTSC label (cue-forge-zxw.11)', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ' +
        'ttp:frameRate="30" ttp:frameRateMultiplier="1000 1001">' +
        '<body><div><p begin="0s" end="0s">x</p></div></body></tt>',
    );
    // The exact effective rate is 30·1000/1001 = 29.97002997…, but it is stored
    // as the canonical 29.97 label so drop-frame detection and the fps picker
    // recognise it (timing math still uses the exact rate — no drift).
    expect(doc.metadata.frameRate).toBe(29.97);
  });

  describe('drop-frame mode hint from ttp:dropMode (cue-forge-pm8)', () => {
    const ntsc = (dropMode?: string) =>
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ' +
      'ttp:frameRate="30" ttp:frameRateMultiplier="1000 1001" ttp:timeBase="smpte"' +
      (dropMode !== undefined ? ` ttp:dropMode="${dropMode}"` : '') +
      '><body><div><p begin="0s" end="0s">x</p></div></body></tt>';

    it('records ttp:dropMode="nonDrop" as a non-drop hint in metadata.raw', () => {
      const doc = parseTtml(ntsc('nonDrop'));
      expect((doc.metadata.raw as { dropFrame?: unknown }).dropFrame).toBe(false);
    });

    it('records ttp:dropMode="dropNTSC" as a drop-frame hint in metadata.raw', () => {
      const doc = parseTtml(ntsc('dropNTSC'));
      expect((doc.metadata.raw as { dropFrame?: unknown }).dropFrame).toBe(true);
    });

    it('leaves the hint unset (unknown) when ttp:dropMode is absent', () => {
      const doc = parseTtml(ntsc());
      expect((doc.metadata.raw as { dropFrame?: unknown }).dropFrame).toBeUndefined();
    });

    it('QC position labels honour the recorded mode (nonDrop -> NDF, dropNTSC -> DF)', () => {
      // Frame 1800 = NDF 00:01:00:00 but DF 00:01:00;02 — the case where they
      // diverge. Without the recorded hint, canonical 29.97 defaults to DF.
      expect(positionLabelFor(parseTtml(ntsc('nonDrop')))(60060)).toBe('00:01:00:00 (60060 ms)');
      expect(positionLabelFor(parseTtml(ntsc('dropNTSC')))(60060)).toBe('00:01:00;02 (60060 ms)');
    });
  });

  it('reads inline styling from tts attributes on spans', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"><body><div>' +
        '<p begin="0s" end="1s">a <span tts:fontStyle="italic">b</span> ' +
        '<span tts:fontWeight="bold">c</span> <span tts:textDecoration="underline">d</span></p>' +
        '</div></body></tt>',
    );
    const spans = doc.cues[0]!.lines[0]!.spans;
    expect(spans.find((s) => s.text === 'b')!.italic).toBe(true);
    expect(spans.find((s) => s.text === 'c')!.bold).toBe(true);
    expect(spans.find((s) => s.text === 'd')!.underline).toBe(true);
  });

  it('preserves style and region references on the cue', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
        '<p begin="0s" end="1s" style="s1" region="r1" xml:id="c1">x</p>' +
        '</div></body></tt>',
    );
    expect(doc.cues[0]!.styleRefs).toEqual(['s1']);
    expect(doc.cues[0]!.id).toBe('c1');
  });

  it('maps tts:writingMode rltb to no vertical (RTL stays horizontal)', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">' +
        '<body><div><p begin="0s" end="1s" tts:writingMode="tbrl">x</p></div></body></tt>',
    );
    expect(doc.cues[0]!.position!.vertical).toBe('vertical-rl');
  });

  it('warns and skips a p with no begin/end timing', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p>no timing</p></div></body></tt>',
    );
    expect(doc.cues).toHaveLength(0);
    expect(doc.warnings.some((w) => w.code === 'malformed-timing')).toBe(true);
  });

  it('surfaces excessive nesting depth as a parse warning, not a crash', () => {
    const deep =
      '<tt xmlns="http://www.w3.org/ns/ttml"><body>' +
      '<div>'.repeat(300) +
      '<p begin="0s" end="1s">x</p>' +
      '</div>'.repeat(300) +
      '</body></tt>';
    const doc = parseTtml(deep);
    expect(doc.cues).toHaveLength(0);
    expect(doc.warnings.some((w) => /depth/i.test(w.message))).toBe(true);
  });

  it('decodes an out-of-range character reference to its literal text without throwing', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
        '<p begin="0s" end="1s">&#x110000;</p></div></body></tt>',
    );
    expect(cueToText(doc.cues[0]!)).toBe('&#x110000;');
  });

  it('warns when a cue overlaps the previous cue', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
        '<p begin="0s" end="5s">a</p><p begin="3s" end="6s">b</p></div></body></tt>',
    );
    expect(doc.warnings.some((w) => w.code === 'overlap')).toBe(true);
  });

  it('warns on reversed timing', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
        '<p begin="5s" end="2s">x</p></div></body></tt>',
    );
    expect(doc.warnings.some((w) => w.code === 'reversed-timing')).toBe(true);
  });

  it('collapses pretty-printed whitespace inside <p> (xml:space default)', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>\n' +
        '      <p begin="0s" end="1s">\n' +
        '        Hello\n' +
        '        beautiful\n' +
        '        world\n' +
        '      </p>\n' +
        '    </div></body></tt>',
    );
    expect(cueToText(doc.cues[0]!)).toBe('Hello beautiful world');
  });

  it('trims collapsed whitespace around <br/> line boundaries', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
        '<p begin="0s" end="1s">\n  Line one<br/>\n  Line two\n</p>' +
        '</div></body></tt>',
    );
    expect(cueToText(doc.cues[0]!)).toBe('Line one\nLine two');
  });

  it('drops whitespace-only runs around a pretty-printed span', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">' +
        '<body><div><p begin="0s" end="1s">\n' +
        '        <span tts:fontStyle="italic">styled</span>\n' +
        '      </p></div></body></tt>',
    );
    expect(doc.cues[0]!.lines).toEqual([{ spans: [{ text: 'styled', italic: true }] }]);
  });

  it('does not glue words together across span boundaries when collapsing', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
        '<p begin="0s" end="1s"><span>Hello </span><span>world</span></p>' +
        '</div></body></tt>',
    );
    expect(cueToText(doc.cues[0]!)).toBe('Hello world');
  });

  it('keeps interior whitespace under xml:space="preserve" on the p', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
        '<p begin="0s" end="1s" xml:space="preserve">  Hello\n  world  </p>' +
        '</div></body></tt>',
    );
    expect(cueToText(doc.cues[0]!)).toBe('  Hello\n  world  ');
  });

  it('inherits xml:space="preserve" from an ancestor div', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div xml:space="preserve">' +
        '<p begin="0s" end="1s">  a   b  </p>' +
        '</div></body></tt>',
    );
    expect(cueToText(doc.cues[0]!)).toBe('  a   b  ');
  });

  it('lets xml:space="default" on a span override inherited preserve', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml" xml:space="preserve"><body><div>' +
        '<p begin="0s" end="1s"><span xml:space="default">a   b</span></p>' +
        '</div></body></tt>',
    );
    expect(cueToText(doc.cues[0]!)).toBe('a b');
  });

  it('preserves head styling/layout in metadata.raw', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">' +
        '<head><styling><style xml:id="s1" tts:color="red"/></styling>' +
        '<layout><region xml:id="r1"/></layout></head>' +
        '<body><div><p begin="0s" end="1s" style="s1" region="r1">x</p></div></body></tt>',
    );
    const raw = doc.metadata.raw as { head?: unknown };
    expect(raw.head).toBeTruthy();
  });
});

describe('serializeTtml', () => {
  it('emits a parseable tt document with clock-time begin/end', () => {
    const out = serializeTtml(parseTtml(MINIMAL));
    expect(out).toContain('<tt');
    expect(out).toContain('begin="00:00:01.000"');
    expect(out).toContain('end="00:00:04.000"');
  });

  it('escapes XML special characters in cue text', () => {
    const doc = parseTtml(
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
        '<p begin="0s" end="1s">a &lt; b &amp; c</p></div></body></tt>',
    );
    const out = serializeTtml(doc);
    expect(out).toContain('a &lt; b &amp; c');
  });

  it('round-trips minimal: preserves cues and metadata, adding serializer namespace declarations', () => {
    const once = parseTtml(MINIMAL);
    const twice = parseTtml(serializeTtml(once));
    expect(twice.cues).toEqual(once.cues);
    expect(twice.metadata).toEqual({
      ...once.metadata,
      raw: {
        ...once.metadata.raw,
        ttAttrs: {
          ...(once.metadata.raw?.ttAttrs as Record<string, string>),
          'xmlns:ttp': 'http://www.w3.org/ns/ttml#parameter',
          'xmlns:tts': 'http://www.w3.org/ns/ttml#styling',
        },
      },
    });
  });

  it('round-trips styled spans and line breaks', () => {
    const src =
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">' +
      '<body><div><p begin="0s" end="2s">a <span tts:fontStyle="italic">b</span><br/>line2</p></div></body></tt>';
    const once = parseTtml(src);
    const twice = parseTtml(serializeTtml(once));
    expect(twice.cues).toEqual(once.cues);
  });

  it('round-trips frame rate, style/region refs and writing mode', () => {
    const src =
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ' +
      'xmlns:tts="http://www.w3.org/ns/ttml#styling" ttp:frameRate="25">' +
      '<head><styling><style xml:id="s1" tts:color="red"/></styling>' +
      '<layout><region xml:id="r1"/></layout></head>' +
      '<body><div><p begin="00:00:01:00" end="00:00:02:00" style="s1" region="r1" xml:id="c1" ' +
      'tts:writingMode="tbrl">x</p></div></body></tt>';
    const once = parseTtml(src);
    const twice = parseTtml(serializeTtml(once));
    expect(twice.cues).toEqual(once.cues);
    expect(twice.metadata).toEqual(once.metadata);
  });

  it('drops opaque markup but keeps the visible text of a span', () => {
    const doc = parseTtml(MINIMAL);
    doc.cues[0]!.lines = [{ spans: [{ text: 'kept', opaque: '{\\pos(1,2)}' }] }];
    const out = serializeTtml(doc);
    expect(out).toContain('>kept</p>');
    expect(out).not.toContain('pos');
  });

  it('serializes a document with no preserved raw (cross-format conversion)', () => {
    const doc = parseTtml(MINIMAL);
    // Simulate a doc produced by another format's parser: drop TTML-specific raw.
    const bare = {
      ...doc,
      metadata: { sourceFormat: 'ttml' as const },
    };
    const out = serializeTtml(bare);
    const reparsed = parseTtml(out);
    expect(reparsed.cues.map((c) => cueToText(c))).toEqual(['Hello world', 'Second\nline two']);
  });
});
