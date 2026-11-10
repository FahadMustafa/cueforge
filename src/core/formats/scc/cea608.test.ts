import { describe, expect, it } from 'vitest';
import {
  canEncodeCea608,
  decodeControl,
  decodeExtendedChar,
  decodeMidRow,
  decodePac,
  encodeChar,
  frameToTimecode,
  hasOddParity,
  isDropFrameTimecode,
  isPac,
  msToFrame,
  SPECIAL_CHARS,
  timecodeToFrame,
} from './cea608';

describe('parity', () => {
  it('hasOddParity reflects the one-bit count', () => {
    expect(hasOddParity(0x94)).toBe(true); // 0x14 + parity
    expect(hasOddParity(0x14)).toBe(false); // even one-bits, no parity
  });
});

describe('timecode ↔ frame', () => {
  it('detects the drop-frame separator', () => {
    expect(isDropFrameTimecode('00:00:01;00')).toBe(true);
    expect(isDropFrameTimecode('00:00:01:00')).toBe(false);
    expect(isDropFrameTimecode('garbage')).toBe(false);
  });

  it('throws on an invalid timecode', () => {
    expect(() => timecodeToFrame('not-a-tc')).toThrow();
  });

  it('round-trips non-drop frame ↔ timecode', () => {
    for (const tc of ['00:00:00:00', '00:00:01:15', '01:02:03:29']) {
      expect(frameToTimecode(timecodeToFrame(tc), false)).toBe(tc);
    }
  });

  it('round-trips drop-frame frame ↔ timecode', () => {
    for (const tc of ['00:00:01;00', '00:01:00;02', '00:10:00;00', '01:00:00;00']) {
      expect(frameToTimecode(timecodeToFrame(tc), true)).toBe(tc);
    }
  });

  it('msToFrame inverts frameToMs on frame-aligned values', () => {
    for (const f of [0, 1, 30, 1800, 17982]) {
      // frameToMs then back lands on the same frame.
      expect(msToFrame(Math.round((f * 1001) / 30))).toBe(f);
    }
  });
});

describe('PAC decoding', () => {
  it('recognizes valid PAC byte pairs', () => {
    expect(isPac(0x14, 0x60)).toBe(true); // row 15 white
    expect(isPac(0x11, 0x20)).toBe(false); // mid-row, not a PAC
    expect(isPac(0x14, 0x2f)).toBe(false); // control code
  });

  it('decodes row, indent, italics and underline', () => {
    expect(decodePac(0x14, 0x60)).toMatchObject({ row: 15, indent: 0, italic: false });
    expect(decodePac(0x14, 0x40)).toMatchObject({ row: 14, indent: 0 });
    // Italics PAC (style index 7) on row 15: x=0x4e -> b2=0x6e.
    expect(decodePac(0x14, 0x6e)).toMatchObject({ row: 15, italic: true });
    // Indent PAC: x with 0x10 bit set -> column = ((x&0x0e)>>1)*4.
    expect(decodePac(0x14, 0x72)).toMatchObject({ row: 15, indent: 4 });
    // Underline bit.
    expect(decodePac(0x10, 0x41)).toMatchObject({ row: 11, underline: true });
  });
});

describe('mid-row decoding', () => {
  it('decodes colours, underline and italics', () => {
    expect(decodeMidRow(0x20)).toEqual({ italic: false, underline: false, color: 'white' });
    expect(decodeMidRow(0x29)).toEqual({ italic: false, underline: true, color: 'red' });
    expect(decodeMidRow(0x2e)).toEqual({ italic: true, underline: false });
    expect(decodeMidRow(0x2f)).toEqual({ italic: true, underline: true });
  });
});

