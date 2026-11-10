/**
 * Ruleset schema (spec §5.1): QC presets are **data, not code**. A ruleset is a
 * JSON document describing which rules are active and their parameters; the
 * engine ({@link import('./evaluate').evaluate}) interprets it. Because presets
 * are loaded as untyped JSON, {@link parseRuleset} validates them at runtime so a
 * malformed preset fails loudly instead of silently mis-evaluating.
 *
 * A rule runs when it is present in `rules` and `enabled !== false`. Absent or
 * disabled rules are skipped — this lets a preset ship a rule but turn it off
 * (e.g. the Arabic preset disables `punctuation-spacing`, spec §5.2).
 */

import type { DigitStyle } from '../rtl';
import type { RuleId, Severity } from './types';

export const DIGIT_STYLES: readonly DigitStyle[] = [
  'western',
  'arabic-indic',
  'extended-arabic-indic',
];

/** Fields shared by every rule config. */
export interface BaseRuleConfig {
  enabled: boolean;
  severity: Severity;
}

export interface MaxCharsPerLineConfig extends BaseRuleConfig {
  max: number;
}
export interface MaxLinesPerCueConfig extends BaseRuleConfig {
  max: number;
}
export interface MaxCpsConfig extends BaseRuleConfig {
  max: number;
  /** Exclude line breaks from the character count (default true). */
  excludeLineBreaks?: boolean;
  /** Inclusive [start, end] code-point ranges to exclude (e.g. Arabic diacritics). */
  excludeRanges?: [number, number][];
}
export interface MinDurationConfig extends BaseRuleConfig {
  ms: number;
}
export interface MaxDurationConfig extends BaseRuleConfig {
  ms: number;
}
/** Minimum gap between consecutive cues, expressed in ms and/or frames. */
export interface MinGapConfig extends BaseRuleConfig {
  ms?: number;
  /** Frames at the document frame rate; `ms` is the fallback when fps is unknown. */
  frames?: number;
}
export interface ForbiddenCharactersConfig extends BaseRuleConfig {
  /** Literal characters that may not appear (e.g. a tab). */
  chars?: string[];
  /** Literal substrings that may not appear (e.g. a double space). */
  patterns?: string[];
}

/** Rule 16 `mixed-digit-style`: normalize to this digit family (default western). */
export interface MixedDigitStyleConfig extends BaseRuleConfig {
  style?: DigitStyle;
}
/** Rule 18 `arabic-line-length`: max length counting diacritics as zero-width. */
export interface ArabicLineLengthConfig extends BaseRuleConfig {
  max: number;
}

/** Rules with no parameters beyond {@link BaseRuleConfig}. */
export type SimpleRuleConfig = BaseRuleConfig;

/** Maps each rule id to its config shape. */
export interface RuleConfigMap {
  'max-chars-per-line': MaxCharsPerLineConfig;
  'max-lines-per-cue': MaxLinesPerCueConfig;
  'max-cps': MaxCpsConfig;
  'min-duration': MinDurationConfig;
  'max-duration': MaxDurationConfig;
  'min-gap': MinGapConfig;
  overlap: SimpleRuleConfig;
  'reversed-timing': SimpleRuleConfig;
  'empty-cue': SimpleRuleConfig;
  'duplicate-cue': SimpleRuleConfig;
  'forbidden-characters': ForbiddenCharactersConfig;
  'punctuation-spacing': SimpleRuleConfig;
  'unclosed-tag': SimpleRuleConfig;
  'cue-count-monotonic-timing': SimpleRuleConfig;
  'bidi-punctuation': SimpleRuleConfig;
  'mixed-digit-style': MixedDigitStyleConfig;
  'latin-run-isolation': SimpleRuleConfig;
  'arabic-line-length': ArabicLineLengthConfig;
  'kashida-strip': SimpleRuleConfig;
  'ellipsis-style': SimpleRuleConfig;
}

export interface Ruleset {
  name: string;
  /** Whether the parameters were verified against current platform docs (spec §5.4). */
  verified: boolean;
  /** Documentation URL the human owner verifies the values against. */
  reference?: string;
  rules: { [K in RuleId]?: RuleConfigMap[K] };
}

