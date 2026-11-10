import type { SubtitleDocument } from '../../model/types';
import { parseTtml, serializeTtmlProfile } from '../ttml';
import { msToTimecode } from '../../timing/timecode';
import { canonicalFps } from '../../timing/timing';

/**
 * Apple iTunes Timed Text (.itt) — a constrained profile of TTML 1.0 (spec §3
 * TTML, H1). Because iTT *is* valid TTML, the codec reuses the TTML parser and
 * serializer rather than a second engine: {@link parseItt} runs the generic TTML
 * parser and relabels the source format, and {@link serializeItt} emits TTML with
 * the iTT profile's required `<tt>` attributes and time model.
 *
 * Timing follows Apple's ingest convention (iTunes/FCP/Compressor), which is
 * SMPTE, not the media clock (cue-forge-sdv.13): `ttp:timeBase="smpte"`, an
 * explicit `ttp:frameRate` (plus `ttp:frameRateMultiplier` + `ttp:dropMode` for
 * the NTSC rates), and frame-based `HH:MM:SS:FF` begin/end timecodes. Sub-frame
 * millisecond clock times with no declared frame rate are a known iTT
 * ingest-rejection cause, so the serializer never emits them.
 *
 * Round-trip is content/ms-based (the canonical model), not byte-identical: iTT
 * frame timecodes parse back to integer ms (quantised to the frame grid) and
 * re-emit to the same timecodes.
 */

/** Default frame rate when a document carries no frame-rate context of its own. */
const DEFAULT_ITT_FPS = 24;

/** SMPTE `<tt>` timing parameters per canonical fps (frameRate is the nominal integer). */
interface SmpteRate {
  frameRate: string;
  multiplier?: string;
  dropMode?: string;
}
const SMPTE_RATES: Record<number, SmpteRate> = {
  23.976: { frameRate: '24', multiplier: '1000 1001' },
  24: { frameRate: '24' },
  25: { frameRate: '25' },
  29.97: { frameRate: '30', multiplier: '1000 1001', dropMode: 'dropNTSC' },
  30: { frameRate: '30' },
};

/** Namespaces + fixed cell resolution the iTT profile requires (timing is added per-doc). */
const ITT_TT_ATTRS: Record<string, string> = {
  xmlns: 'http://www.w3.org/ns/ttml',
  'xmlns:tts': 'http://www.w3.org/ns/ttml#styling',
  'xmlns:ttp': 'http://www.w3.org/ns/ttml#parameter',
  'xmlns:ttm': 'http://www.w3.org/ns/ttml#metadata',
  'ttp:cellResolution': '50 33',
  'xml:lang': 'en',
};

/** Parse Apple iTT text into a SubtitleDocument (a TTML profile). */
export function parseItt(text: string): SubtitleDocument {
  const doc = parseTtml(text);
  return { ...doc, metadata: { ...doc.metadata, sourceFormat: 'itt' } };
}

/** Serialize a SubtitleDocument to Apple iTT text (the iTT TTML profile). */
export function serializeItt(doc: SubtitleDocument): string {
  const fps = canonicalFps(doc.metadata.frameRate ?? DEFAULT_ITT_FPS);
  const rate = SMPTE_RATES[fps] ?? { frameRate: String(Math.round(fps)) };

  const timing: Record<string, string> = {
    'ttp:timeBase': 'smpte',
    'ttp:frameRate': rate.frameRate,
  };
  if (rate.multiplier !== undefined) timing['ttp:frameRateMultiplier'] = rate.multiplier;
  if (rate.dropMode !== undefined) timing['ttp:dropMode'] = rate.dropMode;

  // Format drop-frame timecodes only when we actually emit ttp:dropMode. Deriving
  // this from the final timing (not SMPTE_RATES membership) keeps the timecodes
  // consistent with the <tt> label, so a round-trip can't drift ~2 frames by
  // re-reading non-drop timecodes as drop-frame (cue-forge-zxw.1).
  const dropFrame = timing['ttp:dropMode'] !== undefined;

  return serializeTtmlProfile(doc, {
    defaultTtAttrs: ITT_TT_ATTRS,
    overrideTtAttrs: timing,
    // TTML clock-time uses ':' for the frames field; drop-frame is signalled by
    // ttp:dropMode, not a ';' separator, so normalise the SCC drop-frame form.
    formatTime: (ms) => msToTimecode(ms, fps, dropFrame).replace(';', ':'),
  });
}
