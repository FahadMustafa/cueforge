import type { Cue, CueLine, ParseWarning, StyledSpan, SubtitleDocument } from '../model/types';
import { TEXT_FORMATS, type TextFormatId } from './registry';
import type { ProFormatId } from './pro';
import { positionFromAlignment, srtAlignment, type SrtCueRaw } from './srt/srt';

/**
 * Cross-format conversion (spec §4.1 #1, §6.3 #2). Conversion is always
 * parse → normalize-for-target → serialize; never a format-to-format shortcut
 * (spec §2). Normalization interprets ASS override blocks into inline styles for
 * non-ASS targets and reports every capability the target cannot express, so the
 * caller can surface a warning for each dropped feature.
 */

export type Capability =
  | 'italic'
  | 'bold'
  | 'underline'
  | 'color'
  | 'voice'
  | 'position'
  | 'override';

/** Styling/positioning each target format can express (spec §3). */
export const CAN: Record<TextFormatId, Set<Capability>> = {
  // SRT speaks <i>/<b>/<u>/<font color>; <v> is WebVTT-only, so voice spans are
  // dropped (text kept) with a warning when converting to SRT.
  srt: new Set<Capability>(['italic', 'bold', 'underline', 'color']),
  // VTT color is expressed as a <c.classname> span (no STYLE block synthesized).
  vtt: new Set<Capability>(['italic', 'bold', 'underline', 'color', 'voice', 'position']),
  // SBV is plain text only.
  sbv: new Set<Capability>([]),
  // ASS expresses i/b/u via override tags, keeps native overrides, and (H1)
  // synthesizes \c colour from span.color and \pos/\an from cue.position.
  ass: new Set<Capability>(['italic', 'bold', 'underline', 'color', 'position', 'override']),
};

/**
 * Capabilities of the Pro targets (spec §4.2), mirroring what each serializer
 * actually expresses. Pure data — the codecs themselves stay lazy-loaded.
 */
export const PRO_CAN: Record<ProFormatId, Set<Capability>> = {
  // tts:fontStyle/fontWeight/textDecoration/color + text alignment (tts:textAlign)
  // and writing direction. Absolute x/y placement is not emitted — cues carrying
  // line/position/size get an explicit drop warning (cue-forge-z6t).
  ttml: new Set<Capability>(['italic', 'bold', 'underline', 'color', 'position']),
  // CEA-608 mid-row codes: italics, underline, and the 7 caption colours.
  scc: new Set<Capability>(['italic', 'underline', 'color']),
  // EBU-STL text-field control codes: italics and underline only.
  stl: new Set<Capability>(['italic', 'underline']),
  // Apple iTT (constrained TTML): the TTML styling subset + text alignment;
  // x/y placement warns like TTML (cue-forge-z6t).
  itt: new Set<Capability>(['italic', 'bold', 'underline', 'color', 'position']),
  // IMSC 1.0.1 / 1.1 (validated TTML profiles): same styling subset as plain
  // TTML (cue-forge-sdv.7); x/y placement warns like TTML/iTT (cue-forge-z6t).
  imsc101: new Set<Capability>(['italic', 'bold', 'underline', 'color', 'position']),
  imsc11: new Set<Capability>(['italic', 'bold', 'underline', 'color', 'position']),
  // MCC (CEA-708 container over CEA-608 mid-row codes): italics, underline, and
  // the 7 caption colours — the same expressible subset as SCC.
  mcc: new Set<Capability>(['italic', 'underline', 'color']),
  // EBU-TT-D (a TTML distribution profile): the same TTML styling subset;
  // x/y placement warns like TTML/IMSC (cue-forge-z6t).
  ebuttd: new Set<Capability>(['italic', 'bold', 'underline', 'color', 'position']),
};

/** Any format conversion/export can target: the core four plus the Pro three. */
export type ConversionTargetId = TextFormatId | ProFormatId;

/** Capability set for any conversion target (core or Pro). */
function targetCapabilities(to: ConversionTargetId): Set<Capability> {
  return to in CAN ? CAN[to as TextFormatId] : PRO_CAN[to as ProFormatId];
}

/** Stable capability ordering for deterministic report output. */
const CAPABILITY_ORDER: Capability[] = [
  'italic',
  'bold',
  'underline',
  'color',
  'voice',
  'position',
  'override',
];

/** Every conversion target: the four core text formats followed by the Pro three. */
export const ALL_TARGETS: ConversionTargetId[] = [
  ...(Object.keys(CAN) as TextFormatId[]),
  ...(Object.keys(PRO_CAN) as ProFormatId[]),
];

