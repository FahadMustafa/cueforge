import { describe, expect, it } from 'vitest';
import { makeSpan, textLine } from '../../model/cue';
import { LRM } from '../../rtl';
import type { Cue, CueLine, SubtitleDocument } from '../../model/types';
import { isolateLatinRuns, latinRunIsolation } from './latin-isolation';

function docOf(...lines: CueLine[]): SubtitleDocument {
  const cue: Cue = { index: 1, startMs: 0, endMs: 2000, lines };
  return { cues: [cue], metadata: { sourceFormat: 'srt' }, warnings: [] };
}
const base = { enabled: true, severity: 'warning' } as const;

describe('isolateLatinRuns', () => {
  it('wraps a Latin word run with LRM on both sides', () => {
    expect(isolateLatinRuns('شاهد MBC الآن')).toBe(`شاهد ${LRM}MBC${LRM} الآن`);
  });
  it('keeps an internal decimal/number run intact', () => {
    expect(isolateLatinRuns('السعر 3.14 ريال')).toBe(`السعر ${LRM}3.14${LRM} ريال`);
  });
  it('does not capture a trailing dot into the run', () => {
    expect(isolateLatinRuns('قناة MBC.')).toBe(`قناة ${LRM}MBC${LRM}.`);
  });
  it('is idempotent', () => {
    const once = isolateLatinRuns('شاهد MBC4 الآن');
    expect(isolateLatinRuns(once)).toBe(once);
  });
  it('leaves text with no Latin runs unchanged', () => {
    expect(isolateLatinRuns('مرحبا بالعالم')).toBe('مرحبا بالعالم');
  });
});

describe('latin-run-isolation rule', () => {
  it('flags an RTL line with an unisolated Latin run and is fixable', () => {
    expect(latinRunIsolation.fixable).toBe(true);
    const v = latinRunIsolation.evaluate(docOf(textLine('شاهد على MBC الآن')), base);
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
    // The message spells out the LRM acronym once (cue-forge-w28.16).
    expect(v[0]!.message).toContain('left-to-right mark (LRM)');
  });

  it('does not flag a pure-Latin line (no RTL context)', () => {
    expect(latinRunIsolation.evaluate(docOf(textLine('Hello world')), base)).toEqual([]);
  });

  it('does not flag an already-isolated run', () => {
    expect(latinRunIsolation.evaluate(docOf(textLine(`شاهد ${LRM}MBC${LRM} الآن`)), base)).toEqual(
      [],
    );
  });

  it('fix resolves the issue and preserves per-span styling', () => {
    const line: CueLine = { spans: [makeSpan('شاهد ', {}), makeSpan('MBC', { italic: true })] };
    const fixed = latinRunIsolation.fix!(docOf(line), base);
    const span = fixed.cues[0]!.lines[0]!.spans.find((s) => s.text.includes('MBC'));
    expect(span?.italic).toBe(true);
    expect(span?.text).toBe(`${LRM}MBC${LRM}`);
    expect(latinRunIsolation.evaluate(fixed, base)).toEqual([]);
  });
});
