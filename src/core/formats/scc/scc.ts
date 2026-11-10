import type { Cue, CueLine, ParseWarning, StyledSpan, SubtitleDocument } from '../../model/types';
import {
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
  isDropFrameTimecode,
  isPac,
  msToFrame,
  SPECIAL_CHARS,
  stripParity,
  timecodeToFrame,
} from './cea608';
import { canonicalFps } from '../../timing/timing';

/**
 * SCC (Scenarist Closed Caption / CEA-608) parser (spec §3 SCC).
 *
 * The Scenarist header is followed by `timecode<TAB>hex-words` lines; every word
 * is two odd-parity bytes and occupies one frame. Pop-on captions are assembled
 * in a non-displayed buffer (RCL → PAC/text/mid-row → EOC flips it on screen at
 * the EOC frame; EDM/next-EOC ends it). Roll-up is parsed (parse-only): text
 * between carriage returns becomes a cue. Doubled control codes act once. Timing
 * is integer milliseconds on the 30000/1001 timebase.
 */

interface BufferRow {
  row: number;
  indent: number;
  spans: StyledSpan[];
}

interface Style {
  italic: boolean;
  underline: boolean;
  color?: string;
}

interface DisplayedCaption {
  startFrame: number;
  rows: BufferRow[];
}

const HEADER_RE = /Scenarist_SCC/i;
const CAPTION_RE = /^(\d{2}:\d{2}:\d{2}[:;.]\d{2})\s+(.*)$/;

function emptyStyle(): Style {
  return { italic: false, underline: false };
}

class Decoder {
  private buffer: BufferRow[] = [];
  private currentRow = 15;
  private style: Style = emptyStyle();
  private displayed: DisplayedCaption | null = null;
  private lastControlWord = -1;
  private mode: 'popon' | 'rollup' | 'direct' = 'popon';
  private rollupSpans: StyledSpan[] = [];
  private rollupStartFrame = 0;
  private lastFrame = 0;
  /**
   * Whether the most recent control-code prefix selected field-1 channel 1.
   * Prefixes 0x10–0x17 are CC1; 0x18–0x1F are CC2, and 0x15-prefixed misc
   * controls are field-2 CC3 — while any of those are active, text bytes must
   * not bleed into the CC1 buffer (cue-forge-c0h).
   */
  private cc1Active = true;

  readonly cues: Cue[] = [];
  readonly warnings: ParseWarning[] = [];

  private getRow(row: number): BufferRow {
    let r = this.buffer.find((x) => x.row === row);
    if (!r) {
      r = { row, indent: 0, spans: [] };
      this.buffer.push(r);
    }
    return r;
  }

  private appendText(text: string): void {
    if (text === '') return;
    if (this.mode === 'rollup' || this.mode === 'direct') {
      if (this.rollupSpans.length === 0) this.rollupStartFrame = this.lastFrame;
      this.pushSpan(this.rollupSpans, text);
      return;
    }
    this.pushSpan(this.getRow(this.currentRow).spans, text);
  }

