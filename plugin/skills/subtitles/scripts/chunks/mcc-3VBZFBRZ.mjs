import {
  SPECIAL_CHARS,
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
  stripParity
} from "./chunk-RCR4PM7R.mjs";

// src/core/formats/mcc/cea708.ts
var CC_TYPE = {
  /** valid CEA-608 line-21 field 1 (cc_type 0). */
  E608_F1: 252,
  /** valid CEA-608 line-21 field 2 (cc_type 1). */
  E608_F2: 253,
  /** valid DTVCC packet continuation (cc_type 2). */
  DTVCC_DATA: 254,
  /** valid DTVCC packet start (cc_type 3). */
  DTVCC_START: 255,
  /** invalid DTVCC channel data used as inter-packet padding. */
  DTVCC_PAD: 250
};
var CDP_FRAME_RATE_29_97 = 4;
var CC_COUNT_29_97 = 20;
var CDP_ID_HIGH = 150;
var CDP_ID_LOW = 105;
var CC_DATA_ID = 114;
var CDP_FOOTER_ID = 116;
function packCdp(triplets, seq, frameRateCode = CDP_FRAME_RATE_29_97) {
  const ccBytes = triplets.length * 3;
  const cdpLength = ccBytes + 13;
  const bytes = [
    CDP_ID_HIGH,
    CDP_ID_LOW,
    cdpLength & 255,
    (frameRateCode & 15) << 4 | 15,
    67,
    // timecode absent, service info absent, captions present
    seq >> 8 & 255,
    seq & 255,
    CC_DATA_ID,
    triplets.length & 31 | 224
  ];
  for (const [marker, d1, d2] of triplets) bytes.push(marker & 255, d1 & 255, d2 & 255);
  bytes.push(CDP_FOOTER_ID, seq >> 8 & 255, seq & 255);
  let sum = 0;
  for (const b of bytes) sum = sum + b & 255;
  bytes.push(256 - sum & 255);
  return bytes;
}
function unpackCdp(bytes) {
  if (bytes[0] !== CDP_ID_HIGH || bytes[1] !== CDP_ID_LOW) {
    throw new Error("Invalid CDP identifier (expected 0x9669).");
  }
  if (bytes.length < 9) {
    throw new Error(`Truncated CDP header (need 9 bytes, got ${bytes.length}).`);
  }
  if (bytes[7] !== CC_DATA_ID) throw new Error("CDP missing ccdata_section (0x72).");
  const ccCount = bytes[8] & 31;
  const needed = 9 + ccCount * 3 + 4;
  if (bytes.length < needed) {
    throw new Error(`Truncated CDP ccdata_section (need ${needed} bytes, got ${bytes.length}).`);
  }
  let sum = 0;
  for (const b of bytes) sum = sum + b & 255;
  if (sum !== 0) throw new Error(`Bad CDP packet checksum (sum ${sum} \u2260 0 mod 256).`);
  const frameRateCode = bytes[3] >> 4 & 15;
  const seq = (bytes[5] << 8 | bytes[6]) & 65535;
  const triplets = [];
  let i = 9;
  for (let n = 0; n < ccCount; n++) {
    triplets.push([bytes[i], bytes[i + 1], bytes[i + 2]]);
    i += 3;
  }
  return { triplets, seq, frameRateCode };
}
function encodeServiceBlock(service, data) {
  if (data.length > 31) throw new Error("DTVCC service block exceeds 31 bytes.");
  return [(service & 7) << 5 | data.length & 31, ...data];
}
function encodeDtvccPacket(blocks, seq = 0) {
  const body = blocks.flat();
  let total = 1 + body.length;
  if (total % 2 === 1) total += 1;
  const sizeCode = total / 2 & 63;
  const packet = [(seq & 3) << 6 | sizeCode, ...body];
  while (packet.length < total) packet.push(0);
  return packet;
}
function dtvccToTriplets(packet) {
  const triplets = [];
  for (let i = 0; i < packet.length; i += 2) {
    const marker = i === 0 ? CC_TYPE.DTVCC_START : CC_TYPE.DTVCC_DATA;
    triplets.push([marker, packet[i], packet[i + 1] ?? 0]);
  }
  return triplets;
}
var C1_DISPLAY_WINDOWS = 137;
var C1_DELETE_WINDOWS = 140;
var C1_SET_PEN_ATTRIBUTES = 144;
var C1_SET_PEN_COLOR = 145;
var C1_SET_PEN_LOCATION = 146;
var C1_DEFINE_WINDOW_BASE = 152;
function cmdDefineWindow(windowId, w) {
  const b0 = (w.visible ? 32 : 0) | (w.rowLock ? 16 : 0) | (w.colLock ? 8 : 0) | w.priority & 7;
  const b1 = (w.relative ? 128 : 0) | w.verticalAnchor & 127;
  const b2 = w.horizontalAnchor & 255;
  const b3 = (w.anchorId & 15) << 4 | w.rowCount & 15;
  const b4 = w.columnCount & 63;
  const b5 = (w.windowStyle & 7) << 3 | w.penStyle & 7;
  return [C1_DEFINE_WINDOW_BASE | windowId & 7, b0, b1, b2, b3, b4, b5];
}
function cmdDisplayWindows(bitmap) {
  return [C1_DISPLAY_WINDOWS, bitmap & 255];
}
function cmdDeleteWindows(bitmap) {
  return [C1_DELETE_WINDOWS, bitmap & 255];
}
function cmdSetPenLocation(row, column) {
  return [C1_SET_PEN_LOCATION, row & 15, column & 63];
}
function cmdSetPenAttributes(a) {
  const b0 = 1 << 2 | 1;
  const b1 = (a.italic ? 128 : 0) | (a.underline ? 96 : 0);
  return [C1_SET_PEN_ATTRIBUTES, b0, b1];
}
function colorTo708(color) {
  const rgb = {
    white: [3, 3, 3],
    black: [0, 0, 0],
    red: [3, 0, 0],
    green: [0, 3, 0],
    blue: [0, 0, 3],
    yellow: [3, 3, 0],
    cyan: [0, 3, 3],
    magenta: [3, 0, 3]
  };
  const [r, g, b] = rgb[color] ?? rgb.white;
  return (r & 3) << 4 | (g & 3) << 2 | b & 3;
}
function cmdSetPenColor(color) {
  return [C1_SET_PEN_COLOR, colorTo708(color), 192, 0];
}
function penAttributesFor(style) {
  return { italic: !!style.italic, underline: !!style.underline };
}
var EXT1 = 16;
var G2_CHARS = {
  37: "\u2026",
  42: "\u0160",
  44: "\u0152",
  48: "\u2588",
  51: "\u201C",
  52: "\u201D",
  53: "\u2022",
  57: "\u2122",
  58: "\u0161",
  60: "\u0153",
  61: "\u2120",
  63: "\u0178",
  118: "\u215B",
  119: "\u215C",
  120: "\u215D",
  121: "\u215E"
};
var G2_REVERSE = (() => {
  const m = {};
  for (const [code, ch] of Object.entries(G2_CHARS)) if (!(ch in m)) m[ch] = Number(code);
  return m;
})();
function encode708Char(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 32 && cp <= 127) return [cp];
  if (cp >= 160 && cp <= 255) return [cp];
  if (ch in G2_REVERSE) return [EXT1, G2_REVERSE[ch]];
  return null;
}
function encode708Text(text) {
  const bytes = [];
  for (const ch of text) {
    const enc = encode708Char(ch);
    if (enc) bytes.push(...enc);
  }
  return bytes;
}

