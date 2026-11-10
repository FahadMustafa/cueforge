/**
 * Encoding detection & decoding (spec §2).
 *
 * Detects UTF-8 (with/without BOM) and UTF-16 LE/BE, decodes to a UTF-8 JS
 * string with any BOM stripped, and reports the source newline convention.
 * Bytes that are clearly not UTF-8 (a dense U+FFFD result) fall back to a
 * legacy Windows code page — windows-1256 for Arabic, windows-1252 otherwise —
 * with a warning instead of silent mojibake (cue-forge-1wx).
 * Output is always a UTF-8 string; {@link encodeUtf8} re-encodes for byte sinks.
 */

export type DetectedEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' | 'windows-1256';
export type NewlineStyle = 'lf' | 'crlf' | 'mixed' | 'none';

export interface DecodeResult {
  /** Decoded text with any leading BOM removed. */
  text: string;
  encoding: DetectedEncoding;
  hadBom: boolean;
  newline: NewlineStyle;
  /** Present when decoding had to assume a legacy code page heuristically. */
  warning?: string;
}

/** Number of bytes inspected for the BOM-less UTF-16 heuristic. */
const HEURISTIC_SAMPLE = 1024;

/** Detect encoding and BOM length from the leading bytes. */
export function detectEncoding(bytes: Uint8Array): {
  encoding: DetectedEncoding;
  hadBom: boolean;
  bomLength: number;
} {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', hadBom: true, bomLength: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', hadBom: true, bomLength: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', hadBom: true, bomLength: 2 };
  }
  // BOM-less UTF-16 heuristic. UTF-16 text has positional structure UTF-8 lacks:
  // its high-byte lane holds the Unicode block prefix, which for nearly every
  // non-CJK script is a small value (< 0x30) — 0x00 for Latin, 0x04 Cyrillic,
  // 0x05 Hebrew, 0x06 Arabic, etc. So one byte lane is overwhelmingly "low"
  // while the other (the character's low byte) varies across the full range.
  // Keying on that asymmetry — not just NUL bytes — also catches Latin-free
  // Arabic, which the old NUL-only test mis-detected as UTF-8 (cue-forge-71a.12).
  // Inherent limitation: BMP CJK has large, varied high bytes, so BOM-less
  // UTF-16 CJK still cannot be distinguished from UTF-8 here.
  const n = Math.min(bytes.length, HEURISTIC_SAMPLE);
  const pairs = Math.floor(n / 2);
  if (pairs >= 1) {
    let evenLow = 0;
    let oddLow = 0;
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i + 1 < n; i += 2) {
      if (bytes[i]! < 0x30) evenLow++;
      if (bytes[i]! === 0) evenZero++;
      if (bytes[i + 1]! < 0x30) oddLow++;
      if (bytes[i + 1]! === 0) oddZero++;
    }
    const evenLowRatio = evenLow / pairs;
    const oddLowRatio = oddLow / pairs;
    const evenZeroRatio = evenZero / pairs;
    const oddZeroRatio = oddZero / pairs;
    // A genuine UTF-16 high-byte lane is overwhelmingly < 0x30 (HIGH) and clearly
    // "lower" than the opposite lane (MARGIN). The asymmetry is what rules out
    // UTF-8, which has no even/odd bias; the zero-ratio arm preserves the
    // original ASCII-range behaviour.
    const HIGH = 0.6;
    const MARGIN = 0.25;
    if ((oddZeroRatio > 0.3 || oddLowRatio >= HIGH) && oddLowRatio > evenLowRatio + MARGIN) {
      return { encoding: 'utf-16le', hadBom: false, bomLength: 0 };
    }
    if ((evenZeroRatio > 0.3 || evenLowRatio >= HIGH) && evenLowRatio > oddLowRatio + MARGIN) {
      return { encoding: 'utf-16be', hadBom: false, bomLength: 0 };
    }
  }
  return { encoding: 'utf-8', hadBom: false, bomLength: 0 };
}

