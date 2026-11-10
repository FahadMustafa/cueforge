import {
  canonicalFps
} from "./chunk-GP4UVXBM.mjs";
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
  encodeWord,
  frameToMs,
  frameToTimecode,
  hasOddParity,
  isDropFrameTimecode,
  isPac,
  msToFrame,
  stripParity,
  timecodeToFrame
} from "./chunk-RCR4PM7R.mjs";

// src/core/formats/scc/scc.ts
var HEADER_RE = /Scenarist_SCC/i;
var CAPTION_RE = /^(\d{2}:\d{2}:\d{2}[:;.]\d{2})\s+(.*)$/;
function emptyStyle() {
  return { italic: false, underline: false };
}
var Decoder = class {
  buffer = [];
  currentRow = 15;
  style = emptyStyle();
  displayed = null;
  lastControlWord = -1;
  mode = "popon";
  rollupSpans = [];
  rollupStartFrame = 0;
  lastFrame = 0;
  /**
   * Whether the most recent control-code prefix selected field-1 channel 1.
   * Prefixes 0x10–0x17 are CC1; 0x18–0x1F are CC2, and 0x15-prefixed misc
   * controls are field-2 CC3 — while any of those are active, text bytes must
   * not bleed into the CC1 buffer (cue-forge-c0h).
   */
  cc1Active = true;
  cues = [];
  warnings = [];
  getRow(row) {
    let r = this.buffer.find((x) => x.row === row);
    if (!r) {
      r = { row, indent: 0, spans: [] };
      this.buffer.push(r);
    }
    return r;
  }
  appendText(text) {
    if (text === "") return;
    if (this.mode === "rollup" || this.mode === "direct") {
      if (this.rollupSpans.length === 0) this.rollupStartFrame = this.lastFrame;
      this.pushSpan(this.rollupSpans, text);
      return;
    }
    this.pushSpan(this.getRow(this.currentRow).spans, text);
  }
  pushSpan(spans, text) {
    const last = spans[spans.length - 1];
    if (last && last.opaque === void 0 && !!last.italic === this.style.italic && !!last.underline === this.style.underline && last.color === this.style.color) {
      last.text += text;
      return;
    }
    const span = { text };
    if (this.style.italic) span.italic = true;
    if (this.style.underline) span.underline = true;
    if (this.style.color !== void 0) span.color = this.style.color;
    spans.push(span);
  }
  closeDisplayed(endFrame) {
    if (!this.displayed) return;
    this.emit(this.displayed.startFrame, endFrame, this.displayed.rows);
    this.displayed = null;
  }
  emit(startFrame, endFrame, rows) {
    const ordered = rows.filter((r) => r.spans.some((s) => s.text !== "")).sort((a, b) => a.row - b.row);
    if (ordered.length === 0) return;
    const lines = ordered.map((r) => ({ spans: r.spans }));
    const cue = {
      index: this.cues.length + 1,
      startMs: frameToMs(startFrame),
      endMs: frameToMs(Math.max(endFrame, startFrame)),
      lines,
      raw: { rows: ordered.map((r) => ({ row: r.row, indent: r.indent })) }
    };
    this.cues.push(cue);
  }
  /** Process one control/PAC/special word (first byte 0x10–0x1F). */
  handleControl(b1, b2, frame) {
    const command = decodeControl(b1, b2);
    if (command) {
      switch (command) {
        case "RCL":
          this.mode = "popon";
          this.buffer = [];
          this.currentRow = 15;
          this.style = emptyStyle();
          return;
        case "EOC":
          this.closeDisplayed(frame);
          this.displayed = { startFrame: frame, rows: this.buffer };
          this.buffer = [];
          return;
        case "EDM":
          this.closeDisplayed(frame);
          this.flushRollup(frame);
          return;
        case "ENM":
          this.buffer = [];
          return;
        case "RU2":
        case "RU3":
        case "RU4":
          this.mode = "rollup";
          this.style = emptyStyle();
          return;
        case "RDC":
          this.mode = "direct";
          this.style = emptyStyle();
          return;
        case "CR":
          this.flushRollup(frame);
          return;
        case "TO1":
        case "TO2":
        case "TO3":
          return;
      }
    }
    if (isPac(b1, b2)) {
      const pac = decodePac(b1, b2);
      this.currentRow = pac.row;
      this.style = { italic: pac.italic, underline: pac.underline };
      if (this.mode === "popon") this.getRow(pac.row).indent = pac.indent;
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
      this.appendText(SPECIAL_CHARS[b2] ?? "");
      return;
    }
    const extended = decodeExtendedChar(b1, b2);
    if (extended !== null) {
      this.replaceLastWith(extended);
      return;
    }
  }
  /** Drop the last buffered character and append `ch` in its place. */
  replaceLastWith(ch) {
    const spans = this.mode === "rollup" || this.mode === "direct" ? this.rollupSpans : this.getRow(this.currentRow).spans;
    for (let i = spans.length - 1; i >= 0; i--) {
      const span = spans[i];
      if (span.text !== "") {
        span.text = span.text.slice(0, -1);
        break;
      }
    }
    this.appendText(ch);
  }
  flushRollup(frame) {
    if (this.rollupSpans.length === 0) return;
    this.emit(this.rollupStartFrame, frame, [
      { row: this.currentRow, indent: 0, spans: this.rollupSpans }
    ]);
    this.rollupSpans = [];
  }
  /** Process a single word given its absolute frame index. */
  processWord(word, frame) {
    this.lastFrame = frame;
    const b1 = stripParity(word >> 8 & 255);
    const b2 = stripParity(word & 255);
    if (b1 === 0 && b2 === 0) return;
    const isControl = b1 >= 16 && b1 <= 31;
    if (isControl) {
      if (word === this.lastControlWord) {
        this.lastControlWord = -1;
        return;
      }
      this.lastControlWord = word;
      if (b1 >= 24 || b1 === 21 && b2 >= 32 && b2 <= 47) {
        this.cc1Active = false;
        return;
      }
      this.cc1Active = true;
      this.handleControl(b1, b2, frame);
      return;
    }
    this.lastControlWord = -1;
    if (!this.cc1Active) return;
    this.appendText(decodeBasicChar(b1));
    this.appendText(decodeBasicChar(b2));
  }
  finish() {
    this.closeDisplayed(this.lastFrame);
    this.flushRollup(this.lastFrame);
  }
};
function parseScc(text) {
  const lines = text.split(/\r?\n/);
  const decoder = new Decoder();
  const warnings = decoder.warnings;
  let sawHeader = false;
  let dropFrame = false;
  let headerLine = "Scenarist_SCC V1.0";
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") continue;
    if (!sawHeader) {
      if (HEADER_RE.test(line)) {
        sawHeader = true;
        headerLine = line.trim();
        continue;
      }
      warnings.push({
        code: "unexpected-content",
        message: "Missing Scenarist_SCC header."
      });
      sawHeader = true;
    }
    const m = CAPTION_RE.exec(line);
    if (!m) continue;
    const tc = m[1];
    dropFrame = isDropFrameTimecode(tc);
    let frame;
    try {
      frame = timecodeToFrame(tc);
    } catch {
      warnings.push({ code: "malformed-timing", message: `Bad SCC timecode: "${tc}".` });
      continue;
    }
    const words = m[2].trim().split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!/^[0-9a-fA-F]{4}$/.test(w)) continue;
      decoder.processWord(parseInt(w, 16), frame + i);
    }
  }
  decoder.finish();
  const metadata = {
    sourceFormat: "scc",
    // The CEA-608 timebase is the exact 30000/1001, but store the canonical
    // 29.97 label (cue-forge-zxw.11/pm8, consistent with the ttml/itt parsers)
    // so supportsDropFrame and the Studio fps picker recognise it — timing math
    // in cea608.ts still uses the exact 30000/1001 frame count, so this relabel
    // introduces no drift and leaves the round-trip ms-identical.
    frameRate: canonicalFps(3e4 / 1001),
    raw: { dropFrame, header: headerLine }
  };
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
var MIDROW_COLOR_INDEX = {
  white: 0,
  green: 1,
  blue: 2,
  cyan: 3,
  red: 4,
  yellow: 5,
  magenta: 6
};
function midRowByte(italic, underline, color) {
  const idx = italic ? 7 : color !== void 0 ? MIDROW_COLOR_INDEX[color] ?? 0 : 0;
  return 32 + idx * 2 + (underline ? 1 : 0);
}
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
      const rest = row.slice(breakAt + 1);
      rows.push(row.slice(0, breakAt));
      row = rest;
      lastSpace = -1;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}
