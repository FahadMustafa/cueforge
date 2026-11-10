import type {
  Cue,
  CueLine,
  CuePosition,
  ParseWarning,
  StyledSpan,
  SubtitleDocument,
} from '../../model/types';

/**
 * Advanced SubStation Alpha (.ass) and legacy SubStation Alpha (.ssa) codec
 * (spec §3 ASS/SSA).
 *
 * The header — `[Script Info]`, the styles section (`[V4+ Styles]` / `[V4 Styles]`),
 * and the `[Events]` `Format:` line — is preserved verbatim in `metadata.raw` so
 * style definitions and script settings survive round-trips untouched. Each
 * `Dialogue:`/`Comment:` event becomes a {@link Cue}; its non-canonical fields
 * (Layer, Name, Margins, Effect, …) are stored in `cue.raw.fields` keyed by the
 * event Format names, so the line is reconstructed in the original field order.
 *
 * Inline override blocks (`{\i1}`, `{\pos(..)}`, …) are kept as opaque markup on
 * the following text span — lossless for ASS round-trips. Interpreting them into
 * italic/bold/underline (and stripping the rest with a warning) happens at
 * conversion time, not here (spec §3: "preserved as opaque spans … conversion to
 * SRT maps {\i1}…{\i0} → <i>…</i>").
 */

const NL = '\r\n';
const TC_RE = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/;
const OVERRIDE_RE = /\{[^}]*\}/g;

/** Fields whose values come from the canonical model, not `cue.raw.fields`. */
const CANONICAL_FIELDS = new Set(['Start', 'End', 'Style', 'Text']);

export interface AssRaw {
  /** Verbatim text from the start of the file through the `[Events]` Format line. */
  header: string;
  /** Event field names, in order, parsed from the `[Events]` Format line. */
  eventFields: string[];
  /** Sections after the events ([Fonts], [Graphics], …), preserved verbatim. */
  trailer?: string;
}

interface AssCueRaw {
  /** Event kind, e.g. `Dialogue` or `Comment`. */
  kind: string;
  /** Non-canonical field values keyed by Format name (Layer, Name, Margins, …). */
  fields: Record<string, string>;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

function tcToMs(token: string): number | null {
  const m = TC_RE.exec(token.trim());
  if (!m) return null;
  return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]) * 10;
}