describe('control decoding', () => {
  it('maps miscellaneous control codes', () => {
    expect(decodeControl(0x14, 0x20)).toBe('RCL');
    expect(decodeControl(0x14, 0x2f)).toBe('EOC');
    expect(decodeControl(0x14, 0x2c)).toBe('EDM');
    expect(decodeControl(0x14, 0x2e)).toBe('ENM');
    expect(decodeControl(0x14, 0x29)).toBe('RDC');
    expect(decodeControl(0x14, 0x2d)).toBe('CR');
    expect(decodeControl(0x14, 0x25)).toBe('RU2');
    expect(decodeControl(0x14, 0x26)).toBe('RU3');
    expect(decodeControl(0x14, 0x27)).toBe('RU4');
    expect(decodeControl(0x17, 0x21)).toBe('TO1');
    expect(decodeControl(0x17, 0x23)).toBe('TO3');
  });

  it('returns null for non-control words', () => {
    expect(decodeControl(0x41, 0x42)).toBeNull();
    expect(decodeControl(0x14, 0x24)).toBeNull(); // DER, unsupported
  });

  it('does not treat 0x15-prefixed (field-2 CC3) controls as channel 1 (cue-forge-c0h)', () => {
    expect(decodeControl(0x15, 0x20)).toBeNull(); // CC3 RCL
    expect(decodeControl(0x15, 0x2f)).toBeNull(); // CC3 EOC
  });
});

describe('extended characters (cue-forge-12v)', () => {
  it('decodes the 0x12 (Spanish/Misc/French) set', () => {
    expect(decodeExtendedChar(0x12, 0x25)).toBe('ü');
    expect(decodeExtendedChar(0x12, 0x27)).toBe('¡');
    expect(decodeExtendedChar(0x12, 0x2a)).toBe('—');
    expect(decodeExtendedChar(0x12, 0x3e)).toBe('«');
    expect(decodeExtendedChar(0x12, 0x3f)).toBe('»');
  });

  it('decodes the 0x13 (Portuguese/German/Danish) set', () => {
    expect(decodeExtendedChar(0x13, 0x31)).toBe('ä');
    expect(decodeExtendedChar(0x13, 0x34)).toBe('ß');
    expect(decodeExtendedChar(0x13, 0x38)).toBe('Å');
    expect(decodeExtendedChar(0x13, 0x3b)).toBe('ø');
  });

  it('returns null outside the extended ranges', () => {
    expect(decodeExtendedChar(0x12, 0x40)).toBeNull();
    expect(decodeExtendedChar(0x11, 0x25)).toBeNull();
    expect(decodeExtendedChar(0x14, 0x25)).toBeNull();
  });

  it('encodeChar emits fallback + extended pair for extended characters', () => {
    expect(encodeChar('ü')).toEqual([
      { kind: 'extended', fallback: 'u'.charCodeAt(0), b1: 0x12, b2: 0x25 },
    ]);
    expect(encodeChar('ß')).toEqual([
      { kind: 'extended', fallback: 's'.charCodeAt(0), b1: 0x13, b2: 0x34 },
    ]);
    expect(encodeChar('«')).toEqual([
      { kind: 'extended', fallback: '"'.charCodeAt(0), b1: 0x12, b2: 0x3e },
    ]);
  });

  it('encodeChar still prefers basic and special encodings over extended', () => {
    expect(encodeChar('é')).toEqual([{ kind: 'basic', byte: 0x5c }]);
    expect(encodeChar('à')).toEqual([{ kind: 'special', b2: 0x38 }]);
  });
});

describe('special characters', () => {
  it('maps the musical note and degree sign', () => {
    expect(SPECIAL_CHARS[0x37]).toBe('♪');
    expect(SPECIAL_CHARS[0x31]).toBe('°');
  });
});

describe('canEncodeCea608', () => {
  it('accepts the basic, special, and extended sets', () => {
    expect(canEncodeCea608('A')).toBe(true);
    expect(canEncodeCea608('?')).toBe(true);
    expect(canEncodeCea608('é')).toBe(true); // basic override
    expect(canEncodeCea608('à')).toBe(true); // special char
    expect(canEncodeCea608('ü')).toBe(true); // extended set
    expect(canEncodeCea608('ß')).toBe(true); // extended set
  });

  it('accepts transliterations and diacritic-strippable letters', () => {
    expect(canEncodeCea608('…')).toBe(true); // → "..."
    expect(canEncodeCea608('–')).toBe(true); // → "-"
    expect(canEncodeCea608('ą')).toBe(true); // strips to "a"
  });

  it('rejects characters that would fall back to "?"', () => {
    expect(canEncodeCea608('س')).toBe(false); // Arabic
    expect(canEncodeCea608('あ')).toBe(false); // CJK
    expect(canEncodeCea608('€')).toBe(false);
  });
});
