import { describe, expect, it } from 'vitest';
import { TEXT_FORMATS, TEXT_FORMAT_IDS, getTextFormat } from './registry';

describe('text-format registry', () => {
  it('exposes the registered text formats by id', () => {
    expect(TEXT_FORMAT_IDS).toEqual(['srt', 'vtt', 'sbv', 'ass']);
  });

  it('exposes the ASS codec with both extensions', () => {
    const ass = getTextFormat('ass');
    expect(ass.extensions).toEqual(['.ass', '.ssa']);
    expect(typeof ass.parse).toBe('function');
    expect(typeof ass.serialize).toBe('function');
  });

  it('getTextFormat returns a codec with parse/serialize and extensions', () => {
    const srt = getTextFormat('srt');
    expect(srt).toBe(TEXT_FORMATS.srt);
    expect(srt.extensions).toContain('.srt');
    expect(typeof srt.parse).toBe('function');
    expect(typeof srt.serialize).toBe('function');
  });
});
