import type { CueLine, StyledSpan, SubtitleDocument } from '../../model/types';
import {
  escapeAttr,
  escapeText,
  parseTtml,
  parseXml,
  serializeTtmlProfile,
  serializeXml,
  XmlError,
  type XmlElement,
} from '../ttml';

/**
 * EBU-TT-D (EBU Tech 3380) — the EBU's TTML profile for distributing subtitles
 * over IP networks (cue-forge-sdv.9). Like Apple iTT and IMSC, an EBU-TT-D file
 * *is* valid TTML, so this codec reuses the generic TTML engine rather than a
 * second parser/serializer.
 *
 * Conformance constraints asserted below are taken from EBU Tech 3380 v1.0
 * (https://tech.ebu.ch/publications/tech3380, PDF tech3380v1_0.pdf) and the EBU
 * ebu-tt-live-toolkit conformance table
 * (https://github.com/ebu/ebu-tt-live-toolkit/wiki/EBU-Tech-3350,-3370-&-3380-conformance-requirements):
 *   - `ttp:timeBase` SHALL be `"media"` — the only permitted value (E6).
 *   - `ttp:cellResolution` should be set explicitly; the default is `"32 15"` (E14).
 *   - `xml:lang` is REQUIRED on `<tt>` (E17); an unknown language is a spec-valid `""`.
 *   - `<head>` carries `<metadata>` with an `ebuttm:conformsToStandard`
 *     (namespace `urn:ebu:tt:metadata`) plus `<styling>` and a `<layout>` with
 *     at least one `<region>` whose `tts:origin`/`tts:extent` are PERCENTAGES
 *     (E43/E60), with `tts:displayAlign` and `tts:overflow` (E45/overflow-visible).
 *   - **Referential styling only** (E35/E36, §12): `tts:*` presentation
 *     attributes may appear ONLY on `<style>`/`<region>` (plus the root `<tt>`,
 *     which legitimately carries `tts:extent` for the reference video size),
 *     never inline on content (`<p>`/`<span>`). Content references styles via
 *     the `style` attribute.
 *   - Colours SHALL be `#RRGGBB`/`#RRGGBBAA` hex (E54).
 *   - `begin`/`end` on `<p>` are media-clock times `HH:MM:SS.mmm`.
 *
 * The referential-styling rule is exactly what plain `serializeTtml` violates
 * (it writes `tts:fontStyle` etc. on `<span>`s), so serialization here COLLECTS
 * the distinct span-style combinations the document uses, emits one `<style>`
 * per combo in `<head><styling>`, and references them from the spans via the
 * `serializeTtmlProfile` `serializeContent` hook (chosen over building an
 * `XmlElement` tree by hand: it reuses the profile's `<tt>`/head/timing/escaping
 * machinery, is additive, and leaves the other TTML profiles untouched).
 */

/** conformsToStandard designator for the EBU-TT-D distribution profile. */
const CONFORMS_TO = 'urn:ebu:tt:distribution:2014';
/** The single synthesized base style (font/colour/alignment) referenced by every `<p>`. */
const BASE_STYLE_ID = 's0';
/** The single synthesized region referenced by every `<p>`. */
const REGION_ID = 'r0';

