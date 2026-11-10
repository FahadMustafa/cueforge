/**
 * QC engine public types (spec §5.1). The engine evaluates a
 * {@link import('../model/types').SubtitleDocument} against a ruleset and
 * returns {@link QCIssue}s; auto-fix consumes those issues.
 */

export type Severity = 'error' | 'warning';

/**
 * The twenty rule ids (spec §5.2 rules 1–14, §5.3 Arabic/RTL rules 15–19, plus
 * the Netflix `ellipsis-style` content rule, cue-forge-sdv.15).
 */
export type RuleId =
  | 'max-chars-per-line'
  | 'max-lines-per-cue'
  | 'max-cps'
  | 'min-duration'
  | 'max-duration'
  | 'min-gap'
  | 'overlap'
  | 'reversed-timing'
  | 'empty-cue'
  | 'duplicate-cue'
  | 'forbidden-characters'
  | 'punctuation-spacing'
  | 'unclosed-tag'
  | 'cue-count-monotonic-timing'
  | 'bidi-punctuation'
  | 'mixed-digit-style'
  | 'latin-run-isolation'
  | 'arabic-line-length'
  | 'kashida-strip'
  | 'ellipsis-style';

/** One problem found by the engine (spec §5.1). */
export interface QCIssue {
  ruleId: RuleId;
  /** Index of the offending cue (the `Cue.index`), or -1 for document-level. */
  cueIndex: number;
  severity: Severity;
  message: string;
  /** Whether an auto-fix exists for this rule. */
  fixable: boolean;
  /**
   * Whether the auto-fix would actually help on THIS cue, given the rest of the
   * ruleset (cue-forge-8b4). Set by the engine only for conditionally-fixable
   * rules — e.g. a `max-chars-per-line` re-wrap is reverted when it would push
   * the cue past `max-lines-per-cue`, so the UI should offer a manual remedy
   * instead of a dead Fix button. Absent for every other rule; consumers fall
   * back to {@link QCIssue.fixable} when it is undefined.
   */
  effectivelyFixable?: boolean;
}