function encodeRowCells(cells) {
  const words = [];
  let curItalic = false;
  let curUnderline = false;
  let curColor;
  let pending = null;
  const flush = () => {
    if (pending !== null) {
      words.push(encodeWord(pending, 0));
      pending = null;
    }
  };
  const emitByte = (byte) => {
    if (pending === null) pending = byte;
    else {
      words.push(encodeWord(pending, byte));
      pending = null;
    }
  };
  const emitControl = (b1, b2) => {
    flush();
    words.push(encodeWord(b1, b2), encodeWord(b1, b2));
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
function defaultRows(count) {
  return Array.from({ length: count }, (_, i) => 15 - (count - 1 - i));
}
function serializeScc(doc, warnings) {
  const raw = doc.metadata.raw ?? {};
  const dropFrame = raw.dropFrame ?? false;
  const header = raw.header ?? "Scenarist_SCC V1.0";
  const RCL = encodeWord(20, 32);
  const EOC = encodeWord(20, 47);
  const EDM = encodeWord(20, 44);
  const emitted = [];
  let nextFree = 0;
  let pendingEdm = null;
  const emitEdm = (frame) => {
    emitted.push({ frame, text: `${frameToTimecode(frame, dropFrame)}	${EDM} ${EDM}` });
    nextFree = frame + 2;
  };
  for (const cue of doc.cues) {
    const startFrame = msToFrame(cue.startMs);
    const endFrame = Math.max(msToFrame(cue.endMs), startFrame + 1);
    const wrappedRows = cue.lines.flatMap((line) => wrapCells(lineToCells(line.spans)));
    const cueRaw = cue.raw;
    const rowNumbers = cueRaw?.rows && cueRaw.rows.length === wrappedRows.length ? cueRaw.rows.map((r) => r.row) : defaultRows(wrappedRows.length || 1);
    const words = [RCL, RCL];
    wrappedRows.forEach((cells, i) => {
      const [pb1, pb2] = encodePac(rowNumbers[i] ?? 15, 0, false, false);
      words.push(encodeWord(pb1, pb2), encodeWord(pb1, pb2));
      words.push(...encodeRowCells(cells));
    });
    const eocIndex = words.length;
    words.push(EOC, EOC);
    let captionFrame = Math.max(0, startFrame - eocIndex);
    let dense = false;
    if (pendingEdm !== null) {
      const edmFrame = Math.max(pendingEdm, nextFree);
      if (edmFrame + 2 <= captionFrame) {
        emitEdm(edmFrame);
      } else {
        dense = true;
      }
    }
    if (captionFrame < nextFree) {
      captionFrame = nextFree;
      if (captionFrame + eocIndex > startFrame) dense = true;
    }
    if (dense) {
      warnings?.push({
        code: "captions-too-dense",
        message: `Captions too dense at ${frameToTimecode(startFrame, dropFrame)}.`,
        cueIndex: cue.index
      });
    }
    emitted.push({
      frame: captionFrame,
      text: `${frameToTimecode(captionFrame, dropFrame)}	${words.join(" ")}`
    });
    nextFree = captionFrame + words.length;
    pendingEdm = endFrame;
  }
  if (pendingEdm !== null) emitEdm(Math.max(pendingEdm, nextFree));
  emitted.sort((a, b) => a.frame - b.frame);
  const lines = [header, "", ...emitted.flatMap((e) => [e.text, ""])];
  return lines.join("\n");
}
export {
  addOddParity,
  canEncodeCea608,
  frameToMs,
  frameToTimecode,
  hasOddParity,
  isDropFrameTimecode,
  msToFrame,
  parseScc,
  serializeScc,
  stripParity,
  timecodeToFrame
};