// src/core/formats/mcc/mcc.ts
function faRun(n) {
  return Array.from({ length: n }, () => [250, 0, 0]).flat();
}
var MCC_ALIASES = {
  G: faRun(1),
  H: faRun(2),
  I: faRun(3),
  J: faRun(4),
  K: faRun(5),
  L: faRun(6),
  M: faRun(7),
  N: faRun(8),
  O: faRun(9),
  P: [251, 128, 128],
  Q: [252, 128, 128],
  R: [253, 128, 128],
  S: [150, 105],
  T: [97, 1],
  U: [225, 0, 0, 0],
  Z: [0]
};
var ALIAS_BY_LENGTH = Object.entries(MCC_ALIASES).sort(
  (a, b) => b[1].length - a[1].length
);
function expandAliases(payload) {
  const bytes = [];
  let i = 0;
  while (i < payload.length) {
    const ch = payload[i];
    if (ch in MCC_ALIASES) {
      bytes.push(...MCC_ALIASES[ch]);
      i += 1;
    } else {
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
function compressAliases(bytes) {
  let out = "";
  let i = 0;
  outer: while (i < bytes.length) {
    for (const [alias, seq] of ALIAS_BY_LENGTH) {
      if (i + seq.length <= bytes.length && seq.every((b, k) => bytes[i + k] === b)) {
        out += alias;
        i += seq.length;
        continue outer;
      }
    }
    out += bytes[i].toString(16).padStart(2, "0").toUpperCase();
    i += 1;
  }
  return out;
}
var HEADER_LINES = [
  "File Format=MacCaption_MCC V1.0",
  "///////////////////////////////////////////////////////////////////////////////////",
  "// Telestream, LLC",
  "// Ancillary Data Packet Transfer File",
  "//",
  "// Permission to generate this format is granted provided that",
  "//   1. This ANC Transfer file format is used on an as-is basis and no warranty is given, and",
  "//   2. This entire descriptive information text is included in a generated .mcc file.",
  "//",
  "// General file format:",
  "//   HH:MM:SS:FF(tab)[Hexadecimal ANC data in groups of 2 characters]",
  "//     Hexadecimal data starts with the Ancillary Data Packet DID (Data ID defined in S291M)",
  "//       and concludes with the Check Sum following the User Data Words.",
  "//     Each time code line must contain at most one complete ancillary data packet.",
  "//     To transfer additional ANC Data successive lines may contain identical time code.",
  "//     Time Code Rate=[24, 25, 30, 30DF, 50, 60, 60DF]",
  "//",
  "//   ANC data bytes may be represented by one ASCII character according to the following schema:",
  "//     G  FAh 00h 00h",
  "//     H  2 x (FAh 00h 00h)",
  "//     I  3 x (FAh 00h 00h)",
  "//     J  4 x (FAh 00h 00h)",
  "//     K  5 x (FAh 00h 00h)",
  "//     L  6 x (FAh 00h 00h)",
  "//     M  7 x (FAh 00h 00h)",
  "//     N  8 x (FAh 00h 00h)",
  "//     O  9 x (FAh 00h 00h)",
  "//     P  FBh 80h 80h",
  "//     Q  FCh 80h 80h",
  "//     R  FDh 80h 80h",
  "//     S  96h 69h",
  "//     T  61h 01h",
  "//     U  E1h 00h 00h 00h",
  "//     Z  00h",
  "//",
  "///////////////////////////////////////////////////////////////////////////////////",
  ""
];
var METADATA_LINES = [
  "UUID=00000000-0000-0000-0000-000000000000",
  "Creation Program=CueForge",
  "Creation Date=Thursday, January 1, 1970",
  "Creation Time=0:00:00",
  "Time Code Rate=30DF",
  ""
];
function headerBlock() {
  return [...HEADER_LINES, ...METADATA_LINES];
}
var MIDROW_COLOR_INDEX = {
  white: 0,
  green: 1,
  blue: 2,
  cyan: 3,
  red: 4,
  yellow: 5,
  magenta: 6
};
var MAX_ROW_CHARS = 32;
function lineToCells(spans) {
  const cells = [];
  for (const span of spans) {
    for (const ch of span.text) {
      cells.push({ ch, italic: !!span.italic, underline: !!span.underline, color: span.color });
    }
  }
  return cells;
}
function wrapCells(cells) {
  if (cells.length <= MAX_ROW_CHARS) return [cells];
  const rows = [];
  let row = [];
  let lastSpace = -1;
  for (const cell of cells) {
    row.push(cell);
    if (cell.ch === " ") lastSpace = row.length - 1;
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
function midRowByte(italic, underline, color) {
  const idx = italic ? 7 : color !== void 0 ? MIDROW_COLOR_INDEX[color] ?? 0 : 0;
  return 32 + idx * 2 + (underline ? 1 : 0);
}
function defaultRows(count) {
  return Array.from({ length: count }, (_, i) => 15 - (count - 1 - i));
}
function rowPac(row) {
  return encodePac(row, 0, false, false);
}
function encodeRow608(cells) {
  const words = [];
  let curItalic = false;
  let curUnderline = false;
  let curColor;
  let pending = null;
  const flush = () => {
    if (pending !== null) {
      words.push([pending, 0]);
      pending = null;
    }
  };
  const emitByte = (byte) => {
    if (pending === null) pending = byte;
    else {
      words.push([pending, byte]);
      pending = null;
    }
  };
  const emitControl = (b1, b2) => {
    flush();
    words.push([b1, b2], [b1, b2]);
  };
  for (const cell of cells) {
    if (cell.italic !== curItalic || cell.underline !== curUnderline || cell.color !== curColor) {
      emitControl(17, midRowByte(cell.italic, cell.underline, cell.color));
      curItalic = cell.italic;
      curUnderline = cell.underline;
      curColor = cell.color;
    }
    for (const enc of encodeChar(cell.ch)) {
      if (enc.kind === "basic") emitByte(enc.byte);
      else if (enc.kind === "special") emitControl(17, enc.b2);
      else {
        emitByte(enc.fallback);
        emitControl(enc.b1, enc.b2);
      }
    }
  }
  flush();
  return words;
}
var RCL = [20, 32];
var EOC = [20, 47];
var EDM = [20, 44];
function build608Track(cues, warnings) {
  const words = [];
  let nextFree = 0;
  let pendingEdm = null;
  const push = (frame, pair) => {
    words.push({ frame, b1: pair[0], b2: pair[1] });
  };
  const emitEdm = (frame) => {
    push(frame, EDM);
    push(frame + 1, EDM);
    nextFree = frame + 2;
  };
  for (const cue of cues) {
    const startFrame = msToFrame(cue.startMs);
    const endFrame = Math.max(msToFrame(cue.endMs), startFrame + 1);
    const wrappedRows = cue.lines.flatMap((line) => wrapCells(lineToCells(line.spans)));
    const rowNumbers = defaultRows(wrappedRows.length || 1);
    const seq = [RCL, RCL];
    wrappedRows.forEach((cells, i) => {
      const pac = rowPac(rowNumbers[i] ?? 15);
      seq.push(pac, pac);
      seq.push(...encodeRow608(cells));
    });
    const eocIndex = seq.length;
    seq.push(EOC, EOC);
    let captionFrame = Math.max(0, startFrame - eocIndex);
    if (pendingEdm !== null) {
      const edmFrame = Math.max(pendingEdm, nextFree);
      if (edmFrame + 2 <= captionFrame) emitEdm(edmFrame);
    }
    if (captionFrame < nextFree) {
      captionFrame = nextFree;
      if (captionFrame + eocIndex > startFrame) {
        warnings?.push({
          code: "captions-too-dense",
          message: `Captions too dense near cue ${cue.index}.`,
          cueIndex: cue.index
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
var DTVCC_SERVICE = 1;
var MAX_BLOCK = 31;
var MAX_DTVCC_TRIPLETS = CC_COUNT_29_97 - 2;
function load708Commands(cue) {
  const cmds = [];
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
      penStyle: 1
    })
  );
  cue.lines.forEach((line, row) => {
    cmds.push(...cmdSetPenLocation(row, 0));
    let curItalic = false;
    let curUnderline = false;
    let curColor = void 0;
    let started = false;
    for (const span of line.spans) {
      const italic = !!span.italic;
      const underline = !!span.underline;
      const color = span.color;
      if (!started || italic !== curItalic || underline !== curUnderline) {
        cmds.push(...cmdSetPenAttributes(penAttributesFor({ italic, underline })));
      }
      if (!started || color !== curColor) {
        cmds.push(...cmdSetPenColor(color ?? "white"));
      }
      cmds.push(...encode708Text(span.text));
      curItalic = italic;
      curUnderline = underline;
      curColor = color;
      started = true;
    }
  });
  cmds.push(...cmdDisplayWindows(1));
  cmds.push(3);
  return cmds;
}
function toServiceChunks(commands) {
  const chunks = [];
  for (let i = 0; i < commands.length; i += MAX_BLOCK) {
    chunks.push(commands.slice(i, i + MAX_BLOCK));
  }
  return chunks;
}
function build708Track(cues) {
  const chunks = [];
  for (const cue of cues) {
    const startFrame = msToFrame(cue.startMs);
    const endFrame = Math.max(msToFrame(cue.endMs), startFrame + 1);
    const serviceChunks = toServiceChunks(load708Commands(cue));
    const beginFrame = Math.max(0, startFrame - (serviceChunks.length - 1));
    serviceChunks.forEach((bytes, f) => chunks.push({ frame: beginFrame + f, bytes }));
    chunks.push({ frame: endFrame, bytes: cmdDeleteWindows(1) });
  }
  let seq = 0;
  let nextFree = -1;
  return chunks.sort((a, b) => a.frame - b.frame).map(({ frame: preferred, bytes }) => {
    const frame = Math.max(preferred, nextFree);
    nextFree = frame + 1;
    const packet = encodeDtvccPacket([encodeServiceBlock(DTVCC_SERVICE, bytes)], seq);
    seq = seq + 1 & 3;
    return { frame, triplets: dtvccToTriplets(packet) };
  });
}
var NULL_608_F1 = [CC_TYPE.E608_F1, 128, 128];
var NULL_608_F2 = [CC_TYPE.E608_F2, 128, 128];
var DTVCC_PADDING = [CC_TYPE.DTVCC_PAD, 0, 0];
function serializeMcc(doc, warnings) {
  const track608 = build608Track(doc.cues, warnings);
  const track708 = build708Track(doc.cues);
  const word608ByFrame = /* @__PURE__ */ new Map();
  for (const w of track608) word608ByFrame.set(w.frame, [w.b1, w.b2]);
  const dtvccByFrame = /* @__PURE__ */ new Map();
  for (const d of track708) dtvccByFrame.set(d.frame, d.triplets);
  const frames = /* @__PURE__ */ new Set([...word608ByFrame.keys(), ...dtvccByFrame.keys()]);
  if (frames.size === 0) return headerBlock().join("\n");
  const first = Math.min(...frames);
  const last = Math.max(...frames);
  const lines = headerBlock();
  let seq = 0;
  for (let frame = first; frame <= last; frame++) {
    const triplets = [];
    const word = word608ByFrame.get(frame);
    triplets.push(
      word ? [CC_TYPE.E608_F1, addOddParity(word[0]), addOddParity(word[1])] : NULL_608_F1
    );
    triplets.push(NULL_608_F2);
    const dtvcc = dtvccByFrame.get(frame);
    if (dtvcc && dtvcc.length > 0) triplets.push(...dtvcc.slice(0, MAX_DTVCC_TRIPLETS));
    else triplets.push(DTVCC_PADDING);
    while (triplets.length < CC_COUNT_29_97) triplets.push(DTVCC_PADDING);
    const cdp = packCdp(triplets, seq, CDP_FRAME_RATE_29_97);
    seq = seq + 1 & 65535;
    const anc = [97, 1, cdp.length & 255, ...cdp];
    lines.push(`${frameToTimecode(frame, true)}	${compressAliases(anc)}`);
  }
  lines.push("");
  return lines.join("\n");
}
var Cea608PopOnDecoder = class {
  buffer = [];
  currentRow = 15;
  style = { italic: false, underline: false };
  displayed = null;
  lastControlWord = -1;
  lastFrame = 0;
  cues = [];
  getRow(row) {
    let r = this.buffer.find((x) => x.row === row);
    if (!r) {
      r = { row, spans: [] };
      this.buffer.push(r);
    }
    return r;
  }
  pushSpan(text) {
    if (text === "") return;
    const spans = this.getRow(this.currentRow).spans;
    const last = spans[spans.length - 1];
    if (last && !!last.italic === this.style.italic && !!last.underline === this.style.underline && last.color === this.style.color) {
      last.text += text;
      return;
    }
    const span = { text };
    if (this.style.italic) span.italic = true;
    if (this.style.underline) span.underline = true;
    if (this.style.color !== void 0) span.color = this.style.color;
    spans.push(span);
  }
  replaceLastWith(ch) {
    const spans = this.getRow(this.currentRow).spans;
    for (let i = spans.length - 1; i >= 0; i--) {
      if (spans[i].text !== "") {
        spans[i].text = spans[i].text.slice(0, -1);
        break;
      }
    }
    this.pushSpan(ch);
  }
  closeDisplayed(endFrame) {
    if (!this.displayed) return;
    const ordered = this.displayed.rows.filter((r) => r.spans.some((s) => s.text !== "")).sort((a, b) => a.row - b.row);
    if (ordered.length > 0) {
      const lines = ordered.map((r) => ({ spans: r.spans }));
      this.cues.push({
        index: this.cues.length + 1,
        startMs: frameToMs(this.displayed.startFrame),
        endMs: frameToMs(Math.max(endFrame, this.displayed.startFrame)),
        lines
      });
    }
    this.displayed = null;
  }
  handleControl(b1, b2, frame) {
    const command = decodeControl(b1, b2);
    if (command === "RCL") {
      this.buffer = [];
      this.currentRow = 15;
      this.style = { italic: false, underline: false };
      return;
    }
    if (command === "EOC") {
      this.closeDisplayed(frame);
      this.displayed = { startFrame: frame, rows: this.buffer };
      this.buffer = [];
      return;
    }
    if (command === "EDM") {
      this.closeDisplayed(frame);
      return;
    }
    if (command) return;
    if (isPac(b1, b2)) {
      const pac = decodePac(b1, b2);
      this.currentRow = pac.row;
      this.style = { italic: pac.italic, underline: pac.underline };
      return;
    }
    if (b1 === 17 && b2 >= 32 && b2 <= 47) {
      const m = decodeMidRow(b2);
      this.style = {
        italic: m.italic,
        underline: m.underline,
        color: m.color === "white" ? void 0 : m.color
      };
      return;
    }
    if (b1 === 17 && b2 >= 48 && b2 <= 63) {
      this.pushSpan(SPECIAL_CHARS[b2] ?? "");
      return;
    }
    const extended = decodeExtendedChar(b1, b2);
    if (extended !== null) this.replaceLastWith(extended);
  }
  processWord(b1, b2, frame) {
    this.lastFrame = frame;
    if (b1 === 0 && b2 === 0) return;
    const word = b1 << 8 | b2;
    if (b1 >= 16 && b1 <= 31) {
      if (word === this.lastControlWord) {
        this.lastControlWord = -1;
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
  finish() {
    this.closeDisplayed(this.lastFrame);
  }
};
var TIMECODE_LINE = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})\t(.+)$/;
function parseMcc(text) {
  const warnings = [];
  const decoder = new Cea608PopOnDecoder();
  let dropFrame = false;
  let sawCaptionData = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const m = TIMECODE_LINE.exec(line);
    if (!m) continue;
    dropFrame = m[4] === ";";
    const frame = tcToFrame(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[5]), dropFrame);
    const timecode = `${m[1]}:${m[2]}:${m[3]}${m[4]}${m[5]}`;
    let bytes;
    try {
      bytes = expandAliases(m[6]);
    } catch {
      warnings.push({
        code: "unexpected-content",
        message: `Malformed MCC payload at ${timecode}.`
      });
      continue;
    }
    const cdpStart = findCdp(bytes);
    if (cdpStart < 0) continue;
    let contents;
    try {
      contents = unpackCdp(bytes.slice(cdpStart));
    } catch (err) {
      warnings.push({
        code: "unexpected-content",
        message: `Invalid CDP: ${err.message}`
      });
      continue;
    }
    for (const [marker, d1, d2] of contents.triplets) {
      if (marker === CC_TYPE.DTVCC_START || marker === CC_TYPE.DTVCC_DATA) {
        sawCaptionData = true;
      } else if ((marker === CC_TYPE.E608_F1 || marker === CC_TYPE.E608_F2) && !(stripParity(d1) === 0 && stripParity(d2) === 0)) {
        sawCaptionData = true;
      }
      if (marker !== CC_TYPE.E608_F1) continue;
      decoder.processWord(stripParity(d1), stripParity(d2), frame);
    }
  }
  decoder.finish();
  const metadata = {
    sourceFormat: "mcc",
    frameRate: 3e4 / 1001,
    raw: { dropFrame }
  };
  if (decoder.cues.length === 0 && sawCaptionData) {
    warnings.push({
      code: "unexpected-content",
      message: "No decodable pop-on CEA-608 captions found; this file may carry CEA-708-only or roll-up/paint-on captions, which import does not support."
    });
  }
  for (let k = 1; k < decoder.cues.length; k++) {
    if (decoder.cues[k].startMs < decoder.cues[k - 1].endMs) {
      warnings.push({
        code: "overlap",
        message: `Cue ${decoder.cues[k].index} overlaps the previous cue.`,
        cueIndex: decoder.cues[k].index
      });
    }
  }
  return { cues: decoder.cues, metadata, warnings };
}
function findCdp(bytes) {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 150 && bytes[i + 1] === 105) return i;
  }
  return -1;
}
function tcToFrame(h, m, s, f, drop) {
  const totalMinutes = h * 60 + m;
  let frame = ((h * 60 + m) * 60 + s) * 30 + f;
  if (drop) frame -= 2 * (totalMinutes - Math.floor(totalMinutes / 10));
  return frame;
}
function canEncodeMcc(ch) {
  return canEncodeCea608(ch);
}
export {
  canEncodeMcc,
  parseMcc,
  serializeMcc
};