  private pushSpan(spans: StyledSpan[], text: string): void {
    const last = spans[spans.length - 1];
    if (
      last &&
      last.opaque === undefined &&
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

  private closeDisplayed(endFrame: number): void {
    if (!this.displayed) return;
    this.emit(this.displayed.startFrame, endFrame, this.displayed.rows);
    this.displayed = null;
  }

  private emit(startFrame: number, endFrame: number, rows: BufferRow[]): void {
    const ordered = rows
      .filter((r) => r.spans.some((s) => s.text !== ''))
      .sort((a, b) => a.row - b.row);
    if (ordered.length === 0) return;
    const lines: CueLine[] = ordered.map((r) => ({ spans: r.spans }));
    const cue: Cue = {
      index: this.cues.length + 1,
      startMs: frameToMs(startFrame),
      endMs: frameToMs(Math.max(endFrame, startFrame)),
      lines,
      raw: { rows: ordered.map((r) => ({ row: r.row, indent: r.indent })) },
    };
    this.cues.push(cue);
  }

  /** Process one control/PAC/special word (first byte 0x10–0x1F). */
  private handleControl(b1: number, b2: number, frame: number): void {
    const command = decodeControl(b1, b2);
    if (command) {
      switch (command) {
        case 'RCL':
          this.mode = 'popon';
          this.buffer = [];
          this.currentRow = 15;
          this.style = emptyStyle();
          return;
        case 'EOC':
          this.closeDisplayed(frame);
          this.displayed = { startFrame: frame, rows: this.buffer };
          this.buffer = [];
          return;
        case 'EDM':
          this.closeDisplayed(frame);
          this.flushRollup(frame);
          return;
        case 'ENM':
          this.buffer = [];
          return;
        case 'RU2':
        case 'RU3':
        case 'RU4':
          this.mode = 'rollup';
          this.style = emptyStyle();
          return;
        case 'RDC':
          this.mode = 'direct';
          this.style = emptyStyle();
          return;
        case 'CR':
          this.flushRollup(frame);
          return;
        case 'TO1':
        case 'TO2':
        case 'TO3':
          return;
      }
    }

    if (isPac(b1, b2)) {
      const pac = decodePac(b1, b2);
      this.currentRow = pac.row;
      this.style = { italic: pac.italic, underline: pac.underline };
      if (this.mode === 'popon') this.getRow(pac.row).indent = pac.indent;
      return;
    }

    if (b1 === 0x11 && b2 >= 0x20 && b2 <= 0x2f) {
      const m = decodeMidRow(b2);
      // White is the default colour; model it as no explicit colour so a plain
      // mid-row reset round-trips to a colourless span.
      this.style = {
        italic: m.italic,
        underline: m.underline,
        color: m.color === 'white' ? undefined : m.color,
      };
      return;
    }

    if (b1 === 0x11 && b2 >= 0x30 && b2 <= 0x3f) {
      this.appendText(SPECIAL_CHARS[b2] ?? '');
      return;
    }

    // Extended character: transmitted after a basic fallback char, which it
    // REPLACES in the buffer (cue-forge-12v).
    const extended = decodeExtendedChar(b1, b2);
    if (extended !== null) {
      this.replaceLastWith(extended);
      return;
    }
    // Other control words are ignored.
  }

  /** Drop the last buffered character and append `ch` in its place. */
  private replaceLastWith(ch: string): void {
    const spans =
      this.mode === 'rollup' || this.mode === 'direct'
        ? this.rollupSpans
        : this.getRow(this.currentRow).spans;
    for (let i = spans.length - 1; i >= 0; i--) {
      const span = spans[i]!;
      if (span.text !== '') {
        span.text = span.text.slice(0, -1);
        break;
      }
    }
    this.appendText(ch);
  }

  private flushRollup(frame: number): void {
    if (this.rollupSpans.length === 0) return;
    this.emit(this.rollupStartFrame, frame, [
      { row: this.currentRow, indent: 0, spans: this.rollupSpans },
    ]);
    this.rollupSpans = [];
  }

  /** Process a single word given its absolute frame index. */
  processWord(word: number, frame: number): void {
    this.lastFrame = frame;
    const b1 = stripParity((word >> 8) & 0xff);
    const b2 = stripParity(word & 0xff);
    if (b1 === 0 && b2 === 0) return; // null padding

    const isControl = b1 >= 0x10 && b1 <= 0x1f;
    if (isControl) {
      // Doubled control codes are transmitted twice; act once.
      if (word === this.lastControlWord) {
        this.lastControlWord = -1;
        return;
      }
      this.lastControlWord = word;
      // 0x18–0x1F prefixes are channel 2; 0x15-prefixed misc controls are the
      // field-2 CC3 service. Neither may drive the CC1 state machine, but they
      // do claim the data channel for the text bytes that follow.
      if (b1 >= 0x18 || (b1 === 0x15 && b2 >= 0x20 && b2 <= 0x2f)) {
        this.cc1Active = false;
        return;
      }
      this.cc1Active = true;
      this.handleControl(b1, b2, frame);
      return;
    }

    this.lastControlWord = -1;
    if (!this.cc1Active) return; // CC2/CC3 text — not ours
    this.appendText(decodeBasicChar(b1));
    this.appendText(decodeBasicChar(b2));
  }

  finish(): void {
    this.closeDisplayed(this.lastFrame);
    this.flushRollup(this.lastFrame);
  }
}

/** Parse SCC (Scenarist/CEA-608) text into a SubtitleDocument (spec §3 SCC). */
export function parseScc(text: string): SubtitleDocument {
  const lines = text.split(/\r?\n/);
  const decoder = new Decoder();
  const warnings = decoder.warnings;

  let sawHeader = false;
  let dropFrame = false;
  let headerLine = 'Scenarist_SCC V1.0';

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') continue;
    if (!sawHeader) {
      if (HEADER_RE.test(line)) {
        sawHeader = true;
        headerLine = line.trim();
        continue;
      }
      warnings.push({
        code: 'unexpected-content',
        message: 'Missing Scenarist_SCC header.',
      });
      sawHeader = true; // only warn once; treat the rest as captions
    }

    const m = CAPTION_RE.exec(line);
    if (!m) continue;
    const tc = m[1]!;
    dropFrame = isDropFrameTimecode(tc);
    let frame: number;
    try {
      frame = timecodeToFrame(tc);
    } catch {
      warnings.push({ code: 'malformed-timing', message: `Bad SCC timecode: "${tc}".` });
      continue;
    }
    const words = m[2]!.trim().split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (!/^[0-9a-fA-F]{4}$/.test(w)) continue;
      decoder.processWord(parseInt(w, 16), frame + i);
    }
  }
  decoder.finish();

