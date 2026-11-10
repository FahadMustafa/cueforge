import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decode, encodeUtf8 } from './decode';
import { TEXT_FORMATS, type TextFormatId } from '../formats/registry';

/**
 * Encoding test suite (spec §6.3 #5): the Arabic fixture, supplied as UTF-8,
 * UTF-16LE, and UTF-16BE bytes (each with a BOM), must decode + parse to an
 * identical document.
 */

function utf8WithBom(s: string): Uint8Array {
  return Uint8Array.from([0xef, 0xbb, 0xbf, ...encodeUtf8(s)]);
}
function utf16le(s: string): Uint8Array {
  const out: number[] = [0xff, 0xfe];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c & 0xff, c >> 8);
  }
  return Uint8Array.from(out);
}
function utf16be(s: string): Uint8Array {
  const out: number[] = [0xfe, 0xff];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c >> 8, c & 0xff);
  }
  return Uint8Array.from(out);
}

const dir = resolve(process.cwd(), 'fixtures');

describe('encoding suite: Arabic fixture parses identically across encodings', () => {
  for (const fmt of Object.keys(TEXT_FORMATS) as TextFormatId[]) {
    it(`${fmt}: UTF-8 / UTF-16LE / UTF-16BE produce the same document`, () => {
      const ext = TEXT_FORMATS[fmt].extensions[0].replace('.', '');
      const text = readFileSync(resolve(dir, fmt, `arabic.${ext}`), 'utf8');
      const parse = TEXT_FORMATS[fmt].parse;

      const fromUtf8 = parse(decode(utf8WithBom(text)).text);
      const fromLe = parse(decode(utf16le(text)).text);
      const fromBe = parse(decode(utf16be(text)).text);

      expect(decode(utf8WithBom(text)).encoding).toBe('utf-8');
      expect(decode(utf16le(text)).encoding).toBe('utf-16le');
      expect(decode(utf16be(text)).encoding).toBe('utf-16be');

      expect(fromLe).toEqual(fromUtf8);
      expect(fromBe).toEqual(fromUtf8);
    });
  }
});