/** One target's verdict in a {@link capabilityReport}. */
export interface CapabilityReportEntry {
  target: ConversionTargetId;
  /** Capabilities the document uses that this target can express. */
  preserved: Capability[];
  /** Capabilities the document uses that this target would drop. */
  dropped: Capability[];
}

/**
 * Proactive loss matrix (H1): for each target, partition the capabilities the
 * document actually uses ({@link interpretedCapabilities}) into preserved vs
 * dropped, so the converter can show — before conversion — exactly what a target
 * keeps and loses. Pure and framework-free; reuses the existing capability data.
 */
export function capabilityReport(
  doc: SubtitleDocument,
  targets: ConversionTargetId[] = ALL_TARGETS,
): CapabilityReportEntry[] {
  const used = interpretedCapabilities(doc);
  const usedOrdered = CAPABILITY_ORDER.filter((c) => used.has(c));
  return targets.map((target) => {
    const can = targetCapabilities(target);
    return {
      target,
      preserved: usedOrdered.filter((c) => can.has(c)),
      dropped: usedOrdered.filter((c) => !can.has(c)),
    };
  });
}

export interface ConversionResult {
  text: string;
  /** Source parse warnings followed by capability-drop warnings from conversion. */
  warnings: ParseWarning[];
}

/** Apply one ASS override block's tags to running i/b/u state; collect the rest. */
function applyOverrideBlock(
  block: string,
  state: { italic: boolean; bold: boolean; underline: boolean },
  dropped: string[],
): void {
  const inner = block.replace(/^\{|\}$/g, '');
  for (const tag of inner.split('\\')) {
    if (tag === '') continue;
    if (/^i[01]$/.test(tag)) state.italic = tag === 'i1';
    else if (/^b\d+$/.test(tag)) state.bold = Number(tag.slice(1)) !== 0;
    else if (/^u[01]$/.test(tag)) state.underline = tag === 'u1';
    else dropped.push('\\' + tag);
  }
}

/** All override blocks `{...}` contained in an opaque string. */
function overrideBlocks(opaque: string): string[] {
  return opaque.match(/\{[^}]*\}/g) ?? [];
}

/**
 * Interpret ASS override blocks (spec §3): `{\i1}…{\i0}` → italic flags etc.,
 * dropping every other tag, and the ASS text escapes — `\h` → no-break space,
 * `\n` → line break (treated as a break regardless of WrapStyle; the soft/hard
 * distinction has no equivalent in the other formats). Returns the rewritten
 * lines plus the dropped tags.
 */
export function interpretAssOverrides(lines: CueLine[]): { lines: CueLine[]; dropped: string[] } {
  const dropped: string[] = [];
  const outLines: CueLine[] = [];
  for (const line of lines) {
    const state = { italic: false, bold: false, underline: false };
    let spans: StyledSpan[] = [];
    for (const span of line.spans) {
      if (span.opaque !== undefined) {
        for (const block of overrideBlocks(span.opaque)) applyOverrideBlock(block, state, dropped);
      }
      if (span.text === '') continue;
      const parts = span.text.replace(/\\h/g, '\u00A0').split('\\n');
      parts.forEach((part, k) => {
        if (k > 0) {
          outLines.push({ spans });
          spans = [];
        }
        if (part === '') return;
        const out: StyledSpan = { text: part };
        if (state.italic) out.italic = true;
        if (state.bold) out.bold = true;
        if (state.underline) out.underline = true;
        if (span.color !== undefined) out.color = span.color;
        if (span.voice !== undefined) out.voice = span.voice;
        spans.push(out);
      });
    }
    outLines.push({ spans });
  }
  return { lines: outLines, dropped };
}

/** The styling/positioning capabilities a document's content actually uses. */
export function interpretedCapabilities(doc: SubtitleDocument): Set<Capability> {
  const caps = new Set<Capability>();
  for (const cue of doc.cues) {
    if (cue.position) caps.add('position');
    for (const line of cue.lines) {
      for (const span of line.spans) {
        if (span.italic) caps.add('italic');
        if (span.bold) caps.add('bold');
        if (span.underline) caps.add('underline');
        if (span.color !== undefined) caps.add('color');
        if (span.voice !== undefined) caps.add('voice');
        if (span.opaque !== undefined) {
          const state = { italic: false, bold: false, underline: false };
          const dropped: string[] = [];
          for (const block of overrideBlocks(span.opaque))
            applyOverrideBlock(block, state, dropped);
          if (state.italic) caps.add('italic');
          if (state.bold) caps.add('bold');
          if (state.underline) caps.add('underline');
          if (dropped.length > 0) caps.add('override');
        }
      }
    }
  }
  return caps;
}

