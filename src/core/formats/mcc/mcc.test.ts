import { describe, expect, it } from 'vitest';
import type { ParseWarning, SubtitleDocument } from '../../model/types';
import { stripParity } from '../scc/cea608';
import {
  canEncode708,
  CC_TYPE,
  decodeDtvccPacket,
  packCdp,
  tripletsToDtvcc,
  type CcTriplet,
} from './cea708';
import {
  canEncodeMcc,
  compressAliases,
  expandAliases,
  MCC_ALIASES,
  parseMcc,
  serializeMcc,
} from './mcc';

const FRAME_MS = 1001 / 30; // ≈33.37ms

function doc(cues: SubtitleDocument['cues']): SubtitleDocument {
  return {
    cues,
    metadata: { sourceFormat: 'mcc', frameRate: 30000 / 1001 },
    warnings: [],
  };
}

function textCue(
  index: number,
  startMs: number,
  endMs: number,
  lines: string[][],
  style: Partial<{ italic: boolean; color: string }> = {},
): SubtitleDocument['cues'][number] {
  return {
    index,
    startMs,
    endMs,
    lines: lines.map((spans) => ({
      spans: spans.map((text) => ({ text, ...style })),
    })),
  };
}

describe('MCC alias compression', () => {
  it('exposes the documented alias table', () => {
    expect(MCC_ALIASES['G']).toEqual([0xfa, 0x00, 0x00]);
    expect(MCC_ALIASES['S']).toEqual([0x96, 0x69]);
    expect(MCC_ALIASES['T']).toEqual([0x61, 0x01]);
    expect(MCC_ALIASES['U']).toEqual([0xe1, 0x00, 0x00, 0x00]);
    expect(MCC_ALIASES['Q']).toEqual([0xfc, 0x80, 0x80]);
    expect(MCC_ALIASES['Z']).toEqual([0x00]);
    // I = 3 × FA0000; O = 9 × FA0000.
    expect(MCC_ALIASES['I']).toEqual([0xfa, 0x00, 0x00, 0xfa, 0x00, 0x00, 0xfa, 0x00, 0x00]);
    expect(MCC_ALIASES['O']).toEqual(Array.from({ length: 9 }, () => [0xfa, 0x00, 0x00]).flat());
    expect(MCC_ALIASES['O']).toHaveLength(27);
  });

  it('expands aliases mixed with raw hex', () => {
    // T (61 01) + "43" + S (96 69) + Z (00)
    expect(expandAliases('T43SZ')).toEqual([0x61, 0x01, 0x43, 0x96, 0x69, 0x00]);
  });

  it('round-trips bytes through compress → expand', () => {
    const bytes = [0x61, 0x01, 0x96, 0x69, 0xfc, 0x80, 0x80, 0xfa, 0x00, 0x00, 0x00];
    expect(expandAliases(compressAliases(bytes))).toEqual(bytes);
  });

  it('compresses runs of FA0000 into the multi-count aliases', () => {
    // two FA0000 runs -> "H"
    expect(compressAliases([0xfa, 0x00, 0x00, 0xfa, 0x00, 0x00])).toBe('H');
  });
});

describe('serializeMcc header', () => {
  const out = serializeMcc(doc([textCue(1, 1000, 3000, [['Hello world']])]));

  it('emits the MacCaption file-format banner and alias block', () => {
    expect(out).toContain('File Format=MacCaption_MCC V1.0');
    expect(out).toContain('//     S  96h 69h');
    expect(out).toContain('//     U  E1h 00h 00h 00h');
  });

  it('emits Time Code Rate=30DF for the 29.97 drop-frame timebase', () => {
    expect(out).toContain('Time Code Rate=30DF');
  });

  it('emits a deterministic Creation Date (fixed default)', () => {
    const a = serializeMcc(doc([textCue(1, 1000, 3000, [['Hi']])]));
    const b = serializeMcc(doc([textCue(1, 1000, 3000, [['Hi']])]));
    expect(a).toBe(b);
  });

  it('emits per-frame timecode lines with tab-separated hex', () => {
    const line = out.split('\n').find((l) => /^\d{2}:\d{2}:\d{2}[:;]\d{2}\t/.test(l));
    expect(line).toBeDefined();
    // hex/alias payload begins with the ANC DID/SDID (61 01 => alias "T")
    expect(line!.split('\t')[1]).toMatch(/^T/);
  });
});

