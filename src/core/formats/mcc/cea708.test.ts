import { describe, expect, it } from 'vitest';
import {
  CC_TYPE,
  CDP_FRAME_RATE_29_97,
  canEncode708,
  cmdDefineWindow,
  cmdDeleteWindows,
  cmdDisplayWindows,
  cmdSetPenAttributes,
  cmdSetPenColor,
  cmdSetPenLocation,
  colorTo708,
  decode708Text,
  decodeDtvccPacket,
  dtvccToTriplets,
  encode708Text,
  encodeDtvccPacket,
  encodeServiceBlock,
  packCdp,
  penAttributesFor,
  tripletsToDtvcc,
  unpackCdp,
  type CcTriplet,
} from './cea708';

/**
 * All expected byte vectors below are hand-derived from the layouts documented
 * in the module header (SMPTE ST 334-2 CDP, CEA-708-D DTVCC), NOT read back from
 * the implementation.
 */

describe('CDP pack/unpack + checksum', () => {
  // One 608-field-1 triplet [0xFC, 0x94, 0x2C] (an EOC-ish 608 word), seq 0.
  // cdp_length = 13 + 3 = 16 (0x10). framerate nibble = (0x04<<4)|0x0F = 0x4F.
  // Bytes summed for the checksum (0x96..footer seq-lo):
  //   96 69 10 4F 43 00 00 72 E1 FC 94 2C 74 00 00 = 1316; 1316 mod 256 = 36;
  //   checksum = 256-36 = 220 = 0xDC (total 1536 ≡ 0 mod 256).
  const oneTriplet: CcTriplet[] = [[0xfc, 0x94, 0x2c]];
  const expected = [
    0x96, 0x69, 0x10, 0x4f, 0x43, 0x00, 0x00, 0x72, 0xe1, 0xfc, 0x94, 0x2c, 0x74, 0x00, 0x00, 0xdc,
  ];

  it('packs a CDP with the exact hand-derived bytes', () => {
    expect(packCdp(oneTriplet, 0, CDP_FRAME_RATE_29_97)).toEqual(expected);
  });

  it('produces a packet whose byte sum is 0 mod 256', () => {
    const sum = packCdp(oneTriplet, 0, CDP_FRAME_RATE_29_97).reduce((a, b) => a + b, 0);
    expect(sum % 256).toBe(0);
  });

  it('round-trips triplets, sequence and frame-rate through unpack', () => {
    const seq = 3;
    const triplets: CcTriplet[] = [
      [CC_TYPE.E608_F1, 0x94, 0x2c],
      [CC_TYPE.E608_F2, 0x80, 0x80],
      [CC_TYPE.DTVCC_START, 0x02, 0x22],
    ];
    const got = unpackCdp(packCdp(triplets, seq, CDP_FRAME_RATE_29_97));
    expect(got.triplets).toEqual(triplets);
    expect(got.seq).toBe(seq);
    expect(got.frameRateCode).toBe(CDP_FRAME_RATE_29_97);
  });

  it('rejects a CDP with a corrupted checksum', () => {
    const bytes = packCdp(oneTriplet, 0, CDP_FRAME_RATE_29_97);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) & 0xff;
    expect(() => unpackCdp(bytes)).toThrow(/checksum/i);
  });

  it('rejects bytes that do not start with the CDP identifier', () => {
    expect(() => unpackCdp([0x00, 0x00, 0x10])).toThrow(/identifier/i);
  });

  it('rejects a truncated CDP even when its checksum coincidentally sums to zero', () => {
    // A foreign/damaged CDP whose ccdata_count claims more triplets than the
    // buffer holds must be rejected explicitly, not left to checksum luck. Build
    // a header declaring 10 triplets but carrying only 2, then append a byte so
    // the whole buffer sums to 0 mod 256 — the checksum path alone would pass it.
    const bytes = [
      0x96,
      0x69,
      0x00,
      0x4f,
      0x43,
      0x00,
      0x00,
      0x72,
      (10 & 0x1f) | 0xe0,
      0xfc,
      0x94,
      0x2c,
      0xfc,
      0x80,
      0x80, // only 2 of the 10 declared triplets
    ];
    const sum = bytes.reduce((a, b) => (a + b) & 0xff, 0);
    bytes.push((0x100 - sum) & 0xff); // now sums to 0 mod 256
    expect(() => unpackCdp(bytes)).toThrow(/truncat/i);
  });

  it('rejects a CDP whose header is shorter than the fixed 9-byte prefix', () => {
    expect(() => unpackCdp([0x96, 0x69, 0x04])).toThrow(/truncat/i);
  });
});

