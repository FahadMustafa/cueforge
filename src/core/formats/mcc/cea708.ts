/**
 * CEA-708 (DTVCC) and CDP low-level primitives for the MCC codec (spec MCC).
 *
 * MCC (MacCaption) stores CEA-708 caption data as one ANC/CDP packet per video
 * frame. This module owns the two write-and-read primitive layers that the MCC
 * container (`mcc.ts`) composes:
 *
 *   - the Caption Distribution Packet (CDP): identifier, length, frame-rate and
 *     flags header, the `ccdata_section` of 3-byte cc-triplets, footer and the
 *     modulo-256 packet checksum; and
 *   - the DTVCC transport: caption-channel packet header, service blocks, the
 *     C0/C1 window and pen commands, and G0/G1/G2 text encoding.
 *
 * Every byte layout below was verified against Comcast's caption-inspector
 * (github.com/Comcast/caption-inspector — `src/xform/mcc_encode.c`,
 * `src/xform/dtvcc_decode.c`, `include/dtvcc_decode.h`, `include/cc_utils.h`),
 * which itself cites SMPTE ST 334-1:2015 (VANC mapping), SMPTE ST 334-2:2015
 * (CDP definition) and CEA-708-D (DTV closed captioning, Aug 2008). Facts that
 * differ from a first-order reading of those specs are called out inline.
 *
 * The parity, timecode↔frame and CEA-608 character primitives are shared with
 * the SCC codec via `../scc/cea608` (imported read-only).
 */

/* -------------------------------------------------------------------------- */
/*  cc-triplet marker bytes and CDP frame-rate codes                           */
/* -------------------------------------------------------------------------- */

/**
 * The first byte of a 3-byte cc-triplet encodes `marker(5) | cc_valid(1) |
 * cc_type(2)`. caption-inspector (cc_utils.h) uses the whole-byte constants
 * below; the marker bits are all-ones (0x1F<<3) for the valid types.
 */
export const CC_TYPE = {
  /** valid CEA-608 line-21 field 1 (cc_type 0). */
  E608_F1: 0xfc,
  /** valid CEA-608 line-21 field 2 (cc_type 1). */
  E608_F2: 0xfd,
  /** valid DTVCC packet continuation (cc_type 2). */
  DTVCC_DATA: 0xfe,
  /** valid DTVCC packet start (cc_type 3). */
  DTVCC_START: 0xff,
  /** invalid DTVCC channel data used as inter-packet padding. */
  DTVCC_PAD: 0xfa,
} as const;

/** CDP `cdp_frame_rate` nibble for the 30000/1001 (≈29.97) timebase. */
export const CDP_FRAME_RATE_29_97 = 0x04;

/** Number of cc-triplets per frame at 29.97 fps (SMPTE ST 334-2 fixed rate). */
export const CC_COUNT_29_97 = 20;

/** A 3-byte cc-triplet: `[marker/type byte, cc_data_1, cc_data_2]`. */
export type CcTriplet = [number, number, number];

const CDP_ID_HIGH = 0x96;
const CDP_ID_LOW = 0x69;
const CC_DATA_ID = 0x72;
const CDP_FOOTER_ID = 0x74;

/* -------------------------------------------------------------------------- */
/*  Caption Distribution Packet (CDP)                                          */
/* -------------------------------------------------------------------------- */

/** Decoded CDP contents. */
export interface CdpContents {
  triplets: CcTriplet[];
  seq: number;
  frameRateCode: number;
}

/**
 * Pack cc-triplets into a CDP byte array (SMPTE ST 334-2). The returned bytes
 * run from the `cdp_identifier` (0x9669) through the `packet_checksum`; the
 * caller (`mcc.ts`) prepends only the ANC DID/SDID/data-count (real MacCaption
 * lines end at the packet checksum — no trailing VANC byte). `cdp_length` counts
 * the CDP only (identifier … checksum) = the triplet byte count + 13
 * header/footer bytes.
 */
export function packCdp(
  triplets: CcTriplet[],
  seq: number,
  frameRateCode: number = CDP_FRAME_RATE_29_97,
): number[] {
  const ccBytes = triplets.length * 3;
  const cdpLength = ccBytes + 13;
  const bytes: number[] = [
    CDP_ID_HIGH,
    CDP_ID_LOW,
    cdpLength & 0xff,
    ((frameRateCode & 0x0f) << 4) | 0x0f,
    0x43, // timecode absent, service info absent, captions present
    (seq >> 8) & 0xff,
    seq & 0xff,
    CC_DATA_ID,
    (triplets.length & 0x1f) | 0xe0,
  ];
  for (const [marker, d1, d2] of triplets) bytes.push(marker & 0xff, d1 & 0xff, d2 & 0xff);
  bytes.push(CDP_FOOTER_ID, (seq >> 8) & 0xff, seq & 0xff);
  // Packet checksum: two's complement of the running sum so that the whole CDP
  // (identifier … checksum inclusive) sums to 0 mod 256.
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  bytes.push((0x100 - sum) & 0xff);
  return bytes;
}

