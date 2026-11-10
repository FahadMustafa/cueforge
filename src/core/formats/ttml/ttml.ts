import type {
  Cue,
  CueAlign,
  CueLine,
  CuePosition,
  ParseWarning,
  StyledSpan,
  SubtitleDocument,
  WritingDirection,
} from '../../model/types';
import { escapeAttr, escapeText, parseXml, serializeXml, XmlError, type XmlElement } from './xml';
import { dropFrameTimecodeToMs } from '../../timing/timecode';
import { canonicalFps } from '../../timing/timing';

/**
 * TTML / IMSC1 parser (spec §3 TTML).
 *
 * Namespace-aware over the well-formed subset TTML uses: `<tt>` carries document
 * parameters (`ttp:frameRate`(+`Multiplier`), `xml:lang`); `<head>` holds
 * `<styling>`/`<layout>` (preserved verbatim in `metadata.raw` for round-trip);
 * `<body>` → `<div>` → `<p>` produce cues, with `<span>` runs and `<br/>` line
 * breaks. Times are clock (`HH:MM:SS.fff`, `HH:MM:SS:frames`) or offset
 * (`12s`, `250ms`, `5f`, `10t`). Inline `tts:fontStyle`/`fontWeight`/
 * `textDecoration` map to italic/bold/underline; `tts:writingMode` maps to the
 * canonical writing direction. All timing is integer milliseconds.
 */

const TTML_DEFAULT_TICK_RATE = 1; // ticks/second when neither ttp:tickRate nor frameRate given

/** Strip a namespace prefix: `tts:color` → `color`, `xml:lang` → `lang`. */
function local(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/** Look up an attribute by its local name, ignoring namespace prefix. */
function attrByLocal(el: XmlElement, localName: string): string | undefined {
  for (const key of Object.keys(el.attrs)) {
    if (local(key) === localName) return el.attrs[key];
  }
  return undefined;
}

/** Find the first child element whose local tag name matches. */
function child(el: XmlElement, localName: string): XmlElement | undefined {
  for (const c of el.children) {
    if (typeof c !== 'string' && local(c.tag) === localName) return c;
  }
  return undefined;
}

/** Effective xml:space for an element, given the value inherited from its ancestors. */
function xmlSpacePreserve(el: XmlElement, inherited: boolean): boolean {
  const space = attrByLocal(el, 'space');
  if (space === 'preserve') return true;
  if (space === 'default') return false;
  return inherited;
}

/** A `<p>` paired with its effective xml:space (inherited through tt/body/div). */
interface Paragraph {
  p: XmlElement;
  preserve: boolean;
}

/** All descendant `<p>` elements (depth-first), tracking xml:space inheritance. */
function paragraphs(el: XmlElement, inherited: boolean, out: Paragraph[] = []): Paragraph[] {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    const preserve = xmlSpacePreserve(c, inherited);
    if (local(c.tag) === 'p') out.push({ p: c, preserve });
    else paragraphs(c, preserve, out);
  }
  return out;
}

interface TimingContext {
  /** Effective frame rate (after multiplier), frames/second. */
  frameRate: number;
  /** Nominal integer frame rate the SMPTE FF field counts at (30 for 29.97, 24 for 23.976). */
  nominalFrameRate: number;
  /** Ticks per second (ttp:tickRate, else frameRate, else 1). */
  tickRate: number;
  /** SMPTE drop-frame counting (ttp:dropMode="dropNTSC"): frame timecodes drop 2/min. */
  dropFrame: boolean;
  /**
   * ttp:timeBase — 'smpte' means HH:MM:SS:FF is a frame count (the seconds field
   * is a display, not wall-clock time); 'media' (the TTML default) means the
   * frames field divides by the frame rate over wall-clock seconds.
   */
  timeBase: string;
}

const CLOCK_RE = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+)|:(\d+))?$/;
const OFFSET_RE = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/;