  const metadata: SubtitleDocument['metadata'] = {
    sourceFormat: 'scc',
    // The CEA-608 timebase is the exact 30000/1001, but store the canonical
    // 29.97 label (cue-forge-zxw.11/pm8, consistent with the ttml/itt parsers)
    // so supportsDropFrame and the Studio fps picker recognise it — timing math
    // in cea608.ts still uses the exact 30000/1001 frame count, so this relabel
    // introduces no drift and leaves the round-trip ms-identical.
    frameRate: canonicalFps(30000 / 1001),
    raw: { dropFrame, header: headerLine },
  };

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

const MIDROW_COLOR_INDEX: Record<string, number> = {
  white: 0,
  green: 1,
  blue: 2,
  cyan: 3,
  red: 4,
  yellow: 5,
  magenta: 6,
};

/** Mid-row second byte for a target style (italics takes the colour slot). */
function midRowByte(italic: boolean, underline: boolean, color: string | undefined): number {
  const idx = italic ? 7 : color !== undefined ? (MIDROW_COLOR_INDEX[color] ?? 0) : 0;
  return 0x20 + idx * 2 + (underline ? 1 : 0);
}

const MAX_ROW_CHARS = 32;

interface CharCell {
  ch: string;
  italic: boolean;
  underline: boolean;
  color?: string;
}

/** Flatten a line's spans into per-character cells carrying their style. */
function lineToCells(spans: StyledSpan[]): CharCell[] {
  const cells: CharCell[] = [];
  for (const span of spans) {
    for (const ch of span.text) {
      cells.push({ ch, italic: !!span.italic, underline: !!span.underline, color: span.color });
    }
  }
  return cells;
}

/** Greedily wrap cells into rows of at most {@link MAX_ROW_CHARS}, breaking at spaces. */
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
      const rest = row.slice(breakAt + 1);
      rows.push(row.slice(0, breakAt));
      row = rest;
      lastSpace = -1;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** Encode one row's character cells into SCC words (with style transitions). */
function encodeRowCells(cells: CharCell[]): string[] {
  const words: string[] = [];
  let curItalic = false;
  let curUnderline = false;
  let curColor: string | undefined;
  let pending: number | null = null;

  const flush = () => {
    if (pending !== null) {
      words.push(encodeWord(pending, 0));
      pending = null;
    }
  };
  const emitByte = (byte: number) => {
    if (pending === null) pending = byte;
    else {
      words.push(encodeWord(pending, byte));
      pending = null;
    }
  };
  const emitControl = (b1: number, b2: number) => {
    flush();
    words.push(encodeWord(b1, b2), encodeWord(b1, b2));
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
        // Extended char: basic fallback first, then the replacing pair.
        emitByte(enc.fallback);
        emitControl(enc.b1, enc.b2);
      }
    }
  }
  flush();
  return words;
}

