/**
 * Rules 1–2 (spec §5.2): `max-chars-per-line` and `max-lines-per-cue`. Line
 * length is counted in Unicode code points; rule 1 is auto-fixable (re-wrap at
 * word boundaries, never breaking a word), rule 2 is flag-only.
 */

import { lineToText } from '../../model/cue';
import type { Cue, CueLine, StyledSpan } from '../../model/types';
import type { RuleDefinition } from '../rule';
import type { RuleViolation } from '../rule';
import { countCodePoints } from './util';

type WordStyle = Omit<StyledSpan, 'text'>;
interface Word {
  text: string;
  style: WordStyle;
}

function sameStyle(a: WordStyle, b: WordStyle): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Split a line into words, each carrying the style of the span it came from. */
function lineToWords(line: CueLine): Word[] {
  const words: Word[] = [];
  for (const span of line.spans) {
    const { text, ...style } = span;
    for (const part of text.split(' ')) {
      if (part !== '') words.push({ text: part, style });
    }
  }
  return words;
}

function styleOf(span: StyledSpan): WordStyle {
  const style = { ...span } as Partial<StyledSpan>;
  delete style.text;
  return style;
}

/** Re-join words into spans, putting the separating space on the preceding span. */
function wordsToSpans(words: Word[]): StyledSpan[] {
  const spans: StyledSpan[] = [];
  words.forEach((w, i) => {
    const last = spans[spans.length - 1];
    if (i > 0 && last) {
      if (sameStyle(styleOf(last), w.style)) {
        last.text += ' ' + w.text;
        return;
      }
      last.text += ' ';
    }
    spans.push({ text: w.text, ...w.style });
  });
  return spans;
}

/**
 * Greedy word-wrap a line so each result line is at most `max` code points,
 * breaking only at word boundaries. A single word longer than `max` gets its own
 * line (words are never split, spec §5.2 rule 1).
 */
function wrapLine(line: CueLine, max: number): CueLine[] {
  const words = lineToWords(line);
  if (words.length === 0) return [line];

  const rows: Word[][] = [[]];
  let len = 0;
  for (const w of words) {
    const wl = countCodePoints(w.text);
    const row = rows[rows.length - 1]!;
    if (row.length === 0) {
      row.push(w);
      len = wl;
    } else if (len + 1 + wl <= max) {
      row.push(w);
      len += 1 + wl;
    } else {
      rows.push([w]);
      len = wl;
    }
  }
  return rows.map((row) => ({ spans: wordsToSpans(row) }));
}

/** Re-wrap every over-long line of one cue (shared by the whole-doc and cue fix). */
function rewrapCue(cue: Cue, max: number): Cue {
  const lines = cue.lines.flatMap((line) =>
    countCodePoints(lineToText(line)) > max ? wrapLine(line, max) : [line],
  );
  return { ...cue, lines };
}

export const maxCharsPerLine: RuleDefinition<'max-chars-per-line'> = {
  id: 'max-chars-per-line',
  fixable: true,
  evaluate(doc, config) {
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      cue.lines.forEach((line, i) => {
        const len = countCodePoints(lineToText(line));
        if (len > config.max) {
          out.push({
            cueIndex: cue.index,
            message: `Line ${i + 1} is ${len} characters (max ${config.max}).`,
          });
        }
      });
    }
    return out;
  },
  // Re-wrap each over-long line at word boundaries (never breaking a word).
  fix(doc, config) {
    return { ...doc, cues: doc.cues.map((cue) => rewrapCue(cue, config.max)) };
  },
  // Cue-scoped variant (cue-forge-zxw.12): re-wrap just one cue so fix-one can
  // land the clicked cue even when the whole-doc fix would be reverted elsewhere.
  fixCue(cue, config) {
    return rewrapCue(cue, config.max);
  },
  // The re-wrap helps only when it does not trade a line-length violation for a
  // line-count one (cue-forge-8b4). fix-one now re-wraps ONLY the clicked cue
  // (cue-forge-zxw.12), so the verdict is PER-CUE: wrapping a cue is reverted by
  // the zero-new-issues guard exactly when that cue transitions from within
  // max-lines to over it. A cue already over max-lines is a pre-existing issue —
  // wrapping it does not raise the count, so it stays fixable. With no enforced
  // line cap, the fix always helps. (Was a whole-document verdict under zxw.2,
  // when the fixer could only run doc-wide and one bad cue reverted them all.)
  fixableInContext(doc, ruleset) {
    const max = ruleset.rules['max-chars-per-line']?.max;
    const lineCfg = ruleset.rules['max-lines-per-cue'];
    const maxLines = lineCfg !== undefined && lineCfg.enabled !== false ? lineCfg.max : undefined;
    if (max === undefined || maxLines === undefined) return () => true;
    const wrappedLineCount = (cue: Cue): number => {
      let lines = 0;
      for (const line of cue.lines) {
        lines += countCodePoints(lineToText(line)) > max ? wrapLine(line, max).length : 1;
      }
      return lines;
    };
    const byIndex = new Map(doc.cues.map((c) => [c.index, c] as const));
    return (violation) => {
      const cue = byIndex.get(violation.cueIndex);
      if (cue === undefined) return true;
      return !(cue.lines.length <= maxLines && wrappedLineCount(cue) > maxLines);
    };
  },
};

export const maxLinesPerCue: RuleDefinition<'max-lines-per-cue'> = {
  id: 'max-lines-per-cue',
  fixable: false,
  evaluate(doc, config) {
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      if (cue.lines.length > config.max) {
        out.push({
          cueIndex: cue.index,
          message: `Cue has ${cue.lines.length} lines (max ${config.max}).`,
        });
      }
    }
    return out;
  },
};
