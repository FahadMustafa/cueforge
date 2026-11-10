/**
 * Script-agnostic RTL primitives (spec §5.3). These are the building blocks for
 * the Arabic/RTL QC rules 15–19; everything here operates on any RTL script
 * (Arabic, Hebrew, Persian/Farsi, …) so a rule built on them never crashes on
 * non-Arabic input. The rules themselves (cue/document logic) live in
 * `src/core/qc/rules/`; this module holds only the pure character and string
 * helpers they share.
 */

/** Right-to-Left Mark — forces RTL directionality on neutral characters. */
export const RLM = '‏';
/** Left-to-Right Mark — forces LTR directionality on neutral characters. */
export const LRM = '‎';
/** Arabic Letter Mark — an RLM-like mark that takes Arabic-Indic digit shaping. */
export const ALM = '؜';
/** Tatweel / kashida — a spacing elongation character, often misused as padding. */
export const TATWEEL = 'ـ';

/**
 * Code-point ranges of the invisible bidi formatting/control marks: LRM/RLM, the
 * Arabic Letter Mark, the embedding/override family (U+202A–U+202E) and the
 * isolates (U+2066–U+2069). They have zero advance width, so they must not count
 * toward reading speed (`max-cps`); otherwise the marks the RTL fixers insert
 * (RLM for bidi-punctuation, LRM for latin-run-isolation) would nudge a cue over
 * the CPS limit and the zero-new-issues guard would revert those fixes. Inclusive.
 */
export const BIDI_CONTROL_RANGES: [number, number][] = [
  [0x200e, 0x200f],
  [0x061c, 0x061c],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

const TATWEEL_CP = TATWEEL.codePointAt(0)!;

// Strong RTL scripts. JS regex exposes `\p{Script=…}` but not `\p{Bidi_Class}`,
// so we enumerate the right-to-left scripts we care about. Arabic covers
// Persian/Farsi and Urdu (same script); the rest keep the engine script-agnostic.
const RTL_RE =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
const LATIN_LETTER_RE = /\p{Script=Latin}/u;
// Nonspacing marks (\p{Mn}, e.g. Arabic harakat, Hebrew points) render with zero
// advance width; default-ignorable format chars (\p{Cf}, e.g. the bidi marks
// above) are invisible. Both must count as zero-width for line-length purposes.
const ZERO_WIDTH_RE = /[\p{Mn}\p{Cf}]/u;

function test(re: RegExp, cp: number): boolean {
  return re.test(String.fromCodePoint(cp));
}

/** True for a strong right-to-left character (any supported RTL script). */
export function isRtl(cp: number): boolean {
  return test(RTL_RE, cp);
}

/** True when the text contains at least one strong RTL character. */
export function hasRtl(text: string): boolean {
  return RTL_RE.test(text);
}

/** True for a Latin-script letter (used to isolate Latin runs in RTL text). */
export function isLatinLetter(cp: number): boolean {
  return test(LATIN_LETTER_RE, cp);
}

/** True for a zero-width combining mark or invisible bidi/format control. */
export function isCombiningMark(cp: number): boolean {
  return test(ZERO_WIDTH_RE, cp);
}

/** True for the tatweel/kashida elongation character (U+0640). */
export function isTatweel(cp: number): boolean {
  return cp === TATWEEL_CP;
}

/**
 * Visible length in code points: combining diacritics (zero advance width) and
 * invisible bidi/format marks do not count, so inserting an RLM/LRM or stacking
 * harakat never inflates a line's measured length (spec §5.3 rule 18).
 */
export function visibleLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (!isCombiningMark(ch.codePointAt(0)!)) n++;
  }
  return n;
}

/** Remove every tatweel from the text, leaving all other characters intact. */
export function stripTatweel(text: string): string {
  return [...text].filter((ch) => !isTatweel(ch.codePointAt(0)!)).join('');
}

/** The three digit families subtitle text mixes (spec §5.3 rule 16). */
export type DigitStyle = 'western' | 'arabic-indic' | 'extended-arabic-indic';

/** Inclusive code-point base of each digit family's `0`. */
const DIGIT_BASE: Record<DigitStyle, number> = {
  western: 0x0030, // 0-9
  'arabic-indic': 0x0660, // ٠-٩
  'extended-arabic-indic': 0x06f0, // ۰-۹ (Persian/Urdu)
};

/** The digit family of a code point, or `null` when it is not a 0–9 digit. */
export function digitStyle(cp: number): DigitStyle | null {
  for (const style of Object.keys(DIGIT_BASE) as DigitStyle[]) {
    const base = DIGIT_BASE[style];
    if (cp >= base && cp <= base + 9) return style;
  }
  return null;
}

/** Rewrite every digit to `target`'s family, preserving value and non-digits. */
export function convertDigits(text: string, target: DigitStyle): string {
  const base = DIGIT_BASE[target];
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const style = digitStyle(cp);
    out += style === null ? ch : String.fromCodePoint(base + (cp - DIGIT_BASE[style]));
  }
  return out;
}