describe('DTVCC service block + packet transport', () => {
  // service 1 block carrying DeleteWindows(bitmap 0x01): data = [0x8C, 0x01].
  // block header = (1<<5)|2 = 0x22.
  it('encodes a service block header with service number and block size', () => {
    expect(encodeServiceBlock(1, [0x8c, 0x01])).toEqual([0x22, 0x8c, 0x01]);
  });

  // packet: [header, ...block]. block = [0x22,0x8C,0x01] (3 bytes) => total 4
  // bytes (even). packet_size_code = 4/2 = 2. header = (0<<6)|2 = 0x02.
  it('encodes a DTVCC packet with the correct size code', () => {
    expect(encodeDtvccPacket([encodeServiceBlock(1, [0x8c, 0x01])], 0)).toEqual([
      0x02, 0x22, 0x8c, 0x01,
    ]);
  });

  it('pads an odd-length packet to an even size', () => {
    // block header + 2 data = 3 -> packet header + 3 = 4 already even; use a
    // 1-byte block to force a pad: block = [0x21, 0x8F] (RST, block_size 1) -> 2
    // bytes; packet header + 2 = 3 (odd) -> pad to 4, code 2.
    const packet = encodeDtvccPacket([encodeServiceBlock(1, [0x8f])], 0);
    expect(packet.length % 2).toBe(0);
    expect(packet[0]).toBe(0x02);
    expect(packet).toEqual([0x02, 0x21, 0x8f, 0x00]);
  });

  it('round-trips blocks through decodeDtvccPacket', () => {
    const blocks = [encodeServiceBlock(1, [0x8c, 0x01])];
    const decoded = decodeDtvccPacket(encodeDtvccPacket(blocks, 2));
    expect(decoded.seq).toBe(2);
    expect(decoded.blocks).toEqual([{ service: 1, data: [0x8c, 0x01] }]);
  });

  it('splits a packet into 0xFF-then-0xFE cc triplets and reassembles it', () => {
    // packet [0x02,0x22,0x8C,0x01] -> pairs (02,22)(8C,01): first 0xFF, rest 0xFE.
    const packet = [0x02, 0x22, 0x8c, 0x01];
    expect(dtvccToTriplets(packet)).toEqual([
      [CC_TYPE.DTVCC_START, 0x02, 0x22],
      [CC_TYPE.DTVCC_DATA, 0x8c, 0x01],
    ]);
    expect(tripletsToDtvcc(dtvccToTriplets(packet))).toEqual(packet);
  });
});