function formatAssTc(ms: number): string {
  const cs = Math.round(ms / 10);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor(cs / 6_000) % 60;
  const s = Math.floor(cs / 100) % 60;
  const c = cs % 100;
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(c, 2)}`;
}

/** Split an event payload into `count` fields; the last field keeps any commas. */
function splitFields(rest: string, count: number): string[] {
  const out: string[] = [];
  let start = 0;
  for (let k = 0; k < count - 1; k++) {
    const idx = rest.indexOf(',', start);
    if (idx < 0) {
      out.push(rest.slice(start));
      start = rest.length;
      // Pad missing trailing fields so indices stay aligned with eventFields.
      while (out.length < count - 1) out.push('');
      break;
    }
    out.push(rest.slice(start, idx));
    start = idx + 1;
  }
  out.push(rest.slice(start));
  return out;
}

/** Parse one ASS Text field into styled visual lines (split on the `\N` token). */
function parseAssText(text: string): CueLine[] {
  return text.split('\\N').map((line) => ({ spans: parseAssSpans(line) }));
}

function parseAssSpans(line: string): StyledSpan[] {
  const spans: StyledSpan[] = [];
  let pending = '';
  let last = 0;
  let m: RegExpExecArray | null;
  OVERRIDE_RE.lastIndex = 0;
  while ((m = OVERRIDE_RE.exec(line)) !== null) {
    const before = line.slice(last, m.index);
    if (before !== '') {
      spans.push(makeSpan(before, pending));
      pending = '';
    }
    pending += m[0];
    last = OVERRIDE_RE.lastIndex;
  }
  const tail = line.slice(last);
  if (tail !== '' || pending !== '') spans.push(makeSpan(tail, pending));
  return spans;
}

function makeSpan(text: string, opaque: string): StyledSpan {
  const span: StyledSpan = { text };
  if (opaque !== '') span.opaque = opaque;
  return span;
}

/** Detect legacy SSA (v4) vs. ASS (v4.00+) from the header. */
function isSsa(header: string): boolean {
  if (/^\s*\[V4\+ Styles\]/im.test(header)) return false;
  if (/^\s*\[V4 Styles\]/im.test(header)) return true;
  return /ScriptType:\s*v4\.00(?!\+)/i.test(header);
}

/** Parse SubStation Alpha (.ass/.ssa) text into a SubtitleDocument (spec §3 ASS/SSA). */
export function parseAss(text: string): SubtitleDocument {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const lines = src.split(/\r?\n/);
  const warnings: ParseWarning[] = [];

  // Locate the [Events] section and its Format line.
  let eventsIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[Events\]/i.test(lines[i]!)) {
      eventsIdx = i;
      break;
    }
  }
  let formatIdx = -1;
  if (eventsIdx >= 0) {
    for (let i = eventsIdx + 1; i < lines.length; i++) {
      if (/^\s*Format\s*:/i.test(lines[i]!)) {
        formatIdx = i;
        break;
      }
    }
  }

  if (formatIdx < 0) {
    warnings.push({ code: 'unexpected-content', message: 'No [Events] Format line found.' });
    return {
      cues: [],
      metadata: { sourceFormat: 'ass', raw: { header: src, eventFields: [] } },
      warnings,
    };
  }

  const header = lines.slice(0, formatIdx + 1).join('\n');
  const eventFields = lines[formatIdx]!.slice(lines[formatIdx]!.indexOf(':') + 1)
    .split(',')
    .map((f) => f.trim());
  const textIdx = eventFields.indexOf('Text');
  const startIdx = eventFields.indexOf('Start');
  const endIdx = eventFields.indexOf('End');
  const styleIdx = eventFields.indexOf('Style');

  const cues: Cue[] = [];
  let trailer = '';
  for (let i = formatIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    // A new section header ends the events; everything from here on ([Fonts],
    // [Graphics], [Aegisub Project Garbage], …) is preserved verbatim.
    if (/^\s*\[/.test(line)) {
      const tail = lines.slice(i);
      while (tail.length > 0 && tail[tail.length - 1]!.trim() === '') tail.pop();
      trailer = tail.join('\n');
      break;
    }
    const ci = line.indexOf(':');
    if (ci < 0) {
      warnings.push({ code: 'unexpected-content', message: `Unparsable event: "${line}".` });
      continue;
    }
    const kind = line.slice(0, ci).trim();
    const values = splitFields(line.slice(ci + 1), eventFields.length);

    const startMs = tcToMs(values[startIdx] ?? '');
    const endMs = tcToMs(values[endIdx] ?? '');
    if (startMs === null || endMs === null) {
      warnings.push({ code: 'malformed-timing', message: `Bad event timing: "${line}".` });
      continue;
    }

    const index = cues.length + 1;
    const fields: Record<string, string> = {};
    for (let f = 0; f < eventFields.length; f++) {
      const name = eventFields[f]!;
      if (!CANONICAL_FIELDS.has(name)) fields[name] = (values[f] ?? '').trim();
    }

    const textValue = values[textIdx] ?? '';
    const cue: Cue = {
      index,
      startMs,
      endMs,
      lines: textValue === '' ? [] : parseAssText(textValue),
      styleRefs: [(values[styleIdx] ?? '').trim()],
      raw: { kind, fields } satisfies AssCueRaw,
    };
    if (textValue === '') {
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

  const sourceFormat = isSsa(header) ? 'ssa' : 'ass';
  const raw: AssRaw = { header, eventFields };
  if (trailer !== '') raw.trailer = trailer;
  return { cues, metadata: { sourceFormat, raw: { ...raw } }, warnings };
}

/** Minimal CSS/HTML named-colour table for synthesising ASS `\c` overrides. */
const NAMED_RGB: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  lime: '00FF00',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  cyan: '00FFFF',
  aqua: '00FFFF',
  magenta: 'FF00FF',
  fuchsia: 'FF00FF',
  silver: 'C0C0C0',
  gray: '808080',
  grey: '808080',
  maroon: '800000',
  olive: '808000',
  navy: '000080',
  teal: '008080',
  purple: '800080',
  orange: 'FFA500',
};

/**
 * Convert a model colour (`#RRGGBB`, `#RGB`, a CSS name, or a native `&H..&`) to
 * the ASS `\c` byte order — BGR hex (`BBGGRR`). Returns `undefined` when the
 * colour is not recognised (the override is then simply not synthesised).
 */
function colorToAssBgr(color: string): string | undefined {
  const c = color.trim();
  let rgb: string | undefined;
  if (c.startsWith('&')) {
    const h = c.replace(/[&hH]/g, '');
    // Native ASS colour is already &H(AA)BBGGRR; take the low 6 hex (BBGGRR).
    if (/^[0-9a-fA-F]{6,8}$/.test(h)) return h.slice(-6).toUpperCase();
    return undefined;
  }
  if (c.startsWith('#')) {
    const h = c.slice(1);
    if (/^[0-9a-fA-F]{6}$/.test(h)) rgb = h.toUpperCase();
    else if (/^[0-9a-fA-F]{3}$/.test(h))
      rgb = h
        .split('')
        .map((x) => x + x)
        .join('')
        .toUpperCase();
  } else {
    rgb = NAMED_RGB[c.toLowerCase()];
  }
  if (rgb === undefined) return undefined;
  return rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2); // RRGGBB → BBGGRR
}

