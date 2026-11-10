/**
 * CEA-608 (line-21) low-level primitives for the SCC codec (spec §3 SCC).
 *
 * SCC stores caption data as space-separated 16-bit hex words; every byte
 * carries odd parity in its high bit. This module owns parity, the timecode ↔
 * frame conversion (drop-frame and non-drop at the 30000/1001 timebase) and the
 * character/control-code tables. The pop-on assembly state machine lives in
 * `scc.ts`.
 */

/** Strip the odd-parity high bit, yielding the 7-bit data value. */
export function stripParity(byte: number): number {
  return byte & 0x7f;
}

/** Set the high bit so the byte has an odd number of one-bits. */
export function addOddParity(byte: number): number {
  const data = byte & 0x7f;
  let ones = 0;
  for (let b = data; b !== 0; b >>= 1) ones += b & 1;
  return ones % 2 === 0 ? data | 0x80 : data;
}

/** True if `byte` already carries valid odd parity. */
export function hasOddParity(byte: number): boolean {
  let ones = 0;
  for (let b = byte; b !== 0; b >>= 1) ones += b & 1;
  return ones % 2 === 1;
}

const FRAME_RE = /^(\d{2}):(\d{2}):(\d{2})([:;.])(\d{2})$/;

/** Whether a timecode token uses a drop-frame separator (`;` or `.`). */
export function isDropFrameTimecode(tc: string): boolean {
  const m = FRAME_RE.exec(tc.trim());
  return m ? m[4] === ';' || m[4] === '.' : false;
}

/**
 * Convert an SCC timecode to an absolute frame index. Non-drop counts straight
 * at 30 frames/second; drop-frame drops the first two frame numbers of every
 * minute except every tenth, keeping the timecode aligned to wall-clock time.
 */