/** Parse a TTML time expression to integer milliseconds, or null if malformed. */
function parseTime(value: string, ctx: TimingContext): number | null {
  const v = value.trim();
  const clock = CLOCK_RE.exec(v);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    const s = Number(clock[3]);
    if (clock[5] !== undefined) {
      const frames = Number(clock[5]);
      // Drop-frame counting can't be read off the ':'-separated frames field;
      // it is declared via ttp:dropMode, so decode the whole timecode (sdv.17).
      if (ctx.dropFrame) return dropFrameTimecodeToMs(h, m, s, frames);
      if (ctx.timeBase === 'smpte') {
        // SMPTE non-drop: HH:MM:SS:FF is a frame count at the nominal integer rate,
        // not wall-clock seconds. Decode via the total frame count on the exact
        // timebase — the inverse of msToTimecode's non-drop path (cue-forge-drt.3).
        const totalFrames = (h * 3600 + m * 60 + s) * ctx.nominalFrameRate + frames;
        return Math.round((totalFrames * 1000) / ctx.frameRate);
      }
      return h * 3_600_000 + m * 60_000 + s * 1000 + Math.round((frames / ctx.frameRate) * 1000);
    }
    let ms = h * 3_600_000 + m * 60_000 + s * 1000;
    if (clock[4] !== undefined) {
      ms += Math.round(Number(`0.${clock[4]}`) * 1000);
    }
    return ms;
  }
  const offset = OFFSET_RE.exec(v);
  if (offset) {
    const n = Number(offset[1]);
    switch (offset[2]) {
      case 'h':
        return Math.round(n * 3_600_000);
      case 'm':
        return Math.round(n * 60_000);
      case 's':
        return Math.round(n * 1000);
      case 'ms':
        return Math.round(n);
      case 'f':
        return Math.round((n / ctx.frameRate) * 1000);
      case 't':
        return Math.round((n / ctx.tickRate) * 1000);
    }
  }
  return null;
}

const WRITING_MODE: Record<string, WritingDirection | undefined> = {
  lrtb: undefined,
  rltb: undefined,
  lr: undefined,
  rl: undefined,
  tbrl: 'vertical-rl',
  tb: 'vertical-rl',
  tblr: 'vertical-lr',
};

/** Apply a span's effective tts styling onto a StyledSpan. */
function applyStyle(span: StyledSpan, el: XmlElement): void {
  const fontStyle = attrByLocal(el, 'fontStyle');
  const fontWeight = attrByLocal(el, 'fontWeight');
  const decoration = attrByLocal(el, 'textDecoration');
  const color = attrByLocal(el, 'color');
  if (fontStyle === 'italic' || fontStyle === 'oblique') span.italic = true;
  if (fontWeight === 'bold') span.bold = true;
  if (decoration !== undefined && /underline/.test(decoration)) span.underline = true;
  if (color !== undefined) span.color = color;
}

/** A styled run plus whether it was produced under xml:space="preserve". */
interface Run {
  span: StyledSpan;
  preserved: boolean;
}

/**
 * Trim default-mode whitespace at a visual line's edges (TTML/IMSC whitespace
 * processing: collapsed runs are stripped at `<p>` start/end and around `<br/>`).
 * Runs produced under xml:space="preserve" are left untouched.
 */
function trimLine(runs: Run[]): StyledSpan[] {
  while (runs.length > 0) {
    const first = runs[0]!;
    if (first.preserved) break;
    first.span.text = first.span.text.replace(/^ +/, '');
    if (first.span.text !== '') break;
    runs.shift();
  }
  while (runs.length > 0) {
    const last = runs[runs.length - 1]!;
    if (last.preserved) break;
    last.span.text = last.span.text.replace(/ +$/, '');
    if (last.span.text !== '') break;
    runs.pop();
  }
  return runs.map((r) => r.span);
}