/** The ASS event kind (`Dialogue`, `Comment`, …) carried in `cue.raw`, if any. */
function eventKind(cue: Cue): string | undefined {
  if (cue.raw !== null && typeof cue.raw === 'object' && 'kind' in cue.raw) {
    const kind = (cue.raw as { kind?: unknown }).kind;
    if (typeof kind === 'string') return kind;
  }
  return undefined;
}

/** WebVTT opaque markup (`<c>`, `<ruby>`, …) vs an ASS override block (`{...}`). */
function isVttOpaque(opaque: string): boolean {
  return opaque.startsWith('<');
}

/** Strip preserved WebVTT markup, keeping inner text (timestamp tags vanish). */
function stripVttMarkup(cues: Cue[]): { cues: Cue[]; dropped: string[] } {
  const dropped: string[] = [];
  const out = cues.map((cue) => {
    let changed = false;
    const lines = cue.lines.map((line) => {
      const spans: StyledSpan[] = [];
      for (const span of line.spans) {
        if (span.opaque === undefined || !isVttOpaque(span.opaque)) {
          spans.push(span);
          continue;
        }
        changed = true;
        dropped.push(span.opaque);
        const { opaque: _opaque, ...rest } = span;
        void _opaque;
        if (rest.text !== '') spans.push(rest);
      }
      return { spans };
    });
    return changed ? { ...cue, lines } : cue;
  });
  return { cues: out, dropped };
}

