import type { Cue, CueLine, ParseWarning, SubtitleDocument } from '../../model/types';
import { joinMs, splitMs } from '../../model/timecode';
import { lineToText, textLine } from '../../model/cue';
import { BLANK_LINE } from '../inline';

const NL = '\n';
const TC = /^(\d+):([0-5]?\d):([0-5]?\d)\.(\d{1,3})$/;

function parseTc(token: string): number | null {
  const m = TC.exec(token);
  if (!m) return null;
  // A 1–2 digit fraction is a fraction of a second, not literal ms: ".5" = 500.
  return joinMs({ hours: +m[1]!, minutes: +m[2]!, seconds: +m[3]!, millis: +m[4]!.padEnd(3, '0') });
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

function formatTc(ms: number): string {
  const { hours, minutes, seconds, millis } = splitMs(ms);
  // YouTube SBV uses a non-padded hour field, e.g. "0:00:01.000".
  return `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

/** Parse YouTube SBV (.sbv) text into a SubtitleDocument (spec §3 SBV). */
export function parseSbv(text: string): SubtitleDocument {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const lines = src.split(/\r?\n/);
  const warnings: ParseWarning[] = [];

  // Group into blank-line-separated blocks.
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (cur.length > 0) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) blocks.push(cur);

  const cues: Cue[] = [];
  for (const block of blocks) {
    const timingLine = block[0]!;
    const parts = timingLine.split(',');
    const startMs = parts.length === 2 ? parseTc(parts[0]!.trim()) : null;
    const endMs = parts.length === 2 ? parseTc(parts[1]!.trim()) : null;
    if (startMs === null || endMs === null) {
      warnings.push({ code: 'malformed-timing', message: `Bad timing: "${timingLine}".` });
      continue;
    }

    const index = cues.length + 1;
    const textLines = block.slice(1);
    const cueLines: CueLine[] = textLines.map((l) =>
      l === '' || l === BLANK_LINE ? { spans: [] } : textLine(l),
    );
    const cue: Cue = { index, startMs, endMs, lines: cueLines };
    if (textLines.length === 0) {
      warnings.push({ code: 'empty-cue', message: 'Cue has no text.', cueIndex: index });
    }
    if (endMs < startMs) {
      warnings.push({
        code: 'reversed-timing',
        message: 'Cue end precedes start.',
        cueIndex: index,
      });
    }
    cues.push(cue);
  }

  for (let k = 1; k < cues.length; k++) {
    if (cues[k]!.startMs < cues[k - 1]!.endMs) {
      warnings.push({
        code: 'overlap',
        message: `Cue ${cues[k]!.index} overlaps the previous cue.`,
        cueIndex: cues[k]!.index,
      });
    }
  }

  return { cues, metadata: { sourceFormat: 'sbv' }, warnings };
}

/** Serialize a SubtitleDocument to YouTube SBV (.sbv) text (spec §3 SBV). */
export function serializeSbv(doc: SubtitleDocument): string {
  let out = '';
  for (const cue of doc.cues) {
    out += `${formatTc(cue.startMs)},${formatTc(cue.endMs)}${NL}`;
    if (cue.lines.length > 0) {
      out += cue.lines.map((l) => lineToText(l) || BLANK_LINE).join(NL) + NL;
    }
    out += NL;
  }
  return out;
}