/**
 * Flatten a `<p>`'s content into visual lines. `<br/>` starts a new line; nested
 * `<span>`s contribute styled runs (one level of styling inheritance is enough
 * for the formats we target — nested spans merge their flags). Unless
 * xml:space="preserve" applies (on the `<p>`, inherited, or set on a `<span>`),
 * whitespace runs collapse to a single space and line edges are trimmed.
 */
function parseLines(p: XmlElement, inheritedPreserve: boolean): CueLine[] {
  const lines: Run[][] = [[]];

  function pushText(text: string, style: StyledSpan, preserved: boolean): void {
    if (text === '') return;
    const span: StyledSpan = { text };
    if (style.italic) span.italic = true;
    if (style.bold) span.bold = true;
    if (style.underline) span.underline = true;
    if (style.color !== undefined) span.color = style.color;
    lines[lines.length - 1]!.push({ span, preserved });
  }

  function walk(node: XmlElement, inherited: StyledSpan, preserve: boolean): void {
    for (const c of node.children) {
      if (typeof c === 'string') {
        pushText(preserve ? c : c.replace(/[ \t\r\n]+/g, ' '), inherited, preserve);
        continue;
      }
      const tag = local(c.tag);
      if (tag === 'br') {
        lines.push([]);
        continue;
      }
      // span (or any inline element): merge styling and recurse.
      const merged: StyledSpan = { ...inherited, text: '' };
      applyStyle(merged, c);
      walk(c, merged, xmlSpacePreserve(c, preserve));
    }
  }

  walk(p, { text: '' }, inheritedPreserve);
  return lines.map((runs) => ({ spans: trimLine(runs) }));
}

/** TTML `tts:textAlign` values mapped to the canonical {@link CueAlign}. */
const TEXT_ALIGN: Record<string, CueAlign | undefined> = {
  left: 'left',
  start: 'start',
  center: 'center',
  centre: 'center',
  right: 'right',
  end: 'end',
};

/**
 * Read positioning a TTML `<p>` carries directly (cue-forge-z6t): writing
 * direction (`tts:writingMode`) and text alignment (`tts:textAlign`). Absolute
 * x/y box geometry lives on referenced `<region>`s, preserved verbatim through
 * the `<head>` passthrough rather than re-derived here.
 */
function parsePosition(p: XmlElement): CuePosition | undefined {
  const pos: CuePosition = {};
  const wm = attrByLocal(p, 'writingMode');
  if (wm !== undefined) {
    const vertical = WRITING_MODE[wm];
    if (vertical !== undefined) pos.vertical = vertical;
  }
  const ta = attrByLocal(p, 'textAlign');
  if (ta !== undefined) {
    const align = TEXT_ALIGN[ta.trim().toLowerCase()];
    if (align !== undefined) pos.align = align;
  }
  return Object.keys(pos).length > 0 ? pos : undefined;
}

