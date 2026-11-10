import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CharsetUnsupportedError,
  detectFormatFromName,
  detectImportFormat,
  exportDocument,
  exportProDocument,
  FileTooLargeError,
  friendlyErrorMessage,
  friendlyLoadError,
  importBytes,
  importFile,
  MAX_IMPORT_BYTES,
  normalizeSourceFormat,
  ProImportLockedError,
  retargetFilename,
  UnknownFormatError,
} from './session';

const enc = (s: string) => new TextEncoder().encode(s);
const fixture = (rel: string) =>
  new Uint8Array(readFileSync(resolve(process.cwd(), 'fixtures', rel)));

/** A 16-byte EBU-STL GSI head: the "STL25.01" Disk Format Code sits at byte 3. */
function stlHead(): Uint8Array {
  const b = new Uint8Array(16);
  b.set(enc('850'), 0); // Code Page Number
  b.set(enc('STL25.01'), 3); // Disk Format Code
  return b;
}

const SRT = `1
00:00:01,000 --> 00:00:02,000
Hello

2
00:00:03,000 --> 00:00:04,000
World
`;

describe('detectFormatFromName', () => {
  it('maps known extensions to format ids', () => {
    expect(detectFormatFromName('a.srt')).toBe('srt');
    expect(detectFormatFromName('a.VTT')).toBe('vtt');
    expect(detectFormatFromName('clip.ssa')).toBe('ass');
  });

  it('returns null for unknown or extensionless names', () => {
    expect(detectFormatFromName('a.txt')).toBeNull();
    expect(detectFormatFromName('noext')).toBeNull();
  });
});

describe('importBytes', () => {
  it('surfaces the decoder warning when assuming a legacy code page', () => {
    const text = '1\n00:00:01,000 --> 00:00:02,000\n' + 'café '.repeat(12) + '\n';
    const loaded = importBytes(
      'legacy.srt',
      Uint8Array.from(text, (character) => character.charCodeAt(0)),
    );
    expect(loaded.encoding).toBe('windows-1252');
    expect(loaded.parseWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'encoding-assumed',
        }),
      ]),
    );
    expect(
      loaded.parseWarnings.find((warning) => warning.code === 'encoding-assumed')?.message,
    ).toContain('windows-1252');
  });

  it('decodes, parses, and repairs an SRT file', () => {
    const loaded = importBytes('movie.srt', enc(SRT));
    expect(loaded.sourceFormat).toBe('srt');
    expect(loaded.doc.cues).toHaveLength(2);
    expect(loaded.encoding).toBe('utf-8');
  });

  it('repairs reversed timing on import and reports it', () => {
    const reversed = `1
00:00:05,000 --> 00:00:02,000
Reversed
`;
    const loaded = importBytes('bad.srt', enc(reversed));
    const cue = loaded.doc.cues[0]!;
    expect(cue.startMs).toBeLessThanOrEqual(cue.endMs);
    expect(loaded.repairs.some((r) => r.code === 'fix-reversed')).toBe(true);
  });

  it('strips a UTF-8 BOM', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(SRT)]);
    const loaded = importBytes('bom.srt', withBom);
    expect(loaded.hadBom).toBe(true);
    expect(loaded.doc.cues).toHaveLength(2);
  });

  it('throws UnknownFormatError for unrecognized extensions', () => {
    expect(() => importBytes('notes.txt', enc('x'))).toThrow(UnknownFormatError);
  });

  it('warns (does not crash) when a recognized file parses to no cues', () => {
    const loaded = importBytes('garbage.srt', enc('this is not a subtitle file at all'));
    expect(loaded.doc.cues).toHaveLength(0);
    expect(loaded.parseWarnings.some((w) => /no subtitles/i.test(w.message))).toBe(true);
  });
});