describe('window and pen command byte sequences', () => {
  it('builds DefineWindow with the documented 6 parameter bytes', () => {
    // window 0 (opcode 0x98). visible+rowLock+colLock, priority 0 => b0 0x38.
    // relative=false, vertAnchor 79 (0x4F), horAnchor 100 (0x64).
    // anchorId 7, rowCount 1 => b3 = (7<<4)|1 = 0x71. colCount 31 => 0x1F.
    // winStyle 1, penStyle 1 => b5 = (1<<3)|1 = 0x09.
    expect(
      cmdDefineWindow(0, {
        visible: true,
        rowLock: true,
        colLock: true,
        priority: 0,
        relative: false,
        verticalAnchor: 79,
        horizontalAnchor: 100,
        anchorId: 7,
        rowCount: 1,
        columnCount: 31,
        windowStyle: 1,
        penStyle: 1,
      }),
    ).toEqual([0x98, 0x38, 0x4f, 0x64, 0x71, 0x1f, 0x09]);
  });

  it('builds Display/Delete window commands with a bitmap', () => {
    expect(cmdDisplayWindows(0x01)).toEqual([0x89, 0x01]);
    expect(cmdDeleteWindows(0x01)).toEqual([0x8c, 0x01]);
  });

  it('builds SetPenLocation from row and column', () => {
    expect(cmdSetPenLocation(1, 5)).toEqual([0x92, 0x01, 0x05]);
  });

  it('builds SetPenAttributes with italic and underline toggles', () => {
    // pen size standard (0x01), offset normal (0x01<<2 = 0x04) => b0 0x05.
    expect(cmdSetPenAttributes({ italic: false, underline: false })).toEqual([0x90, 0x05, 0x00]);
    expect(cmdSetPenAttributes({ italic: true, underline: false })).toEqual([0x90, 0x05, 0x80]);
    expect(cmdSetPenAttributes({ italic: true, underline: true })).toEqual([0x90, 0x05, 0xe0]);
  });

  it('builds SetPenColor from a foreground colour (solid, transparent bg)', () => {
    // white fg = 0x3F, bg transparent = 0xC0, edge 0x00.
    expect(cmdSetPenColor('white')).toEqual([0x91, 0x3f, 0xc0, 0x00]);
    expect(cmdSetPenColor('red')).toEqual([0x91, 0x30, 0xc0, 0x00]);
    expect(cmdSetPenColor('green')).toEqual([0x91, 0x0c, 0xc0, 0x00]);
  });

  it('maps named colours to 2-bit-per-component 708 values', () => {
    expect(colorTo708('white')).toBe(0x3f);
    expect(colorTo708('red')).toBe(0x30);
    expect(colorTo708('green')).toBe(0x0c);
    expect(colorTo708('blue')).toBe(0x03);
    expect(colorTo708('yellow')).toBe(0x3c);
    expect(colorTo708('cyan')).toBe(0x0f);
    expect(colorTo708('magenta')).toBe(0x33);
  });

  it('derives pen attributes from a span style', () => {
    expect(penAttributesFor({ italic: true, underline: false })).toEqual({
      italic: true,
      underline: false,
    });
  });
});

describe('708 text encoding (G0 / G1 / G2 via EXT1)', () => {
  it('encodes ASCII directly (G0)', () => {
    expect(encode708Text('AB')).toEqual([0x41, 0x42]);
  });

  it('encodes Latin-1 directly (G1)', () => {
    // é = U+00E9 = 0xE9, ñ = U+00F1 = 0xF1.
    expect(encode708Text('éñ')).toEqual([0xe9, 0xf1]);
  });

  it('encodes a G2 character behind an EXT1 (0x10) prefix', () => {
    // ™ = G2 0x39 => EXT1 0x10, 0x39.
    expect(encode708Text('™')).toEqual([0x10, 0x39]);
  });

  it('round-trips a mixed G0/G1/G2 string', () => {
    const s = 'A™é';
    expect(encode708Text(s)).toEqual([0x41, 0x10, 0x39, 0xe9]);
    expect(decode708Text(encode708Text(s))).toBe(s);
  });

  it('decode708Text skips C1 window commands and their arguments', () => {
    // DefineWindow(6 args) + SetPenLocation(2) + "Hi" + ETX.
    const stream = [
      0x98,
      0x38,
      0x4f,
      0x64,
      0x71,
      0x1f,
      0x09, // DefineWindow + 6 args
      0x92,
      0x00,
      0x00, // SetPenLocation + 2 args
      0x48,
      0x69, // "Hi"
      0x03, // ETX
    ];
    expect(decode708Text(stream)).toBe('Hi');
  });

  it('decode708Text skips C0 multi-byte codes, SetCurrentWindow and unknown bytes', () => {
    const stream = [
      0x80, // SetCurrentWindow 0 (no args)
      0x11,
      0x20, // C0 two-byte code (skips the 0x20 arg)
      0x18,
      0x00,
      0x41, // C0 three-byte code (P16) — the 0x41 is its arg, not an 'A'
      0x93, // reserved C1 code (no argument-count entry -> 0 args)
      0x48,
      0x69, // "Hi"
    ];
    expect(decode708Text(stream)).toBe('Hi');
  });

  it('canEncode708 accepts ASCII/Latin-1/G2 and rejects out-of-set glyphs', () => {
    expect(canEncode708('A')).toBe(true);
    expect(canEncode708('é')).toBe(true);
    expect(canEncode708('™')).toBe(true);
    expect(canEncode708('ا')).toBe(false); // Arabic
    expect(canEncode708('中')).toBe(false); // CJK
  });
});
