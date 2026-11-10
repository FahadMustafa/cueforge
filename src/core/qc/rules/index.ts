/**
 * The rule catalog: every QC rule definition, keyed by id (spec §5.2). The engine
 * looks rules up here by the ids present in a ruleset. The completeness check
 * below fails loudly at load if a rule id is ever missing from the catalog.
 */

import type { RuleDefinition, RuleRegistry } from '../rule';
import { RULE_IDS } from '../ruleset.schema';
import { maxCharsPerLine, maxLinesPerCue } from './length';
import { maxCps } from './cps';
import { maxDuration, minDuration, minGap } from './durations';
import { emptyCue, overlap, reversedTiming } from './structural';
import { duplicateCue } from './duplicate';
import { forbiddenCharacters } from './forbidden';
import { punctuationSpacing } from './punctuation';
import { unclosedTag } from './tags';
import { cueCountMonotonicTiming } from './monotonic';
import { bidiPunctuation } from './bidi-punctuation';
import { mixedDigitStyle } from './digits';
import { latinRunIsolation } from './latin-isolation';
import { arabicLineLength } from './arabic-length';
import { kashidaStrip } from './kashida';
import { ellipsisStyle } from './ellipsis';

const defs: RuleDefinition[] = [
  maxCharsPerLine,
  maxLinesPerCue,
  maxCps,
  minDuration,
  maxDuration,
  minGap,
  overlap,
  reversedTiming,
  emptyCue,
  duplicateCue,
  forbiddenCharacters,
  punctuationSpacing,
  unclosedTag,
  cueCountMonotonicTiming,
  bidiPunctuation,
  mixedDigitStyle,
  latinRunIsolation,
  arabicLineLength,
  kashidaStrip,
  ellipsisStyle,
];

const catalog = Object.fromEntries(defs.map((d) => [d.id, d]));

const missing = RULE_IDS.filter((id) => !(id in catalog));
if (missing.length > 0) {
  throw new Error(`QC rule catalog is missing: ${missing.join(', ')}`);
}

export const RULES: RuleRegistry = catalog as RuleRegistry;