describe('friendly load failures (cue-forge-9ww.3)', () => {
  it('rejects pathological oversize input before parsing, with a sizing message', () => {
    const huge = new Uint8Array(MAX_IMPORT_BYTES + 1);
    expect(() => importBytes('huge.srt', huge)).toThrow(FileTooLargeError);
    expect(() => importBytes('huge.srt', huge)).toThrow(/too large|MB/i);
  });

  it('guards oversize input on the unified importFile path too', async () => {
    const huge = new Uint8Array(MAX_IMPORT_BYTES + 1);
    await expect(importFile('huge.srt', huge, { allowPro: true })).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
  });

  it('loads malformed Pro content gracefully (no crash) with an actionable warning', async () => {
    const broken = enc('<tt><body><div><p begin="0s"');
    const loaded = await importFile('broken.ttml', broken, { allowPro: true });
    expect(loaded.doc.cues).toHaveLength(0);
    expect(loaded.parseWarnings.some((w) => /no subtitles|malformed/i.test(w.message))).toBe(true);
  });

  it('friendlyLoadError keeps our errors verbatim and collapses unknowns to a generic line', () => {
    expect(friendlyLoadError(new UnknownFormatError('x.zzz'), 'x.zzz')).toMatch(/unrecognized/i);
    expect(
      friendlyLoadError(new FileTooLargeError('big.srt', MAX_IMPORT_BYTES + 1), 'big.srt'),
    ).toMatch(/too large/i);
    const generic = friendlyLoadError(new Error('TypeError: undefined is not a function'), 'm.srt');
    expect(generic).toMatch(/m\.srt/);
    expect(generic).not.toMatch(/undefined is not a function/);
  });
});

describe('normalizeSourceFormat (cue-forge-sdv.11.6 — loadFreshDocument cast hole)', () => {
  it('passes through every Free text format id unchanged', () => {
    expect(normalizeSourceFormat('srt')).toBe('srt');
    expect(normalizeSourceFormat('vtt')).toBe('vtt');
    expect(normalizeSourceFormat('sbv')).toBe('sbv');
    expect(normalizeSourceFormat('ass')).toBe('ass');
  });

  it('passes through every Pro format id unchanged', () => {
    expect(normalizeSourceFormat('ttml')).toBe('ttml');
    expect(normalizeSourceFormat('scc')).toBe('scc');
    expect(normalizeSourceFormat('stl')).toBe('stl');
    expect(normalizeSourceFormat('itt')).toBe('itt');
    expect(normalizeSourceFormat('imsc101')).toBe('imsc101');
    expect(normalizeSourceFormat('imsc11')).toBe('imsc11');
  });

  it('maps the ASS parser’s legacy "ssa" id to "ass" (not a TextFormatId/ProFormatId member)', () => {
    expect(normalizeSourceFormat('ssa')).toBe('ass');
  });

  it('falls back to "srt" for anything else (defensive — SubtitleFormat is exhaustive today)', () => {
    // @ts-expect-error -- exercising the runtime fallback for a hypothetical future format id
    expect(normalizeSourceFormat('made-up')).toBe('srt');
  });
});

describe('retargetFilename', () => {
  it('swaps the extension for the target format', () => {
    expect(retargetFilename('movie.srt', 'vtt')).toBe('movie.vtt');
    expect(retargetFilename('clip.ass', 'srt')).toBe('clip.srt');
    expect(retargetFilename('noext', 'vtt')).toBe('noext.vtt');
  });
});

