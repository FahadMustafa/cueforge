import { describe, expect, it } from 'vitest';
import { decode, detectEncoding, detectNewline, encodeUtf8 } from './decode';

// --- byte builders (test helpers) -------------------------------------------
function utf8(s: string, bom = false): Uint8Array {
  const body = new TextEncoder().encode(s);
  if (!bom) return body;
  return Uint8Array.from([0xef, 0xbb, 0xbf, ...body]);
}
function utf16le(s: string, bom = false): Uint8Array {
  const out: number[] = bom ? [0xff, 0xfe] : [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c & 0xff, c >> 8);
  }
  return Uint8Array.from(out);
}
function utf16be(s: string, bom = false): Uint8Array {
  const out: number[] = bom ? [0xfe, 0xff] : [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c >> 8, c & 0xff);
  }
  return Uint8Array.from(out);
}

const ARABIC = 'مرحبا بالعالم — Netflix ١٢٣';
// Arabic with spaces but no Latin/digits: high bytes are dominated by 0x06, so
// zero-byte counting alone cannot detect the UTF-16 lane.
const ARABIC_ONLY = 'مرحبا بالعالم اليوم الجو جميل جدا في المدينة القديمة';

describe('detectEncoding', () => {
  it('detects UTF-8 without BOM', () => {
    expect(detectEncoding(utf8('hello'))).toEqual({
      encoding: 'utf-8',
      hadBom: false,
      bomLength: 0,
    });
  });
  it('detects UTF-8 BOM', () => {
    expect(detectEncoding(utf8('hello', true))).toEqual({
      encoding: 'utf-8',
      hadBom: true,
      bomLength: 3,
    });
  });
  it('detects UTF-16LE BOM', () => {
    expect(detectEncoding(utf16le('hi', true))).toEqual({
      encoding: 'utf-16le',
      hadBom: true,
      bomLength: 2,
    });
  });
  it('detects UTF-16BE BOM', () => {
    expect(detectEncoding(utf16be('hi', true))).toEqual({
      encoding: 'utf-16be',
      hadBom: true,
      bomLength: 2,
    });
  });
  it('detects BOM-less UTF-16LE via null-byte heuristic', () => {
    expect(detectEncoding(utf16le('hello world')).encoding).toBe('utf-16le');
  });
  it('detects BOM-less UTF-16BE via null-byte heuristic', () => {
    expect(detectEncoding(utf16be('hello world')).encoding).toBe('utf-16be');
  });

  // Latin-free Arabic: high bytes are ~all 0x06, so the old null-byte heuristic
  // (which keyed on 0x00) fell back to UTF-8 and produced mojibake.
  it('detects BOM-less UTF-16LE for Latin-free Arabic text', () => {
    expect(detectEncoding(utf16le(ARABIC_ONLY)).encoding).toBe('utf-16le');
  });
  it('detects BOM-less UTF-16BE for Latin-free Arabic text', () => {
    expect(detectEncoding(utf16be(ARABIC_ONLY)).encoding).toBe('utf-16be');
  });
  it('does not misdetect BOM-less UTF-8 Arabic as UTF-16', () => {
    expect(detectEncoding(utf8(ARABIC_ONLY)).encoding).toBe('utf-8');
  });
  it('does not misdetect plain UTF-8 Latin text as UTF-16', () => {
    expect(detectEncoding(utf8('The quick brown fox jumps over the lazy dog.')).encoding).toBe(
      'utf-8',
    );
  });
});

describe('decode (BOM-less UTF-16, non-Latin)', () => {
  it('round-trips BOM-less UTF-16LE/BE Arabic to the original text', () => {
    expect(decode(utf16le(ARABIC_ONLY)).text).toBe(ARABIC_ONLY);
    expect(decode(utf16be(ARABIC_ONLY)).text).toBe(ARABIC_ONLY);
  });
});

describe('detectNewline', () => {
  it('lf', () => expect(detectNewline('a\nb\nc')).toBe('lf'));
  it('crlf', () => expect(detectNewline('a\r\nb\r\nc')).toBe('crlf'));
  it('mixed', () => expect(detectNewline('a\r\nb\nc')).toBe('mixed'));
  it('none', () => expect(detectNewline('abc')).toBe('none'));
});