/** Strip a namespace prefix: `tts:color` → `color`, `xml:id` → `id`. */
function local(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/** Look up an attribute by its local name, ignoring the namespace prefix. */
function attrByLocal(el: XmlElement, localName: string): string | undefined {
  for (const key of Object.keys(el.attrs)) if (local(key) === localName) return el.attrs[key];
  return undefined;
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * The visual styling a content span expresses referentially. Voice has no
 * EBU-TT-D representation and opaque markup can't be expressed, so both degrade
 * to plain text — mirroring the generic TTML serializer's span handling.
 */
interface SpanStyle {
  italic?: boolean;
  bold?: boolean;
  underline?: boolean;
  color?: string;
}

/** A span's effective {@link SpanStyle}, or null when it renders as unstyled text. */
function spanStyle(span: StyledSpan): SpanStyle | null {
  if (span.opaque !== undefined) return null;
  const s: SpanStyle = {};
  if (span.italic) s.italic = true;
  if (span.bold) s.bold = true;
  if (span.underline) s.underline = true;
  if (span.color !== undefined) s.color = span.color;
  return Object.keys(s).length > 0 ? s : null;
}

/** Deterministic identity for a style combination, so equal combos share one `<style>`. */
function styleKey(s: SpanStyle): string {
  return [s.italic ? 'i' : '', s.bold ? 'b' : '', s.underline ? 'u' : '', s.color ?? ''].join('|');
}

interface CollectedStyle {
  id: string;
  style: SpanStyle;
}

/**
 * Collect every distinct span-style combination the document uses, in
 * first-encounter order, assigning ids `s1`, `s2`, … (`s0` is the base style).
 * Returns the ordered list (to emit `<style>`s) and a key→id map (to reference).
 */
function collectStyles(doc: SubtitleDocument): {
  order: CollectedStyle[];
  byKey: Map<string, string>;
} {
  const byKey = new Map<string, string>();
  const order: CollectedStyle[] = [];
  for (const cue of doc.cues) {
    for (const line of cue.lines) {
      for (const span of line.spans) {
        const s = spanStyle(span);
        if (!s) continue;
        const key = styleKey(s);
        if (byKey.has(key)) continue;
        const id = `s${order.length + 1}`;
        byKey.set(key, id);
        order.push({ id, style: s });
      }
    }
  }
  return { order, byKey };
}

/** The `tts:*` attributes for a collected span style (the inverse of parse's `applyStyle`). */
function styleAttrs(s: SpanStyle): string {
  const a: string[] = [];
  if (s.italic) a.push('tts:fontStyle="italic"');
  if (s.bold) a.push('tts:fontWeight="bold"');
  if (s.underline) a.push('tts:textDecoration="underline"');
  if (s.color !== undefined) a.push(`tts:color="${escapeAttr(s.color)}"`);
  return a.join(' ');
}

/** `<tt>` namespaces + EBU-TT-D document parameters. */
function ebuttdTtAttrs(doc: SubtitleDocument): Record<string, string> {
  return {
    xmlns: 'http://www.w3.org/ns/ttml',
    'xmlns:ttp': 'http://www.w3.org/ns/ttml#parameter',
    'xmlns:tts': 'http://www.w3.org/ns/ttml#styling',
    'xmlns:ebuttm': 'urn:ebu:tt:metadata',
    'xmlns:ebutts': 'urn:ebu:tt:style',
    'ttp:timeBase': 'media',
    'ttp:cellResolution': '32 15',
    // The root container extent is the one place absolute pixels are valid; it
    // defines the reference video size the percentage region resolves against.
    'tts:extent': '1920px 1080px',
    // xml:lang is required; an unknown language is spec-valid as '' (matches serializeTtml).
    'xml:lang': doc.metadata.language ?? '',
  };
}

/** The synthesized EBU-TT-D `<head>`: conformance metadata, styling, and one region. */
function buildHead(order: CollectedStyle[]): string {
  const styles = [
    `      <style xml:id="${BASE_STYLE_ID}" tts:fontFamily="proportionalSansSerif" tts:fontSize="80%" tts:lineHeight="normal" tts:textAlign="center" tts:color="#FFFFFF"/>`,
    ...order.map(({ id, style }) => `      <style xml:id="${id}" ${styleAttrs(style)}/>`),
  ];
  return [
    '  <head>',
    '    <metadata>',
    '      <ebuttm:documentMetadata>',
    `        <ebuttm:conformsToStandard>${CONFORMS_TO}</ebuttm:conformsToStandard>`,
    '      </ebuttm:documentMetadata>',
    '    </metadata>',
    '    <styling>',
    ...styles,
    '    </styling>',
    '    <layout>',
    `      <region xml:id="${REGION_ID}" tts:origin="10% 10%" tts:extent="80% 80%" tts:displayAlign="after" tts:overflow="visible"/>`,
    '    </layout>',
    '  </head>',
  ].join('\n');
}

/** Render a cue's lines as `<p>` content using referential styling (`<span style="sN">`). */
function renderContent(lines: CueLine[], byKey: Map<string, string>): string {
  return lines
    .map((line) =>
      line.spans
        .map((span) => {
          const text = escapeText(span.text);
          const s = spanStyle(span);
          if (!s) return text;
          return `<span style="${byKey.get(styleKey(s))!}">${text}</span>`;
        })
        .join(''),
    )
    .join('<br/>');
}

/** Serialize a SubtitleDocument to EBU-TT-D text (EBU Tech 3380). */
export function serializeEbuttd(doc: SubtitleDocument): string {
  const { order, byKey } = collectStyles(doc);
  const ttAttrs = ebuttdTtAttrs(doc);
  return serializeTtmlProfile(doc, {
    defaultTtAttrs: ttAttrs,
    // EBU-TT-D owns its whole parameter set; force it so no source timing/profile
    // attrs leak through when re-serializing a document parsed from another format.
    overrideTtAttrs: ttAttrs,
    head: buildHead(order),
    forceStyle: BASE_STYLE_ID,
    forceRegion: REGION_ID,
    serializeContent: (lines) => renderContent(lines, byKey),
  });
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Map each head `<style xml:id>` to its `tts:*` attributes (verbatim, prefixed). */
function collectHeadStyles(tt: XmlElement): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  const head = tt.children.find((c) => typeof c !== 'string' && local(c.tag) === 'head') as
    | XmlElement
    | undefined;
  const styling = head?.children.find(
    (c) => typeof c !== 'string' && local(c.tag) === 'styling',
  ) as XmlElement | undefined;
  if (!styling) return map;
  for (const c of styling.children) {
    if (typeof c === 'string' || local(c.tag) !== 'style') continue;
    const id = attrByLocal(c, 'id');
    if (id === undefined) continue;
    const tts: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.attrs)) if (k.startsWith('tts:')) tts[k] = v;
    map.set(id, tts);
  }
  return map;
}

