import type { Cue, CueAlign, CuePosition, ParseWarning, SubtitleDocument } from '../../model/types';
import { joinMs, splitMs } from '../../model/timecode';
import { parseStyledLines, serializeCueLines } from '../inline';

const NL = '\n';
const ALIGNS: readonly string[] = ['start', 'center', 'end', 'left', 'right'];

interface VttRaw {
  header: string;
  notes: string[];
  styles: string[];
  regions: string[];
}

function parseVttTc(token: string): number | null {
  // A 1–2 digit fraction is a fraction of a second, not literal ms: ".5" = 500.
  let m = /^(\d+):([0-5]?\d):([0-5]?\d)\.(\d{1,3})$/.exec(token);
  if (m) {
    return joinMs({
      hours: +m[1]!,
      minutes: +m[2]!,
      seconds: +m[3]!,
      millis: +m[4]!.padEnd(3, '0'),
    });
  }
  m = /^([0-5]?\d):([0-5]?\d)\.(\d{1,3})$/.exec(token);
  if (m) {
    return joinMs({ hours: 0, minutes: +m[1]!, seconds: +m[2]!, millis: +m[3]!.padEnd(3, '0') });
  }
  return null;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

function formatVttTc(ms: number): string {
  const { hours, minutes, seconds, millis } = splitMs(ms);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

function parseSettings(raw: string): CuePosition | undefined {
  const settings = raw.trim();
  if (settings === '') return undefined;
  const pos: CuePosition = { raw: settings };
  for (const tok of settings.split(/\s+/)) {
    const ci = tok.indexOf(':');
    if (ci < 0) continue;
    const key = tok.slice(0, ci);
    const value = tok.slice(ci + 1);
    switch (key) {
      case 'vertical':
        if (value === 'rl') pos.vertical = 'vertical-rl';
        else if (value === 'lr') pos.vertical = 'vertical-lr';
        break;
      case 'line': {
        const mm = /^(-?\d+(?:\.\d+)?)(%?)/.exec(value);
        if (mm) {
          pos.line = Number(mm[1]);
          if (mm[2] === '%') pos.linePercent = true;
        }
        break;
      }
      case 'position': {
        const mm = /^(\d+(?:\.\d+)?)%?/.exec(value);
        if (mm) pos.position = Number(mm[1]);
        break;
      }
      case 'size': {
        const mm = /^(\d+(?:\.\d+)?)%?/.exec(value);
        if (mm) pos.size = Number(mm[1]);
        break;
      }
      case 'align':
        if (ALIGNS.includes(value)) pos.align = value as CueAlign;
        break;
      default:
        break;
    }
  }
  return pos;
}

/** Parse WebVTT (.vtt) text into a SubtitleDocument (spec §3 VTT). */
export function parseVtt(text: string): SubtitleDocument {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const lines = src.split(/\r?\n/);
  const warnings: ParseWarning[] = [];
  const raw: VttRaw = { header: '', notes: [], styles: [], regions: [] };

  // Header: from line 0 up to the first blank line.
  let firstBlank = lines.findIndex((l) => l.trim() === '');
  if (firstBlank === -1) firstBlank = lines.length;
  raw.header = lines.slice(0, firstBlank).join(NL);
  const rest = lines.slice(firstBlank + 1);

  // The file must begin with the "WEBVTT" signature, optionally followed by a
  // space/tab and arbitrary text (spec §3 VTT). Parsing stays tolerant, but a
  // missing signature very likely means this isn't a VTT file at all.
  if (!/^WEBVTT([ \t]|$)/.test(lines[0] ?? '')) {
    warnings.push({
      code: 'missing-signature',
      message: 'File does not begin with the "WEBVTT" signature.',
      sourceLine: 1,
    });
  }

  // Group remaining lines into blank-line-separated blocks.
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const line of rest) {
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
    const head = block[0]!;
    const joined = block.join(NL);
    if (/^NOTE(\s|$)/.test(head)) {
      raw.notes.push(joined);
      continue;
    }
    if (/^STYLE(\s|$)/.test(head)) {
      raw.styles.push(joined);
      continue;
    }
    if (/^REGION(\s|$)/.test(head)) {
      raw.regions.push(joined);
      continue;
    }

    const timingIdx = block.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) {
      warnings.push({ code: 'unexpected-content', message: `Block is not a cue: "${head}".` });
      continue;
    }
    const timingLine = block[timingIdx]!;
    const tm = /^(\S+)\s*-->\s*(\S+)(?:\s+(.*))?$/.exec(timingLine);
    const startMs = tm ? parseVttTc(tm[1]!) : null;
    const endMs = tm ? parseVttTc(tm[2]!) : null;
    if (tm === null || startMs === null || endMs === null) {
      warnings.push({ code: 'malformed-timing', message: `Bad timing: "${timingLine}".` });
      continue;
    }

    const index = cues.length + 1;
    const cue: Cue = { index, startMs, endMs, lines: [] };
    if (timingIdx > 0) cue.id = block.slice(0, timingIdx).join(NL);
    const position = parseSettings(tm[3] ?? '');
    if (position) cue.position = position;

    const textBlock = block.slice(timingIdx + 1).join(NL);
    if (textBlock === '') {
      warnings.push({ code: 'empty-cue', message: 'Cue has no text.', cueIndex: index });
    } else {
      const parsed = parseStyledLines(textBlock, { vtt: true });
      cue.lines = parsed.lines;
      for (const w of parsed.warnings) {
        warnings.push({ code: w.code, message: `${w.code}: <${w.tag}>`, cueIndex: index });
      }
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

  return { cues, metadata: { sourceFormat: 'vtt', raw: { ...raw } }, warnings };
}

/** Cue-settings tokens synthesized from structured fields (used when no verbatim raw exists). */
function settingsFromPosition(pos: CuePosition): string {
  const toks: string[] = [];
  if (pos.vertical === 'vertical-rl') toks.push('vertical:rl');
  else if (pos.vertical === 'vertical-lr') toks.push('vertical:lr');
  if (pos.line !== undefined) toks.push(`line:${pos.line}${pos.linePercent ? '%' : ''}`);
  if (pos.position !== undefined) toks.push(`position:${pos.position}%`);
  if (pos.size !== undefined) toks.push(`size:${pos.size}%`);
  if (pos.align !== undefined) toks.push(`align:${pos.align}`);
  return toks.join(' ');
}

/** Serialize a SubtitleDocument to WebVTT (.vtt) text (spec §3 VTT). */
export function serializeVtt(doc: SubtitleDocument): string {
  const raw = (doc.metadata.raw ?? {}) as Partial<VttRaw>;
  const header = raw.header && raw.header.length > 0 ? raw.header : 'WEBVTT';
  let out = header + NL + NL;

  for (const st of raw.styles ?? []) out += st + NL + NL;
  for (const rg of raw.regions ?? []) out += rg + NL + NL;
  for (const nt of raw.notes ?? []) out += nt + NL + NL;

  for (const cue of doc.cues) {
    if (cue.id !== undefined) out += cue.id + NL;
    // Verbatim raw settings win (lossless round-trip); otherwise synthesize
    // tokens from the structured fields (e.g. positions from other formats).
    const settings = cue.position ? (cue.position.raw ?? settingsFromPosition(cue.position)) : '';
    out += `${formatVttTc(cue.startMs)} --> ${formatVttTc(cue.endMs)}`;
    if (settings) out += ' ' + settings;
    out += NL;
    const textLines = serializeCueLines(cue.lines, { vtt: true });
    if (textLines.length > 0) out += textLines.join(NL) + NL;
    out += NL;
  }
  return out;
}