describe('parseMcc of a hand-built line', () => {
  it('expands aliases and recovers the CDP cc-count', () => {
    // Build one CDP frame by hand via the serializer's own primitives would be
    // circular; instead assert a real serialized frame parses without warnings.
    const parsed = parseMcc(serializeMcc(doc([textCue(1, 500, 2000, [['Hi']])])));
    expect(parsed.metadata.sourceFormat).toBe('mcc');
    expect(parsed.warnings.filter((w) => w.code !== 'overlap')).toEqual([]);
    expect(parsed.cues.length).toBe(1);
  });
});

describe('round-trip (serialize → parse)', () => {
  const cues = [
    textCue(1, 1000, 3000, [['Plain caption']]),
    textCue(2, 4000, 6000, [['Italic caption']], { italic: true }),
    textCue(3, 7000, 9000, [['Red café ñoño'], ['second line']], { color: 'red' }),
  ];
  const parsed = parseMcc(serializeMcc(doc(cues)));

  it('preserves the cue count', () => {
    expect(parsed.cues.length).toBe(3);
  });

  it('preserves timings to within one frame', () => {
    for (let i = 0; i < cues.length; i++) {
      expect(Math.abs(parsed.cues[i]!.startMs - cues[i]!.startMs)).toBeLessThanOrEqual(FRAME_MS);
      expect(Math.abs(parsed.cues[i]!.endMs - cues[i]!.endMs)).toBeLessThanOrEqual(FRAME_MS);
    }
  });

  it('preserves text including Latin-1 accents', () => {
    const flat = (c: SubtitleDocument['cues'][number]) =>
      c.lines.map((l) => l.spans.map((s) => s.text).join('')).join('\n');
    expect(flat(parsed.cues[0]!)).toBe('Plain caption');
    expect(flat(parsed.cues[2]!)).toBe('Red café ñoño\nsecond line');
  });

  it('preserves italic styling', () => {
    expect(parsed.cues[1]!.lines[0]!.spans.some((s) => s.italic)).toBe(true);
  });

  it('preserves colour styling', () => {
    expect(parsed.cues[2]!.lines[0]!.spans.some((s) => s.color === 'red')).toBe(true);
  });
});

describe('dense consecutive cues', () => {
  it('does not corrupt lead-in when cues are less than a second apart', () => {
    const cues = [
      textCue(1, 1000, 1500, [['First caption here']]),
      textCue(2, 1800, 2400, [['Second caption here']]),
      textCue(3, 2600, 3200, [['Third caption here']]),
    ];
    const parsed = parseMcc(serializeMcc(doc(cues)));
    expect(parsed.cues.length).toBe(3);
    const flat = (i: number) =>
      parsed.cues[i]!.lines.map((l) => l.spans.map((s) => s.text).join('')).join('');
    expect(flat(0)).toBe('First caption here');
    expect(flat(1)).toBe('Second caption here');
    expect(flat(2)).toBe('Third caption here');
  });
});

