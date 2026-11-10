import { describe, expect, it } from 'vitest';
import {
  canEncodeIso6937,
  composeIso6937,
  encodeIso6937Char,
  ISO6937_COMBINING,
  ISO6937_SINGLE,
} from './iso6937';

describe('ISO 6937 single-byte supplementary set', () => {
  it('round-trips every spacing character through encode', () => {
    for (const [byte, ch] of Object.entries(ISO6937_SINGLE)) {
      if (ch.charCodeAt(0) <= 0x7e) continue; // '$' (0xA4) prefers its ASCII byte
      expect(encodeIso6937Char(ch), `0x${Number(byte).toString(16)} (${ch})`).toEqual([
        Number(byte),
      ]);
    }
  });

  it('differs from Latin-1 where ISO 6937 diverges', () => {
    expect(ISO6937_SINGLE[0xe9]).toBe('Ø'); // Latin-1 would say é
    expect(ISO6937_SINGLE[0xfb]).toBe('ß'); // Latin-1 would say û
    expect(ISO6937_SINGLE[0xd5]).toBe('♪');
  });
});

describe('ISO 6937 combining sequences', () => {
  it('composes every diacritic with a suitable base letter and encodes back', () => {
    // A base letter for which each diacritic has a precomposed NFC form.
    const bases: Record<number, string> = {
      0xc1: 'a', // à
      0xc2: 'e', // é
      0xc3: 'o', // ô
      0xc4: 'n', // ñ
      0xc5: 'a', // ā
      0xc6: 'g', // ğ
      0xc7: 'z', // ż
      0xc8: 'u', // ü
      0xca: 'a', // å
      0xcb: 'c', // ç
      0xcd: 'o', // ő
      0xce: 'e', // ę
      0xcf: 's', // š
    };
    for (const [byteStr, mark] of Object.entries(ISO6937_COMBINING)) {
      const byte = Number(byteStr);
      const base = bases[byte]!;
      const composed = composeIso6937(base, mark);
      expect(composed.length, `0x${byte.toString(16)}`).toBe(1); // precomposed
      expect(encodeIso6937Char(composed)).toEqual([byte, base.charCodeAt(0)]);
    }
  });

  it('handles uppercase bases too (É → acute + E)', () => {
    expect(encodeIso6937Char('É')).toEqual([0xc2, 0x45]);
  });
});

describe('encodeIso6937Char fallbacks', () => {
  it('passes ASCII through unchanged', () => {
    expect(encodeIso6937Char('A')).toEqual([0x41]);
    expect(encodeIso6937Char(' ')).toEqual([0x20]);
    expect(encodeIso6937Char('~')).toEqual([0x7e]);
  });

  it('returns 0x20 for unrepresentable characters', () => {
    expect(encodeIso6937Char('あ')).toEqual([0x20]);
    expect(encodeIso6937Char('€')).toEqual([0x20]);
    // Decomposable but with a combining mark outside the ISO 6937 set.
    expect(encodeIso6937Char('ả')).toEqual([0x20]); // hook above (U+0309)
  });
});

describe('canEncodeIso6937', () => {
  it('accepts ASCII (including the space, which is its own byte)', () => {
    expect(canEncodeIso6937('A')).toBe(true);
    expect(canEncodeIso6937(' ')).toBe(true);
  });

  it('accepts the supplementary set and composable accented letters', () => {
    expect(canEncodeIso6937('Ω')).toBe(true);
    expect(canEncodeIso6937('é')).toBe(true);
    expect(canEncodeIso6937('É')).toBe(true);
  });

  it('rejects characters that would encode to the 0x20 fallback', () => {
    expect(canEncodeIso6937('س')).toBe(false); // Arabic
    expect(canEncodeIso6937('あ')).toBe(false); // CJK
    expect(canEncodeIso6937('€')).toBe(false);
    expect(canEncodeIso6937('ả')).toBe(false); // hook above, outside the set
  });
});
