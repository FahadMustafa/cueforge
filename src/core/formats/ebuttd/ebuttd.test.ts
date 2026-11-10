// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseEbuttd, serializeEbuttd } from './ebuttd';
import { parseXml, type XmlElement } from '../ttml/xml';
import type { StyledSpan, SubtitleDocument } from '../../model/types';

/**
 * EBU-TT-D (EBU Tech 3380) round-trip + structural-conformance tests.
 *
 * The load-bearing constraint (Tech 3380 §12 "referential styling", conformance
 * items E35/E36) is that `tts:*` presentation attributes may appear ONLY on
 * `<style>`/`<region>` elements — never inline on content (`<p>`/`<span>`). Plain
 * `serializeTtml` violates this (it writes `tts:fontStyle` on `<span>`), so these
 * tests pin the referential-styling behaviour the EBU-TT-D codec adds on top.
 */

/** Strip a namespace prefix: `tts:color` → `color`, `xml:id` → `id`. */
function local(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/** Look up an attribute by local name, ignoring namespace prefix. */
function attrByLocal(el: XmlElement, localName: string): string | undefined {
  for (const key of Object.keys(el.attrs)) if (local(key) === localName) return el.attrs[key];
  return undefined;
}

/** Every element in the tree, depth-first including the root. */
function allElements(el: XmlElement, out: XmlElement[] = []): XmlElement[] {
  out.push(el);
  for (const c of el.children) if (typeof c !== 'string') allElements(c, out);
  return out;
}

/** First span anywhere in the document whose text matches exactly. */
function findSpan(doc: SubtitleDocument, text: string): StyledSpan | undefined {
  for (const cue of doc.cues)
    for (const line of cue.lines)
      for (const span of line.spans) if (span.text === text) return span;
  return undefined;
}

/** Visible text of a cue: span text per line, lines joined by newline. */
function plainText(doc: SubtitleDocument): string[] {
  return doc.cues.map((cue) =>
    cue.lines.map((l) => l.spans.map((s) => s.text).join('')).join('\n'),
  );
}

/** A 2-cue document exercising italic/bold/underline/color spans, opaque + voice degradation. */
function sampleDoc(): SubtitleDocument {
  return {
    cues: [
      {
        index: 1,
        startMs: 1000,
        endMs: 3500,
        lines: [
          { spans: [{ text: 'Hello ' }, { text: 'world', italic: true }] },
          { spans: [{ text: 'green', color: '#00FF00' }] },
        ],
      },
      {
        index: 2,
        startMs: 4000,
        endMs: 6000,
        lines: [
          {
            spans: [
              { text: 'bold', bold: true },
              { text: ' and ' },
              { text: 'under', underline: true },
            ],
          },
          {
            spans: [
              { text: 'opaque ', opaque: '<b>' },
              { text: 'voiced', voice: 'Narrator' },
            ],
          },
        ],
      },
    ],
    metadata: { sourceFormat: 'ttml', language: 'en' },
    warnings: [],
  };
}

describe('EBU-TT-D round-trip', () => {
  it('preserves cue count, ms timings, text, and referential span styling', () => {
    const source = sampleDoc();
    const back = parseEbuttd(serializeEbuttd(source));

    expect(back.cues).toHaveLength(2);
    expect(back.cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [1000, 3500],
      [4000, 6000],
    ]);
    expect(plainText(back)).toEqual(['Hello world\ngreen', 'bold and under\nopaque voiced']);

    // Span styling survives via the head <style> references, not inline tts.
    expect(findSpan(back, 'world')?.italic).toBe(true);
    expect(findSpan(back, 'green')?.color).toBe('#00FF00');
    expect(findSpan(back, 'bold')?.bold).toBe(true);
    expect(findSpan(back, 'under')?.underline).toBe(true);
  });

  it('sets metadata.sourceFormat to "ebuttd"', () => {
    expect(parseEbuttd(serializeEbuttd(sampleDoc())).metadata.sourceFormat).toBe('ebuttd');
  });

  it('carries the source language onto xml:lang', () => {
    const xml = serializeEbuttd(sampleDoc());
    expect(attrByLocal(parseXml(xml), 'lang')).toBe('en');
  });
});

describe('EBU-TT-D structural conformance (Tech 3380)', () => {
  const xml = serializeEbuttd(sampleDoc());
  const tt = parseXml(xml);
  const els = allElements(tt);

  it('sets ttp:timeBase="media" on <tt> (Tech 3380 §11.1, media is the only allowed value)', () => {
    expect(attrByLocal(tt, 'timeBase')).toBe('media');
  });

  it('declares the ebuttm:conformsToStandard distribution URN', () => {
    expect(xml).toContain(
      '<ebuttm:conformsToStandard>urn:ebu:tt:distribution:2014</ebuttm:conformsToStandard>',
    );
  });

  it('has at least one <region> with percentage layout', () => {
    const regions = els.filter((e) => local(e.tag) === 'region');
    expect(regions.length).toBeGreaterThanOrEqual(1);
    for (const r of regions) {
      expect(attrByLocal(r, 'origin')).toMatch(/%/);
      expect(attrByLocal(r, 'extent')).toMatch(/%/);
    }
  });

  it('every <p> references a region and has begin/end', () => {
    const ps = els.filter((e) => local(e.tag) === 'p');
    expect(ps.length).toBe(2);
    for (const p of ps) {
      expect(attrByLocal(p, 'begin')).toBeDefined();
      expect(attrByLocal(p, 'end')).toBeDefined();
      expect(attrByLocal(p, 'region')).toBeDefined();
    }
  });

  it('emits tts:* attributes ONLY on <style>/<region>, never on content (E35/E36)', () => {
    const contentTags = new Set(['body', 'div', 'p', 'span']);
    for (const el of els) {
      if (!contentTags.has(local(el.tag))) continue;
      const ttsAttrs = Object.keys(el.attrs).filter((k) => k.startsWith('tts:'));
      expect(ttsAttrs, `<${el.tag}> must not carry inline tts styling`).toEqual([]);
    }
    // ...and the styling really is expressed: at least one <style> carries tts.
    const styled = els.some(
      (e) => local(e.tag) === 'style' && Object.keys(e.attrs).some((k) => k.startsWith('tts:')),
    );
    expect(styled).toBe(true);
  });
});

describe('EBU-TT-D parse edge cases', () => {
  it('parses an unstyled EBU-TT-D document (no head <style> refs to resolve)', () => {
    const xml = serializeEbuttd({
      cues: [{ index: 1, startMs: 0, endMs: 1000, lines: [{ spans: [{ text: 'plain' }] }] }],
      metadata: { sourceFormat: 'ttml' },
      warnings: [],
    });
    const back = parseEbuttd(xml);
    expect(back.cues).toHaveLength(1);
    expect(back.metadata.sourceFormat).toBe('ebuttd');
  });

  it('surfaces malformed XML as a warning, still labelled ebuttd', () => {
    const back = parseEbuttd('<tt><body><div><p>unclosed');
    expect(back.metadata.sourceFormat).toBe('ebuttd');
    expect(back.warnings.length).toBeGreaterThan(0);
  });
});
