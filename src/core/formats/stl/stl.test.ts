import { describe, expect, it } from 'vitest';
import { parseStl, serializeStl } from './stl';
import { cueToText } from '../../model/cue';

/** Write an ASCII string into `buf` at `offset`, space-padded to `len`. */
function writeText(buf: Uint8Array, offset: number, len: number, s: string): void {
  for (let i = 0; i < len; i++) buf[offset + i] = i < s.length ? s.charCodeAt(i) : 0x20;
}

/** Build a 1024-byte GSI block (STL25.01, Latin code table). */
function buildGsi(tnb: number, tns: number): Uint8Array {
  const gsi = new Uint8Array(1024).fill(0x20);
  writeText(gsi, 0, 3, '850'); // CPN
  writeText(gsi, 3, 8, 'STL25.01'); // DFC -> 25 fps
  gsi[11] = '1'.charCodeAt(0); // DSC
  writeText(gsi, 12, 2, '00'); // CCT Latin
  writeText(gsi, 238, 5, String(tnb).padStart(5, '0')); // TNB
  writeText(gsi, 243, 5, String(tns).padStart(5, '0')); // TNS
  return gsi;
}

/**
 * Build a 128-byte TTI block. `text` may contain control bytes already; this
 * helper just lays out the header and copies the text field, 0x8F-padded.
 */
