import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import type { Cue, SubtitleDocument } from '../../model/types';
import {
  fixPunctuationSpacingText,
  hasPunctuationSpacingIssue,
  punctuationSpacing,
} from './punctuation';

function docOf(text: string): SubtitleDocument {
  const cue: Cue = { index: 1, startMs: 0, endMs: 1000, lines: [textLine(text)] };
  return { cues: [cue], metadata: { sourceFormat: 'srt' }, warnings: [] };
}
const base = { enabled: true, severity: 'warning' } as const;

describe('hasPunctuationSpacingIssue', () => {
  it.each([
    ['hello .', true], // space before punctuation
    ['hello,world', true], // missing space after punctuation
    ['Hello, world.', false], // clean
    ['3.14', false], // decimal, not a sentence period
    ['12:30', false], // time, not a clause colon
    ['1,000', false], // thousands separator
    ['Wait... what?', false], // ellipsis then space
    // cue-forge-drt.6: a following letter that does not start a new sentence.
    ['U.S.A.', false], // initialism
    ['e.g. this', false], // lowercase initialism
    ['cue-forge.com', false], // domain / intra-word dot
    ['visit example.org today', false], // domain in a sentence
    ['...and then', false], // ellipsis continuation
    ['end.Start', true], // genuine sentence break (uppercase follows)
    ['Dr.Smith', true], // abbreviation missing its space (multi-letter before dot)
  ])('%s -> %s', (text, expected) => {
    expect(hasPunctuationSpacingIssue(text)).toBe(expected);
  });
});

describe('fixPunctuationSpacingText (cue-forge-drt.6)', () => {
  it.each([
    ['U.S.A.', 'U.S.A.'], // initialism untouched
    ['cue-forge.com', 'cue-forge.com'], // domain untouched
    ['e.g. this', 'e.g. this'], // lowercase initialism untouched
    ['...and then', '...and then'], // ellipsis continuation untouched
    ['end.Start', 'end. Start'], // genuine sentence break gets a space
    ['Dr.Smith', 'Dr. Smith'], // abbreviation gets its missing space
    ['hello ,world', 'hello, world'], // still fixes real issues
    ['Wait... what?', 'Wait... what?'], // ellipsis with trailing space untouched
  ])('%s -> %s', (input, expected) => {
    expect(fixPunctuationSpacingText(input)).toBe(expected);
  });
});

describe('punctuation-spacing', () => {
  it('flags a cue with a spacing issue', () => {
    const v = punctuationSpacing.evaluate(docOf('hello ,world'), base);
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
  });
  it('passes a clean cue', () => {
    expect(punctuationSpacing.evaluate(docOf('Hello, world.'), base)).toEqual([]);
  });
  it('is auto-fixable', () => {
    expect(punctuationSpacing.fixable).toBe(true);
  });
});
