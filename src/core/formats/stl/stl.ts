import type {
  Cue,
  CueAlign,
  CueLine,
  ParseWarning,
  StyledSpan,
  SubtitleDocument,
} from '../../model/types';
import { composeIso6937, encodeIso6937Char, ISO6937_COMBINING, ISO6937_SINGLE } from './iso6937';

/**
 * EBU-STL (EBU Tech 3264) binary subtitle codec (spec §3 STL).
 *
 * The file is a 1024-byte General Subtitle Information (GSI) block followed by
 * fixed 128-byte Text and Timing Information (TTI) blocks. The GSI declares the
 * Disk Format Code (`STL25.01` → 25 fps, `STL30.01` → 30) and is preserved
 * verbatim in `metadata.raw` for round-trip. Each TTI block carries Time Code
 * In/Out (HH MM SS FF binary), Vertical Position, a Justification Code and a
 * 112-byte text field (0x8A row break; 0x80/0x81 italics; 0x82/0x83 underline;
 * 0x8F fill). Text uses the Latin code table (CCT 00, GSI bytes 12–13), which
 * per EBU Tech 3264 is ISO 6937 (see `iso6937.ts`) — other CCTs are decoded
 * best-effort with a warning. Timing is integer milliseconds.
 *
 * Unlike the text formats this codec is byte-oriented: {@link parseStl} takes a
 * `Uint8Array` and {@link serializeStl} returns one.
 */

const GSI_SIZE = 1024;
const TTI_SIZE = 128;
const TEXT_FIELD_OFFSET = 16;
const TEXT_FIELD_LEN = 112;
const FILL = 0x8f;
const NEWLINE = 0x8a;
const ITALIC_ON = 0x80;
const ITALIC_OFF = 0x81;
const UNDERLINE_ON = 0x82;
const UNDERLINE_OFF = 0x83;

const JC_TO_ALIGN: Record<number, CueAlign | undefined> = {
  0: undefined,
  1: 'left',
  2: 'center',
  3: 'right',
};
const ALIGN_TO_JC: Record<string, number> = { left: 1, center: 2, right: 3 };

interface StlRaw {
  /** Verbatim 1024-byte GSI block. */
  gsi: number[];
}

interface TtiRaw {
  vp: number;
  jc: number;
}

function readAscii(buf: Uint8Array, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[offset + i]!);
  return s;
}

function frameRateFromDfc(dfc: string): number {
  if (dfc.startsWith('STL30')) return 30;
  return 25; // STL25.01 and default
}

function tcToMs(buf: Uint8Array, offset: number, fps: number): number {
  const h = buf[offset]!;
  const m = buf[offset + 1]!;
  const s = buf[offset + 2]!;
  const f = buf[offset + 3]!;
  return (h * 3600 + m * 60 + s) * 1000 + Math.round((f * 1000) / fps);
}

/** Decode a TTI text field (112 bytes) into styled visual lines. */
function decodeTextField(buf: Uint8Array, offset: number): CueLine[] {
  const lines: CueLine[] = [{ spans: [] }];
  let italic = false;
  let underline = false;

  const append = (ch: string) => {
    const spans = lines[lines.length - 1]!.spans;
    const last = spans[spans.length - 1];
    if (last && !!last.italic === italic && !!last.underline === underline) {
      last.text += ch;
      return;
    }
    const span: StyledSpan = { text: ch };
    if (italic) span.italic = true;
    if (underline) span.underline = true;
    spans.push(span);
  };

  let pendingDiacritic = '';
  for (let i = 0; offset + i < buf.length; i++) {
    const b = buf[offset + i]!;
    if (b === FILL) continue;
    switch (b) {
      case NEWLINE:
        lines.push({ spans: [] });
        pendingDiacritic = '';
        continue;
      case ITALIC_ON:
        italic = true;
        continue;
      case ITALIC_OFF:
        italic = false;
        continue;
      case UNDERLINE_ON:
        underline = true;
        continue;
      case UNDERLINE_OFF:
        underline = false;
        continue;
    }
    // ISO 6937 non-spacing diacritic: combines with the NEXT (base) character.
    if (ISO6937_COMBINING[b] !== undefined) {
      pendingDiacritic = ISO6937_COMBINING[b]!;
      continue;
    }
    let ch: string | undefined;
    if (b >= 0x20 && b <= 0x7e)
      ch = String.fromCharCode(b); // ASCII region
    else if (b >= 0xa0) ch = ISO6937_SINGLE[b]; // supplementary set
    if (ch !== undefined) {
      append(pendingDiacritic === '' ? ch : composeIso6937(ch, pendingDiacritic));
      pendingDiacritic = '';
    }
    // Other control bytes (teletext colour, box) are ignored.
  }
  return lines;
}

