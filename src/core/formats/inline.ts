import type { CueLine, StyledSpan } from '../model/types';

/**
 * Inline markup shared by text formats (spec §3 SRT/VTT): `<i>`, `<b>`, `<u>`,
 * `<font color="…">`, and WebVTT voice tags `<v Name>`. Parses a text run into
 * {@link StyledSpan}s and back. A `<` that does not begin a recognized tag
 * (e.g. a literal "3 < 4") is preserved as literal text, so it round-trips
 * even though it is not modelled structurally. In VTT mode, unrecognized VTT
 * constructs (`<c>`, `<ruby>`, `<rt>`, `<lang>`, karaoke timestamps) become
 * opaque markup instead, and the six VTT character references are decoded on
 * parse / re-encoded on serialize.
 */

export interface InlineWarning {
  code: 'unclosed-tag' | 'stray-close-tag';
  tag: string;
}

/**
 * Sentinel for an interior empty visual line in blank-line-delimited formats
 * (SRT/VTT/SBV). A truly empty line would be read back as a cue separator and
 * split the cue (cue-forge-3jz.10), so an empty interior {@link CueLine} is
 * serialized as a lone zero-width space — which `String.prototype.trim()` does
 * not strip, so the parser does not mistake it for a blank separator — and
 * decoded back to an empty line on parse.
 */
export const BLANK_LINE = '\u200B';

export interface InlineParseOptions {
  /**
   * WebVTT mode: decode the six VTT character references (&amp; &lt; &gt;
   * &lrm; &rlm; &nbsp;) in text runs, and preserve unrecognized VTT constructs
   * (`<c>`, `<ruby>`, `<rt>`, `<lang>`, karaoke timestamps) as opaque markup
   * attached to the following text span instead of literal text.
   */
  vtt?: boolean;
}

export interface InlineSerializeOptions {
  /**
   * WebVTT mode: escape `&`/`<` (and re-encode U+200E/U+200F as &lrm;/&rlm;)
   * in text, emit opaque markup verbatim, and serialize color spans as
   * `<c.classname>` (valid WebVTT) rather than `<font color>`.
   */
  vtt?: boolean;
}

/** Serialize cue lines, encoding empty lines so they survive a round-trip. */
export function serializeCueLines(lines: CueLine[], opts: InlineSerializeOptions = {}): string[] {
  return lines.map((l) => {
    const text = serializeInline(l.spans, opts);
    return text === '' ? BLANK_LINE : text;
  });
}

const TAG_RE = /<(\/?)(i|b|u|font|v)\b([^>]*)>/gi;
// VTT mode adds: opaque constructs (class/ruby/rt/lang tags, karaoke timestamps)
// and the six character references. Group layout matches TAG_RE (1–3), entity
// name is group 4. `ruby` must precede `rt` in the alternation.
const VTT_TOKEN_RE =
  /<(\/?)(i|b|u|font|v)\b([^>]*)>|<\/?(?:ruby|rt|c|lang)(?:[.\t ][^>]*)?>|<(?:\d+:)?\d{2}:\d{2}\.\d{3}>|&(amp|lt|gt|lrm|rlm|nbsp);/gi;
const COLOR_RE = /color\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;

const VTT_ENTITY: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  lrm: '\u200E',
  rlm: '\u200F',
  nbsp: '\u00A0',
};

function escapeVttText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\u200E/g, '&lrm;')
    .replace(/\u200F/g, '&rlm;');
}

/** A WebVTT cue-text class name for a color token: `red` → `red`, `#FF0000` → `color-FF0000`. */
function vttColorClass(color: string): string {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (hex) return `color-${hex[1]}`;
  const cls = color.replace(/[^\w-]/g, '');
  return cls === '' ? 'color' : cls;
}

interface InlineState {
  italic: number;
  bold: number;
  underline: number;
  colorStack: (string | undefined)[];
  voiceStack: string[];
}

function styleOf(s: InlineState): Omit<StyledSpan, 'text'> {
  const style: Omit<StyledSpan, 'text'> = {};
  if (s.italic > 0) style.italic = true;
  if (s.bold > 0) style.bold = true;
  if (s.underline > 0) style.underline = true;
  for (let i = s.colorStack.length - 1; i >= 0; i--) {
    const c = s.colorStack[i];
    if (c !== undefined) {
      style.color = c;
      break;
    }
  }
  if (s.voiceStack.length > 0) style.voice = s.voiceStack[s.voiceStack.length - 1];
  return style;
}

/** The text right after `<v` (a leading separator space is the common form). */
function voiceName(attrs: string): string {
  return attrs.startsWith(' ') ? attrs.slice(1) : attrs;
}

