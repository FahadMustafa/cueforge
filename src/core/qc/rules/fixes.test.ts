import { describe, expect, it } from 'vitest';
import { cueToText, lineToText, textLine } from '../../model/cue';
import type { Cue, CueLine, SubtitleDocument } from '../../model/types';
import { maxCharsPerLine } from './length';
import { FIX_GAP_FLOOR_MS, maxDuration, minDuration, minGap } from './durations';
import { emptyCue, overlap, reversedTiming } from './structural';
import { forbiddenCharacters } from './forbidden';
import { punctuationSpacing } from './punctuation';
import { unclosedTag } from './tags';

function cue(index: number, startMs: number, endMs: number, lines: CueLine[]): Cue {
  return { index, startMs, endMs, lines };
}
function docOf(cues: Cue[], frameRate?: number): SubtitleDocument {
  return { cues, metadata: { sourceFormat: 'srt', frameRate }, warnings: [] };
}
const sev = { enabled: true, severity: 'warning' } as const;

// Every fixer must be pure: re-checking that the input is untouched.
function expectUnmutated(d: SubtitleDocument, run: () => void): void {
  const before = JSON.stringify(d);
  run();
  expect(JSON.stringify(d)).toBe(before);
}

describe('max-chars-per-line fix (re-wrap)', () => {
  const cfg = { ...sev, max: 10 };
  it('wraps a long line at word boundaries without exceeding max', () => {
    const d = docOf([cue(1, 0, 1000, [textLine('one two three four')])]);
    const out = maxCharsPerLine.fix!(d, cfg);
    for (const line of out.cues[0]!.lines) {
      expect(lineToText(line).length).toBeLessThanOrEqual(10);
    }
  });
  it('never breaks a word', () => {
    const d = docOf([cue(1, 0, 1000, [textLine('antidisestablishmentarianism word')])]);
    const out = maxCharsPerLine.fix!(d, cfg);
    const words = out.cues[0]!.lines.flatMap((l) => lineToText(l).split(' '));
    expect(words).toContain('antidisestablishmentarianism');
  });
  it('clears its own violation when the text is wrappable', () => {
    const d = docOf([cue(1, 0, 1000, [textLine('one two three four')])]);
    expect(maxCharsPerLine.evaluate(maxCharsPerLine.fix!(d, cfg), cfg)).toEqual([]);
  });
  it('preserves styling of a wrapped span', () => {
    const styled: CueLine = { spans: [{ text: 'alpha beta gamma', italic: true }] };
    const out = maxCharsPerLine.fix!(docOf([cue(1, 0, 1000, [styled])]), cfg);
    expect(out.cues[0]!.lines.every((l) => l.spans.every((s) => s.italic))).toBe(true);
  });
  it('does not mutate the input', () => {
    const d = docOf([cue(1, 0, 1000, [textLine('one two three four')])]);
    expectUnmutated(d, () => maxCharsPerLine.fix!(d, cfg));
  });
});

describe('min-duration fix', () => {
  const cfg = { ...sev, ms: 1000 };
  it('extends a short cue toward the gap', () => {
    const out = minDuration.fix!(docOf([cue(1, 0, 400, [textLine('x')])]), cfg);
    expect(out.cues[0]!.endMs).toBe(1000);
    expect(minDuration.evaluate(out, cfg)).toEqual([]);
  });
  it('stops a conservative gap short of the next cue (no overlap, no new min-gap issue)', () => {
    const out = minDuration.fix!(
      docOf([cue(1, 0, 400, [textLine('a')]), cue(2, 600, 2000, [textLine('b')])]),
      cfg,
    );
    expect(out.cues[0]!.endMs).toBe(600 - FIX_GAP_FLOOR_MS);
  });
  it('never shrinks a cue when the gap is already at or below the conservative floor', () => {
    const out = minDuration.fix!(
      docOf([cue(1, 0, 400, [textLine('a')]), cue(2, 450, 2000, [textLine('b')])]),
      cfg,
    );
    expect(out.cues[0]!.endMs).toBe(400);
  });
  it('skips reversed cues (reversed-timing owns those)', () => {
    const out = minDuration.fix!(docOf([cue(1, 900, 0, [textLine('a')])]), cfg);
    expect(out.cues[0]!).toEqual(cue(1, 900, 0, [textLine('a')]));
  });
});

describe('max-duration fix', () => {
  const cfg = { ...sev, ms: 5000 };
  it('trims a long cue to max', () => {
    const out = maxDuration.fix!(docOf([cue(1, 0, 9000, [textLine('x')])]), cfg);
    expect(out.cues[0]!.endMs).toBe(5000);
    expect(maxDuration.evaluate(out, cfg)).toEqual([]);
  });
});