/** Parse TTML/IMSC1 text into a SubtitleDocument (spec §3 TTML). */
export function parseTtml(text: string): SubtitleDocument {
  const warnings: ParseWarning[] = [];
  let tt: XmlElement;
  try {
    tt = parseXml(text);
  } catch (e) {
    const message = e instanceof XmlError ? e.message : String(e);
    warnings.push({ code: 'unexpected-content', message: `Malformed TTML XML: ${message}` });
    return { cues: [], metadata: { sourceFormat: 'ttml' }, warnings };
  }

  if (local(tt.tag) !== 'tt') {
    warnings.push({
      code: 'unexpected-content',
      message: `Root element is <${tt.tag}>, not <tt>.`,
    });
    return { cues: [], metadata: { sourceFormat: 'ttml' }, warnings };
  }

  // Document parameters.
  const declaredRate = attrByLocal(tt, 'frameRate');
  const multiplier = attrByLocal(tt, 'frameRateMultiplier');
  const tickRateAttr = attrByLocal(tt, 'tickRate');
  let frameRate = declaredRate !== undefined ? Number(declaredRate) : 30;
  if (multiplier !== undefined) {
    const parts = multiplier.trim().split(/\s+/).map(Number);
    if (parts.length === 2 && parts[1] !== 0) frameRate = (frameRate * parts[0]!) / parts[1]!;
  }
  const tickRate =
    tickRateAttr !== undefined
      ? Number(tickRateAttr)
      : declaredRate !== undefined
        ? frameRate
        : TTML_DEFAULT_TICK_RATE;
  const dropModeAttr = attrByLocal(tt, 'dropMode');
  const dropFrame = dropModeAttr === 'dropNTSC';
  // TTML defaults timeBase to 'media'. The nominal integer rate (the SMPTE FF
  // field's counting base) is the effective rate rounded — 23.976→24, 29.97→30.
  const timeBase = attrByLocal(tt, 'timeBase') ?? 'media';
  const nominalFrameRate = Math.round(frameRate);
  const ctx: TimingContext = { frameRate, nominalFrameRate, tickRate, dropFrame, timeBase };
  const language = attrByLocal(tt, 'lang');

  const head = child(tt, 'head');
  const body = child(tt, 'body');

  const cues: Cue[] = [];
  if (body) {
    const bodyPreserve = xmlSpacePreserve(body, xmlSpacePreserve(tt, false));
    for (const { p, preserve } of paragraphs(body, bodyPreserve)) {
      const begin = attrByLocal(p, 'begin');
      const end = attrByLocal(p, 'end');
      const dur = attrByLocal(p, 'dur');

      const startMs = begin !== undefined ? parseTime(begin, ctx) : null;
      let endMs: number | null = end !== undefined ? parseTime(end, ctx) : null;
      if (endMs === null && startMs !== null && dur !== undefined) {
        const d = parseTime(dur, ctx);
        if (d !== null) endMs = startMs + d;
      }

      if (startMs === null || endMs === null) {
        warnings.push({
          code: 'malformed-timing',
          message: `<p> missing or invalid begin/end timing.`,
          cueIndex: cues.length + 1,
        });
        continue;
      }

      const index = cues.length + 1;
      const lines = parseLines(p, preserve);
      const style = attrByLocal(p, 'style');
      const region = attrByLocal(p, 'region');
      const id = attrByLocal(p, 'id');
      const position = parsePosition(p);

      const cue: Cue = { index, startMs, endMs, lines };
      if (style !== undefined) cue.styleRefs = style.trim().split(/\s+/);
      if (id !== undefined) cue.id = id;
      if (position) cue.position = position;
      if (region !== undefined) cue.raw = { region };

      if (lines.every((l) => l.spans.every((s) => s.text === ''))) {
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

  const raw: Record<string, unknown> = { ttAttrs: { ...tt.attrs } };
  if (head) raw.head = head;
  // Record the explicit drop-frame mode as a hint (cue-forge-pm8), the same way
  // the SCC parser stores metadata.raw.dropFrame, so QC labels honour a declared
  // nonDrop instead of defaulting canonical-29.97 material to drop-frame. Only
  // set it when the source actually declares ttp:dropMode — an absent attr stays
  // "unknown" and keeps the historical labeling convention.
  if (dropModeAttr !== undefined) raw.dropFrame = dropFrame;
  const metadata: SubtitleDocument['metadata'] = { sourceFormat: 'ttml', raw };
  // Store the canonical fps label (cue-forge-zxw.11) so drop-frame detection and
  // the Studio picker recognise it; ctx.frameRate above keeps the exact rate for
  // frame→ms timing, so this relabel introduces no drift.
  if (declaredRate !== undefined || multiplier !== undefined)
    metadata.frameRate = canonicalFps(frameRate);
  if (language !== undefined) metadata.language = language;

  return { cues, metadata, warnings };
}

const NL = '\n';

/** Default `<tt>` attributes when serializing a document with no preserved raw. */
const DEFAULT_TT_ATTRS: Record<string, string> = {
  xmlns: 'http://www.w3.org/ns/ttml',
  'xmlns:ttp': 'http://www.w3.org/ns/ttml#parameter',
  'xmlns:tts': 'http://www.w3.org/ns/ttml#styling',
};

const VERTICAL_TO_WRITING_MODE: Record<WritingDirection, string | undefined> = {
  horizontal: undefined,
  'vertical-rl': 'tbrl',
  'vertical-lr': 'tblr',
};

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/** Format integer milliseconds as a TTML clock time `HH:MM:SS.mmm`. */
function formatClock(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const millis = ms % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(millis, 3)}`;
}

/** Serialize one styled span: a wrapping `<span>` when it carries styling, else raw text. */
function serializeSpan(span: StyledSpan): string {
  if (span.opaque !== undefined) {
    // TTML cannot express arbitrary opaque markup; keep only the visible text.
    return escapeText(span.text);
  }
  const attrs: string[] = [];
  if (span.italic) attrs.push('tts:fontStyle="italic"');
  if (span.bold) attrs.push('tts:fontWeight="bold"');
  if (span.underline) attrs.push('tts:textDecoration="underline"');
  if (span.color !== undefined) attrs.push(`tts:color="${escapeAttr(span.color)}"`);
  const text = escapeText(span.text);
  if (attrs.length === 0) return text;
  return `<span ${attrs.join(' ')}>${text}</span>`;
}

/** Serialize a cue's visual lines as inline content with `<br/>` separators. */
function serializeContent(lines: CueLine[]): string {
  return lines.map((line) => line.spans.map(serializeSpan).join('')).join('<br/>');
}

/** Serialize a SubtitleDocument to TTML/IMSC1 text (spec §3 TTML). */
export function serializeTtml(doc: SubtitleDocument): string {
  return serializeTtmlProfile(doc, { defaultTtAttrs: DEFAULT_TT_ATTRS });
}

/** Options for {@link serializeTtmlProfile}. */
export interface TtmlProfileOptions {
  /** `<tt>` attributes used when the document carries none of its own. */
  defaultTtAttrs: Record<string, string>;
  /**
   * Attributes forced onto `<tt>` regardless of any preserved raw attrs — the
   * hook a constrained profile uses to own the parameters it must control (e.g.
   * Apple iTT's SMPTE `ttp:timeBase`/`frameRate`, cue-forge-sdv.13). Later keys
   * win, keeping the position of an overridden key from the base set.
   */
  overrideTtAttrs?: Record<string, string>;
  /** Format integer ms as a time expression (default: media clock `HH:MM:SS.mmm`). */
  formatTime?: (ms: number) => string;
  /**
   * A pre-serialized `<head>…</head>` block (already indented to nest under
   * `<tt>`), emitted verbatim in place of any preserved `raw.head` passthrough
   * (and in place of no `<head>` at all). The IMSC profile uses this to
   * synthesize styling/layout the generic TTML serializer never creates
   * (cue-forge-sdv.7) — source region/style refs would otherwise dangle once
   * the source `<head>` is dropped.
   */
  head?: string;
  /**
   * When set, every `<p>` gets this `style` attribute, overriding any
   * `cue.styleRefs` (IMSC forces the single synthesized style).
   */
  forceStyle?: string;
  /**
   * When set, every `<p>` gets this `region` attribute, overriding any
   * `cue.raw.region` (IMSC forces the single synthesized region).
   */
  forceRegion?: string;
  /**
   * Override how a cue's visual lines render to `<p>` inner content. The default
   * emits inline `tts:*` styling on `<span>`s; EBU-TT-D (Tech 3380, cue-forge-
   * ebuttd) forbids inline `tts:` on content elements and requires *referential*
   * styling, so it supplies its own renderer that emits `<span style="sN">`
   * referencing head `<style>`s instead. Additive/optional: profiles that don't
   * set it keep the inline-styling default, so existing profiles are unaffected.
   */
  serializeContent?: (lines: CueLine[]) => string;
}

/**
 * The `ttp:`/profile-designator parameters a profile override fully owns. When
 * a caller forces its own parameter set (`overrideTtAttrs`), any of these
 * carried by the source `<tt>` must be cleared first — otherwise a stale key
 * (e.g. a source's `ttp:frameRateMultiplier`/`ttp:dropMode`, or an inherited
 * `ttp:profile`/`ttp:contentProfiles` from a different profile) leaks into the
 * export and emits contradictory parameters (cue-forge-zxw.1, sdv.7).
 */
const PROFILE_TIMING_KEYS = [
  'ttp:timeBase',
  'ttp:frameRate',
  'ttp:frameRateMultiplier',
  'ttp:dropMode',
  'ttp:profile',
  'ttp:contentProfiles',
] as const;

/**
 * TTML serializer parameterised for constrained profiles like Apple iTT: the
 * caller supplies the default `<tt>` attribute set, any attributes it must force
 * (e.g. iTT's SMPTE timing parameters), and the time formatter for begin/end.
 */
export function serializeTtmlProfile(doc: SubtitleDocument, options: TtmlProfileOptions): string {
  const raw = (doc.metadata.raw ?? {}) as { ttAttrs?: Record<string, string>; head?: XmlElement };
  // A profile that forces its own timing parameters owns the whole ttp: timing
  // set: strip any the source carried so only the override's survive. Plain TTML
  // passes no override and keeps its raw timing attrs untouched (cue-forge-zxw.1).
  const base = { ...options.defaultTtAttrs, ...raw.ttAttrs };
  if (options.overrideTtAttrs) {
    for (const key of PROFILE_TIMING_KEYS) delete base[key];
  }
  const ttAttrs = { ...base, ...options.overrideTtAttrs };
  const formatTime = options.formatTime ?? formatClock;
  const ttAttrStr = Object.keys(ttAttrs)
    .map((k) => `${k}="${escapeAttr(ttAttrs[k]!)}"`)
    .join(' ');

  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  out.push(`<tt ${ttAttrStr}>`);
  if (options.head !== undefined) out.push(options.head);
  else if (raw.head) out.push('  ' + serializeXml(raw.head));
  out.push('  <body>');
  out.push('    <div>');

  for (const cue of doc.cues) {
    const attrs: string[] = [
      `begin="${formatTime(cue.startMs)}"`,
      `end="${formatTime(cue.endMs)}"`,
    ];
    const styleRefs = options.forceStyle !== undefined ? [options.forceStyle] : cue.styleRefs;
    if (styleRefs && styleRefs.length > 0) {
      attrs.push(`style="${escapeAttr(styleRefs.join(' '))}"`);
    }
    const region = options.forceRegion ?? (cue.raw as { region?: string } | undefined)?.region;
    if (region !== undefined) attrs.push(`region="${escapeAttr(region)}"`);
    if (cue.id !== undefined) attrs.push(`xml:id="${escapeAttr(cue.id)}"`);
    const vertical = cue.position?.vertical;
    const wm = vertical ? VERTICAL_TO_WRITING_MODE[vertical] : undefined;
    if (wm !== undefined) attrs.push(`tts:writingMode="${wm}"`);
    // Text alignment is a single standard attribute, losslessly round-tripped
    // (cue-forge-z6t). Every CueAlign value is a valid tts:textAlign keyword.
    if (cue.position?.align !== undefined) {
      attrs.push(`tts:textAlign="${cue.position.align}"`);
    }
    const renderContent = options.serializeContent ?? serializeContent;
    out.push(`      <p ${attrs.join(' ')}>${renderContent(cue.lines)}</p>`);
  }

  out.push('    </div>');
  out.push('  </body>');
  out.push('</tt>');
  return out.join(NL) + NL;
}