/** Parse an EBU-STL byte buffer into a SubtitleDocument (spec §3 STL). */
export function parseStl(bytes: Uint8Array): SubtitleDocument {
  const warnings: ParseWarning[] = [];
  if (bytes.length < GSI_SIZE) {
    warnings.push({ code: 'unexpected-content', message: 'Buffer too short for a GSI block.' });
    return { cues: [], metadata: { sourceFormat: 'stl' }, warnings };
  }

  const dfc = readAscii(bytes, 3, 8);
  const fps = frameRateFromDfc(dfc);
  const cct = readAscii(bytes, 12, 2);
  if (cct !== '00') {
    warnings.push({
      code: 'unexpected-content',
      message: `Unsupported Character Code Table "${cct}"; decoding best-effort as Latin (CCT 00).`,
    });
  }
  const gsi = Array.from(bytes.subarray(0, GSI_SIZE));

  const cues: Cue[] = [];
  let pendingText: number[] | null = null;
  let header: { startMs: number; endMs: number; vp: number; jc: number; cf: number } | null = null;

  for (let off = GSI_SIZE; off + TTI_SIZE <= bytes.length; off += TTI_SIZE) {
    const ebn = bytes[off + 3]!;
    if (pendingText === null) {
      pendingText = [];
      header = {
        startMs: tcToMs(bytes, off + 5, fps),
        endMs: tcToMs(bytes, off + 9, fps),
        vp: bytes[off + 13]!,
        jc: bytes[off + 14]!,
        cf: bytes[off + 15]!,
      };
    }
    for (let i = 0; i < TEXT_FIELD_LEN; i++) pendingText.push(bytes[off + TEXT_FIELD_OFFSET + i]!);

    if (ebn === 0xff) {
      const h = header!;
      if (h.cf !== 1) {
        const field = new Uint8Array(pendingText);
        const lines = decodeTextField(field, 0);
        const align = JC_TO_ALIGN[h.jc];
        const cue: Cue = {
          index: cues.length + 1,
          startMs: h.startMs,
          endMs: h.endMs,
          lines,
          raw: { vp: h.vp, jc: h.jc } satisfies TtiRaw,
        };
        if (align !== undefined) cue.position = { align };
        if (h.endMs < h.startMs) {
          warnings.push({
            code: 'reversed-timing',
            message: 'Cue end precedes start.',
            cueIndex: cue.index,
          });
        }
        cues.push(cue);
      }
      pendingText = null;
      header = null;
    }
  }

  return {
    cues,
    metadata: { sourceFormat: 'stl', frameRate: fps, raw: { gsi } satisfies StlRaw },
    warnings,
  };
}

function writeAscii(buf: Uint8Array, offset: number, len: number, s: string): void {
  for (let i = 0; i < len; i++) buf[offset + i] = i < s.length ? s.charCodeAt(i) & 0xff : 0x20;
}

function msToTc(buf: Uint8Array, offset: number, ms: number, fps: number): void {
  // Round to total frames first so the frame field can never reach fps
  // (e.g. 1980ms at 25fps is 49.5 → 50 frames → 00:00:02:00, not 00:00:01:25).
  const totalFrames = Math.round((ms * fps) / 1000);
  const totalSeconds = Math.floor(totalFrames / fps);
  buf[offset] = Math.floor(totalSeconds / 3600);
  buf[offset + 1] = Math.floor(totalSeconds / 60) % 60;
  buf[offset + 2] = totalSeconds % 60;
  buf[offset + 3] = totalFrames % fps;
}