export const RULE_IDS: readonly RuleId[] = [
  'max-chars-per-line',
  'max-lines-per-cue',
  'max-cps',
  'min-duration',
  'max-duration',
  'min-gap',
  'overlap',
  'reversed-timing',
  'empty-cue',
  'duplicate-cue',
  'forbidden-characters',
  'punctuation-spacing',
  'unclosed-tag',
  'cue-count-monotonic-timing',
  'bidi-punctuation',
  'mixed-digit-style',
  'latin-run-isolation',
  'arabic-line-length',
  'kashida-strip',
  'ellipsis-style',
];

const RULE_ID_SET = new Set<string>(RULE_IDS);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a single rule's parameters, pushing `<id>: <problem>` messages. */
function validateRuleParams(id: RuleId, cfg: Record<string, unknown>, errors: string[]): void {
  const num = (key: string): void => {
    if (typeof cfg[key] !== 'number' || !Number.isFinite(cfg[key])) {
      errors.push(`${id}: ${key} must be a finite number`);
    }
  };
  /** Require an optional field to be an array of strings when present. */
  const stringArray = (key: string): void => {
    const v = cfg[key];
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) {
      errors.push(`${id}: ${key} must be an array of strings`);
    }
  };
  switch (id) {
    case 'max-chars-per-line':
    case 'max-lines-per-cue':
    case 'arabic-line-length':
      num('max');
      break;
    case 'max-cps': {
      num('max');
      const ranges = cfg.excludeRanges;
      if (
        ranges !== undefined &&
        (!Array.isArray(ranges) ||
          ranges.some(
            (r) =>
              !Array.isArray(r) ||
              r.length !== 2 ||
              typeof r[0] !== 'number' ||
              typeof r[1] !== 'number',
          ))
      ) {
        errors.push(`${id}: excludeRanges must be an array of [number, number] pairs`);
      }
      break;
    }
    case 'forbidden-characters':
      stringArray('chars');
      stringArray('patterns');
      break;
    case 'mixed-digit-style':
      if (cfg.style !== undefined && !DIGIT_STYLES.includes(cfg.style as DigitStyle)) {
        errors.push(`${id}: style must be one of ${DIGIT_STYLES.join(', ')}`);
      }
      break;
    case 'min-duration':
    case 'max-duration':
      num('ms');
      break;
    case 'min-gap':
      if (cfg.ms === undefined && cfg.frames === undefined) {
        errors.push(`${id}: must specify ms or frames`);
      }
      if (cfg.ms !== undefined && typeof cfg.ms !== 'number') {
        errors.push(`${id}: ms must be a number`);
      }
      if (cfg.frames !== undefined && typeof cfg.frames !== 'number') {
        errors.push(`${id}: frames must be a number`);
      }
      break;
    default:
      // The parameterless rules accept the base config unchanged.
      break;
  }
}

/** Returns a list of human-readable problems; an empty list means `data` is valid. */
export function validateRuleset(data: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(data)) return ['ruleset must be an object'];

  if (typeof data.name !== 'string') errors.push('name must be a string');
  if (typeof data.verified !== 'boolean') errors.push('verified must be a boolean');
  if (data.reference !== undefined && typeof data.reference !== 'string') {
    errors.push('reference must be a string');
  }

  if (!isObject(data.rules)) {
    errors.push('rules must be an object');
    return errors;
  }

  for (const [id, cfg] of Object.entries(data.rules)) {
    if (!RULE_ID_SET.has(id)) {
      errors.push(`unknown rule id: ${id}`);
      continue;
    }
    if (!isObject(cfg)) {
      errors.push(`${id}: config must be an object`);
      continue;
    }
    if (typeof cfg.enabled !== 'boolean') errors.push(`${id}: enabled must be a boolean`);
    if (cfg.severity !== 'error' && cfg.severity !== 'warning') {
      errors.push(`${id}: severity must be "error" or "warning"`);
    }
    validateRuleParams(id as RuleId, cfg, errors);
  }

  return errors;
}

/** Thrown by {@link parseRuleset} when a ruleset fails validation. */
export class RulesetError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid ruleset:\n  ${errors.join('\n  ')}`);
    this.name = 'RulesetError';
  }
}

/** Validate and narrow untyped JSON to a {@link Ruleset}, throwing on any problem. */
export function parseRuleset(data: unknown): Ruleset {
  const errors = validateRuleset(data);
  if (errors.length > 0) throw new RulesetError(errors);
  return data as Ruleset;
}
