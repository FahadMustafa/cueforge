import type { Cue, CuePosition, ParseWarning, SubtitleDocument } from '../../model/types';
import { joinMs, splitMs } from '../../model/timecode';
import { serializeCueLines } from '../inline';
import { parseStyledLines } from '../inline';

const NL = '\r\n';
// start --> end, with an optional trailer (e.g. SRT coordinate extensions).
// Anchored at line start with bounded hour digits so a pathological digit run
// before "-->" cannot trigger quadratic backtracking (cue-forge-78v).
const TIMING =
  /^\s*(?:(\d{1,9}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(?:(\d{1,9}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})(.*)$/;

// A leading ASS-style alignment tag (numpad layout: 1-3 bottom, 4-6 middle,
// 7-9 top), common in SRT in the wild. Not cue text (cue-forge-qcvu.3).
const AN_TAG = /^\{\\an([1-9])\}/;

/** SRT-native per-cue payload: the timing-line trailer and the `{\anN}` tag. */
export interface SrtCueRaw {
  trailer?: string;
  an?: number;
}

/** The `{\anN}` alignment number an SRT cue carries, if any. */
export function srtAlignment(cue: Cue): number | undefined {
  const an = (cue.raw as SrtCueRaw | undefined)?.an;
  return typeof an === 'number' ? an : undefined;
}

/**
 * The WebVTT-style placement for `{\anN}`: column → align, row → line (top =
 * line 0, middle = 50%, bottom = default). Round-trips through ASS `alignNum`.
 */
export function positionFromAlignment(an: number): CuePosition {
  const col = (an - 1) % 3;
  const row = Math.floor((an - 1) / 3);
  const pos: CuePosition = { align: col === 0 ? 'left' : col === 1 ? 'center' : 'right' };
  if (row === 1) {
    pos.line = 50;
    pos.linePercent = true;
  } else if (row === 2) pos.line = 0;
  return pos;
}

interface TcParse {
  ms: number;
  hourOverflow: boolean;
}

function tcToMs(h: string | undefined, m: string, s: string, ms: string): TcParse {
  const hours = Number(h ?? 0);
  return {
    // A 1–2 digit fraction is a fraction of a second, not literal ms: ",5" = 500.
    ms: joinMs({
      hours,
      minutes: Number(m),
      seconds: Number(s),
      millis: Number(ms.padEnd(3, '0')),
    }),
    hourOverflow: hours > 99,
  };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function formatTc(ms: number): string {
  const { hours, minutes, seconds, millis } = splitMs(ms);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/** Parse SubRip (.srt) text into a SubtitleDocument (spec §3 SRT). */
export function parseSrt(text: string): SubtitleDocument {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const lines = src.split(/\r?\n/);
  const cues: Cue[] = [];
  const warnings: ParseWarning[] = [];

  let i = 0;
  while (i < lines.length) {
    // Skip blank lines between cues.
    while (i < lines.length && lines[i]!.trim() === '') i++;
    if (i >= lines.length) break;

    const startLine = i + 1; // 1-based source line of this record
    let index: number | undefined;
    const cur = lines[i]!;
    const hasTimingNext = i + 1 < lines.length && lines[i + 1]!.includes('-->');
    if (/^\d+$/.test(cur.trim()) && hasTimingNext) {
      index = Number(cur.trim());
      i++;
    }

    const timingLine = lines[i];
    if (timingLine === undefined || !timingLine.includes('-->')) {
      warnings.push({
        code: 'unexpected-content',
        message: `Expected a timing line near source line ${startLine}.`,
        sourceLine: startLine,
      });
      i++;
      continue;
    }

    const m = TIMING.exec(timingLine);
    if (!m) {
      warnings.push({
        code: 'malformed-timing',
        message: `Could not parse timing: "${timingLine.trim()}".`,
        sourceLine: i + 1,
      });
      i++;
      continue;
    }
    i++;

    if (index === undefined) {
      index = cues.length + 1;
      warnings.push({
        code: 'missing-index',
        message: `Missing cue index; assigned ${index}.`,
        cueIndex: index,
        sourceLine: startLine,
      });
    }

    const start = tcToMs(m[1], m[2]!, m[3]!, m[4]!);
    const end = tcToMs(m[5], m[6]!, m[7]!, m[8]!);
    if (start.hourOverflow || end.hourOverflow) {
      warnings.push({
        code: 'hour-overflow',
        message: 'Hour field exceeds 99.',
        cueIndex: index,
        sourceLine: startLine,
      });
    }
    const trailer = (m[9] ?? '').replace(/\s+$/, '');

    // Collect text lines. A blank run ends the cue only before EOF, a timing
    // line, or an index line followed by a timing line; otherwise each blank
    // is kept as an interior empty line.
    const textLines: string[] = [];
    let firstAbsorbedBlank: number | undefined;
    while (i < lines.length) {
      if (lines[i]!.trim() === '') {
        let j = i;
        while (j < lines.length && lines[j]!.trim() === '') j++;
        const next = lines[j];
        if (
          next === undefined ||
          next.includes('-->') ||
          (/^\d+$/.test(next.trim()) && lines[j + 1]?.includes('-->'))
        )
          break;
        // Leading blanks (no text yet) are skipped silently; interior ones become empty lines.
        if (textLines.length > 0) {
          firstAbsorbedBlank ??= i + 1;
          while (i < j) {
            textLines.push('');
            i++;
          }
        }
        i = j;
        continue;
      }
      textLines.push(lines[i]!);
      i++;
    }
    if (firstAbsorbedBlank !== undefined) {
      warnings.push({
        code: 'blank-line-in-cue',
        message: `Cue ${index} contains a blank line; the text after it was kept as part of the cue.`,
        cueIndex: index,
        sourceLine: firstAbsorbedBlank,
      });
    }
    let block = textLines.join('\n');
    const anTag = AN_TAG.exec(block);
    if (anTag) block = block.slice(anTag[0].length);

    const cue: Cue = { index, startMs: start.ms, endMs: end.ms, lines: [] };
    if (block === '') {
      warnings.push({
        code: 'empty-cue',
        message: 'Cue has no text.',
        cueIndex: index,
        sourceLine: startLine,
      });
    } else {
      const parsed = parseStyledLines(block);
      cue.lines = parsed.lines;
      for (const w of parsed.warnings) {
        warnings.push({
          code: w.code,
          message: `${w.code}: <${w.tag}>`,
          cueIndex: index,
          sourceLine: startLine,
        });
      }
    }
    const raw: SrtCueRaw = {};
    if (trailer.trim() !== '') raw.trailer = trailer;
    if (anTag) raw.an = Number(anTag[1]);
    if (raw.trailer !== undefined || raw.an !== undefined) cue.raw = raw;
    if (end.ms < start.ms) {
      warnings.push({
        code: 'reversed-timing',
        message: 'Cue end precedes start.',
        cueIndex: index,
        sourceLine: startLine,
      });
    }
    cues.push(cue);
  }

  // Overlap detection in document order.
  for (let k = 1; k < cues.length; k++) {
    if (cues[k]!.startMs < cues[k - 1]!.endMs) {
      warnings.push({
        code: 'overlap',
        message: `Cue ${cues[k]!.index} overlaps the previous cue.`,
        cueIndex: cues[k]!.index,
      });
    }
  }

  return { cues, metadata: { sourceFormat: 'srt' }, warnings };
}

/** Serialize a SubtitleDocument to SubRip (.srt) text (spec §3 SRT). */
export function serializeSrt(doc: SubtitleDocument): string {
  let out = '';
  for (const cue of doc.cues) {
    const trailer =
      cue.raw && typeof cue.raw === 'object' && 'trailer' in cue.raw ? String(cue.raw.trailer) : '';
    out += `${cue.index}${NL}`;
    out += `${formatTc(cue.startMs)} --> ${formatTc(cue.endMs)}${trailer}${NL}`;
    const textLines = serializeCueLines(cue.lines);
    const an = srtAlignment(cue);
    if (an !== undefined) textLines[0] = `{\\an${an}}${textLines[0] ?? ''}`;
    if (textLines.length > 0) out += textLines.join(NL) + NL;
    out += NL;
  }
  return out;
}