/**
 * Encode a cue's lines into the full TTI text byte stream (control codes + ISO
 * 6937 text). The caller chunks this into 112-byte TTI text fields; text longer
 * than one field spills into EBN extension blocks rather than being truncated.
 */
function encodeTextField(lines: CueLine[]): number[] {
  const bytes: number[] = [];
  let italic = false;
  let underline = false;
  lines.forEach((line, li) => {
    if (li > 0) bytes.push(NEWLINE);
    for (const span of line.spans) {
      if (!!span.italic !== italic) {
        bytes.push(span.italic ? ITALIC_ON : ITALIC_OFF);
        italic = !!span.italic;
      }
      if (!!span.underline !== underline) {
        bytes.push(span.underline ? UNDERLINE_ON : UNDERLINE_OFF);
        underline = !!span.underline;
      }
      for (const ch of span.text) bytes.push(...encodeIso6937Char(ch));
    }
  });
  if (italic) bytes.push(ITALIC_OFF);
  if (underline) bytes.push(UNDERLINE_OFF);
  return bytes;
}

/** Build a default 1024-byte GSI block for a document without a preserved one. */
function defaultGsi(fps: number, count: number): Uint8Array {
  const gsi = new Uint8Array(GSI_SIZE).fill(0x20);
  writeAscii(gsi, 0, 3, '850');
  writeAscii(gsi, 3, 8, fps === 30 ? 'STL30.01' : 'STL25.01');
  gsi[11] = '1'.charCodeAt(0);
  writeAscii(gsi, 12, 2, '00');
  writeAscii(gsi, 238, 5, String(count).padStart(5, '0'));
  writeAscii(gsi, 243, 5, String(count).padStart(5, '0'));
  return gsi;
}

/** Serialize a SubtitleDocument to an EBU-STL byte buffer (spec §3 STL). */
export function serializeStl(doc: SubtitleDocument): Uint8Array {
  const fps = doc.metadata.frameRate === 30 ? 30 : 25;
  const raw = doc.metadata.raw as Partial<StlRaw> | undefined;
  const gsi =
    raw?.gsi && raw.gsi.length === GSI_SIZE
      ? Uint8Array.from(raw.gsi)
      : defaultGsi(fps, doc.cues.length);

  const blocks: Uint8Array[] = [gsi];
  doc.cues.forEach((cue, idx) => {
    const ttiRaw = cue.raw as Partial<TtiRaw> | undefined;
    const vp = ttiRaw?.vp ?? 20;
    const jc = ttiRaw?.jc ?? (cue.position?.align ? (ALIGN_TO_JC[cue.position.align] ?? 2) : 2);
    // Text longer than one 112-byte field spills into EBN extension blocks: one
    // TTI per chunk, EBN chained 0,1,… with 0xFF on the last, all sharing the
    // subtitle number and header. Reassembled on parse (cue-forge-drt.4).
    const text = encodeTextField(cue.lines);
    const chunkCount = Math.max(1, Math.ceil(text.length / TEXT_FIELD_LEN));
    for (let c = 0; c < chunkCount; c++) {
      const tti = new Uint8Array(TTI_SIZE).fill(FILL);
      tti[0] = 0; // SGN
      tti[1] = idx & 0xff;
      tti[2] = (idx >> 8) & 0xff;
      tti[3] = c === chunkCount - 1 ? 0xff : c; // EBN: 0xFF marks the subtitle's last block
      tti[4] = 0; // CS
      msToTc(tti, 5, cue.startMs, fps);
      msToTc(tti, 9, cue.endMs, fps);
      tti[13] = vp;
      tti[14] = jc;
      tti[15] = 0; // CF
      const chunk = text.slice(c * TEXT_FIELD_LEN, (c + 1) * TEXT_FIELD_LEN);
      for (let i = 0; i < chunk.length; i++) tti[TEXT_FIELD_OFFSET + i] = chunk[i]!;
      blocks.push(tti);
    }
  });

  // TNB counts TTI blocks (now ≥ cue count with extension blocks); TNS counts subtitles.
  writeAscii(gsi, 238, 5, String(blocks.length - 1).padStart(5, '0'));
  writeAscii(gsi, 243, 5, String(doc.cues.length).padStart(5, '0'));

  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}