export function timecodeToFrame(tc: string): number {
  const m = FRAME_RE.exec(tc.trim());
  if (!m) throw new Error(`Invalid SCC timecode: "${tc}".`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const f = Number(m[5]);
  const drop = m[4] === ';' || m[4] === '.';
  const totalMinutes = h * 60 + min;
  let frame = ((h * 60 + min) * 60 + s) * 30 + f;
  if (drop) frame -= 2 * (totalMinutes - Math.floor(totalMinutes / 10));
  return frame;
}

/** Milliseconds for a frame index on the 30000/1001 (≈29.97) timebase. */
export function frameToMs(frame: number): number {
  return Math.round((frame * 1001) / 30);
}

/** Nearest frame index for a millisecond value on the 30000/1001 timebase. */
export function msToFrame(ms: number): number {
  return Math.round((ms * 30) / 1001);
}

/** Format a frame index as an SCC timecode (drop-frame or non-drop). */
export function frameToTimecode(frame: number, dropFrame: boolean): string {
  let f = frame;
  if (dropFrame) {
    // Invert the drop: walk minutes adding back the dropped frames.
    const framesPer10Min = 17982; // 10*60*30 - 9*2
    const framesPerMin = 1798; // 60*30 - 2
    const d = Math.floor(f / framesPer10Min);
    let m = f % framesPer10Min;
    if (m < 2) m += 2; // never lands on a dropped number
    f = f + 18 * d + 2 * Math.floor((m - 2) / framesPerMin);
  }
  const ff = f % 30;
  const totalSeconds = Math.floor(f / 30);
  const s = totalSeconds % 60;
  const min = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const sep = dropFrame ? ';' : ':';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(min)}:${p(s)}${sep}${p(ff)}`;
}

/** Basic character substitutions over ASCII 0x20–0x7F (CEA-608 §). */
const BASIC_OVERRIDES: Record<number, string> = {
  0x2a: 'á',
  0x5c: 'é',
  0x5e: 'í',
  0x5f: 'ó',
  0x60: 'ú',
  0x7b: 'ç',
  0x7c: '÷',
  0x7d: 'Ñ',
  0x7e: 'ñ',
  0x7f: '█',
};

/** Decode a standard (0x20–0x7F) character byte to a string. */
export function decodeBasicChar(data: number): string {
  if (data < 0x20 || data > 0x7f) return '';
  return BASIC_OVERRIDES[data] ?? String.fromCharCode(data);
}

/** Special characters: control word 0x11, second byte 0x30–0x3F. */
export const SPECIAL_CHARS: Record<number, string> = {
  0x30: '®',
  0x31: '°',
  0x32: '½',
  0x33: '¿',
  0x34: '™',
  0x35: '¢',
  0x36: '£',
  0x37: '♪',
  0x38: 'à',
  0x39: ' ',
  0x3a: 'è',
  0x3b: 'â',
  0x3c: 'ê',
  0x3d: 'î',
  0x3e: 'ô',
  0x3f: 'û',
};

/**
 * Extended Western European characters (CEA-608 optional set): channel-1
 * control words 0x12 (Spanish/Misc/French) and 0x13 (Portuguese/German/
 * Danish), second byte 0x20–0x3F. Each is transmitted as a basic fallback
 * character followed by the extended pair, which REPLACES the fallback.
 */
const EXTENDED_12: readonly string[] = [
  'Á',
  'É',
  'Ó',
  'Ú',
  'Ü',
  'ü',
  '‘',
  '¡',
  '*',
  '’',
  '—',
  '©',
  '℠',
  '•',
  '“',
  '”',
  'À',
  'Â',
  'Ç',
  'È',
  'Ê',
  'Ë',
  'ë',
  'Î',
  'Ï',
  'ï',
  'Ô',
  'Ù',
  'ù',
  'Û',
  '«',
  '»',
];
const EXTENDED_13: readonly string[] = [
  'Ã',
  'ã',
  'Í',
  'Ì',
  'ì',
  'Ò',
  'ò',
  'Õ',
  'õ',
  '{',
  '}',
  '\\',
  '^',
  '_',
  '|',
  '~',
  'Ä',
  'ä',
  'Ö',
  'ö',
  'ß',
  '¥',
  '¤',
  '│',
  'Å',
  'å',
  'Ø',
  'ø',
  '┌',
  '┐',
  '└',
  '┘',
];

/** Decode an extended character pair (parity-stripped), or null if not one. */
export function decodeExtendedChar(b1: number, b2: number): string | null {
  if (b2 < 0x20 || b2 > 0x3f) return null;
  if (b1 === 0x12) return EXTENDED_12[b2 - 0x20]!;
  if (b1 === 0x13) return EXTENDED_13[b2 - 0x20]!;
  return null;
}

/** Mid-row style codes: control word 0x11, second byte 0x20–0x2F. */
export interface MidRowStyle {
  italic: boolean;
  underline: boolean;
  color?: string;
}

const MIDROW_COLORS = ['white', 'green', 'blue', 'cyan', 'red', 'yellow', 'magenta'];

/** Decode a mid-row style code (second byte 0x20–0x2F). */
export function decodeMidRow(b2: number): MidRowStyle {
  const underline = (b2 & 0x01) === 1;
  const idx = (b2 - 0x20) >> 1;
  if (idx === 7) return { italic: true, underline };
  return { italic: false, underline, color: MIDROW_COLORS[idx] };
}

/** A decoded Preamble Address Code: row, indent column, and base style. */
export interface Pac {
  row: number;
  indent: number;
  italic: boolean;
  underline: boolean;
}

const PAC_ROW_BASE: Record<number, number> = {
  0x11: 1,
  0x12: 3,
  0x15: 5,
  0x16: 7,
  0x17: 9,
  0x10: 11,
  0x13: 12,
  0x14: 14,
};

/** True if (b1,b2) — already parity-stripped — form a Preamble Address Code. */
export function isPac(b1: number, b2: number): boolean {
  return b1 >= 0x10 && b1 <= 0x17 && b2 >= 0x40 && b2 <= 0x7f && PAC_ROW_BASE[b1] !== undefined;
}

/** Decode a Preamble Address Code from parity-stripped bytes. */
export function decodePac(b1: number, b2: number): Pac {
  const base = PAC_ROW_BASE[b1]!;
  const row = base === 11 ? 11 : base + (b2 >= 0x60 ? 1 : 0);
  const x = b2 >= 0x60 ? b2 - 0x20 : b2; // normalize to 0x40–0x5f
  const underline = (x & 0x01) === 1;
  if (x & 0x10) {
    // Indent PAC: columns 0,4,8,…,28.
    const indent = ((x & 0x0e) >> 1) * 4;
    return { row, indent, italic: false, underline };
  }
  // Colour/italics PAC.
  const styleIdx = (x & 0x0e) >> 1;
  return { row, indent: 0, italic: styleIdx === 7, underline };
}

/** Encode a 16-bit word (two parity-stripped bytes) to a 4-hex SCC token. */
export function encodeWord(b1: number, b2: number): string {
  const w = (addOddParity(b1) << 8) | addOddParity(b2);
  return w.toString(16).padStart(4, '0');
}

/** Encode a Preamble Address Code (inverse of {@link decodePac}). */
export function encodePac(
  row: number,
  indent: number,
  italic: boolean,
  underline: boolean,
): [number, number] {
  const b1 = Number(
    Object.keys(PAC_ROW_BASE).find((k) => {
      const base = PAC_ROW_BASE[Number(k)]!;
      return base === 11 ? row === 11 : row === base || row === base + 1;
    }),
  );
  const base = PAC_ROW_BASE[b1]!;
  const lower = base !== 11 && row === base + 1;
  let x: number;
  if (indent > 0) {
    x = 0x50 | ((Math.floor(indent / 4) & 0x07) << 1) | (underline ? 1 : 0);
  } else {
    const styleIdx = italic ? 7 : 0;
    x = 0x40 | (styleIdx << 1) | (underline ? 1 : 0);
  }
  const b2 = lower ? x + 0x20 : x;
  return [b1, b2];
}

/** Reverse lookup: glyph → standard-character byte (0x20–0x7F). */
const BASIC_REVERSE: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let code = 0x20; code <= 0x7f; code++) {
    const ch = decodeBasicChar(code);
    if (!(ch in m)) m[ch] = code;
  }
  return m;
})();

/** Reverse lookup: glyph → special-character second byte (0x30–0x3F). */
const SPECIAL_REVERSE: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (const [k, v] of Object.entries(SPECIAL_CHARS)) if (!(v in m)) m[v] = Number(k);
  return m;
})();

/** Reverse lookup: glyph → extended-character (b1, b2) pair. */
const EXTENDED_REVERSE: Record<string, [number, number]> = (() => {
  const m: Record<string, [number, number]> = {};
  EXTENDED_12.forEach((ch, i) => {
    if (!(ch in m)) m[ch] = [0x12, 0x20 + i];
  });
  EXTENDED_13.forEach((ch, i) => {
    if (!(ch in m)) m[ch] = [0x13, 0x20 + i];
  });
  return m;
})();

/**
 * Designated fallback glyphs for extended characters with no Unicode
 * decomposition (letters fall back to their NFD-stripped base instead).
 */
const EXTENDED_FALLBACK: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '«': '"',
  '»': '"',
  '—': '-',
  '•': '.',
  '©': 'c',
  '℠': 's',
  '¡': '!',
  '*': '?',
  '{': '(',
  '}': ')',
  '\\': '/',
  '^': '?',
  _: '-',
  '|': '!',
  '~': '?',
  '¥': 'Y',
  '¤': '$',
  '│': '!',
  '┌': '!',
  '┐': '!',
  '└': '!',
  '┘': '!',
  ß: 's',
  ø: 'o',
  Ø: 'O',
};

/** Basic byte shown before (and replaced by) an extended character. */
function extendedFallbackByte(ch: string): number {
  const candidate = EXTENDED_FALLBACK[ch] ?? ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return BASIC_REVERSE[candidate] ?? BASIC_REVERSE['?']!;
}

/** Common punctuation outside the CEA-608 set, mapped to representable ASCII. */
const TRANSLIT: Record<string, string> = {
  '–': '-',
  '…': '...',
  ' ': ' ',
};

/**
 * A representable CEA-608 glyph: a standard byte, a special-character code, or
 * an extended character (fallback byte + replacing control pair).
 */
export type EncodedChar =
  | { kind: 'basic'; byte: number }
  | { kind: 'special'; b2: number }
  | { kind: 'extended'; fallback: number; b1: number; b2: number };

/**
 * Map a single character to its CEA-608 encoding, transliterating out-of-set
 * characters to the nearest representable form (returns one or more EncodedChars;
 * a transliteration like "…" → "..." expands to several).
 */
export function encodeChar(ch: string): EncodedChar[] {
  if (ch in BASIC_REVERSE) return [{ kind: 'basic', byte: BASIC_REVERSE[ch]! }];
  if (ch in SPECIAL_REVERSE) return [{ kind: 'special', b2: SPECIAL_REVERSE[ch]! }];
  const ext = EXTENDED_REVERSE[ch];
  if (ext) {
    return [{ kind: 'extended', fallback: extendedFallbackByte(ch), b1: ext[0], b2: ext[1] }];
  }
  if (ch in TRANSLIT) return [...TRANSLIT[ch]!].flatMap(encodeChar);
  // Strip diacritics (e.g. ą → a) and retry; otherwise fall back to '?'.
  const stripped = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (stripped !== ch && stripped !== '') return [...stripped].flatMap(encodeChar);
  return [{ kind: 'basic', byte: BASIC_REVERSE['?']! }];
}

/**
 * Whether a character is representable in CEA-608 without information loss
 * beyond diacritic stripping: directly (basic/special/extended sets), via the
 * designated transliterations, or after dropping combining diacritics. False
 * means {@link encodeChar} would fall back to '?' (e.g. Arabic, CJK).
 */
export function canEncodeCea608(ch: string): boolean {
  if (ch in BASIC_REVERSE || ch in SPECIAL_REVERSE || ch in EXTENDED_REVERSE || ch in TRANSLIT) {
    return true;
  }
  const stripped = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (stripped !== ch && stripped !== '') return [...stripped].every(canEncodeCea608);
  return false;
}

/** CEA-608 control-code commands relevant to pop-on/roll-up assembly. */
export type ControlCommand =
  | 'RCL' // Resume Caption Loading (pop-on)
  | 'EOC' // End Of Caption (display flip)
  | 'EDM' // Erase Displayed Memory
  | 'ENM' // Erase Non-displayed Memory
  | 'RDC' // Resume Direct Captioning
  | 'RU2'
  | 'RU3'
  | 'RU4'
  | 'CR' // Carriage Return (roll-up)
  | 'TO1'
  | 'TO2'
  | 'TO3'; // tab offsets

/**
 * Decode a CC1 control command from parity-stripped bytes, or null if not one.
 * Only 0x14 prefixes are field-1 channel-1 miscellaneous controls; 0x1C is
 * channel 2 and 0x15/0x1D are the field-2 services (CC3/CC4) — none of those
 * may drive the CC1 state machine.
 */
export function decodeControl(b1: number, b2: number): ControlCommand | null {
  if (b1 === 0x14) {
    switch (b2) {
      case 0x20:
        return 'RCL';
      case 0x24:
        return null; // DER (delete to end of row) — unsupported, ignore
      case 0x25:
        return 'RU2';
      case 0x26:
        return 'RU3';
      case 0x27:
        return 'RU4';
      case 0x29:
        return 'RDC';
      case 0x2c:
        return 'EDM';
      case 0x2d:
        return 'CR';
      case 0x2e:
        return 'ENM';
      case 0x2f:
        return 'EOC';
    }
  }
  if (b1 === 0x17 && b2 >= 0x21 && b2 <= 0x23) {
    return b2 === 0x21 ? 'TO1' : b2 === 0x22 ? 'TO2' : 'TO3';
  }
  return null;
}