/** Serialize a span list back to an ASS Text fragment for one visual line. */
function serializeAssLine(spans: StyledSpan[]): string {
  let out = '';
  let cur = { i: false, b: false, u: false, color: undefined as string | undefined };
  for (const span of spans) {
    if (span.opaque !== undefined) {
      out += span.opaque + span.text;
      continue;
    }
    const tags: string[] = [];
    const wantI = span.italic === true;
    const wantB = span.bold === true;
    const wantU = span.underline === true;
    const wantColor = span.color !== undefined ? colorToAssBgr(span.color) : undefined;
    if (wantI !== cur.i) tags.push(wantI ? '\\i1' : '\\i0');
    if (wantB !== cur.b) tags.push(wantB ? '\\b1' : '\\b0');
    if (wantU !== cur.u) tags.push(wantU ? '\\u1' : '\\u0');
    // A bare \c reverts to the style's primary colour (ASS spec).
    if (wantColor !== cur.color) tags.push(wantColor !== undefined ? `\\c&H${wantColor}&` : '\\c');
    cur = { i: wantI, b: wantB, u: wantU, color: wantColor };
    if (tags.length > 0) out += `{${tags.join('')}}`;
    out += span.text;
  }
  // Close any still-open styles so the next line starts clean.
  const closers: string[] = [];
  if (cur.i) closers.push('\\i0');
  if (cur.b) closers.push('\\b0');
  if (cur.u) closers.push('\\u0');
  if (cur.color !== undefined) closers.push('\\c');
  if (closers.length > 0) out += `{${closers.join('')}}`;
  return out;
}

/** Read PlayResX/PlayResY from a header, defaulting to 1920×1080. */
function playRes(header: string): { x: number; y: number } {
  const mx = /^\s*PlayResX:\s*(\d+)/im.exec(header);
  const my = /^\s*PlayResY:\s*(\d+)/im.exec(header);
  return { x: mx ? Number(mx[1]) : 1920, y: my ? Number(my[1]) : 1080 };
}

/** Numpad-style \an alignment from a model position (column from align, row from line%). */
function alignNum(pos: CuePosition): number | undefined {
  const col =
    pos.align === 'left' || pos.align === 'start'
      ? 1
      : pos.align === 'center'
        ? 2
        : pos.align === 'right' || pos.align === 'end'
          ? 3
          : undefined;
  const row =
    typeof pos.line === 'number'
      ? pos.line < 100 / 3
        ? 2
        : pos.line < 200 / 3
          ? 1
          : 0
      : undefined;
  if (col === undefined && row === undefined) return undefined;
  return (row ?? 0) * 3 + (col ?? 2); // bottom 1-3, middle 4-6, top 7-9
}

/**
 * Synthesise the leading override block for a cue's position: an `\an` alignment
 * tag and, when both axes are explicit percentages, an `\pos(x,y)` placed via
 * PlayResX/PlayResY. Returns '' when there is nothing positional to express.
 */
function positionPrefix(pos: CuePosition | undefined, res: { x: number; y: number }): string {
  if (pos === undefined) return '';
  const tags: string[] = [];
  const an = alignNum(pos);
  if (an !== undefined) tags.push(`\\an${an}`);
  if (typeof pos.position === 'number' && typeof pos.line === 'number') {
    const x = Math.round((pos.position / 100) * res.x);
    const y = Math.round((pos.line / 100) * res.y);
    tags.push(`\\pos(${x},${y})`);
  }
  return tags.length > 0 ? `{${tags.join('')}}` : '';
}

function serializeAssText(lines: CueLine[]): string {
  return lines.map((l) => serializeAssLine(l.spans)).join('\\N');
}

/** Serialize a SubtitleDocument to SubStation Alpha (.ass) text (spec §3 ASS/SSA). */
export function serializeAss(doc: SubtitleDocument): string {
  const raw = (doc.metadata.raw ?? {}) as Partial<AssRaw>;
  const header = raw.header && raw.header.length > 0 ? raw.header : defaultHeader();
  const fields =
    raw.eventFields && raw.eventFields.length > 0 ? raw.eventFields : DEFAULT_EVENT_FIELDS;

  const res = playRes(header);
  let out = header.replace(/\r?\n/g, NL) + NL;
  for (const cue of doc.cues) {
    const cr = (cue.raw ?? { kind: 'Dialogue', fields: {} }) as Partial<AssCueRaw>;
    const kind = cr.kind ?? 'Dialogue';
    const cueFields = cr.fields ?? {};
    const values = fields.map((name) => {
      switch (name) {
        case 'Start':
          return formatAssTc(cue.startMs);
        case 'End':
          return formatAssTc(cue.endMs);
        case 'Style':
          return cue.styleRefs?.[0] ?? 'Default';
        case 'Text':
          return positionPrefix(cue.position, res) + serializeAssText(cue.lines);
        default:
          return cueFields[name] ?? '';
      }
    });
    out += `${kind}: ${values.join(',')}${NL}`;
  }
  if (raw.trailer !== undefined && raw.trailer !== '') {
    out += NL + raw.trailer.replace(/\r?\n/g, NL) + NL;
  }
  return out;
}

const DEFAULT_EVENT_FIELDS = [
  'Layer',
  'Start',
  'End',
  'Style',
  'Name',
  'MarginL',
  'MarginR',
  'MarginV',
  'Effect',
  'Text',
];

function defaultHeader(): string {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
    '',
    '[Events]',
    'Format: ' + DEFAULT_EVENT_FIELDS.join(', '),
  ].join('\n');
}