describe('friendlyErrorMessage (cue-forge-w28.12)', () => {
  const FALLBACK = 'Something went wrong. Try a different format.';

  it('passes through the messages of our own user-facing error classes', () => {
    const charset = new CharsetUnsupportedError('SCC cannot represent 3 character(s).');
    expect(friendlyErrorMessage(charset, FALLBACK)).toBe(charset.message);
    const unknown = new UnknownFormatError('x.zzz');
    expect(friendlyErrorMessage(unknown, FALLBACK)).toBe(unknown.message);
    const locked = new ProImportLockedError('EBU STL');
    expect(friendlyErrorMessage(locked, FALLBACK)).toBe(locked.message);
    const big = new FileTooLargeError('big.srt', MAX_IMPORT_BYTES + 1);
    expect(friendlyErrorMessage(big, FALLBACK)).toBe(big.message);
  });

  it('collapses unexpected throws to the fallback — no raw exception strings', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(friendlyErrorMessage(new TypeError('x is not a function'), FALLBACK)).toBe(FALLBACK);
    expect(friendlyErrorMessage(new Error('ENOENT: no such file'), FALLBACK)).toBe(FALLBACK);
    expect(friendlyErrorMessage('string throw', FALLBACK)).toBe(FALLBACK);
    expect(friendlyErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
    spy.mockRestore();
  });

  it('preserves the swallowed diagnostic via console.error on the fallback path only (site-review)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // An allowlisted, user-facing error passes through silently…
    friendlyErrorMessage(new UnknownFormatError('x.zzz'), FALLBACK);
    expect(spy).not.toHaveBeenCalled();
    // …but an unexpected throw is logged with the ORIGINAL error before the
    // calm fallback replaces it in the UI.
    const raw = new TypeError('x is not a function');
    friendlyErrorMessage(raw, FALLBACK);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(raw);
    spy.mockRestore();
  });

  it('lets callers whitelist additional expected error classes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    class QuotaError extends Error {}
    const quota = new QuotaError('Storage is full — delete a preset first.');
    expect(friendlyErrorMessage(quota, FALLBACK, [QuotaError])).toBe(quota.message);
    expect(spy).not.toHaveBeenCalled();
    // …without opening the door to arbitrary Errors.
    expect(friendlyErrorMessage(new Error('raw'), FALLBACK, [QuotaError])).toBe(FALLBACK);
    spy.mockRestore();
  });
});