/** Default pop-on rows, bottom-anchored at row 15 (e.g. 2 lines → rows 14,15). */
function defaultRows(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 15 - (count - 1 - i));
}

/**
 * Serialize a SubtitleDocument to SCC (Scenarist/CEA-608) pop-on captions
 * (spec §3 SCC).
 *
 * Every word occupies one frame, so each caption is back-timed so its EOC
 * lands on the cue's start frame. Transmissions are never allowed to collide
 * (cue-forge-0zz): when cues are too dense the previous cue's explicit EDM is
 * dropped (the next EOC replaces the display) and, if the stream still cannot
 * fit, the EOC is delayed; either case is reported into `warnings` when the
 * caller provides a sink.
 */
export function serializeScc(doc: SubtitleDocument, warnings?: ParseWarning[]): string {
  const raw = (doc.metadata.raw ?? {}) as { dropFrame?: boolean; header?: string };
  const dropFrame = raw.dropFrame ?? false;
  const header = raw.header ?? 'Scenarist_SCC V1.0';

  const RCL = encodeWord(0x14, 0x20);
  const EOC = encodeWord(0x14, 0x2f);
  const EDM = encodeWord(0x14, 0x2c);

  const emitted: Array<{ frame: number; text: string }> = [];
  let nextFree = 0; // first frame not yet occupied by a transmitted word
  let pendingEdm: number | null = null; // EDM frame owed for the previous cue

  const emitEdm = (frame: number) => {
    emitted.push({ frame, text: `${frameToTimecode(frame, dropFrame)}\t${EDM} ${EDM}` });
    nextFree = frame + 2;
  };

  for (const cue of doc.cues) {
    const startFrame = msToFrame(cue.startMs);
    const endFrame = Math.max(msToFrame(cue.endMs), startFrame + 1);

    // Wrap each visual line to the 32-char limit, then assign rows.
    const wrappedRows = cue.lines.flatMap((line) => wrapCells(lineToCells(line.spans)));
    const cueRaw = cue.raw as { rows?: Array<{ row: number; indent: number }> } | undefined;
    const rowNumbers =
      cueRaw?.rows && cueRaw.rows.length === wrappedRows.length
        ? cueRaw.rows.map((r) => r.row)
        : defaultRows(wrappedRows.length || 1);

    const words: string[] = [RCL, RCL];
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
        // No room for an explicit EDM before this caption's transmission must
        // begin: drop it — this caption's EOC replaces the display.
        dense = true;
      }
    }

    if (captionFrame < nextFree) {
      captionFrame = nextFree;
      if (captionFrame + eocIndex > startFrame) dense = true; // delayed EOC
    }
    if (dense) {
      warnings?.push({
        code: 'captions-too-dense',
        message: `Captions too dense at ${frameToTimecode(startFrame, dropFrame)}.`,
        cueIndex: cue.index,
      });
    }

    emitted.push({
      frame: captionFrame,
      text: `${frameToTimecode(captionFrame, dropFrame)}\t${words.join(' ')}`,
    });
    nextFree = captionFrame + words.length;
    pendingEdm = endFrame;
  }

  if (pendingEdm !== null) emitEdm(Math.max(pendingEdm, nextFree));

  // Frames are monotonic by construction; the sort is defensive only.
  emitted.sort((a, b) => a.frame - b.frame);
  const lines = [header, '', ...emitted.flatMap((e) => [e.text, ''])];
  return lines.join('\n');
}