describe('parse robustness', () => {
  it('returns an empty document with only the header for a document with no cues', () => {
    const out = serializeMcc(doc([]));
    expect(out).toContain('File Format=MacCaption_MCC V1.0');
    expect(out.split('\n').some((l) => /^\d{2}:\d{2}:\d{2}/.test(l))).toBe(false);
    expect(parseMcc(out).cues).toEqual([]);
  });

  it('ignores non-timecode and malformed payload lines but keeps valid cues', () => {
    const valid = serializeMcc(doc([textCue(1, 1000, 3000, [['Kept']])]));
    const polluted = [
      'not a caption line',
      '00:00:05:00\tZZZZ nothex!!', // malformed payload (odd hex)
      '00:00:06:00\t4243', // valid hex but no CDP identifier -> skipped
      ...valid.split('\n'),
    ].join('\n');
    const parsed = parseMcc(polluted);
    expect(parsed.cues.length).toBe(1);
    expect(parsed.warnings.some((w) => w.code === 'unexpected-content')).toBe(true);
  });

  it('warns when a file carries caption data but no decodable pop-on 608 cues', () => {
    // Hand-build one MCC frame whose CDP carries a CEA-708 DTVCC packet with
    // NULL (FC 80 80) 608 field-1 padding — i.e. a 708-only / roll-up authored
    // file our pop-on-608 decoder cannot decode. It must not silently import
    // as an empty document.
    const triplets: CcTriplet[] = [
      [CC_TYPE.E608_F1, 0x80, 0x80], // null 608 field-1 padding
      [CC_TYPE.E608_F2, 0x80, 0x80], // null 608 field-2 padding
      [CC_TYPE.DTVCC_START, 0x41, 0x42], // real 708 caption data
      [CC_TYPE.DTVCC_DATA, 0x43, 0x44],
    ];
    const cdp = packCdp(triplets, 0);
    const anc = [0x61, 0x01, cdp.length & 0xff, ...cdp];
    const parsed = parseMcc(`00:00:01:00\t${compressAliases(anc)}`);

    expect(parsed.cues).toEqual([]);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings[0]!.message).toMatch(/708|roll-up|pop-on/i);
  });

  it('does not warn for a genuinely empty (all-padding) file', () => {
    // Only null 608 padding + DTVCC padding: legitimately no captions.
    const triplets: CcTriplet[] = [
      [CC_TYPE.E608_F1, 0x80, 0x80],
      [CC_TYPE.E608_F2, 0x80, 0x80],
      [CC_TYPE.DTVCC_PAD, 0x00, 0x00],
    ];
    const cdp = packCdp(triplets, 0);
    const anc = [0x61, 0x01, cdp.length & 0xff, ...cdp];
    const parsed = parseMcc(`00:00:01:00\t${compressAliases(anc)}`);

    expect(parsed.cues).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });
});

describe('styling round-trips beyond italic', () => {
  it('preserves underline styling', () => {
    const cue: SubtitleDocument['cues'][number] = {
      index: 1,
      startMs: 1000,
      endMs: 3000,
      lines: [{ spans: [{ text: 'Underlined', underline: true }] }],
    };
    const parsed = parseMcc(serializeMcc(doc([cue])));
    expect(parsed.cues[0]!.lines[0]!.spans.some((s) => s.underline)).toBe(true);
  });

  it('round-trips a special/extended character through the 608 track', () => {
    // ™ is a CEA-608 special character (control 0x11, 0x34).
    const parsed = parseMcc(serializeMcc(doc([textCue(1, 1000, 3000, [['Brand™']])])));
    expect(parsed.cues[0]!.lines[0]!.spans.map((s) => s.text).join('')).toContain('™');
  });
});

describe('canEncodeMcc', () => {
  it('accepts Latin-1 and the G2 set, rejects out-of-set scripts', () => {
    expect(canEncodeMcc('é')).toBe(true);
    expect(canEncodeMcc('A')).toBe(true);
    expect(canEncodeMcc('™')).toBe(true);
    expect(canEncodeMcc('العربية'[0]!)).toBe(false);
  });

  it('rejects a 708-encodable char the authoritative 608 track cannot represent (cue-forge-qmp)', () => {
    // Parse reconstructs cue text from the CEA-608 companion track, so the
    // export pre-check must reflect 608 representability — NOT the wider 708
    // charset. '×' (U+00D7) rides 708's Latin-1 range but has no 608 glyph, so
    // it silently degrades to '?' on the authoritative round-trip.
    expect(canEncode708('×')).toBe(true); // the 708 mirror layer would accept it
    expect(canEncodeMcc('×')).toBe(false); // but the pre-check must not

    const parsed = parseMcc(serializeMcc(doc([textCue(1, 1000, 3000, [['a×b']])])));
    const text = parsed.cues[0]!.lines[0]!.spans.map((s) => s.text).join('');
    expect(text).not.toContain('×'); // round-trip reality: substituted, not intact
  });
});