/** Unpack a CDP byte array, validating the identifier and packet checksum. */
export function unpackCdp(bytes: number[]): CdpContents {
  if (bytes[0] !== CDP_ID_HIGH || bytes[1] !== CDP_ID_LOW) {
    throw new Error('Invalid CDP identifier (expected 0x9669).');
  }
  // The fixed header runs identifier(2) … ccdata_id(1) ccdata_count(1) = 9 bytes;
  // a foreign/damaged CDP shorter than that cannot carry a ccdata_section.
  if (bytes.length < 9) {
    throw new Error(`Truncated CDP header (need 9 bytes, got ${bytes.length}).`);
  }
  if (bytes[7] !== CC_DATA_ID) throw new Error('CDP missing ccdata_section (0x72).');
  const ccCount = bytes[8]! & 0x1f;
  // The cc_count triplets (3 bytes each) plus the 4-byte footer (footer id, two
  // sequence bytes, packet checksum) must all be present. Validating the length
  // BEFORE the checksum rejects a truncated CDP even when its remaining bytes
  // coincidentally sum to 0 mod 256 — otherwise the triplet loop below would
  // read undefined bytes off the end of the buffer.
  const needed = 9 + ccCount * 3 + 4;
  if (bytes.length < needed) {
    throw new Error(`Truncated CDP ccdata_section (need ${needed} bytes, got ${bytes.length}).`);
  }
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  if (sum !== 0) throw new Error(`Bad CDP packet checksum (sum ${sum} ≠ 0 mod 256).`);

  const frameRateCode = (bytes[3]! >> 4) & 0x0f;
  const seq = ((bytes[5]! << 8) | bytes[6]!) & 0xffff;
  const triplets: CcTriplet[] = [];
  let i = 9;
  for (let n = 0; n < ccCount; n++) {
    triplets.push([bytes[i]!, bytes[i + 1]!, bytes[i + 2]!]);
    i += 3;
  }
  return { triplets, seq, frameRateCode };
}

/* -------------------------------------------------------------------------- */
/*  DTVCC caption-channel transport                                            */
/* -------------------------------------------------------------------------- */

/** Encode one DTVCC service block: `service_number(3) | block_size(5)` header. */
export function encodeServiceBlock(service: number, data: number[]): number[] {
  if (data.length > 0x1f) throw new Error('DTVCC service block exceeds 31 bytes.');
  return [((service & 0x07) << 5) | (data.length & 0x1f), ...data];
}

/**
 * Encode a DTVCC caption-channel packet: `sequence(2) | packet_size_code(6)`
 * header, the concatenated service blocks, then NUL padding to an even length.
 * `packet_size_code = total_bytes / 2` (0 would mean 128).
 */
export function encodeDtvccPacket(blocks: number[][], seq = 0): number[] {
  const body = blocks.flat();
  let total = 1 + body.length;
  if (total % 2 === 1) total += 1; // pad to even
  const sizeCode = (total / 2) & 0x3f;
  const packet = [((seq & 0x03) << 6) | sizeCode, ...body];
  while (packet.length < total) packet.push(0x00);
  return packet;
}

/** A decoded DTVCC packet. */
export interface DtvccPacket {
  seq: number;
  blocks: { service: number; data: number[] }[];
}

/** Decode a DTVCC caption-channel packet into its service blocks. */
export function decodeDtvccPacket(packet: number[]): DtvccPacket {
  const seq = (packet[0]! >> 6) & 0x03;
  const sizeCode = packet[0]! & 0x3f;
  const size = sizeCode === 0 ? 128 : sizeCode * 2;
  const blocks: DtvccPacket['blocks'] = [];
  let i = 1;
  while (i < size && size - i > 1) {
    const service = (packet[i]! >> 5) & 0x07;
    const blockSize = packet[i]! & 0x1f;
    i += 1;
    if (blockSize === 0) break;
    if (service === 0) break; // NUL fill to end of packet
    blocks.push({ service, data: packet.slice(i, i + blockSize) });
    i += blockSize;
  }
  return { seq, blocks };
}

/**
 * Chop a DTVCC packet byte stream into cc-triplets: the first pair rides a
 * `DTVCC_START` (0xFF) triplet, each subsequent pair a `DTVCC_DATA` (0xFE) one.
 * An odd trailing byte is padded with NUL.
 */
