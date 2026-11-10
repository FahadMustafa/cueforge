import type { Cue, CueLine, StyledSpan } from './types';

/** Construct a styled span. Falsy/absent style fields are omitted. */
export function makeSpan(text: string, style?: Partial<Omit<StyledSpan, 'text'>>): StyledSpan {
  return { text, ...style };
}

/** Construct a single-line cue line from plain text (one unstyled span). */
export function textLine(text: string): CueLine {
  return { spans: [{ text }] };
}

/** Flatten one line's spans to plain text. */
export function lineToText(line: CueLine): string {
  return line.spans.map((s) => s.text).join('');
}

/** Flatten a cue to plain text, joining visual lines with '\n'. */
export function cueToText(cue: Cue): string {
  return cue.lines.map(lineToText).join('\n');
}

/** Cue duration in milliseconds (may be negative for reversed-timing cues). */
export function cueDurationMs(cue: Cue): number {
  return cue.endMs - cue.startMs;
}