function buildTti(opts: {
  sn: number;
  tcIn: [number, number, number, number];
  tcOut: [number, number, number, number];
  vp?: number;
  jc?: number;
  text: number[];
}): Uint8Array {
  const tti = new Uint8Array(128).fill(0x8f);
  tti[0] = 0; // SGN
  tti[1] = opts.sn & 0xff;
  tti[2] = (opts.sn >> 8) & 0xff;
  tti[3] = 0xff; // EBN (last)
  tti[4] = 0; // CS
  tti.set(opts.tcIn, 5);
  tti.set(opts.tcOut, 9);
  tti[13] = opts.vp ?? 20;
  tti[14] = opts.jc ?? 2;
  tti[15] = 0; // CF
  for (let i = 0; i < opts.text.length && i < 112; i++) tti[16 + i] = opts.text[i]!;
  return tti;
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const MINIMAL = concat(
  buildGsi(2, 2),
  buildTti({ sn: 0, tcIn: [0, 0, 1, 0], tcOut: [0, 0, 4, 0], text: ascii('Hello world') }),
  buildTti({
    sn: 1,
    tcIn: [0, 0, 5, 0],
    tcOut: [0, 0, 6, 12],
    text: [...ascii('Second'), 0x8a, ...ascii('line two')],
  }),
);

describe('parseStl', () => {
  it('reads the frame rate and code table from the GSI block', () => {
    const doc = parseStl(MINIMAL);
    expect(doc.metadata.sourceFormat).toBe('stl');
    expect(doc.metadata.frameRate).toBe(25);
  });

  it('parses TTI time codes to milliseconds at 25 fps', () => {
    const doc = parseStl(MINIMAL);
    expect(doc.cues).toHaveLength(2);
    expect(doc.cues[0]).toMatchObject({ startMs: 1000, endMs: 4000 });
    // 6s + 12 frames at 25fps = 6000 + 480ms.
    expect(doc.cues[1]).toMatchObject({ startMs: 5000, endMs: 6480 });
  });

  it('reads the subtitle text and splits rows on the 0x8A newline', () => {
    const doc = parseStl(MINIMAL);
    expect(cueToText(doc.cues[0]!)).toBe('Hello world');
    expect(doc.cues[1]!.lines).toHaveLength(2);
    expect(cueToText(doc.cues[1]!)).toBe('Second\nline two');
  });

  it('decodes italic control bytes (0x80 on / 0x81 off)', () => {
    const stl = concat(
      buildGsi(1, 1),
      buildTti({
        sn: 0,
        tcIn: [0, 0, 1, 0],
        tcOut: [0, 0, 2, 0],
        text: [...ascii('a '), 0x80, ...ascii('b'), 0x81, ...ascii(' c')],
      }),
    );
    const doc = parseStl(stl);
    const spans = doc.cues[0]!.lines[0]!.spans;
    expect(spans.find((s) => s.text === 'b')!.italic).toBe(true);
    expect(cueToText(doc.cues[0]!)).toBe('a b c');
  });

  it('reads the justification code into cue alignment', () => {
    const stl = concat(
      buildGsi(1, 1),
      buildTti({ sn: 0, tcIn: [0, 0, 1, 0], tcOut: [0, 0, 2, 0], jc: 1, text: ascii('x') }),
    );
    expect(parseStl(stl).cues[0]!.position!.align).toBe('left');
  });

  it('warns when the buffer is too short to hold a GSI block', () => {
    const doc = parseStl(new Uint8Array(100));
    expect(doc.warnings.some((w) => w.code === 'unexpected-content')).toBe(true);
    expect(doc.cues).toHaveLength(0);
  });

  it('skips TTI blocks flagged as comments (CF=1)', () => {
    const comment = buildTti({
      sn: 0,
      tcIn: [0, 0, 1, 0],
      tcOut: [0, 0, 2, 0],
      text: ascii('note'),
    });
    comment[15] = 1; // CF = comment
    const real = buildTti({ sn: 1, tcIn: [0, 0, 3, 0], tcOut: [0, 0, 4, 0], text: ascii('shown') });
    const doc = parseStl(concat(buildGsi(2, 2), comment, real));
    expect(doc.cues).toHaveLength(1);
    expect(cueToText(doc.cues[0]!)).toBe('shown');
  });

  it('warns on reversed timing', () => {
    const stl = concat(
      buildGsi(1, 1),
      buildTti({ sn: 0, tcIn: [0, 0, 5, 0], tcOut: [0, 0, 2, 0], text: ascii('x') }),
    );
    expect(parseStl(stl).warnings.some((w) => w.code === 'reversed-timing')).toBe(true);
  });

  it('decodes underline control bytes (0x82 on / 0x83 off)', () => {
    const stl = concat(
      buildGsi(1, 1),
      buildTti({
        sn: 0,
        tcIn: [0, 0, 1, 0],
        tcOut: [0, 0, 2, 0],
        text: [0x82, ...ascii('u'), 0x83, ...ascii('n')],
      }),
    );
    const spans = parseStl(stl).cues[0]!.lines[0]!.spans;
    expect(spans.find((s) => s.text === 'u')!.underline).toBe(true);
  });

  it('concatenates text across extension blocks (EBN < 0xFF then 0xFF)', () => {
    const first = buildTti({
      sn: 0,
      tcIn: [0, 0, 1, 0],
      tcOut: [0, 0, 2, 0],
      text: ascii('Hello '),
    });
    first[3] = 0x00; // EBN: not the last block
    const second = buildTti({
      sn: 0,
      tcIn: [0, 0, 1, 0],
      tcOut: [0, 0, 2, 0],
      text: ascii('world'),
    });
    second[3] = 0xff; // EBN: last block
    const doc = parseStl(concat(buildGsi(2, 1), first, second));
    expect(doc.cues).toHaveLength(1);
    expect(cueToText(doc.cues[0]!)).toBe('Hello world');
  });

  it('accepts STL30.01 as 30 fps', () => {
    const gsi = buildGsi(1, 1);
    writeText(gsi, 3, 8, 'STL30.01');
    const stl = concat(
      gsi,
      buildTti({ sn: 0, tcIn: [0, 0, 1, 0], tcOut: [0, 0, 2, 0], text: ascii('x') }),
    );
    expect(parseStl(stl).metadata.frameRate).toBe(30);
  });
});

/** Single-cue STL document for serializer tests. */
function mkDoc(startMs: number, endMs: number, text = 'hi') {
  return {
    cues: [{ index: 1, startMs, endMs, lines: [{ spans: [{ text }] }] }],
    metadata: { sourceFormat: 'stl' as const, frameRate: 25 },
    warnings: [],
  };
}

describe('msToTc frame rounding (cue-forge-6o1)', () => {
  it('rounds 1980ms at 25fps to 00:00:02:00, never frame 25', () => {
    // 1980 * 25 / 1000 = 49.5 → 50 frames = exactly 2 seconds.
    const bytes = serializeStl(mkDoc(1980, 3000));
    expect([...bytes.subarray(1024 + 5, 1024 + 9)]).toEqual([0, 0, 2, 0]);
  });

  it('keeps the frame field strictly below fps for arbitrary ms values', () => {
    for (let ms = 0; ms <= 3000; ms += 13) {
      const bytes = serializeStl(mkDoc(ms, ms + 997));
      expect(bytes[1024 + 8]!).toBeLessThan(25); // TC-in frame byte
      expect(bytes[1024 + 12]!).toBeLessThan(25); // TC-out frame byte
    }
  });
});

describe('ISO 6937 text (CCT 00) (cue-forge-wmm)', () => {
  it('encodes accented letters as diacritic-prefix + base-letter byte pairs', () => {
    const bytes = serializeStl(mkDoc(1000, 2000, 'à é ü ñ ç'));
    const field = [...bytes.subarray(1024 + 16, 1024 + 16 + 14)];
    expect(field).toEqual([
      0xc1,
      0x61,
      0x20, // à = grave + a
      0xc2,
      0x65,
      0x20, // é = acute + e
      0xc8,
      0x75,
      0x20, // ü = diaeresis + u
      0xc4,
      0x6e,
      0x20, // ñ = tilde + n
      0xcb,
      0x63, // ç = cedilla + c
    ]);
  });

  it('decodes diacritic-prefix pairs into precomposed characters', () => {
    const stl = concat(
      buildGsi(1, 1),
      buildTti({
        sn: 0,
        tcIn: [0, 0, 1, 0],
        tcOut: [0, 0, 2, 0],
        text: [0xc1, 0x61, 0x20, 0xc2, 0x65, 0x20, 0xc8, 0x75, 0x20, 0xc4, 0x6e, 0x20, 0xcb, 0x63],
      }),
    );
    expect(cueToText(parseStl(stl).cues[0]!)).toBe('à é ü ñ ç');
  });

  it('round-trips accented and single-byte ISO 6937 characters', () => {
    const text = 'àéüñç ß¿«» Øœ ±½°';
    const doc = parseStl(serializeStl(mkDoc(1000, 2000, text)));
    expect(cueToText(doc.cues[0]!)).toBe(text);
  });

  it('does not decode ISO 6937 bytes as Latin-1 (0xE9 is Ø, not é)', () => {
    const stl = concat(
      buildGsi(1, 1),
      buildTti({ sn: 0, tcIn: [0, 0, 1, 0], tcOut: [0, 0, 2, 0], text: [0xe9] }),
    );
    expect(cueToText(parseStl(stl).cues[0]!)).toBe('Ø');
  });

  it('replaces unrepresentable characters with a space on encode', () => {
    const doc = parseStl(serializeStl(mkDoc(1000, 2000, 'a→あ←b')));
    // あ is unrepresentable; the arrows are ISO 6937 single-byte chars.
    expect(cueToText(doc.cues[0]!)).toBe('a→ ←b');
  });

  it('warns when the GSI declares a CCT other than 00', () => {
    const gsi = buildGsi(1, 1);
    writeText(gsi, 12, 2, '01');
    const stl = concat(
      gsi,
      buildTti({ sn: 0, tcIn: [0, 0, 1, 0], tcOut: [0, 0, 2, 0], text: ascii('x') }),
    );
    const doc = parseStl(stl);
    const warning = doc.warnings.find((w) => w.code === 'unexpected-content');
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('01');
    // Best-effort decode still yields the cue.
    expect(cueToText(doc.cues[0]!)).toBe('x');
  });

  it('does not warn for CCT 00', () => {
    expect(parseStl(MINIMAL).warnings).toHaveLength(0);
  });
});

describe('serializeStl', () => {
  it('produces a buffer that round-trips through the parser', () => {
    const once = parseStl(MINIMAL);
    const bytes = serializeStl(once);
    const twice = parseStl(bytes);
    expect(twice.cues).toEqual(once.cues);
    expect(twice.metadata).toEqual(once.metadata);
  });

  it('round-trips italics and a two-row subtitle', () => {
    const stl = concat(
      buildGsi(1, 1),
      buildTti({
        sn: 0,
        tcIn: [0, 0, 1, 0],
        tcOut: [0, 0, 2, 0],
        text: [...ascii('a '), 0x80, ...ascii('b'), 0x81, 0x8a, ...ascii('row2')],
      }),
    );
    const once = parseStl(stl);
    const twice = parseStl(serializeStl(once));
    expect(twice.cues).toEqual(once.cues);
  });

  it('emits a GSI header with the STL frame-rate code when no raw is present', () => {
    const doc = {
      cues: [
        {
          index: 1,
          startMs: 1000,
          endMs: 2000,
          lines: [{ spans: [{ text: 'hi' }] }],
        },
      ],
      metadata: { sourceFormat: 'stl' as const, frameRate: 25 },
      warnings: [],
    };
    const bytes = serializeStl(doc);
    const reparsed = parseStl(bytes);
    expect(cueToText(reparsed.cues[0]!)).toBe('hi');
    expect(reparsed.cues[0]).toMatchObject({ startMs: 1000, endMs: 2000 });
  });
});

/**
 * cue-forge-drt.4: a TTI text field holds only 112 bytes, but a subtitle may need
 * more (the parser already reassembles EBN extension chains). The serializer used
 * to emit a single TTI and slice the text to 112 bytes, silently dropping the rest.
 */
describe('serializeStl multi-block cues (cue-forge-drt.4)', () => {
  const longDoc = {
    cues: [
      {
        index: 1,
        startMs: 1000,
        endMs: 5000,
        lines: [
          { spans: [{ text: 'A'.repeat(50) }] },
          { spans: [{ text: 'B'.repeat(50) }] },
          { spans: [{ text: 'C'.repeat(50) }] }, // 150 chars + 2 breaks = 152 bytes > 112
        ],
      },
    ],
    metadata: { sourceFormat: 'stl' as const, frameRate: 25 },
    warnings: [],
  };
  const blockCount = (bytes: Uint8Array) => (bytes.length - 1024) / 128;

  it('does not truncate a cue whose text exceeds the 112-byte TTI field', () => {
    const reparsed = parseStl(serializeStl(longDoc));
    expect(reparsed.cues).toHaveLength(1);
    expect(reparsed.cues[0]!.lines.map((l) => l.spans.map((s) => s.text).join(''))).toEqual([
      'A'.repeat(50),
      'B'.repeat(50),
      'C'.repeat(50),
    ]);
  });

  it('emits an EBN-chained multi-block subtitle (>1 TTI block, last EBN=0xFF)', () => {
    const bytes = serializeStl(longDoc);
    const n = blockCount(bytes);
    expect(n).toBeGreaterThan(1);
    expect(bytes[1024 + 3]).not.toBe(0xff); // first block: not the last
    expect(bytes[1024 + (n - 1) * 128 + 3]).toBe(0xff); // final block: last
  });

  it('shares one subtitle number (SN) across all blocks of the cue', () => {
    const bytes = serializeStl(longDoc);
    const n = blockCount(bytes);
    for (let b = 0; b < n; b++) {
      expect(bytes[1024 + b * 128 + 1]).toBe(0); // SN low byte = idx 0
      expect(bytes[1024 + b * 128 + 2]).toBe(0); // SN high byte
    }
  });

  it('still emits exactly one TTI block (EBN=0xFF) for a short cue', () => {
    const bytes = serializeStl({
      cues: [{ index: 1, startMs: 0, endMs: 1000, lines: [{ spans: [{ text: 'hi' }] }] }],
      metadata: { sourceFormat: 'stl' as const, frameRate: 25 },
      warnings: [],
    });
    expect(blockCount(bytes)).toBe(1);
    expect(bytes[1024 + 3]).toBe(0xff);
  });

  it('writes TNB (total TTI blocks) distinct from TNS (subtitle count) in the GSI', () => {
    const bytes = serializeStl(longDoc);
    const tnb = Number(String.fromCharCode(...bytes.subarray(238, 243)));
    const tns = Number(String.fromCharCode(...bytes.subarray(243, 248)));
    expect(tnb).toBe(blockCount(bytes));
    expect(tns).toBe(1);
  });
});