export function dtvccToTriplets(packet: number[]): CcTriplet[] {
  const triplets: CcTriplet[] = [];
  for (let i = 0; i < packet.length; i += 2) {
    const marker = i === 0 ? CC_TYPE.DTVCC_START : CC_TYPE.DTVCC_DATA;
    triplets.push([marker, packet[i]!, packet[i + 1] ?? 0x00]);
  }
  return triplets;
}

/** Reassemble a DTVCC packet from its `DTVCC_START`/`DTVCC_DATA` triplets. */
export function tripletsToDtvcc(triplets: CcTriplet[]): number[] {
  const bytes: number[] = [];
  for (const [marker, d1, d2] of triplets) {
    if (marker === CC_TYPE.DTVCC_START || marker === CC_TYPE.DTVCC_DATA) bytes.push(d1, d2);
  }
  return bytes;
}

/* -------------------------------------------------------------------------- */
/*  DTVCC C1 window / pen commands                                             */
/* -------------------------------------------------------------------------- */

const C1_DISPLAY_WINDOWS = 0x89;
const C1_DELETE_WINDOWS = 0x8c;
const C1_SET_PEN_ATTRIBUTES = 0x90;
const C1_SET_PEN_COLOR = 0x91;
const C1_SET_PEN_LOCATION = 0x92;
const C1_DEFINE_WINDOW_BASE = 0x98;

/** Parameters of a DefineWindow (DFx) command. */
export interface WindowDef {
  visible: boolean;
  rowLock: boolean;
  colLock: boolean;
  priority: number;
  relative: boolean;
  verticalAnchor: number;
  horizontalAnchor: number;
  anchorId: number;
  rowCount: number;
  columnCount: number;
  windowStyle: number;
  penStyle: number;
}

/** Build a DefineWindow (DF0–DF7) command with its 6 parameter bytes. */
export function cmdDefineWindow(windowId: number, w: WindowDef): number[] {
  const b0 =
    (w.visible ? 0x20 : 0) | (w.rowLock ? 0x10 : 0) | (w.colLock ? 0x08 : 0) | (w.priority & 0x07);
  const b1 = (w.relative ? 0x80 : 0) | (w.verticalAnchor & 0x7f);
  const b2 = w.horizontalAnchor & 0xff;
  const b3 = ((w.anchorId & 0x0f) << 4) | (w.rowCount & 0x0f);
  const b4 = w.columnCount & 0x3f;
  const b5 = ((w.windowStyle & 0x07) << 3) | (w.penStyle & 0x07);
  return [C1_DEFINE_WINDOW_BASE | (windowId & 0x07), b0, b1, b2, b3, b4, b5];
}

/** Build a DisplayWindows (DSW) command from a window bitmap. */
export function cmdDisplayWindows(bitmap: number): number[] {
  return [C1_DISPLAY_WINDOWS, bitmap & 0xff];
}

/** Build a DeleteWindows (DLW) command from a window bitmap. */
export function cmdDeleteWindows(bitmap: number): number[] {
  return [C1_DELETE_WINDOWS, bitmap & 0xff];
}

/** Build a SetPenLocation (SPL) command. */
export function cmdSetPenLocation(row: number, column: number): number[] {
  return [C1_SET_PEN_LOCATION, row & 0x0f, column & 0x3f];
}

/** Pen attribute toggles carried by SetPenAttributes. */
export interface PenAttributes {
  italic: boolean;
  underline: boolean;
}

/**
 * Build a SetPenAttributes (SPA) command. Pen size = standard, offset = normal,
 * text tag = dialog, edge = none, font = default; only italic/underline vary.
 * b1 = `italic(0x80) | underline(0x60) | edge(0x38) | font(0x07)`.
 */
export function cmdSetPenAttributes(a: PenAttributes): number[] {
  const b0 = (0x01 << 2) | 0x01; // offset normal (0x04) | pen size standard (0x01)
  const b1 = (a.italic ? 0x80 : 0) | (a.underline ? 0x60 : 0);
  return [C1_SET_PEN_ATTRIBUTES, b0, b1];
}

/** Named-colour → 2-bit-per-component (R,G,B) 708 colour byte. */
export function colorTo708(color: string): number {
  const rgb: Record<string, [number, number, number]> = {
    white: [3, 3, 3],
    black: [0, 0, 0],
    red: [3, 0, 0],
    green: [0, 3, 0],
    blue: [0, 0, 3],
    yellow: [3, 3, 0],
    cyan: [0, 3, 3],
    magenta: [3, 0, 3],
  };
  const [r, g, b] = rgb[color] ?? rgb.white!;
  return ((r & 0x03) << 4) | ((g & 0x03) << 2) | (b & 0x03);
}

