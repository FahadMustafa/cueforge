/** Public surface of the QC engine (spec §5). */
export type { QCIssue, RuleId, Severity } from './types';
export {
  type Ruleset,
  type RuleConfigMap,
  type BaseRuleConfig,
  type MaxCharsPerLineConfig,
  type MaxLinesPerCueConfig,
  type MaxCpsConfig,
  type MinDurationConfig,
  type MaxDurationConfig,
  type MinGapConfig,
  type ForbiddenCharactersConfig,
  RULE_IDS,
  RulesetError,
  parseRuleset,
  validateRuleset,
  DIGIT_STYLES,
} from './ruleset.schema';
export type { DigitStyle } from '../rtl';
export { evaluate } from './evaluate';
export { resolvedIssues } from './reconcile';
export { autoFix, type AutoFixOptions, type AutoFixResult } from './autofix';
export { RULES } from './rules';
export { PRESETS, DEFAULT_PRESET, type PresetName } from './presets';