/** Re-shape a parsed document for a target format, reporting dropped capabilities. */
export function normalizeForTarget(
  doc: SubtitleDocument,
  to: ConversionTargetId,
): { doc: SubtitleDocument; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = [];
  const targetIsAss = to === 'ass';
  const docCaps = interpretedCapabilities(doc);

  let cues: Cue[] = doc.cues;

  // ASS Comment (and other non-Dialogue) events are not visible subtitles — no
  // other format has an equivalent, so they are dropped, not converted.
  if (!targetIsAss) {
    const kept = cues.filter((cue) => {
      const kind = eventKind(cue);
      return kind === undefined || kind === 'Dialogue';
    });
    if (kept.length !== cues.length) {
      warnings.push({
        code: 'capability-dropped',
        message: `${cues.length - kept.length} comment event(s) dropped (target "${to}" only has dialogue cues).`,
      });
      cues = kept;
    }
  }

  // Preserved WebVTT constructs (<c>, <ruby>, <rt>, <lang>, karaoke timestamps)
  // cannot be expressed elsewhere: strip the markup, keep the inner text.
  if (to !== 'vtt') {
    const r = stripVttMarkup(cues);
    if (r.dropped.length > 0) {
      cues = r.cues;
      warnings.push({
        code: 'capability-dropped',
        message: `Target "${to}" cannot express WebVTT markup (${[...new Set(r.dropped)].join(' ')}); it was dropped.`,
      });
    }
  }

  const can = targetCapabilities(to);

  // SRT `{\anN}` tags (kept on cue.raw by parseSrt) become structured placement
  // for targets that can express it, and are dropped with a position warning
  // otherwise. Either way the tag is consumed here, so the native-reference
  // check below does not misreport it (cue-forge-qcvu.3).
  if (doc.metadata.sourceFormat === 'srt' && to !== 'srt') {
    let tagged = 0;
    cues = cues.map((cue) => {
      const an = srtAlignment(cue);
      if (an === undefined) return cue;
      tagged++;
      const { an: _an, ...rest } = cue.raw as SrtCueRaw;
      void _an;
      const out: Cue = { ...cue, raw: Object.keys(rest).length > 0 ? rest : undefined };
      if (out.raw === undefined) delete out.raw;
      if (can.has('position') && !cue.position) out.position = positionFromAlignment(an);
      return out;
    });
    if (tagged > 0 && !can.has('position')) {
      warnings.push({
        code: 'capability-dropped',
        message: `Target "${to}" cannot express position ({\\an} placement on ${tagged} cue(s)); it was dropped.`,
      });
    }
  }

  const droppedTags: string[] = [];
  // Interpret ASS overrides into inline styles when leaving ASS for another
  // format. Always runs for ASS/SSA sources: the `\h`/`\n` text escapes need
  // mapping even when no override blocks are present. Gated on ASS opaque only:
  // preserved WebVTT markup also lives in span.opaque, and feeding it through
  // this pass would drop the markup and corrupt literal `\n`/`\h` text.
  const fromAss = doc.metadata.sourceFormat === 'ass' || doc.metadata.sourceFormat === 'ssa';
  if (!targetIsAss && (fromAss || cuesHaveAssOpaque(cues))) {
    cues = cues.map((cue) => {
      const r = interpretAssOverrides(cue.lines);
      droppedTags.push(...r.dropped);
      return { ...cue, lines: r.lines };
    });
  }

  // Strip span properties the target cannot express, so the serializer never
  // emits foreign tags (e.g. a WebVTT <v> in SRT output).
  const stripVoice = !can.has('voice');
  const stripColor = !can.has('color');
  if (stripVoice || stripColor) {
    cues = cues.map((cue) => ({
      ...cue,
      lines: cue.lines.map((line) => ({
        spans: line.spans.map((span) => {
          if (
            (!stripVoice || span.voice === undefined) &&
            (!stripColor || span.color === undefined)
          ) {
            return span;
          }
          const out = { ...span };
          if (stripVoice) delete out.voice;
          if (stripColor) delete out.color;
          return out;
        }),
      })),
    }));
  }

  // Report every capability the target cannot express (spec §6.3 #2). The
  // override drop lists the exact stripped tags (spec §3: "warning listing what
  // will be stripped").
  for (const cap of docCaps) {
    if (can.has(cap)) continue;
    const detail =
      cap === 'override' && droppedTags.length > 0
        ? ` (${[...new Set(droppedTags)].join(' ')})`
        : '';
    warnings.push({
      code: 'capability-dropped',
      message: `Target "${to}" cannot express ${cap}${detail}; it was dropped.`,
    });
  }

  // TTML/iTT express text alignment (tts:textAlign) and writing direction, but
  // not absolute x/y box geometry — so cues carrying line/position/size lose that
  // placement. Surface it explicitly rather than dropping it silently while the
  // 'position' capability still advertises alignment support (cue-forge-z6t).
  if (to === 'ttml' || to === 'itt' || to === 'imsc101' || to === 'imsc11' || to === 'ebuttd') {
    const n = cues.filter(
      (c) =>
        c.position &&
        (c.position.line !== undefined ||
          c.position.position !== undefined ||
          c.position.size !== undefined),
    ).length;
    if (n > 0) {
      warnings.push({
        code: 'capability-dropped',
        message: `Target "${to}" keeps text alignment but not exact x/y placement; ${n} cue(s) lose absolute positioning.`,
      });
    }
  }

  const source = doc.metadata.sourceFormat;
  const rebuildsHead = to === 'imsc101' || to === 'imsc11' || to === 'ebuttd';
  const preserveNative = (source === to || (source === 'ssa' && targetIsAss)) && !rebuildsHead;
  const metadata = { ...doc.metadata, sourceFormat: to };
  if (!preserveNative) {
    const raw = metadata.raw;
    const hasNativeDefinitions =
      raw?.head !== undefined ||
      (fromAss && raw?.header !== undefined) ||
      ['styles', 'regions', 'notes'].some(
        (field) => Array.isArray(raw?.[field]) && raw[field].length > 0,
      ) ||
      (source === 'vtt' && typeof raw?.header === 'string' && raw.header.trim() !== 'WEBVTT');
    const hasNativeReferences = cues.some(
      (cue) =>
        (cue.styleRefs?.length ?? 0) > 0 ||
        cue.raw !== undefined ||
        /(?:^|\s)region:/.test(cue.position?.raw ?? ''),
    );
    if (hasNativeDefinitions || hasNativeReferences) {
      warnings.push({
        code: 'capability-dropped',
        message: `Target "${to}" does not preserve native "${source}" headers, styling/layout or cue references; native definitions and references were dropped.`,
      });
    }
    delete metadata.raw;
    cues = cues.map((cue) => {
      const normalized = { ...cue };
      delete normalized.raw;
      delete normalized.styleRefs;
      if (cue.position?.raw !== undefined) {
        normalized.position = { ...cue.position };
        delete normalized.position.raw;
      }
      return normalized;
    });
  }
  return { doc: { cues, metadata, warnings: [] }, warnings };
}

/**
 * Any span carrying an ASS override block (`{...}`) — the counterpart of
 * {@link isVttOpaque}. Only ASS opaque markup may enter the ASS interpretation
 * pass; VTT opaque (`<c>`, `<ruby>`, …) is handled by {@link stripVttMarkup}.
 */
function cuesHaveAssOpaque(cues: Cue[]): boolean {
  return cues.some((c) =>
    c.lines.some((l) => l.spans.some((s) => s.opaque !== undefined && s.opaque.startsWith('{'))),
  );
}

/** Convert subtitle text from one registered format to another (spec §4.1 #1). */
export function convert(source: string, from: TextFormatId, to: TextFormatId): ConversionResult {
  const parsed = TEXT_FORMATS[from].parse(source);
  const { doc, warnings } = normalizeForTarget(parsed, to);
  const text = TEXT_FORMATS[to].serialize(doc);
  return { text, warnings: [...parsed.warnings, ...warnings] };
}