describe('min-gap fix', () => {
  const cfg = { ...sev, ms: 100 };
  it('prefers moving the next cue start forward when it keeps a safe duration', () => {
    const out = minGap.fix!(
      docOf([cue(1, 0, 1000, [textLine('a')]), cue(2, 1050, 2000, [textLine('b')])]),
      cfg,
    );
    expect(out.cues[0]!.endMs).toBe(1000); // earlier cue untouched
    expect(out.cues[1]!.startMs).toBe(1100); // 1000 + 100
    expect(minGap.evaluate(out, cfg)).toEqual([]);
  });
  it('falls back to trimming the earlier cue when the next one is too short', () => {
    const out = minGap.fix!(
      docOf([cue(1, 0, 2000, [textLine('a')]), cue(2, 2050, 2900, [textLine('b')])]),
      cfg,
    );
    expect(out.cues[1]!.startMs).toBe(2050); // next cue untouched
    expect(out.cues[0]!.endMs).toBe(1950); // 2050 - 100
    expect(minGap.evaluate(out, cfg)).toEqual([]);
  });
  it('leaves the pair flagged when either fix would under-run the duration floor', () => {
    const d = docOf([cue(1, 0, 880, [textLine('a')]), cue(2, 930, 1700, [textLine('b')])]);
    const out = minGap.fix!(d, cfg);
    expect(out.cues).toEqual(d.cues);
    expect(minGap.evaluate(out, cfg)).toHaveLength(1);
  });
  it('does not push a cue below min-duration to create the gap (cue-forge-mz1)', () => {
    // netflix-latin shape: required gap 83 ms, min-duration 833 ms. The old fix
    // shortened cue 1 to 0–817 ms.
    const out = minGap.fix!(
      docOf([cue(1, 0, 900, [textLine('a')]), cue(2, 900, 2000, [textLine('b')])]),
      { ...sev, ms: 83 },
    );
    expect(out.cues[0]!.endMs).toBe(900);
    expect(out.cues[1]!.startMs).toBe(983);
    expect(minDuration.evaluate(out, { ...sev, ms: 833 })).toEqual([]);
    expect(minGap.evaluate(out, { ...sev, ms: 83 })).toEqual([]);
  });
});

describe('overlap fix', () => {
  it('trims the earlier cue, restoring a conservative gap before the later one', () => {
    const out = overlap.fix!(
      docOf([cue(1, 0, 1200, [textLine('a')]), cue(2, 1000, 2000, [textLine('b')])]),
      sev,
    );
    expect(out.cues[0]!.endMs).toBe(1000 - FIX_GAP_FLOOR_MS);
    expect(overlap.evaluate(out, sev)).toEqual([]);
  });
  it('leaves an overlap flagged when trimming would produce a zero-length cue (cue-forge-mz1)', () => {
    const d = docOf([cue(1, 500, 1500, [textLine('a')]), cue(2, 500, 2000, [textLine('b')])]);
    const out = overlap.fix!(d, sev);
    expect(out.cues).toEqual(d.cues);
    expect(overlap.evaluate(out, sev)).toHaveLength(1);
  });
  it('leaves an overlap flagged when trimming would under-run the duration floor', () => {
    const d = docOf([cue(1, 0, 2000, [textLine('a')]), cue(2, 500, 2500, [textLine('b')])]);
    const out = overlap.fix!(d, sev);
    expect(out.cues).toEqual(d.cues);
    expect(overlap.evaluate(out, sev)).toHaveLength(1);
  });
});

describe('reversed-timing fix', () => {
  it('swaps start and end', () => {
    const out = reversedTiming.fix!(docOf([cue(1, 1000, 400, [textLine('a')])]), sev);
    expect(out.cues[0]!.startMs).toBe(400);
    expect(out.cues[0]!.endMs).toBe(1000);
    expect(reversedTiming.evaluate(out, sev)).toEqual([]);
  });
});

describe('empty-cue fix', () => {
  it('drops empty cues and renumbers the rest', () => {
    const out = emptyCue.fix!(
      docOf([
        cue(1, 0, 1000, [textLine('a')]),
        cue(2, 1000, 2000, [textLine('')]),
        cue(3, 2000, 3000, [textLine('b')]),
      ]),
      sev,
    );
    expect(out.cues.map((c) => cueToText(c))).toEqual(['a', 'b']);
    expect(out.cues.map((c) => c.index)).toEqual([1, 2]);
    expect(emptyCue.evaluate(out, sev)).toEqual([]);
  });
});

describe('forbidden-characters fix', () => {
  it('removes forbidden chars and collapses whitespace patterns', () => {
    const cfg = { ...sev, chars: ['\t'], patterns: ['  '] };
    const out = forbiddenCharacters.fix!(docOf([cue(1, 0, 1000, [textLine('a\tb  c')])]), cfg);
    expect(cueToText(out.cues[0]!)).toBe('ab c');
    expect(forbiddenCharacters.evaluate(out, cfg)).toEqual([]);
  });
});