/**
 * Build a SetPenColor (SPC) command: solid foreground of `color`, transparent
 * background, no edge. b0 = `fg opacity solid(0x00) | fg colour`; b1 =
 * `bg opacity transparent(0xC0)`; b2 = edge colour 0.
 */
export function cmdSetPenColor(color: string): number[] {
  return [C1_SET_PEN_COLOR, colorTo708(color), 0xc0, 0x00];
}

/** Derive pen attribute toggles from a span style. */
export function penAttributesFor(style: { italic?: boolean; underline?: boolean }): PenAttributes {
  return { italic: !!style.italic, underline: !!style.underline };
}

/* -------------------------------------------------------------------------- */
/*  DTVCC text (G0 / G1 / G2)                                                  */
/* -------------------------------------------------------------------------- */

const EXT1 = 0x10;

/** G2 (EXT1-prefixed) code → glyph, per CEA-708-D / caption-inspector. */
const G2_CHARS: Record<number, string> = {
  0x25: '…',
  0x2a: 'Š',
  0x2c: 'Œ',
  0x30: '█',
  0x33: '“',
  0x34: '”',
  0x35: '•',
  0x39: '™',
  0x3a: 'š',
  0x3c: 'œ',
  0x3d: '℠',
  0x3f: 'Ÿ',
  0x76: '⅛',
  0x77: '⅜',
  0x78: '⅝',
  0x79: '⅞',
};

const G2_REVERSE: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (const [code, ch] of Object.entries(G2_CHARS)) if (!(ch in m)) m[ch] = Number(code);
  return m;
})();

/** Encode one character into its DTVCC text bytes, or null if unrepresentable. */
function encode708Char(ch: string): number[] | null {
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x20 && cp <= 0x7f) return [cp]; // G0 (ASCII)
  if (cp >= 0xa0 && cp <= 0xff) return [cp]; // G1 (Latin-1 == Unicode)
  if (ch in G2_REVERSE) return [EXT1, G2_REVERSE[ch]!]; // G2 behind EXT1
  return null;
}

/**
 * Encode a string into DTVCC text bytes. Out-of-set characters are dropped (the
 * caller uses {@link canEncode708} / the MCC charset check to warn beforehand).
 */
export function encode708Text(text: string): number[] {
  const bytes: number[] = [];
  for (const ch of text) {
    const enc = encode708Char(ch);
    if (enc) bytes.push(...enc);
  }
  return bytes;
}

/** C1 command (0x80–0x9F) argument-byte counts (CEA-708-D). */
const C1_ARG_COUNT: Record<number, number> = {
  0x88: 1,
  0x89: 1,
  0x8a: 1,
  0x8b: 1,
  0x8c: 1,
  0x8d: 1,
  0x8e: 0,
  0x8f: 0,
  0x90: 2,
  0x91: 3,
  0x92: 2,
  0x97: 4,
};

/**
 * Extract the visible text from a DTVCC command/text stream, skipping C0 and C1
 * commands (with their argument bytes) and decoding G0/G1/G2 glyphs. Used to
 * verify the 708 layer round-trips; cue reconstruction proper uses the CEA-608
 * companion track (see `mcc.ts`).
 */
export function decode708Text(stream: number[]): string {
  let out = '';
  let i = 0;
  while (i < stream.length) {
    const b = stream[i]!;
    if (b === EXT1) {
      const code = stream[i + 1];
      if (code !== undefined && code in G2_CHARS) out += G2_CHARS[code];
      i += 2;
    } else if (b <= 0x0f) {
      i += 1; // C0 single-byte command (NUL, ETX, CR, …)
    } else if (b >= 0x11 && b <= 0x17) {
      i += 2; // C0 two-byte code
    } else if (b >= 0x18 && b <= 0x1f) {
      i += 3; // C0 three-byte code
    } else if (b >= 0x80 && b <= 0x87) {
      i += 1; // SetCurrentWindow (no args)
    } else if (b >= 0x88 && b <= 0x9f) {
      i += 1 + (C1_ARG_COUNT[b] ?? (b >= 0x98 ? 6 : 0)); // C1 command + args (DFx = 6)
    } else if (b >= 0x20 && b <= 0x7f) {
      out += String.fromCharCode(b); // G0
      i += 1;
    } else if (b >= 0xa0 && b <= 0xff) {
      out += String.fromCharCode(b); // G1
      i += 1;
    } else {
      i += 1;
    }
  }
  return out;
}

/** Whether a character is representable in the DTVCC (708) text layer. */
export function canEncode708(ch: string): boolean {
  return encode708Char(ch) !== null;
}