describe('CEA-708 DTVCC packets are per-frame spec-valid (cue-forge-bu6)', () => {
  // A long 3-line cue whose 708 command stream exceeds 127 bytes: a single
  // packet would overflow the 6-bit packet_size_code, and chopping one packet's
  // triplets across frames leaves later frames starting on a DTVCC_DATA (cc_type
  // 2) triplet — invalid to a decoder that begins a packet only on DTVCC_START
  // (cc_type 3). Every emitted frame must instead carry a self-contained packet.
  const longCue = textCue(1, 2000, 6000, [
    ['This is the first line of a fairly long caption'],
    ['and this is the second line, also quite long here'],
    ['finally the third line rounds out three full rows'],
  ]);
  const out = serializeMcc(doc([longCue]));

  /** Per-frame DTVCC (0xFF/0xFE) triplets, in frame order, non-empty frames only. */
  const frames: CcTriplet[][] = (() => {
    const result: CcTriplet[][] = [];
    for (const line of out.split('\n')) {
      const m = /^\d{2}:\d{2}:\d{2}[:;]\d{2}\t(.+)$/.exec(line);
      if (!m) continue;
      const bytes = expandAliases(m[1]!);
      const cdpStart = bytes.indexOf(0x96);
      const ccCount = bytes[cdpStart + 8]! & 0x1f;
      const dtvcc: CcTriplet[] = [];
      let i = cdpStart + 9;
      for (let n = 0; n < ccCount; n++) {
        const t: CcTriplet = [bytes[i]!, bytes[i + 1]!, bytes[i + 2]!];
        if (t[0] === CC_TYPE.DTVCC_START || t[0] === CC_TYPE.DTVCC_DATA) dtvcc.push(t);
        i += 3;
      }
      if (dtvcc.length > 0) result.push(dtvcc);
    }
    return result;
  })();

  it('spans more than one frame for the long cue', () => {
    expect(frames.length).toBeGreaterThan(1);
  });

  it('begins every frame with a DTVCC_START triplet then only DTVCC_DATA', () => {
    for (const dtvcc of frames) {
      expect(dtvcc[0]![0]).toBe(CC_TYPE.DTVCC_START);
      expect(dtvcc.slice(1).every((t) => t[0] === CC_TYPE.DTVCC_DATA)).toBe(true);
    }
  });

  it('emits a valid 6-bit packet_size_code matching each frame packet length', () => {
    for (const dtvcc of frames) {
      const packet = tripletsToDtvcc(dtvcc);
      const sizeCode = packet[0]! & 0x3f;
      const size = sizeCode === 0 ? 128 : sizeCode * 2; // CEA-708-D: 0 => 128
      expect(size).toBeLessThanOrEqual(128);
      expect(size).toBe(packet.length); // whole packet contained in this frame
    }
  });

  it('decodes each frame to a single service-1 block within the 31-byte limit', () => {
    for (const dtvcc of frames) {
      const decoded = decodeDtvccPacket(tripletsToDtvcc(dtvcc));
      expect(decoded.blocks.length).toBe(1);
      expect(decoded.blocks[0]!.service).toBe(1);
      expect(decoded.blocks[0]!.data.length).toBeLessThanOrEqual(0x1f);
    }
  });

  it('still round-trips the long cue through the 608 companion track', () => {
    const parsed = parseMcc(out);
    expect(parsed.cues.length).toBe(1);
    const text = parsed.cues[0]!.lines.map((l) => l.spans.map((s) => s.text).join('')).join(' ');
    expect(text).toContain('first line');
    expect(text).toContain('third line');
  });
});

