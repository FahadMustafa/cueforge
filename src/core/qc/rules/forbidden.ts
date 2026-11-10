/**
 * Rule 11 (spec §5.2): `forbidden-characters` — a configurable list of literal
 * characters (`chars`, e.g. a tab) and substrings (`patterns`, e.g. a double
 * space) that may not appear. Auto-fixable (strip the chars, collapse the
 * patterns). With nothing configured the rule is inert.
 */

import { cueToText } from '../../model/cue';
import type { RuleDefinition, RuleViolation } from '../rule';

/** A readable name for whitespace tokens so messages aren't blank. */
export function describeToken(token: string): string {
  if (token === '\t') return 'a tab';
  if (token === '  ') return 'a double space';
  if (/^\s+$/.test(token)) return 'whitespace';
  return `"${token}"`;
}

export const forbiddenCharacters: RuleDefinition<'forbidden-characters'> = {
  id: 'forbidden-characters',
  fixable: true,
  evaluate(doc, config) {
    const chars = config.chars ?? [];
    const patterns = config.patterns ?? [];
    if (chars.length === 0 && patterns.length === 0) return [];

    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      const text = cueToText(cue);
      for (const token of [...chars, ...patterns]) {
        if (token !== '' && text.includes(token)) {
          out.push({ cueIndex: cue.index, message: `Contains ${describeToken(token)}.` });
        }
      }
    }
    return out;
  },
  // Remove forbidden chars; collapse whitespace patterns to a single space,
  // remove other patterns outright. Applied per span to keep styling.
  fix(doc, config) {
    const chars = config.chars ?? [];
    const patterns = config.patterns ?? [];
    if (chars.length === 0 && patterns.length === 0) return doc;

    const scrub = (text: string): string => {
      let t = text;
      for (const ch of chars) if (ch !== '') t = t.split(ch).join('');
      for (const p of patterns) {
        if (p === '') continue;
        t = /^\s+$/.test(p) ? t.split(p).join(' ').replace(/ {2,}/g, ' ') : t.split(p).join('');
      }
      return t;
    };

    const cues = doc.cues.map((cue) => ({
      ...cue,
      lines: cue.lines.map((line) => ({
        spans: line.spans.map((s) => ({ ...s, text: scrub(s.text) })),
      })),
    }));
    return { ...doc, cues };
  },
};