/** Parse inline-styled text (no line splitting) into spans. */
export function parseInline(
  text: string,
  opts: InlineParseOptions = {},
): { spans: StyledSpan[]; warnings: InlineWarning[] } {
  const spans: StyledSpan[] = [];
  const warnings: InlineWarning[] = [];
  const s: InlineState = { italic: 0, bold: 0, underline: 0, colorStack: [], voiceStack: [] };
  const re = opts.vtt === true ? VTT_TOKEN_RE : TAG_RE;

  // Text accumulates in `buf`; opaque VTT markup accumulates in `pendingOpaque`
  // and attaches to the *following* text span (mirrors the ASS opaque pattern).
  let buf = '';
  let pendingOpaque = '';
  const flush = () => {
    if (buf === '') return;
    const span: StyledSpan = { text: buf, ...styleOf(s) };
    if (pendingOpaque !== '') span.opaque = pendingOpaque;
    spans.push(span);
    buf = '';
    pendingOpaque = '';
  };
  const close = (tag: string, ok: boolean) => {
    if (!ok) warnings.push({ code: 'stray-close-tag', tag });
  };

  re.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    buf += text.slice(last, m.index);
    last = re.lastIndex;
    if (m[2] === undefined) {
      // VTT-only branches: a character reference or an opaque construct.
      if (m[4] !== undefined) buf += VTT_ENTITY[m[4].toLowerCase()]!;
      else {
        flush();
        pendingOpaque += m[0];
      }
      continue;
    }
    flush();
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    switch (tag) {
      case 'i':
        if (closing) close(tag, s.italic-- > 0);
        else s.italic++;
        break;
      case 'b':
        if (closing) close(tag, s.bold-- > 0);
        else s.bold++;
        break;
      case 'u':
        if (closing) close(tag, s.underline-- > 0);
        else s.underline++;
        break;
      case 'font':
        if (closing) {
          if (s.colorStack.length > 0) s.colorStack.pop();
          else close(tag, false);
        } else {
          const cm = COLOR_RE.exec(attrs);
          s.colorStack.push(cm ? (cm[2] ?? cm[3] ?? cm[4]) : undefined);
        }
        break;
      default: // 'v'
        if (closing) {
          if (s.voiceStack.length > 0) s.voiceStack.pop();
          else close(tag, false);
        } else {
          s.voiceStack.push(voiceName(attrs));
        }
    }
    // Guard the post-decrement underflow for i/b/u.
    if (s.italic < 0) s.italic = 0;
    if (s.bold < 0) s.bold = 0;
    if (s.underline < 0) s.underline = 0;
  }
  buf += text.slice(last);
  if (buf === '' && pendingOpaque !== '') {
    // Trailing opaque markup with no following text (e.g. a closing `</c>`).
    spans.push({ text: '', ...styleOf(s), opaque: pendingOpaque });
  } else {
    flush();
  }

  for (let i = 0; i < s.italic; i++) warnings.push({ code: 'unclosed-tag', tag: 'i' });
  for (let i = 0; i < s.bold; i++) warnings.push({ code: 'unclosed-tag', tag: 'b' });
  for (let i = 0; i < s.underline; i++) warnings.push({ code: 'unclosed-tag', tag: 'u' });
  for (let i = 0; i < s.colorStack.length; i++)
    warnings.push({ code: 'unclosed-tag', tag: 'font' });
  // An unclosed <v> is valid WebVTT (voice runs to end of cue) — no warning.

  return { spans, warnings };
}

/** Serialize spans back to inline-styled text. */
export function serializeInline(spans: StyledSpan[], opts: InlineSerializeOptions = {}): string {
  const vtt = opts.vtt === true;
  let out = '';
  for (const span of spans) {
    // VTT opaque markup (preserved constructs) is re-emitted verbatim; other
    // serializers do not understand it and ignore it (conversion strips it).
    if (vtt && span.opaque !== undefined) out += span.opaque;
    const openers: string[] = [];
    const closers: string[] = [];
    if (span.voice !== undefined) {
      const name = span.voice;
      const sep = name === '' || name.startsWith('.') ? '' : ' ';
      openers.push(`<v${sep}${name}>`);
      closers.unshift('</v>');
    }
    if (span.color !== undefined) {
      // <font color> is not valid WebVTT — VTT uses a class span instead. No
      // STYLE block is synthesized; the class names a renderer default/style.
      openers.push(vtt ? `<c.${vttColorClass(span.color)}>` : `<font color="${span.color}">`);
      closers.unshift(vtt ? '</c>' : '</font>');
    }
    if (span.bold) {
      openers.push('<b>');
      closers.unshift('</b>');
    }
    if (span.italic) {
      openers.push('<i>');
      closers.unshift('</i>');
    }
    if (span.underline) {
      openers.push('<u>');
      closers.unshift('</u>');
    }
    out += openers.join('') + (vtt ? escapeVttText(span.text) : span.text) + closers.join('');
  }
  return out;
}

function splitSpansIntoLines(spans: StyledSpan[]): CueLine[] {
  const lines: CueLine[] = [{ spans: [] }];
  for (const span of spans) {
    const parts = span.text.split('\n');
    parts.forEach((part, k) => {
      if (k > 0) lines.push({ spans: [] });
      // Opaque markup precedes the span's text, so it belongs to the first part.
      const opaque = k === 0 ? span.opaque : undefined;
      if (part === '' && opaque === undefined) return;
      const out: StyledSpan = { ...span, text: part };
      if (opaque === undefined) delete out.opaque;
      lines[lines.length - 1]!.spans.push(out);
    });
  }
  return lines;
}

/** True when a visual line is just the interior-blank sentinel. */
export function isBlankLineSentinel(line: CueLine): boolean {
  return line.spans.length === 1 && line.spans[0]!.text === BLANK_LINE;
}

/** Parse a multi-line cue text block into styled lines (spans carry across `\n`). */
export function parseStyledLines(
  block: string,
  opts: InlineParseOptions = {},
): { lines: CueLine[]; warnings: InlineWarning[] } {
  const { spans, warnings } = parseInline(block, opts);
  const lines = splitSpansIntoLines(spans).map((l) => (isBlankLineSentinel(l) ? { spans: [] } : l));
  return { lines, warnings };
}

/** Serialize styled lines to a cue text block, joining visual lines with `\n`. */
export function serializeStyledLines(lines: CueLine[], opts: InlineSerializeOptions = {}): string {
  return lines.map((l) => serializeInline(l.spans, opts)).join('\n');
}
