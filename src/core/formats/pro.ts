import type { ParseWarning, SubtitleDocument } from '../model/types';

/**
 * Pro / binary format registry (spec §7 M6, §6.3 #7).
 *
 * TTML, SCC and EBU-STL are heavier and rarer than the core text formats, so
 * they are **lazy-loaded**: each codec lives behind a dynamic `import()` and is
 * deliberately NOT re-exported from `formats/index.ts` / `core/index.ts`. That
 * keeps them in their own bundle chunks, excluded from the initial bundle the
 * budget gate measures. Callers (the app, conversion) discover formats via
 * {@link PRO_FORMATS} and load a codec on demand with {@link loadProCodec}.
 *
 * STL is binary, so the registry models two codec shapes — text (string in/out)
 * and binary (Uint8Array in/out) — discriminated by `kind`.
 */

export type ProFormatId = 'ttml' | 'scc' | 'stl' | 'itt' | 'imsc101' | 'imsc11' | 'mcc' | 'ebuttd';

export interface ProFormat {
  id: ProFormatId;
  name: string;
  extensions: string[];
  /** Whether the codec works on decoded text or raw bytes. */
  kind: 'text' | 'binary';
}

export const PRO_FORMATS: readonly ProFormat[] = [
  { id: 'ttml', name: 'TTML / IMSC1', extensions: ['.ttml', '.xml', '.dfxp'], kind: 'text' },
  { id: 'scc', name: 'Scenarist Closed Caption', extensions: ['.scc'], kind: 'text' },
  { id: 'stl', name: 'EBU-STL', extensions: ['.stl'], kind: 'binary' },
  { id: 'itt', name: 'Apple iTT', extensions: ['.itt'], kind: 'text' },
  { id: 'imsc101', name: 'IMSC 1.0.1 (TTML)', extensions: ['.ttml', '.xml'], kind: 'text' },
  { id: 'imsc11', name: 'IMSC 1.1 (TTML)', extensions: ['.ttml', '.xml'], kind: 'text' },
  { id: 'mcc', name: 'MCC (CEA-708)', extensions: ['.mcc'], kind: 'text' },
  { id: 'ebuttd', name: 'EBU-TT-D', extensions: ['.xml'], kind: 'text' },
] as const;

export const PRO_FORMAT_IDS: ProFormatId[] = PRO_FORMATS.map((f) => f.id);

/** Look up Pro-format metadata by id. */
export function getProFormat(id: ProFormatId): ProFormat {
  const fmt = PRO_FORMATS.find((f) => f.id === id);
  if (!fmt) throw new Error(`Unknown Pro format: ${id}`);
  return fmt;
}

export interface ProTextCodec {
  kind: 'text';
  parse(text: string): SubtitleDocument;
  /** Serializers with a warnings out-param (SCC density) push into `warnings`. */
  serialize(doc: SubtitleDocument, warnings?: ParseWarning[]): string;
  /**
   * Charset-representability predicate for legacy targets (CEA-608); absent
   * for Unicode targets (TTML).
   */
  canEncodeChar?: (ch: string) => boolean;
}

export interface ProBinaryCodec {
  kind: 'binary';
  parse(bytes: Uint8Array): SubtitleDocument;
  serialize(doc: SubtitleDocument): Uint8Array;
  /** Charset-representability predicate (ISO 6937 for STL). */
  canEncodeChar?: (ch: string) => boolean;
}

export type ProCodec = ProTextCodec | ProBinaryCodec;

/**
 * Dynamically import the codec for a Pro format. The `import()` calls are the
 * split points that keep each format in its own lazily-loaded chunk.
 */
export async function loadProCodec(id: ProFormatId): Promise<ProCodec> {
  switch (id) {
    case 'ttml': {
      const m = await import('./ttml');
      return { kind: 'text', parse: m.parseTtml, serialize: m.serializeTtml };
    }
    case 'scc': {
      const m = await import('./scc');
      return {
        kind: 'text',
        parse: m.parseScc,
        serialize: m.serializeScc,
        canEncodeChar: m.canEncodeCea608,
      };
    }
    case 'stl': {
      const m = await import('./stl');
      return {
        kind: 'binary',
        parse: m.parseStl,
        serialize: m.serializeStl,
        canEncodeChar: m.canEncodeIso6937,
      };
    }
    case 'itt': {
      const m = await import('./itt');
      return { kind: 'text', parse: m.parseItt, serialize: m.serializeItt };
    }
    case 'imsc101': {
      const m = await import('./imsc');
      return { kind: 'text', parse: m.parseImsc101, serialize: m.serializeImsc101 };
    }
    case 'imsc11': {
      const m = await import('./imsc');
      return { kind: 'text', parse: m.parseImsc11, serialize: m.serializeImsc11 };
    }
    case 'mcc': {
      const m = await import('./mcc');
      return {
        kind: 'text',
        parse: m.parseMcc,
        serialize: m.serializeMcc,
        canEncodeChar: m.canEncodeMcc,
      };
    }
    case 'ebuttd': {
      const m = await import('./ebuttd');
      return { kind: 'text', parse: m.parseEbuttd, serialize: m.serializeEbuttd };
    }
  }
}
