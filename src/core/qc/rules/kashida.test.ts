import { describe, expect, it } from 'vitest';
import { textLine } from '../../model/cue';
import { TATWEEL } from '../../rtl';
import type { Cue, SubtitleDocument } from '../../model/types';
import { kashidaStrip } from './kashida';

function docOf(...texts: string[]): SubtitleDocument {
  const cues: Cue[] = texts.map((t, i) => ({
    index: i + 1,
    startMs: i * 1000,
    endMs: i * 1000 + 1000,
    lines: t.split('\n').map(textLine),
  }));
  return { cues, metadata: { sourceFormat: 'srt' }, warnings: [] };
}
const base = { enabled: true, severity: 'warning' } as const;

const cueText = (doc: SubtitleDocument, i = 0): string =>
  doc.cues[i]!.lines.map((l) => l.spans.map((s) => s.text).join('')).join('\n');

describe('kashida-strip', () => {
  it('flags a cue padded with tatweel', () => {
    const v = kashidaStrip.evaluate(docOf(`كتــــاب`), base);
    expect(v).toHaveLength(1);
    expect(v[0]!.cueIndex).toBe(1);
  });

  it('passes a cue with no tatweel', () => {
    expect(kashidaStrip.evaluate(docOf('كتاب', 'Hello'), base)).toEqual([]);
  });

  it('is auto-fixable and removes every tatweel', () => {
    expect(kashidaStrip.fixable).toBe(true);
    const fixed = kashidaStrip.fix!(docOf(`كتــاب ${TATWEEL}`), base);
    const text = cueText(fixed);
    expect(text.includes(TATWEEL)).toBe(false);
    expect(text.startsWith('كتاب')).toBe(true);
  });

  it('fix resolves the issue (rule re-check is clean)', () => {
    const doc = docOf('شعـــار');
    const fixed = kashidaStrip.fix!(doc, base);
    expect(kashidaStrip.evaluate(fixed, base)).toEqual([]);
  });
});
