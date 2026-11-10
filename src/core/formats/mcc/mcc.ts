import type { Cue, CueLine, ParseWarning, StyledSpan, SubtitleDocument } from '../../model/types';
import {
  addOddParity,
  canEncodeCea608,
  decodeBasicChar,
  decodeControl,
  decodeExtendedChar,
  decodeMidRow,
  decodePac,
  encodeChar,
  encodePac,
  frameToMs,
  frameToTimecode,
  isPac,
  msToFrame,
  SPECIAL_CHARS,
  stripParity,
} from '../scc/cea608';
import {
  CC_COUNT_29_97,
  CC_TYPE,
  CDP_FRAME_RATE_29_97,
  cmdDefineWindow,
  cmdDeleteWindows,
  cmdDisplayWindows,
  cmdSetPenAttributes,
  cmdSetPenColor,
  cmdSetPenLocation,
  dtvccToTriplets,
  encode708Text,
  encodeDtvccPacket,
  encodeServiceBlock,
  packCdp,
  penAttributesFor,
  unpackCdp,
  type CcTriplet,
} from './cea708';

/**
 * MCC (MacCaption / CEA-708) container codec (spec MCC).
 *
 * An MCC file is an ASCII "Ancillary Data Packet Transfer File": a fixed header
 * documenting the alias table, then one `HH:MM:SS:FF<TAB><hex>` line per video
 * frame. Each line's hex is an ANC packet (DID 0x61 / SDID 0x01) wrapping a
 * Caption Distribution Packet (CDP, SMPTE ST 334-2) whose `ccdata_section`
 * carries `cc_count` 3-byte triplets. Every serialized frame carries BOTH:
 *
 *   - a CEA-608 line-21 field-1 companion track (0xFC triplets), assembled as
 *     pop-on captions exactly like the SCC codec (one 608 word per frame, EOC on
 *     the start frame, EDM at the end) so legacy decoders and 608-only ingest
 *     see the captions; and
 *   - a CEA-708 DTVCC track (0xFF/0xFE triplets): the DefineWindow + pen + text
 *     command stream split into one ≤128-byte caption-channel packet per frame,
 *     placed so the window is populated by the cue's start frame, and a
 *     DeleteWindows packet at the end.
 *
 * `parseMcc` reconstructs cues from the 608 companion track (universally present
 * in our output and standard in broadcast MCC), reusing the shared CEA-608
 * primitives; the DTVCC layer is fully encoded and round-trips at the primitive
 * level (`cea708.ts`). Timing is integer milliseconds on the 30000/1001
 * timebase; the file is emitted at 29.97 drop-frame (Time Code Rate=30DF).
 *
 * Byte layout verified against Comcast's caption-inspector and a real MacCaption
 * `.mcc` sample (see `cea708.ts` header). Two deviations from a naive reading of
 * caption-inspector's `mcc_encode.c`, both matching real MacCaption output:
 *   - lines end at the CDP `packet_checksum` (no trailing VANC checksum byte);
 *   - newlines are LF, matching the sibling SCC serializer.
 */

/* -------------------------------------------------------------------------- */
/*  Alias compression                                                          */
/* -------------------------------------------------------------------------- */

/** `n` repetitions of the FA0000 idle-padding run (aliases G/H/…/O). */
function faRun(n: number): number[] {
  return Array.from({ length: n }, () => [0xfa, 0x00, 0x00]).flat();
}

/** The MacCaption single-character alias table (mcc_encode.c header block). */
export const MCC_ALIASES: Record<string, number[]> = {
  G: faRun(1),
  H: faRun(2),
  I: faRun(3),
  J: faRun(4),
  K: faRun(5),
  L: faRun(6),
  M: faRun(7),
  N: faRun(8),
  O: faRun(9),
  P: [0xfb, 0x80, 0x80],
  Q: [0xfc, 0x80, 0x80],
  R: [0xfd, 0x80, 0x80],
  S: [0x96, 0x69],
  T: [0x61, 0x01],
  U: [0xe1, 0x00, 0x00, 0x00],
  Z: [0x00],
};