describe('punctuation-spacing fix', () => {
  const cfg = sev;
  it('removes space before and inserts space after punctuation', () => {
    const out = punctuationSpacing.fix!(docOf([cue(1, 0, 1000, [textLine('hello ,world')])]), cfg);
    expect(cueToText(out.cues[0]!)).toBe('hello, world');
    expect(punctuationSpacing.evaluate(out, cfg)).toEqual([]);
  });
  it('leaves numbers and times alone', () => {
    const out = punctuationSpacing.fix!(docOf([cue(1, 0, 1000, [textLine('3.14 at 12:30')])]), cfg);
    expect(cueToText(out.cues[0]!)).toBe('3.14 at 12:30');
  });
  it('fixes a multi-span line without flattening its styling (cue-forge-xod)', () => {
    const line: CueLine = {
      spans: [{ text: 'Hello ' }, { text: 'world', italic: true }, { text: ' ,bad' }],
    };
    const out = punctuationSpacing.fix!(docOf([cue(1, 0, 1000, [line])]), cfg);
    expect(lineToText(out.cues[0]!.lines[0]!)).toBe('Hello world, bad');
    expect(out.cues[0]!.lines[0]!.spans).toContainEqual({ text: 'world', italic: true });
    expect(punctuationSpacing.evaluate(out, cfg)).toEqual([]);
  });
  it('leaves an issue-free styled line untouched', () => {
    const line: CueLine = { spans: [{ text: 'Hello, ' }, { text: 'world.', italic: true }] };
    const out = punctuationSpacing.fix!(docOf([cue(1, 0, 1000, [line])]), cfg);
    expect(out.cues[0]!.lines[0]!).toEqual(line);
  });
  it('repairs punctuation sitting at a span boundary, keeping each span its own style', () => {
    const line: CueLine = {
      spans: [
        { text: 'Hi ', color: 'red' },
        { text: ',there', italic: true },
      ],
    };
    const out = punctuationSpacing.fix!(docOf([cue(1, 0, 1000, [line])]), cfg);
    expect(out.cues[0]!.lines[0]!.spans).toEqual([
      { text: 'Hi', color: 'red' },
      { text: ', there', italic: true },
    ]);
  });
  it('inserts the missing space when punctuation ends one span and a word opens the next', () => {
    const line: CueLine = {
      spans: [{ text: 'Wait,', italic: true }, { text: 'no' }],
    };
    const out = punctuationSpacing.fix!(docOf([cue(1, 0, 1000, [line])]), cfg);
    expect(out.cues[0]!.lines[0]!.spans).toEqual([
      { text: 'Wait,', italic: true },
      { text: ' no' },
    ]);
  });
  it('drops a whitespace-only span emptied by the boundary repair', () => {
    const line: CueLine = { spans: [{ text: 'a' }, { text: ' ' }, { text: ',b' }] };
    const out = punctuationSpacing.fix!(docOf([cue(1, 0, 1000, [line])]), cfg);
    expect(lineToText(out.cues[0]!.lines[0]!)).toBe('a, b');
    expect(punctuationSpacing.evaluate(out, cfg)).toEqual([]);
  });
  it('handles a line opening with punctuation and skips already-empty spans', () => {
    const line: CueLine = { spans: [{ text: '' }, { text: ',start ok' }] };
    const out = punctuationSpacing.fix!(docOf([cue(1, 0, 1000, [line])]), cfg);
    expect(out.cues[0]!.lines[0]!.spans).toEqual([{ text: ', start ok' }]);
  });
});

describe('unclosed-tag fix', () => {
  it('rebuilds the cue with balanced tags', () => {
    const out = unclosedTag.fix!(docOf([cue(1, 0, 1000, [textLine('hello <i>world')])]), sev);
    expect(unclosedTag.evaluate(out, sev)).toEqual([]);
    expect(cueToText(out.cues[0]!)).toContain('world');
  });
  it('keeps pre-existing structured styling while balancing a literal tag (cue-forge-lnj)', () => {
    const line: CueLine = {
      spans: [{ text: 'styled', italic: true }, { text: ' plain <i>broken' }],
    };
    const out = unclosedTag.fix!(docOf([cue(1, 0, 1000, [line])]), sev);
    expect(unclosedTag.evaluate(out, sev)).toEqual([]);
    const spans = out.cues[0]!.lines[0]!.spans;
    expect(spans).toContainEqual({ text: 'styled', italic: true });
    // The unclosed opener is balanced as styling that runs to the end of the cue.
    expect(spans).toContainEqual({ text: 'broken', italic: true });
    expect(cueToText(out.cues[0]!)).toBe('styled plain broken');
  });
  it('leaves a cue with only balanced structured styling alone', () => {
    const d = docOf([cue(1, 0, 1000, [{ spans: [{ text: 'fine', italic: true }] }])]);
    const out = unclosedTag.fix!(d, sev);
    expect(out.cues[0]!.lines).toEqual(d.cues[0]!.lines);
  });
});