/**
 * Resolve referential styling onto content spans: copy each referenced style's
 * `tts:*` attributes inline onto the `<span>` that references it, so the generic
 * TTML parser (which reads only inline `tts:` on spans, not `style` references)
 * recovers italic/bold/underline/colour. Only spans are resolved — the base
 * style referenced by `<p>` is document-level presentation, not per-span state.
 */
function inlineSpanStyles(el: XmlElement, styleMap: Map<string, Record<string, string>>): void {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (local(c.tag) === 'span') {
      const ref = attrByLocal(c, 'style');
      if (ref !== undefined) {
        for (const id of ref.trim().split(/\s+/)) {
          const tts = styleMap.get(id);
          if (!tts) continue;
          for (const [k, v] of Object.entries(tts)) {
            if (attrByLocal(c, local(k)) === undefined) c.attrs[k] = v;
          }
        }
      }
    }
    inlineSpanStyles(c, styleMap);
  }
}

/**
 * Parse EBU-TT-D text into a SubtitleDocument. An EBU-TT-D file is valid TTML, so
 * this resolves referential span styling (see {@link inlineSpanStyles}) then
 * delegates to the generic TTML parser and relabels the source format.
 */
export function parseEbuttd(text: string): SubtitleDocument {
  let resolved = text;
  try {
    const tt = parseXml(text);
    const styleMap = collectHeadStyles(tt);
    if (styleMap.size > 0) {
      inlineSpanStyles(tt, styleMap);
      resolved = serializeXml(tt);
    }
  } catch (e) {
    // Malformed XML: fall through to parseTtml, which surfaces the parse warning.
    if (!(e instanceof XmlError)) throw e;
  }
  const doc = parseTtml(resolved);
  return {
    ...doc,
    metadata: { ...doc.metadata, sourceFormat: 'ebuttd' },
  };
}