/** Aliases ordered longest-run-first so compression is greedy and unambiguous. */
const ALIAS_BY_LENGTH: Array<[string, number[]]> = Object.entries(MCC_ALIASES).sort(
  (a, b) => b[1].length - a[1].length,
);

/** Expand an alias/hex payload string into raw bytes. */
export function expandAliases(payload: string): number[] {
  const bytes: number[] = [];
  let i = 0;
  while (i < payload.length) {
    const ch = payload[i]!;
    if (ch in MCC_ALIASES) {
      bytes.push(...MCC_ALIASES[ch]!);
      i += 1;
    } else {
      // Two hex digits form one byte.
      const hex = payload.slice(i, i + 2);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new Error(`Malformed MCC payload near "${payload.slice(i, i + 4)}".`);
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
    }
  }
  return bytes;
}

/** Compress a byte array into an alias/hex payload string (aliases preferred). */
export function compressAliases(bytes: number[]): string {
  let out = '';
  let i = 0;
  outer: while (i < bytes.length) {
    for (const [alias, seq] of ALIAS_BY_LENGTH) {
      if (i + seq.length <= bytes.length && seq.every((b, k) => bytes[i + k] === b)) {
        out += alias;
        i += seq.length;
        continue outer;
      }
    }
    out += bytes[i]!.toString(16).padStart(2, '0').toUpperCase();
    i += 1;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Header                                                                     */
/* -------------------------------------------------------------------------- */

const HEADER_LINES = [
  'File Format=MacCaption_MCC V1.0',
  '///////////////////////////////////////////////////////////////////////////////////',
  '// Telestream, LLC',
  '// Ancillary Data Packet Transfer File',
  '//',
  '// Permission to generate this format is granted provided that',
  '//   1. This ANC Transfer file format is used on an as-is basis and no warranty is given, and',
  '//   2. This entire descriptive information text is included in a generated .mcc file.',
  '//',
  '// General file format:',
  '//   HH:MM:SS:FF(tab)[Hexadecimal ANC data in groups of 2 characters]',
  '//     Hexadecimal data starts with the Ancillary Data Packet DID (Data ID defined in S291M)',
  '//       and concludes with the Check Sum following the User Data Words.',
  '//     Each time code line must contain at most one complete ancillary data packet.',
  '//     To transfer additional ANC Data successive lines may contain identical time code.',
  '//     Time Code Rate=[24, 25, 30, 30DF, 50, 60, 60DF]',
  '//',
  '//   ANC data bytes may be represented by one ASCII character according to the following schema:',
  '//     G  FAh 00h 00h',
  '//     H  2 x (FAh 00h 00h)',
  '//     I  3 x (FAh 00h 00h)',
  '//     J  4 x (FAh 00h 00h)',
  '//     K  5 x (FAh 00h 00h)',
  '//     L  6 x (FAh 00h 00h)',
  '//     M  7 x (FAh 00h 00h)',
  '//     N  8 x (FAh 00h 00h)',
  '//     O  9 x (FAh 00h 00h)',
  '//     P  FBh 80h 80h',
  '//     Q  FCh 80h 80h',
  '//     R  FDh 80h 80h',
  '//     S  96h 69h',
  '//     T  61h 01h',
  '//     U  E1h 00h 00h 00h',
  '//     Z  00h',
  '//',
  '///////////////////////////////////////////////////////////////////////////////////',
  '',
];

/**
 * Fixed default metadata so serializer output is byte-deterministic (the tests
 * and downstream diffs depend on it; real creation timestamps would not).
 */
const METADATA_LINES = [
  'UUID=00000000-0000-0000-0000-000000000000',
  'Creation Program=CueForge',
  'Creation Date=Thursday, January 1, 1970',
  'Creation Time=0:00:00',
  'Time Code Rate=30DF',
  '',
];

/** Full header + metadata block preceding the per-frame lines. */
function headerBlock(): string[] {
  return [...HEADER_LINES, ...METADATA_LINES];
}

/* -------------------------------------------------------------------------- */
/*  Serialize: CEA-608 companion track (pop-on, one word per frame)            */
/* -------------------------------------------------------------------------- */

const MIDROW_COLOR_INDEX: Record<string, number> = {
  white: 0,
  green: 1,
  blue: 2,
  cyan: 3,
  red: 4,
  yellow: 5,
  magenta: 6,
};

const MAX_ROW_CHARS = 32;

interface CharCell {
  ch: string;
  italic: boolean;
  underline: boolean;
  color?: string;
}

function lineToCells(spans: StyledSpan[]): CharCell[] {
  const cells: CharCell[] = [];
  for (const span of spans) {
    for (const ch of span.text) {
      cells.push({ ch, italic: !!span.italic, underline: !!span.underline, color: span.color });
    }
  }
  return cells;
}

/** Greedily wrap cells to {@link MAX_ROW_CHARS}, breaking at spaces. */
function wrapCells(cells: CharCell[]): CharCell[][] {
  if (cells.length <= MAX_ROW_CHARS) return [cells];
  const rows: CharCell[][] = [];
  let row: CharCell[] = [];
  let lastSpace = -1;
  for (const cell of cells) {
    row.push(cell);
    if (cell.ch === ' ') lastSpace = row.length - 1;
    if (row.length > MAX_ROW_CHARS) {
      const breakAt = lastSpace > 0 ? lastSpace : row.length - 1;
      rows.push(row.slice(0, breakAt));
      row = row.slice(breakAt + 1);
      lastSpace = -1;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

function midRowByte(italic: boolean, underline: boolean, color: string | undefined): number {
  const idx = italic ? 7 : color !== undefined ? (MIDROW_COLOR_INDEX[color] ?? 0) : 0;
  return 0x20 + idx * 2 + (underline ? 1 : 0);
}

function defaultRows(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 15 - (count - 1 - i));
}

/** Plain (colourless, no-indent) Preamble Address Code for a row start. */
function rowPac(row: number): [number, number] {
  return encodePac(row, 0, false, false);
}

/** 608 words for one wrapped row, applying mid-row style transitions. */
function encodeRow608(cells: CharCell[]): Array<[number, number]> {
  const words: Array<[number, number]> = [];
  let curItalic = false;
  let curUnderline = false;
  let curColor: string | undefined;
  let pending: number | null = null;

  const flush = () => {
    if (pending !== null) {
      words.push([pending, 0x00]);
      pending = null;
    }
  };
  const emitByte = (byte: number) => {
    if (pending === null) pending = byte;
    else {
      words.push([pending, byte]);
      pending = null;
    }
  };
  const emitControl = (b1: number, b2: number) => {
    flush();
    words.push([b1, b2], [b1, b2]); // doubled, per 608 convention
  };

  for (const cell of cells) {
    if (cell.italic !== curItalic || cell.underline !== curUnderline || cell.color !== curColor) {
      emitControl(0x11, midRowByte(cell.italic, cell.underline, cell.color));
      curItalic = cell.italic;
      curUnderline = cell.underline;
      curColor = cell.color;
    }
    for (const enc of encodeChar(cell.ch)) {
      if (enc.kind === 'basic') emitByte(enc.byte);
      else if (enc.kind === 'special') emitControl(0x11, enc.b2);
      else {
        emitByte(enc.fallback);
        emitControl(enc.b1, enc.b2);
      }
    }
  }
  flush();
  return words;
}

/** A 608 word (two data bytes) to emit on a specific frame. */
interface Word608 {
  frame: number;
  b1: number;
  b2: number;
}

const RCL: [number, number] = [0x14, 0x20];
const EOC: [number, number] = [0x14, 0x2f];
const EDM: [number, number] = [0x14, 0x2c];

/**
 * Build the CEA-608 companion track as a per-frame word list, mirroring the SCC
 * pop-on scheduler: each caption is back-timed so its EOC lands on the start
 * frame, transmissions never collide, and a trailing EDM clears the display.
 */
function build608Track(cues: Cue[], warnings?: ParseWarning[]): Word608[] {
  const words: Word608[] = [];
  let nextFree = 0;
  let pendingEdm: number | null = null;

  const push = (frame: number, pair: [number, number]) => {
    words.push({ frame, b1: pair[0], b2: pair[1] });
  };
  const emitEdm = (frame: number) => {
    push(frame, EDM);
    push(frame + 1, EDM);
    nextFree = frame + 2;
  };

  for (const cue of cues) {
    const startFrame = msToFrame(cue.startMs);
    const endFrame = Math.max(msToFrame(cue.endMs), startFrame + 1);

    const wrappedRows = cue.lines.flatMap((line) => wrapCells(lineToCells(line.spans)));
    const rowNumbers = defaultRows(wrappedRows.length || 1);

    const seq: Array<[number, number]> = [RCL, RCL];
    wrappedRows.forEach((cells, i) => {
      const pac = rowPac(rowNumbers[i] ?? 15);
      seq.push(pac, pac);
      seq.push(...encodeRow608(cells));
    });
    const eocIndex = seq.length;
    seq.push(EOC, EOC);

    let captionFrame = Math.max(0, startFrame - eocIndex);

    if (pendingEdm !== null) {
      // The doubled EDM needs 2 free frames before the next cue's transmission
      // begins. When a sub-second gap leaves no room, the EDM is intentionally
      // dropped: the prior caption stays displayed until the next EOC replaces
      // it (a bounded end-time stretch to the next cue's start). That is the
      // least-bad outcome — emitting the EDM early would clip the prior cue's
      // authored duration, and delaying the lead-in would shift the NEXT cue's
      // start, corrupting timing instead of stretching it. Tested in mcc.test.ts
      // (cue-forge-jde).
      const edmFrame = Math.max(pendingEdm, nextFree);
      if (edmFrame + 2 <= captionFrame) emitEdm(edmFrame);
    }
    if (captionFrame < nextFree) {
      captionFrame = nextFree;
      if (captionFrame + eocIndex > startFrame) {
        warnings?.push({
          code: 'captions-too-dense',
          message: `Captions too dense near cue ${cue.index}.`,
          cueIndex: cue.index,
        });
      }
    }

    seq.forEach((pair, k) => push(captionFrame + k, pair));
    nextFree = captionFrame + seq.length;
    pendingEdm = endFrame;
  }

  if (pendingEdm !== null) emitEdm(Math.max(pendingEdm, nextFree));
  return words;
}

/* -------------------------------------------------------------------------- */
/*  Serialize: CEA-708 DTVCC track                                             */
/* -------------------------------------------------------------------------- */

const DTVCC_SERVICE = 1;
const MAX_BLOCK = 0x1f; // service-block data limit (5-bit size)
const MAX_DTVCC_TRIPLETS = CC_COUNT_29_97 - 2; // room after the two 608 triplets

/** DTVCC triplets to emit on a specific frame. */
interface Dtvcc708 {
  frame: number;
  triplets: CcTriplet[];
}

/** Command bytes that load window 0 with a cue's styled text (pop-on). */
function load708Commands(cue: Cue): number[] {
  const cmds: number[] = [];
  const rows = cue.lines.length || 1;
  cmds.push(
    ...cmdDefineWindow(0, {
      visible: true,
      rowLock: true,
      colLock: true,
      priority: 0,
      relative: false,
      verticalAnchor: 79,
      horizontalAnchor: 100,
      anchorId: 7,
      rowCount: Math.max(0, rows - 1),
      columnCount: 31,
      windowStyle: 1,
      penStyle: 1,
    }),
  );
  cue.lines.forEach((line, row) => {
    cmds.push(...cmdSetPenLocation(row, 0));
    let curItalic = false;
    let curUnderline = false;
    let curColor: string | undefined = undefined;
    let started = false;
    for (const span of line.spans) {
      const italic = !!span.italic;
      const underline = !!span.underline;
      const color = span.color;
      if (!started || italic !== curItalic || underline !== curUnderline) {
        cmds.push(...cmdSetPenAttributes(penAttributesFor({ italic, underline })));
      }
      if (!started || color !== curColor) {
        cmds.push(...cmdSetPenColor(color ?? 'white'));
      }
      cmds.push(...encode708Text(span.text));
      curItalic = italic;
      curUnderline = underline;
      curColor = color;
      started = true;
    }
  });
  cmds.push(...cmdDisplayWindows(0x01));
  cmds.push(0x03); // ETX flush
  return cmds;
}

/**
 * Split a service command stream into per-packet ≤31-byte chunks. Each chunk
 * becomes ONE service block inside ONE caption-channel packet on ONE frame: the
 * packet's 6-bit `packet_size_code` counts `total_bytes / 2` with 0 meaning 128
 * (CEA-708-D; caption-inspector `dtvcc_decode.c` `processCurrentPacket`), so a
 * single packet may never exceed 128 bytes — a long multi-line cue's command
 * stream must split into multiple packets, not one oversized packet whose size
 * code silently wraps. A 31-byte chunk packs to a 34-byte packet = 17 triplets,
 * within the per-frame budget, so every frame's DTVCC data starts on its own
 * DTVCC_START triplet and is independently decodable.
 */
function toServiceChunks(commands: number[]): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < commands.length; i += MAX_BLOCK) {
    chunks.push(commands.slice(i, i + MAX_BLOCK));
  }
  return chunks;
}

/** One service-block chunk with its preferred frame before collision spilling. */
interface Chunk708 {
  frame: number;
  bytes: number[];
}

/**
 * Build the DTVCC track: each cue's load commands are split into one packet per
 * frame, scheduled so the last packet lands on the start frame (lead-in), and a
 * DeleteWindows packet lands on the end frame. Packet sequence numbers increment
 * modulo 4 in frame order across the whole track (CEA-708-D `sequence_number`).
 * Frames are best-effort — the authoritative timing is the 608 companion track.
 *
 * A ≤31-byte chunk packs to a 34-byte packet = 17 triplets, so ONE packet fits
 * the per-frame DTVCC budget (`MAX_DTVCC_TRIPLETS`) but two do not. When dense or
 * overlapping cues would schedule two packets on one frame, the surplus is
 * spilled to the next free frame rather than concatenated (which would exceed the
 * budget and truncate the second packet's tail, breaking the every-frame-self-
 * contained invariant — cue-forge-oti). Spilling forward keeps frames unique and
 * sequence numbers continuous; the bounded frame shift is immaterial since the
 * 608 companion track carries the authoritative timing.
 */
function build708Track(cues: Cue[]): Dtvcc708[] {
  const chunks: Chunk708[] = [];
  for (const cue of cues) {
    const startFrame = msToFrame(cue.startMs);
    const endFrame = Math.max(msToFrame(cue.endMs), startFrame + 1);

    const serviceChunks = toServiceChunks(load708Commands(cue));
    const beginFrame = Math.max(0, startFrame - (serviceChunks.length - 1));
    serviceChunks.forEach((bytes, f) => chunks.push({ frame: beginFrame + f, bytes }));

    chunks.push({ frame: endFrame, bytes: cmdDeleteWindows(0x01) });
  }

  // Assign every chunk a distinct frame (spilling collisions forward) and encode
  // in ascending frame order so sequence numbers stay continuous for a decoder
  // consuming the stream front to back.
  let seq = 0;
  let nextFree = -1;
  return chunks
    .sort((a, b) => a.frame - b.frame)
    .map(({ frame: preferred, bytes }) => {
      const frame = Math.max(preferred, nextFree);
      nextFree = frame + 1;
      const packet = encodeDtvccPacket([encodeServiceBlock(DTVCC_SERVICE, bytes)], seq);
      seq = (seq + 1) & 0x03;
      return { frame, triplets: dtvccToTriplets(packet) };
    });
}

/* -------------------------------------------------------------------------- */
/*  Serialize                                                                  */
/* -------------------------------------------------------------------------- */

/** Null CEA-608 triplet (0x00 byte carries odd parity 0x80). */
const NULL_608_F1: CcTriplet = [CC_TYPE.E608_F1, 0x80, 0x80];
const NULL_608_F2: CcTriplet = [CC_TYPE.E608_F2, 0x80, 0x80];
const DTVCC_PADDING: CcTriplet = [CC_TYPE.DTVCC_PAD, 0x00, 0x00];

/** Serialize a document to MCC (spec MCC). */
export function serializeMcc(doc: SubtitleDocument, warnings?: ParseWarning[]): string {
  const track608 = build608Track(doc.cues, warnings);
  const track708 = build708Track(doc.cues);

  const word608ByFrame = new Map<number, [number, number]>();
  for (const w of track608) word608ByFrame.set(w.frame, [w.b1, w.b2]);
  const dtvccByFrame = new Map<number, CcTriplet[]>();
  for (const d of track708) dtvccByFrame.set(d.frame, d.triplets);

  const frames = new Set<number>([...word608ByFrame.keys(), ...dtvccByFrame.keys()]);
  if (frames.size === 0) return headerBlock().join('\n');
  const first = Math.min(...frames);
  const last = Math.max(...frames);

  const lines = headerBlock();

  let seq = 0;
  for (let frame = first; frame <= last; frame++) {
    const triplets: CcTriplet[] = [];

    // Field-1 608 companion word (or null padding).
    const word = word608ByFrame.get(frame);
    triplets.push(
      word ? [CC_TYPE.E608_F1, addOddParity(word[0]), addOddParity(word[1])] : NULL_608_F1,
    );
    // Field-2 608 is always null (single-field captions).
    triplets.push(NULL_608_F2);

    // DTVCC track (or a single padding triplet when idle). `build708Track`
    // guarantees at most one self-contained packet (≤17 triplets) per frame by
    // spilling colliding packets to neighbouring frames, so the slice below is a
    // defensive bound that keeps cc_count within its 5-bit field — never a
    // truncation in practice (cue-forge-oti).
    const dtvcc = dtvccByFrame.get(frame);
    if (dtvcc && dtvcc.length > 0) triplets.push(...dtvcc.slice(0, MAX_DTVCC_TRIPLETS));
    else triplets.push(DTVCC_PADDING);

    // Pad to the fixed 29.97 cc_count with invalid-DTVCC padding.
    while (triplets.length < CC_COUNT_29_97) triplets.push(DTVCC_PADDING);

    const cdp = packCdp(triplets, seq, CDP_FRAME_RATE_29_97);
    seq = (seq + 1) & 0xffff;
    const anc = [0x61, 0x01, cdp.length & 0xff, ...cdp];
    lines.push(`${frameToTimecode(frame, true)}\t${compressAliases(anc)}`);
  }

  lines.push('');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Parse (via the CEA-608 companion track)                                    */
/* -------------------------------------------------------------------------- */

interface Style {
  italic: boolean;
  underline: boolean;
  color?: string;
}

interface BufferRow {
  row: number;
  spans: StyledSpan[];
}

interface Displayed {
  startFrame: number;
  rows: BufferRow[];
}

/**
 * A focused CEA-608 pop-on decoder over the field-1 companion track, using the
 * shared cea608 primitives. Mirrors the SCC decoder's pop-on path (RCL builds a
 * hidden buffer; EOC flips it on screen; EDM/next-EOC ends it).
 */
class Cea608PopOnDecoder {
  private buffer: BufferRow[] = [];
  private currentRow = 15;
  private style: Style = { italic: false, underline: false };
  private displayed: Displayed | null = null;
  private lastControlWord = -1;
  private lastFrame = 0;

  readonly cues: Cue[] = [];

  private getRow(row: number): BufferRow {
    let r = this.buffer.find((x) => x.row === row);
    if (!r) {
      r = { row, spans: [] };
      this.buffer.push(r);
    }
    return r;
  }

  private pushSpan(text: string): void {
    if (text === '') return;
    const spans = this.getRow(this.currentRow).spans;
    const last = spans[spans.length - 1];
    if (
      last &&
      !!last.italic === this.style.italic &&
      !!last.underline === this.style.underline &&
      last.color === this.style.color
    ) {
      last.text += text;
      return;
    }
    const span: StyledSpan = { text };
    if (this.style.italic) span.italic = true;
    if (this.style.underline) span.underline = true;
    if (this.style.color !== undefined) span.color = this.style.color;
    spans.push(span);
  }

  private replaceLastWith(ch: string): void {
    const spans = this.getRow(this.currentRow).spans;
    for (let i = spans.length - 1; i >= 0; i--) {
      if (spans[i]!.text !== '') {
        spans[i]!.text = spans[i]!.text.slice(0, -1);
        break;
      }
    }
    this.pushSpan(ch);
  }

  private closeDisplayed(endFrame: number): void {
    if (!this.displayed) return;
    const ordered = this.displayed.rows
      .filter((r) => r.spans.some((s) => s.text !== ''))
      .sort((a, b) => a.row - b.row);
    if (ordered.length > 0) {
      const lines: CueLine[] = ordered.map((r) => ({ spans: r.spans }));
      this.cues.push({
        index: this.cues.length + 1,
        startMs: frameToMs(this.displayed.startFrame),
        endMs: frameToMs(Math.max(endFrame, this.displayed.startFrame)),
        lines,
      });
    }
    this.displayed = null;
  }

  private handleControl(b1: number, b2: number, frame: number): void {
    const command = decodeControl(b1, b2);
    if (command === 'RCL') {
      this.buffer = [];
      this.currentRow = 15;
      this.style = { italic: false, underline: false };
      return;
    }
    if (command === 'EOC') {
      this.closeDisplayed(frame);
      this.displayed = { startFrame: frame, rows: this.buffer };
      this.buffer = [];
      return;
    }
    if (command === 'EDM') {
      this.closeDisplayed(frame);
      return;
    }
    if (command) return; // other controls (ENM/roll-up/tabs) unused by our writer

    if (isPac(b1, b2)) {
      const pac = decodePac(b1, b2);
      this.currentRow = pac.row;
      this.style = { italic: pac.italic, underline: pac.underline };
      return;
    }
    if (b1 === 0x11 && b2 >= 0x20 && b2 <= 0x2f) {
      const m = decodeMidRow(b2);
      this.style = {
        italic: m.italic,
        underline: m.underline,
        color: m.color === 'white' ? undefined : m.color,
      };
      return;
    }
    if (b1 === 0x11 && b2 >= 0x30 && b2 <= 0x3f) {
      this.pushSpan(SPECIAL_CHARS[b2] ?? '');
      return;
    }
    const extended = decodeExtendedChar(b1, b2);
    if (extended !== null) this.replaceLastWith(extended);
  }

  processWord(b1: number, b2: number, frame: number): void {
    this.lastFrame = frame;
    if (b1 === 0 && b2 === 0) return; // null padding
    const word = (b1 << 8) | b2;
    if (b1 >= 0x10 && b1 <= 0x1f) {
      if (word === this.lastControlWord) {
        this.lastControlWord = -1; // doubled control acts once
        return;
      }
      this.lastControlWord = word;
      this.handleControl(b1, b2, frame);
      return;
    }
    this.lastControlWord = -1;
    this.pushSpan(decodeBasicChar(b1));
    this.pushSpan(decodeBasicChar(b2));
  }

  finish(): void {
    this.closeDisplayed(this.lastFrame);
  }
}

const TIMECODE_LINE = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})\t(.+)$/;

/** Parse an MCC file into a SubtitleDocument (spec MCC). */
export function parseMcc(text: string): SubtitleDocument {
  const warnings: ParseWarning[] = [];
  const decoder = new Cea608PopOnDecoder();
  let dropFrame = false;
  // Did any frame carry actual caption payload (708 DTVCC data, or non-null
  // 608 words) rather than pure padding? Used to distinguish a legitimately
  // empty file from one whose captions we simply cannot decode.
  let sawCaptionData = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const m = TIMECODE_LINE.exec(line);
    if (!m) continue;
    dropFrame = m[4] === ';';
    const frame = tcToFrame(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[5]), dropFrame);

    const timecode = `${m[1]}:${m[2]}:${m[3]}${m[4]}${m[5]}`;
    let bytes: number[];
    try {
      bytes = expandAliases(m[6]!);
    } catch {
      warnings.push({
        code: 'unexpected-content',
        message: `Malformed MCC payload at ${timecode}.`,
      });
      continue;
    }

    // Locate the CDP (0x96 0x69) after the ANC DID/SDID/data-count.
    const cdpStart = findCdp(bytes);
    if (cdpStart < 0) continue;
    let contents;
    try {
      contents = unpackCdp(bytes.slice(cdpStart));
    } catch (err) {
      warnings.push({
        code: 'unexpected-content',
        message: `Invalid CDP: ${(err as Error).message}`,
      });
      continue;
    }

    // Feed the field-1 608 words (in frame order) to the pop-on decoder.
    for (const [marker, d1, d2] of contents.triplets) {
      if (marker === CC_TYPE.DTVCC_START || marker === CC_TYPE.DTVCC_DATA) {
        sawCaptionData = true; // valid CEA-708 caption-channel data
      } else if (
        (marker === CC_TYPE.E608_F1 || marker === CC_TYPE.E608_F2) &&
        !(stripParity(d1) === 0 && stripParity(d2) === 0)
      ) {
        sawCaptionData = true; // non-null 608 word (data or a control code)
      }
      if (marker !== CC_TYPE.E608_F1) continue;
      decoder.processWord(stripParity(d1), stripParity(d2), frame);
    }
  }
  decoder.finish();

  const metadata: SubtitleDocument['metadata'] = {
    sourceFormat: 'mcc',
    frameRate: 30000 / 1001,
    raw: { dropFrame },
  };

  // The file carried caption payload but our field-1 pop-on decoder recovered
  // nothing — the captions are almost certainly CEA-708-only or 608 roll-up/
  // paint-on, neither of which this importer decodes. Warn rather than return a
  // silently blank document.
  if (decoder.cues.length === 0 && sawCaptionData) {
    warnings.push({
      code: 'unexpected-content',
      message:
        'No decodable pop-on CEA-608 captions found; this file may carry ' +
        'CEA-708-only or roll-up/paint-on captions, which import does not support.',
    });
  }

  for (let k = 1; k < decoder.cues.length; k++) {
    if (decoder.cues[k]!.startMs < decoder.cues[k - 1]!.endMs) {
      warnings.push({
        code: 'overlap',
        message: `Cue ${decoder.cues[k]!.index} overlaps the previous cue.`,
        cueIndex: decoder.cues[k]!.index,
      });
    }
  }

  return { cues: decoder.cues, metadata, warnings };
}

/** Find the CDP identifier (0x96 0x69) within an ANC payload. */
function findCdp(bytes: number[]): number {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x96 && bytes[i + 1] === 0x69) return i;
  }
  return -1;
}

/** Drop-frame-aware timecode → absolute frame index (30000/1001 timebase). */
function tcToFrame(h: number, m: number, s: number, f: number, drop: boolean): number {
  const totalMinutes = h * 60 + m;
  let frame = ((h * 60 + m) * 60 + s) * 30 + f;
  if (drop) frame -= 2 * (totalMinutes - Math.floor(totalMinutes / 10));
  return frame;
}

/* -------------------------------------------------------------------------- */
/*  Charset                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether a character survives an MCC round-trip. Although MCC carries a CEA-708
 * DTVCC track, cue text is authored into — and reconstructed from — the CEA-608
 * companion track (`parseMcc` rides field 1), so the *authoritative* charset is
 * 608, not the wider 708 set. Gating on 708 would pass characters (e.g. '×', 'Œ',
 * the vulgar fractions) that the 608 encoder silently substitutes with '?', so
 * the export pre-check must use the 608 predicate to match round-trip reality.
 */
export function canEncodeMcc(ch: string): boolean {
  return canEncodeCea608(ch);
}