describe('decode', () => {
  it('decodes UTF-8 and strips BOM', () => {
    const r = decode(utf8('héllo\nworld', true));
    expect(r.text).toBe('héllo\nworld');
    expect(r.encoding).toBe('utf-8');
    expect(r.hadBom).toBe(true);
    expect(r.newline).toBe('lf');
  });

  it('never leaves a BOM character at the start', () => {
    expect(decode(utf8('x', true)).text.charCodeAt(0)).not.toBe(0xfeff);
    expect(decode(utf16le('x', true)).text.charCodeAt(0)).not.toBe(0xfeff);
    expect(decode(utf16be('x', true)).text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('decodes the same Arabic text from UTF-8 / UTF-16LE / UTF-16BE identically', () => {
    const fromU8 = decode(utf8(ARABIC, true)).text;
    const fromLe = decode(utf16le(ARABIC, true)).text;
    const fromBe = decode(utf16be(ARABIC, true)).text;
    expect(fromU8).toBe(ARABIC);
    expect(fromLe).toBe(ARABIC);
    expect(fromBe).toBe(ARABIC);
  });
});

describe('decode (legacy code-page fallback, cue-forge-1wx)', () => {
  // 'السلام' in windows-1256 — invalid as UTF-8, so the old decoder silently
  // produced U+FFFD mojibake.
  const CP1256_ARABIC = Uint8Array.from([0xc7, 0xe1, 0xd3, 0xe1, 0xc7, 0xe3]);
  // 'café' in windows-1252.
  const CP1252_CAFE = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);

  it('decodes windows-1256 Arabic bytes to Arabic with a legacy-code-page warning', () => {
    const expected = new TextDecoder('windows-1256').decode(CP1256_ARABIC);
    expect(expected).toBe('السلام'); // sanity-check the fixture bytes
    const r = decode(CP1256_ARABIC);
    expect(r.text).toBe(expected);
    expect(r.encoding).toBe('windows-1256');
    expect(r.warning).toMatch(/windows-1256/);
  });

  it('decodes windows-1252 accented Latin bytes as windows-1252', () => {
    const r = decode(CP1252_CAFE);
    expect(r.text).toBe('café');
    expect(r.encoding).toBe('windows-1252');
    expect(r.warning).toMatch(/windows-1252/);
  });

  it('keeps cp1252 French with uppercase accents as windows-1252 (Ç is not Arabic)', () => {
    // 'Ça va très bien': Ç=0xC7 decodes to Arabic ا in cp1256, but only 1 of
    // the 2 high bytes is Arabic-looking — one stray char must not flip the
    // whole file to windows-1256.
    const bytes = Uint8Array.from([
      0xc7,
      ...new TextEncoder().encode('a va tr'),
      0xe8,
      ...new TextEncoder().encode('s bien'),
    ]);
    expect(new TextDecoder('windows-1252').decode(bytes)).toBe('Ça va très bien'); // fixture sanity
    const r = decode(bytes);
    expect(r.text).toBe('Ça va très bien');
    expect(r.encoding).toBe('windows-1252');
    expect(r.warning).toMatch(/windows-1252/);
  });

  it('picks windows-1252 for high bytes outside the 0xC0–0xFF range (curly quotes)', () => {
    // The exact 0x80–0x9F mapping differs between ICU (Node) and WHATWG
    // (browsers), so compare against the platform decoder, not a literal.
    const bytes = Uint8Array.from([0x93, 0x74, 0x65, 0x73, 0x74, 0x94]); // “test”
    const r = decode(bytes);
    expect(r.text).toBe(new TextDecoder('windows-1252').decode(bytes));
    expect(r.encoding).toBe('windows-1252');
  });

  it('falls back on the absolute threshold for long mostly-ASCII texts', () => {
    // 5 bad bytes in 305 is < 2% but > 4 absolute.
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode('a'.repeat(300)),
      0x93,
      0x93,
      0x93,
      0x93,
      0x93,
    ]);
    const r = decode(bytes);
    expect(r.encoding).toBe('windows-1252');
    expect(r.text).toBe(new TextDecoder('windows-1252').decode(bytes));
  });

  it('keeps valid BOM-less UTF-8 (incl. non-ASCII) as utf-8 with no warning', () => {
    const r = decode(utf8('héllo، السلام'));
    expect(r.text).toBe('héllo، السلام');
    expect(r.encoding).toBe('utf-8');
    expect(r.warning).toBeUndefined();
  });

  it('does not second-guess a UTF-8 BOM even when the body is malformed', () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0xe9]);
    const r = decode(bytes);
    expect(r.encoding).toBe('utf-8');
    expect(r.warning).toBeUndefined();
  });

  it('tolerates a tiny replacement ratio in long otherwise-valid UTF-8', () => {
    // 1 bad byte in ~300 chars: below both thresholds, so no fallback.
    const bytes = Uint8Array.from([...new TextEncoder().encode('a'.repeat(300)), 0xe9]);
    const r = decode(bytes);
    expect(r.encoding).toBe('utf-8');
    expect(r.warning).toBeUndefined();
  });
});

describe('encodeUtf8', () => {
  it('round-trips through decode', () => {
    const bytes = encodeUtf8(ARABIC);
    expect(decode(bytes).text).toBe(ARABIC);
  });
  it('emits no BOM', () => {
    const bytes = encodeUtf8('x');
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
  });
});