/** Classify the newline convention used in a decoded string. */
export function detectNewline(text: string): NewlineStyle {
  const crlf = /\r\n/.test(text);
  // A line feed not immediately preceded by a carriage return.
  const loneLf = /(^|[^\r])\n/.test(text);
  if (crlf && loneLf) return 'mixed';
  if (crlf) return 'crlf';
  if (loneLf) return 'lf';
  return 'none';
}

/**
 * U+FFFD density that signals a mis-decoded legacy code page rather than the
 * odd corrupt byte: more than 2% of the result, or more than 4 absolute (so a
 * cluster in a short text still triggers while one stray byte in a long file
 * does not).
 */
function looksMojibake(text: string): boolean {
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) bad++;
  }
  return bad > 4 || (bad > 0 && bad / text.length > 0.02);
}

/**
 * Re-decode non-UTF-8 bytes with a legacy Windows code page. Chooses
 * windows-1256 when the 0xC0–0xFF range dominates the high bytes (that range
 * holds the Arabic letters in cp1256) *and* a strict majority of the high
 * bytes actually decodes into the Arabic block; otherwise windows-1252.
 * (cp1256 keeps Latin accented letters like é/è/à at their cp1252 positions,
 * but the uppercase ones — Ç → ا, for instance — land on Arabic letters, so
 * 'Ça va très bien' is 1 Arabic char out of 2 high bytes: a stray
 * Arabic-looking char must not flip accented French/Spanish to cp1256, while
 * real cp1256 Arabic text decodes to nearly 100% Arabic-block high bytes.)
 */
const ARABIC_SHARE_MIN = 0.5; // exclusive: more than half

function decodeLegacy(body: Uint8Array): Pick<DecodeResult, 'text' | 'encoding' | 'warning'> {
  let high = 0; // bytes >= 0x80
  let upper = 0; // bytes 0xC0–0xFF
  for (const b of body) {
    if (b >= 0x80) high++;
    if (b >= 0xc0) upper++;
  }
  const cp1256 = new TextDecoder('windows-1256').decode(body);
  // cp1256 is single-byte, so each Arabic-block char comes from one high byte.
  let arabic = 0;
  for (let i = 0; i < cp1256.length; i++) {
    const c = cp1256.charCodeAt(i);
    if (c >= 0x0600 && c <= 0x06ff) arabic++;
  }
  // high is never 0 here (invalid UTF-8 implies bytes >= 0x80); NaN-safe anyway.
  const isArabic = upper / high >= 0.5 && arabic / high > ARABIC_SHARE_MIN;
  const encoding = isArabic ? 'windows-1256' : 'windows-1252';
  const text = isArabic ? cp1256 : new TextDecoder('windows-1252').decode(body);
  return {
    text,
    encoding,
    warning: `Input is not valid UTF-8; assumed legacy code page ${encoding}.`,
  };
}

/** Detect encoding, strip the BOM, and decode to a UTF-8 string. */
export function decode(bytes: Uint8Array): DecodeResult {
  const { encoding, hadBom, bomLength } = detectEncoding(bytes);
  const body = bomLength > 0 ? bytes.subarray(bomLength) : bytes;
  // ignoreBOM:true => the decoder treats a leading U+FEFF as data; we already
  // stripped the byte BOM above, so this just prevents double handling.
  const decoder = new TextDecoder(encoding, { ignoreBOM: true, fatal: false });
  let text = decoder.decode(body);
  /* v8 ignore next 2 -- defensive: byte BOM already stripped above */
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // A BOM is an explicit declaration — only BOM-less "UTF-8" gets second-guessed.
  if (encoding === 'utf-8' && !hadBom && looksMojibake(text)) {
    const legacy = decodeLegacy(body);
    return { ...legacy, hadBom: false, newline: detectNewline(legacy.text) };
  }
  return { text, encoding, hadBom, newline: detectNewline(text) };
}

/** Encode a string to UTF-8 bytes (no BOM). */
export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