describe('same-frame 708 packet collision spills, never truncates (cue-forge-oti)', () => {
  // Two long 3-line cues that overlap: each cue's command stream splits into
  // several ≤17-triplet packets whose lead-in frames (back-timed from the start
  // frame) land in the same frame window. Two packets on one frame would exceed
  // the per-frame DTVCC budget and get sliced, cutting the second packet's tail
  // and leaving a mid-frame DTVCC_START — the exact defect bu6 fixed for the
  // single-cue case. Colliding packets must spill to neighbouring frames so every
  // emitted frame still carries exactly one self-contained packet.
  const three = (tag: string): string[][] => [
    [`${tag}: first line of a fairly long caption here`],
    [`${tag}: second line, also quite long across it`],
    [`${tag}: third line rounds out three full rows now`],
  ];
  const cues = [textCue(1, 2000, 5000, three('A')), textCue(2, 2100, 5100, three('B'))];
  const out = serializeMcc(doc(cues));

  /** Per-frame DTVCC (0xFF/0xFE) triplets, in frame order, non-empty frames only. */
  const frames: CcTriplet[][] = (() => {
    const result: CcTriplet[][] = [];
    for (const line of out.split('\n')) {
      const m = /^\d{2}:\d{2}:\d{2}[:;]\d{2}\t(.+)$/.exec(line);
      if (!m) continue;
      const bytes = expandAliases(m[1]!);
      const cdpStart = bytes.indexOf(0x96);
      const ccCount = bytes[cdpStart + 8]! & 0x1f;
      const dtvcc: CcTriplet[] = [];
      let i = cdpStart + 9;
      for (let n = 0; n < ccCount; n++) {
        const t: CcTriplet = [bytes[i]!, bytes[i + 1]!, bytes[i + 2]!];
        if (t[0] === CC_TYPE.DTVCC_START || t[0] === CC_TYPE.DTVCC_DATA) dtvcc.push(t);
        i += 3;
      }
      if (dtvcc.length > 0) result.push(dtvcc);
    }
    return result;
  })();

  it('begins every frame with a DTVCC_START triplet then only DTVCC_DATA', () => {
    for (const dtvcc of frames) {
      expect(dtvcc[0]![0]).toBe(CC_TYPE.DTVCC_START);
      expect(dtvcc.slice(1).every((t) => t[0] === CC_TYPE.DTVCC_DATA)).toBe(true);
    }
  });

  it('carries a complete, self-contained packet on every frame (no truncated tail)', () => {
    for (const dtvcc of frames) {
      expect(dtvcc.length).toBeLessThanOrEqual(18); // MAX_DTVCC_TRIPLETS
      const packet = tripletsToDtvcc(dtvcc);
      const sizeCode = packet[0]! & 0x3f;
      const size = sizeCode === 0 ? 128 : sizeCode * 2;
      expect(size).toBeLessThanOrEqual(128);
      expect(size).toBe(packet.length); // whole packet contained in this frame
      const decoded = decodeDtvccPacket(packet);
      expect(decoded.blocks.length).toBe(1);
      expect(decoded.blocks[0]!.service).toBe(1);
      expect(decoded.blocks[0]!.data.length).toBeLessThanOrEqual(0x1f);
    }
  });

  it('still round-trips both overlapping cues through the 608 companion track', () => {
    const parsed = parseMcc(out);
    expect(parsed.cues.length).toBe(2);
    const flat = (i: number) =>
      parsed.cues[i]!.lines.map((l) => l.spans.map((s) => s.text).join('')).join(' ');
    expect(flat(0)).toContain('A: first line');
    expect(flat(0)).toContain('A: third line');
    expect(flat(1)).toContain('B: first line');
    expect(flat(1)).toContain('B: third line');
  });
});

