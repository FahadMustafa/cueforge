import type { SubtitleDocument } from '../../model/types';
import { parseTtml, serializeTtmlProfile } from '../ttml';

/**
 * IMSC 1.0.1 / IMSC 1.1 (spec §7 M6, cue-forge-sdv.7) — the W3C-published,
 * validated TTML subtitle profiles. Like Apple iTT, both *are* TTML, so the
 * codec reuses the generic TTML parser/serializer rather than a second engine:
 * {@link parseImsc101}/{@link parseImsc11} run the generic parser and relabel
 * the source format, and {@link serializeImsc101}/{@link serializeImsc11} emit
 * TTML constrained to what each IMSC version requires.
 *
 * Unlike iTT (which forces only the `<tt>` timing parameters), IMSC export
 * always synthesizes its own `<head>`: a single percent-only region
 * (`tts:origin`/`tts:extent`, bottom-anchored via `tts:displayAlign="after"`)
 * and a single default style. IMSC forbids pixel units everywhere except the
 * root container `tts:extent` (spec: absolute pixel geometry is only valid on
 * the root, since it defines the reference "related video object" size);
 * regions must use percentages. A source document's `<head>`/region/style refs
 * are therefore *replaced*, not passed through — carrying them over verbatim
 * would leave every `<p>`'s `region`/`style` referencing an id that no longer
 * exists once the source `<head>` is dropped.
 *
 * The profile designator differs by version and is expressed by a different
 * attribute (TTML2/IMSC1.1 added `ttp:contentProfiles` as a more expressive
 * successor to TTML1's single `ttp:profile`):
 *   - IMSC 1.0.1: `ttp:profile="http://www.w3.org/ns/ttml/profile/imsc1/text"`.
 *   - IMSC 1.1:   `ttp:contentProfiles="http://www.w3.org/ns/ttml/profile/imsc1.1/text"`
 *                 (never emitted alongside `ttp:profile`).
 *
 * Timing stays the TTML default media clock (`ttp:timeBase="media"`,
 * `HH:MM:SS.mmm`) — IMSC does not require frame-based SMPTE timing the way
 * Apple iTT does.
 */

/** The synthesized `<head>`: one percent-only, bottom-anchored region + one default style. */
const IMSC_HEAD = [
  '  <head>',
  '    <styling>',
  '      <style xml:id="s0" tts:fontSize="100%" tts:fontFamily="default" tts:color="white" tts:textAlign="center"/>',
  '    </styling>',
  '    <layout>',
  '      <region xml:id="r0" tts:origin="10% 10%" tts:extent="80% 80%" tts:displayAlign="after"/>',
  '    </layout>',
  '  </head>',
].join('\n');

/** Namespaces + parameters common to both IMSC versions; only the profile designator differs. */
function imscTtAttrs(
  doc: SubtitleDocument,
  profileAttrs: Record<string, string>,
): Record<string, string> {
  return {
    xmlns: 'http://www.w3.org/ns/ttml',
    'xmlns:ttp': 'http://www.w3.org/ns/ttml#parameter',
    'xmlns:tts': 'http://www.w3.org/ns/ttml#styling',
    'xmlns:ttm': 'http://www.w3.org/ns/ttml#metadata',
    'ttp:timeBase': 'media',
    // IMSC requires xml:lang present; an unknown language is spec-valid as ''.
    'xml:lang': doc.metadata.language ?? '',
    // The root container extent is the one place IMSC permits pixel units.
    'tts:extent': '1920px 1080px',
    ...profileAttrs,
  };
}

/** Shared serialization: force the synthesized head + default region/style onto plain TTML. */
function serializeImscProfile(doc: SubtitleDocument, profileAttrs: Record<string, string>): string {
  const ttAttrs = imscTtAttrs(doc, profileAttrs);
  return serializeTtmlProfile(doc, {
    defaultTtAttrs: ttAttrs,
    // Source raw ttAttrs (timing, a stale profile designator, source xml:lang…)
    // must not leak into an IMSC export — the profile owns its whole parameter
    // set, so force it via override rather than default.
    overrideTtAttrs: ttAttrs,
    head: IMSC_HEAD,
    forceRegion: 'r0',
    forceStyle: 's0',
  });
}

/** Serialize a SubtitleDocument to IMSC 1.0.1 text. */
export function serializeImsc101(doc: SubtitleDocument): string {
  return serializeImscProfile(doc, {
    'ttp:profile': 'http://www.w3.org/ns/ttml/profile/imsc1/text',
  });
}

/** Serialize a SubtitleDocument to IMSC 1.1 text. */
export function serializeImsc11(doc: SubtitleDocument): string {
  return serializeImscProfile(doc, {
    'ttp:contentProfiles': 'http://www.w3.org/ns/ttml/profile/imsc1.1/text',
  });
}

/** Parse IMSC 1.0.1 text into a SubtitleDocument (a TTML profile; delegates to the generic parser). */
export function parseImsc101(text: string): SubtitleDocument {
  const doc = parseTtml(text);
  return { ...doc, metadata: { ...doc.metadata, sourceFormat: 'imsc101' } };
}

/** Parse IMSC 1.1 text into a SubtitleDocument (a TTML profile; delegates to the generic parser). */
export function parseImsc11(text: string): SubtitleDocument {
  const doc = parseTtml(text);
  return { ...doc, metadata: { ...doc.metadata, sourceFormat: 'imsc11' } };
}