describe('exportDocument', () => {
  it('serializes to the target format with a retargeted filename', () => {
    const loaded = importBytes('movie.srt', enc(SRT));
    const out = exportDocument(loaded, 'vtt');
    expect(out.format).toBe('vtt');
    expect(out.filename).toBe('movie.vtt');
    expect(out.text).toContain('WEBVTT');
    expect(out.text).toContain('Hello');
  });

  it('reports capability-drop warnings when converting to a lossy target', () => {
    const styled = `1
00:00:01,000 --> 00:00:02,000
<i>Hello</i>
`;
    const loaded = importBytes('styled.srt', enc(styled));
    const out = exportDocument(loaded, 'sbv'); // SBV is plain text only
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});

describe('exportProDocument', () => {
  it('serializes a text Pro format (SCC) to a string with a retargeted name', async () => {
    const loaded = importBytes('movie.srt', enc(SRT));
    const out = await exportProDocument(loaded, 'scc');
    expect(out.kind).toBe('text');
    expect(out.format).toBe('scc');
    expect(out.filename).toBe('movie.scc');
    expect(typeof out.text).toBe('string');
    expect(out.text).toContain('Scenarist_SCC');
  });

  it('serializes a binary Pro format (STL) to bytes', async () => {
    const loaded = importBytes('movie.srt', enc(SRT));
    const out = await exportProDocument(loaded, 'stl');
    expect(out.kind).toBe('binary');
    expect(out.filename).toBe('movie.stl');
    expect(out.bytes).toBeInstanceOf(Uint8Array);
    expect(out.bytes!.length).toBeGreaterThan(0);
  });
});

describe('exportProDocument charset preflight (spec §4.2)', () => {
  const ARABIC = `1
00:00:01,000 --> 00:00:02,000
السلام عليكم

2
00:00:03,000 --> 00:00:04,000
مرحبا بالعالم
`;

  const FRENCH = `1
00:00:01,000 --> 00:00:02,000
Le café est prêt
`;

  // Mostly-Latin with one Arabic word: below the 30% failure threshold.
  const MIXED = `1
00:00:01,000 --> 00:00:02,000
The word سلام means peace and more
`;

  it('rejects an Arabic document exported to SCC with a clear error', async () => {
    const loaded = importBytes('arabic.srt', enc(ARABIC));
    await expect(exportProDocument(loaded, 'scc')).rejects.toThrow(CharsetUnsupportedError);
    await expect(exportProDocument(loaded, 'scc')).rejects.toThrow(/cannot represent/i);
  });

  it('rejects an Arabic document exported to STL too', async () => {
    const loaded = importBytes('arabic.srt', enc(ARABIC));
    await expect(exportProDocument(loaded, 'stl')).rejects.toThrow(CharsetUnsupportedError);
  });

  it('exports French to SCC cleanly (extended charset covers it)', async () => {
    const loaded = importBytes('french.srt', enc(FRENCH));
    const out = await exportProDocument(loaded, 'scc');
    expect(out.text).toContain('Scenarist_SCC');
    expect(out.warnings.filter((w) => w.code === 'charset-unrepresentable')).toEqual([]);
  });

  it('warns (but succeeds) when only a small share is unrepresentable', async () => {
    const loaded = importBytes('mixed.srt', enc(MIXED));
    const out = await exportProDocument(loaded, 'scc');
    expect(typeof out.text).toBe('string');
    const warning = out.warnings.find((w) => w.code === 'charset-unrepresentable');
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/cannot represent 4 character\(s\)/);
    expect(warning!.message).toMatch(/they will be replaced/);
  });

  it('Arabic exports to TTML without charset errors (Unicode target)', async () => {
    const loaded = importBytes('arabic.srt', enc(ARABIC));
    const out = await exportProDocument(loaded, 'ttml');
    expect(out.text).toContain('السلام');
    expect(out.warnings.filter((w) => w.code === 'charset-unrepresentable')).toEqual([]);
  });

  it('reports capability-drop warnings when normalizing for the Pro target', async () => {
    const bold = `1
00:00:01,000 --> 00:00:02,000
<b>Hello</b>
`;
    const loaded = importBytes('bold.srt', enc(bold));
    const out = await exportProDocument(loaded, 'scc');
    expect(out.warnings.some((w) => /bold/.test(w.message))).toBe(true);
  });
});

describe('detectImportFormat', () => {
  it('detects Free formats by extension', () => {
    expect(detectImportFormat('a.srt', enc(SRT))).toEqual({ id: 'srt', pro: false });
    expect(detectImportFormat('clip.ass', enc('[Events]'))).toEqual({ id: 'ass', pro: false });
  });

  it('detects Pro formats by extension (scc / stl / ttml / dfxp / itt)', () => {
    expect(detectImportFormat('cap.scc', enc('Scenarist_SCC V1.0'))).toEqual({
      id: 'scc',
      pro: true,
    });
    expect(detectImportFormat('cap.stl', stlHead())).toEqual({ id: 'stl', pro: true });
    expect(detectImportFormat('cap.ttml', enc('<tt></tt>'))).toEqual({ id: 'ttml', pro: true });
    expect(detectImportFormat('cap.dfxp', enc('<tt></tt>'))).toEqual({ id: 'ttml', pro: true });
    expect(detectImportFormat('cap.itt', enc('<tt></tt>'))).toEqual({ id: 'itt', pro: true });
    expect(detectImportFormat('cap.mcc', enc('File Format=MacCaption_MCC V1.0'))).toEqual({
      id: 'mcc',
      pro: true,
    });
  });

  it('disambiguates .xml by root element (tt = TTML; fcpxml is not importable yet)', () => {
    expect(detectImportFormat('cap.xml', enc('<?xml version="1.0"?>\n<tt xmlns="x">'))).toEqual({
      id: 'ttml',
      pro: true,
    });
    expect(
      detectImportFormat('seq.xml', enc('<?xml version="1.0"?>\n<fcpxml version="1.9">')),
    ).toBeNull();
  });

  it('disambiguates an EBU-TT-D .xml from a plain-TTML .xml by its distribution signature', () => {
    // conformsToStandard designator (the distribution URN).
    expect(
      detectImportFormat(
        'ebu.xml',
        enc(
          '<?xml version="1.0"?>\n<tt xmlns="x" ttp:conformsToStandard="urn:ebu:tt:distribution:2014">',
        ),
      ),
    ).toEqual({ id: 'ebuttd', pro: true });
    // ...or an `ebuttm:` metadata element usage.
    expect(
      detectImportFormat(
        'meta.xml',
        enc('<?xml version="1.0"?>\n<tt xmlns="x"><head><ebuttm:documentMetadata/></head>'),
      ),
    ).toEqual({ id: 'ebuttd', pro: true });
    // A plain-TTML .xml (no EBU-TT-D signature) still resolves to ttml.
    expect(detectImportFormat('plain.xml', enc('<?xml version="1.0"?>\n<tt xmlns="x">'))).toEqual({
      id: 'ttml',
      pro: true,
    });
  });

  it('sniffs signatures when the extension is missing or unknown', () => {
    expect(detectImportFormat('capture', stlHead())).toEqual({ id: 'stl', pro: true });
    expect(detectImportFormat('caption.dat', enc('Scenarist_SCC V1.0'))).toEqual({
      id: 'scc',
      pro: true,
    });
    expect(detectImportFormat('caption.dat', enc('File Format=MacCaption_MCC V1.0'))).toEqual({
      id: 'mcc',
      pro: true,
    });
    // An extensionless EBU-TT-D file resolves by its distribution namespace.
    expect(detectImportFormat('capture', enc('<tt xmlns:ttp="urn:ebu:tt:distribution">'))).toEqual({
      id: 'ebuttd',
      pro: true,
    });
  });

  it('returns null for unrecognized content', () => {
    expect(detectImportFormat('notes.txt', enc('just some text'))).toBeNull();
  });
});

describe('importFile (Pro-gated import)', () => {
  it('imports a Free format without Pro', async () => {
    const loaded = await importFile('movie.srt', enc(SRT), { allowPro: false });
    expect(loaded.sourceFormat).toBe('srt');
    expect(loaded.doc.cues).toHaveLength(2);
  });

  it('imports TTML when Pro is allowed', async () => {
    const loaded = await importFile('cap.ttml', fixture('ttml/minimal.ttml'), { allowPro: true });
    expect(loaded.sourceFormat).toBe('ttml');
    expect(loaded.doc.cues.length).toBeGreaterThan(0);
  });

  it('imports SCC when Pro is allowed', async () => {
    const loaded = await importFile('cap.scc', fixture('scc/minimal.scc'), { allowPro: true });
    expect(loaded.sourceFormat).toBe('scc');
    expect(loaded.doc.cues.length).toBeGreaterThan(0);
  });

  it('imports Apple iTT when Pro is allowed', async () => {
    const loaded = await importFile('cap.itt', fixture('itt/minimal.itt'), { allowPro: true });
    expect(loaded.sourceFormat).toBe('itt');
    expect(loaded.doc.cues.length).toBeGreaterThan(0);
  });

  it('blocks an iTT import for free users (Pro-gated)', async () => {
    await expect(
      importFile('cap.itt', fixture('itt/minimal.itt'), { allowPro: false }),
    ).rejects.toBeInstanceOf(ProImportLockedError);
  });

  it('imports binary STL via the byte path with Pro', async () => {
    const loaded = await importFile('cap.stl', fixture('stl/minimal.stl'), { allowPro: true });
    expect(loaded.sourceFormat).toBe('stl');
    expect(loaded.encoding).toBe('binary');
    expect(loaded.doc.cues.length).toBeGreaterThan(0);
  });

  it('blocks a Pro import for free users with a ProImportLockedError naming the format', async () => {
    const attempt = () => importFile('cap.scc', fixture('scc/minimal.scc'), { allowPro: false });
    await expect(attempt()).rejects.toBeInstanceOf(ProImportLockedError);
    await expect(attempt()).rejects.toThrow(/Scenarist Closed Caption/);
  });

  it('throws UnknownFormatError for unrecognized files even with Pro', async () => {
    await expect(importFile('notes.txt', enc('hello'), { allowPro: true })).rejects.toBeInstanceOf(
      UnknownFormatError,
    );
  });
});
