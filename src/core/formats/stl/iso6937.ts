/**
 * ISO/IEC 6937 character coding for the EBU-STL Latin code table (CCT 00).
 *
 * EBU Tech 3264 §4 declares ISO 6937 — not Latin-1 — for CCT 00. The 0x20–0x7E
 * region is ASCII; 0xA0–0xFF is the supplementary set of spacing characters;
 * and 0xC1–0xCF are *non-spacing diacritical marks that PRECEDE the base
 * letter* (e.g. 0xC1 0x61 = à, 0xC2 0x65 = é). On decode the diacritic byte is
 * mapped to its Unicode combining mark, appended after the base letter and
 * normalised to NFC; on encode the character is NFD-decomposed and the
 * combining mark mapped back to the prefix byte. Characters with no ISO 6937
 * representation encode to 0x20 (space).
 */

/** Spacing characters of the ISO 6937 supplementary set (0xA0–0xFF). */
export const ISO6937_SINGLE: Readonly<Record<number, string>> = {
  0xa0: ' ',
  0xa1: '¡',
  0xa2: '¢',
  0xa3: '£',
  0xa4: '$',
  0xa5: '¥',
  0xa7: '§',
  0xa8: '¤',
  0xa9: '‘',
  0xaa: '“',
  0xab: '«',
  0xac: '←',
  0xad: '↑',
  0xae: '→',
  0xaf: '↓',
  0xb0: '°',
  0xb1: '±',
  0xb2: '²',
  0xb3: '³',
  0xb4: '×',
  0xb5: 'µ',
  0xb6: '¶',
  0xb7: '·',
  0xb8: '÷',
  0xb9: '’',
  0xba: '”',
  0xbb: '»',
  0xbc: '¼',
  0xbd: '½',
  0xbe: '¾',
  0xbf: '¿',
  0xd0: '―',
  0xd1: '¹',
  0xd2: '®',
  0xd3: '©',
  0xd4: '™',
  0xd5: '♪',
  0xd6: '¬',
  0xd7: '¦',
  0xdc: '⅛',
  0xdd: '⅜',
  0xde: '⅝',
  0xdf: '⅞',
  0xe0: 'Ω',
  0xe1: 'Æ',
  0xe2: 'Đ',
  0xe3: 'ª',
  0xe4: 'Ħ',
  0xe6: 'Ĳ',
  0xe7: 'Ŀ',
  0xe8: 'Ł',
  0xe9: 'Ø',
  0xea: 'Œ',
  0xeb: 'º',
  0xec: 'Þ',
  0xed: 'Ŧ',
  0xee: 'Ŋ',
  0xef: 'ŉ',
  0xf0: 'ĸ',
  0xf1: 'æ',
  0xf2: 'đ',
  0xf3: 'ð',
  0xf4: 'ħ',
  0xf5: 'ı',
  0xf6: 'ĳ',
  0xf7: 'ŀ',
  0xf8: 'ł',
  0xf9: 'ø',
  0xfa: 'œ',
  0xfb: 'ß',
  0xfc: 'þ',
  0xfd: 'ŧ',
  0xfe: 'ŋ',
};

/** Non-spacing diacritics (0xC1–0xCF) → Unicode combining marks. */
export const ISO6937_COMBINING: Readonly<Record<number, string>> = {
  0xc1: '\u0300', // grave
  0xc2: '\u0301', // acute
  0xc3: '\u0302', // circumflex
  0xc4: '\u0303', // tilde
  0xc5: '\u0304', // macron
  0xc6: '\u0306', // breve
  0xc7: '\u0307', // dot above
  0xc8: '\u0308', // diaeresis
  0xca: '\u030a', // ring above
  0xcb: '\u0327', // cedilla
  0xcd: '\u030b', // double acute
  0xce: '\u0328', // ogonek
  0xcf: '\u030c', // caron
};

const SINGLE_REVERSE: Readonly<Record<string, number>> = (() => {
  const m: Record<string, number> = {};
  for (const [byte, ch] of Object.entries(ISO6937_SINGLE)) if (!(ch in m)) m[ch] = Number(byte);
  return m;
})();

const COMBINING_REVERSE: Readonly<Record<string, number>> = (() => {
  const m: Record<string, number> = {};
  for (const [byte, mark] of Object.entries(ISO6937_COMBINING)) m[mark] = Number(byte);
  return m;
})();

/**
 * Combine a base character with a pending Unicode combining mark, precomposing
 * to the NFC form (e.g. 'a' + U+0300 → 'à').
 */
export function composeIso6937(base: string, combiningMark: string): string {
  return (base + combiningMark).normalize('NFC');
}

/**
 * Encode one character to its ISO 6937 byte sequence: ASCII as-is, the
 * supplementary set as one byte, accented letters as diacritic-prefix + base,
 * anything else as 0x20.
 */
export function encodeIso6937Char(ch: string): number[] {
  const code = ch.codePointAt(0)!;
  if (code >= 0x20 && code <= 0x7e) return [code];
  const single = SINGLE_REVERSE[ch];
  if (single !== undefined) return [single];
  const nfd = ch.normalize('NFD');
  if (nfd.length === 2) {
    const base = nfd.codePointAt(0)!;
    const diacritic = COMBINING_REVERSE[nfd[1]!];
    if (diacritic !== undefined && base >= 0x20 && base <= 0x7e) return [diacritic, base];
  }
  return [0x20];
}

/**
 * Whether ISO 6937 can represent a character, i.e. {@link encodeIso6937Char}
 * would not fall back to the 0x20 space replacement (space itself is fine).
 */
export function canEncodeIso6937(ch: string): boolean {
  if (ch === ' ') return true;
  const bytes = encodeIso6937Char(ch);
  return !(bytes.length === 1 && bytes[0] === 0x20);
}