describe('dense EDM scheduling and warnings (cue-forge-jde)', () => {
  it('documents the sub-second-gap end-time stretch when no EDM frame fits', () => {
    // cue 1 ends only ~100ms before cue 2 starts; cue 2's lead-in leaves no
    // 2-frame room for cue 1's EDM. Pop-on physics cannot clear and repopulate
    // the screen in under two frames, so cue 1 stays displayed until cue 2's EOC
    // replaces it — a bounded stretch to the next cue's start (the least-bad
    // outcome), NOT a spurious density warning.
    const cues = [
      textCue(1, 1000, 1600, [['First caption']]),
      textCue(2, 1700, 3000, [['Second caption']]),
    ];
    const warnings: ParseWarning[] = [];
    const parsed = parseMcc(serializeMcc(doc(cues), warnings));

    expect(warnings.some((w) => w.code === 'captions-too-dense')).toBe(false);
    expect(parsed.cues.length).toBe(2);
    const flat = (i: number) =>
      parsed.cues[i]!.lines.map((l) => l.spans.map((s) => s.text).join('')).join('');
    expect(flat(0)).toBe('First caption');
    expect(flat(1)).toBe('Second caption');
    // Stretch: cue 1's end extends to cue 2's start (bounded by the next EOC),
    // rather than clearing at its own authored end.
    expect(Math.abs(parsed.cues[0]!.endMs - parsed.cues[1]!.startMs)).toBeLessThanOrEqual(FRAME_MS);
  });

  it('surfaces a captions-too-dense warning through the serializeMcc out-param', () => {
    // Reachability proof for the warnings param: exportProDocument passes a
    // warnings array to serialize(doc, warnings), so overlapping multi-line cues
    // must report density there (not a dead parameter).
    const three = [['Line one here'], ['Line two here'], ['Line three now']];
    const cues = [
      textCue(1, 1000, 1200, three),
      textCue(2, 1100, 1400, three),
      textCue(3, 1200, 1600, three),
      textCue(4, 1300, 1800, three),
    ];
    const warnings: ParseWarning[] = [];
    serializeMcc(doc(cues), warnings);
    expect(warnings.some((w) => w.code === 'captions-too-dense')).toBe(true);
  });
});

describe('608 compatibility track', () => {
  it('carries the first cue text in the 0xFC (608 field 1) triplets', () => {
    const out = serializeMcc(doc([textCue(1, 1000, 3000, [['HELLO']])]));

    // Collect the field-1 (0xFC) 608 words across frames, in frame order.
    const words: Array<[number, number]> = [];
    for (const line of out.split('\n')) {
      const m = /^\d{2}:\d{2}:\d{2}[:;]\d{2}\t(.+)$/.exec(line);
      if (!m) continue;
      const bytes = expandAliases(m[1]!);
      // Walk to the ccdata_section: DID SDID DC 96 69 len fr flags seq seq 72 ccc
      const cdpStart = bytes.indexOf(0x96);
      const ccCount = bytes[cdpStart + 8]! & 0x1f;
      let i = cdpStart + 9;
      for (let n = 0; n < ccCount; n++) {
        const [marker, d1, d2] = [bytes[i]!, bytes[i + 1]!, bytes[i + 2]!];
        if (marker === 0xfc && !(d1 === 0x80 && d2 === 0x80)) {
          words.push([stripParity(d1), stripParity(d2)]);
        }
        i += 3;
      }
    }

    // Decode the 608 basic characters (skip control words 0x10-0x1f).
    let text = '';
    for (const [b1, b2] of words) {
      if (b1 >= 0x10 && b1 <= 0x1f) continue; // control (RCL/PAC/EOC/EDM)
      if (b1 >= 0x20) text += String.fromCharCode(b1);
      if (b2 >= 0x20) text += String.fromCharCode(b2);
    }
    expect(text).toContain('HELLO');
  });
});
