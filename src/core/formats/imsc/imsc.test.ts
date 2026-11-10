import { describe, expect, it } from 'vitest';
import { parseImsc101, parseImsc11, serializeImsc101, serializeImsc11 } from './imsc';
import { parseTtml, serializeTtml } from '../ttml';
import { parseItt, serializeItt } from '../itt';
import { textLine } from '../../model/cue';
import type { Cue, SubtitleDocument } from '../../model/types';

/**
 * IMSC 1.0.1 / IMSC 1.1 (spec §7 M6, cue-forge-sdv.7): both are named, validated
 * TTML profiles reusing the generic TTML parser/serializer (like Apple iTT).
 * Unlike iTT, IMSC export always synthesizes a `<head>` (percent-only region +
 * style) so every `<p>` references a real, non-dangling region/style — the
 * source `<head>` (if any) is replaced, never passed through.
 */

function doc(cues: Cue[], extra: Partial<SubtitleDocument['metadata']> = {}): SubtitleDocument {
  return { cues, metadata: { sourceFormat: 'ttml', ...extra }, warnings: [] };
}

function oneCue(text = 'Hello world'): Cue[] {
  return [{ index: 1, startMs: 1000, endMs: 4000, lines: [textLine(text)] }];
}

describe('serializeImsc101', () => {
  const out = serializeImsc101(doc(oneCue(), { language: 'en' }));

  it('declares the IMSC 1.0.1 profile designator via ttp:profile', () => {
    expect(out).toContain('ttp:profile="http://www.w3.org/ns/ttml/profile/imsc1/text"');
  });

  it('does not also emit ttp:contentProfiles', () => {
    expect(out).not.toContain('ttp:contentProfiles');
  });

  it('declares media timeBase', () => {
    expect(out).toContain('ttp:timeBase="media"');
  });

  it('carries xml:lang from doc.metadata.language', () => {
    expect(out).toContain('xml:lang="en"');
  });

  it('declares the root container extent in px (the one place px is allowed)', () => {
    expect(out).toContain('tts:extent="1920px 1080px"');
  });

  it('synthesizes a head with a percent-only region, bottom-anchored', () => {
    expect(out).toContain('<region xml:id="r0"');
    expect(out).toContain('tts:origin="10% 10%"');
    expect(out).toContain('tts:extent="80% 80%"');
    expect(out).toContain('tts:displayAlign="after"');
  });

  it('synthesizes a default style', () => {
    expect(out).toContain('<style xml:id="s0"');
  });

  it('every <p> references the synthesized region and style', () => {
    const pTags = out.match(/<p [^>]*>/g) ?? [];
    expect(pTags.length).toBeGreaterThan(0);
    for (const p of pTags) {
      expect(p).toContain('region="r0"');
      expect(p).toContain('style="s0"');
    }
  });

  it('emits px nowhere except the root container extent', () => {
    const withoutRootExtent = out.replace('tts:extent="1920px 1080px"', '');
    expect(withoutRootExtent).not.toMatch(/px/);
  });
});

describe('serializeImsc11', () => {
  const out = serializeImsc11(doc(oneCue(), { language: 'en' }));

  it('declares the IMSC 1.1 profile designator via ttp:contentProfiles', () => {
    expect(out).toContain('ttp:contentProfiles="http://www.w3.org/ns/ttml/profile/imsc1.1/text"');
  });

  it('does not also emit ttp:profile', () => {
    expect(out).not.toContain('ttp:profile=');
  });
});

describe('xml:lang fallback', () => {
  it('emits an empty xml:lang when the document has no known language', () => {
    const out = serializeImsc11(doc(oneCue()));
    expect(out).toContain('xml:lang=""');
  });
});

describe('source head/region replacement (no dangling refs)', () => {
  it('replaces a source region/style ref that would otherwise dangle once the source head is dropped', () => {
    const cue: Cue = {
      index: 1,
      startMs: 0,
      endMs: 1000,
      lines: [textLine('hi')],
      styleRefs: ['source-style'],
      raw: { region: 'source-region' },
    };
    const out = serializeImsc11(doc([cue]));
    expect(out).not.toContain('source-region');
    expect(out).not.toContain('source-style');
    expect(out).toContain('region="r0"');
    expect(out).toContain('style="s0"');
  });

  it('drops a preserved source <head> in favor of the synthesized one', () => {
    const withRaw: SubtitleDocument = {
      cues: oneCue(),
      metadata: {
        sourceFormat: 'ttml',
        raw: {
          ttAttrs: { xmlns: 'http://www.w3.org/ns/ttml' },
          head: {
            tag: 'head',
            attrs: {},
            children: [
              {
                tag: 'styling',
                attrs: {},
                children: [
                  { tag: 'style', attrs: { 'xml:id': 'weird-source-style' }, children: [] },
                ],
              },
            ],
          },
        },
      },
      warnings: [],
    };
    const out = serializeImsc11(withRaw);
    expect(out).not.toContain('weird-source-style');
    expect(out).toContain('<style xml:id="s0"');
  });
});

describe('parseImsc101 / parseImsc11', () => {
  it('parses like generic TTML and relabels sourceFormat', () => {
    const out = serializeImsc101(doc(oneCue(), { language: 'en' }));
    const parsed = parseImsc101(out);
    expect(parsed.metadata.sourceFormat).toBe('imsc101');
    expect(parsed.cues).toHaveLength(1);
  });

  it('parseImsc11 relabels sourceFormat to imsc11', () => {
    const out = serializeImsc11(doc(oneCue(), { language: 'en' }));
    const parsed = parseImsc11(out);
    expect(parsed.metadata.sourceFormat).toBe('imsc11');
  });

  it('round-trips cue count, ms timings, and text through generic parseTtml', () => {
    const source = doc(
      [
        { index: 1, startMs: 1000, endMs: 4000, lines: [textLine('Hello world')] },
        { index: 2, startMs: 5000, endMs: 6500, lines: [textLine('Second')] },
      ],
      { language: 'en' },
    );
    const reparsed = parseTtml(serializeImsc11(source));
    expect(reparsed.cues).toHaveLength(2);
    expect(reparsed.cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [1000, 4000],
      [5000, 6500],
    ]);
    expect(reparsed.cues.map((c) => c.lines[0]!.spans[0]!.text)).toEqual(['Hello world', 'Second']);
  });
});

describe('existing TTML/iTT output is unchanged by the new profile hooks', () => {
  it('serializeTtml output is unaffected (no head/forceStyle/forceRegion options passed)', () => {
    const source = doc(oneCue());
    expect(serializeTtml(source)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xmlns:tts="http://www.w3.org/ns/ttml#styling">
        <body>
          <div>
            <p begin="00:00:01.000" end="00:00:04.000">Hello world</p>
          </div>
        </body>
      </tt>
      "
    `);
  });

  it('serializeItt output is unaffected', () => {
    const source: SubtitleDocument = {
      cues: oneCue(),
      metadata: { sourceFormat: 'itt' },
      warnings: [],
    };
    const out = serializeItt(source);
    expect(out).toContain('ttp:timeBase="smpte"');
    expect(out).toContain('ttp:cellResolution=');
    const reparsed = parseItt(out);
    expect(reparsed.cues).toHaveLength(1);
  });
});
