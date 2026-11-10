/**
 * The contract every QC rule implements. Rule *logic* is code; which rules run
 * and with what thresholds is data (the {@link Ruleset}). A rule reports
 * {@link RuleViolation}s; the engine ({@link import('./evaluate').evaluate})
 * attaches severity (from the ruleset) and `fixable` (from the rule) to build the
 * final {@link QCIssue}s.
 */

import type { Cue, SubtitleDocument } from '../model/types';
import type { RuleConfigMap, Ruleset } from './ruleset.schema';
import type { RuleId } from './types';

/** A single rule hit, before the engine adds ruleId/severity/fixable. */
export interface RuleViolation {
  /** Offending `Cue.index`, or -1 for a document-level violation. */
  cueIndex: number;
  message: string;
}

export interface RuleDefinition<K extends RuleId = RuleId> {
  id: K;
  /** Whether {@link RuleDefinition.fix} exists (surfaced on every issue). */
  fixable: boolean;
  evaluate(doc: SubtitleDocument, config: RuleConfigMap[K]): RuleViolation[];
  /**
   * Auto-fix: return a new document with this rule's violations resolved, without
   * mutating the input and without introducing new issues (spec §5.1). Present
   * exactly when {@link RuleDefinition.fixable} is true.
   */
  fix?(doc: SubtitleDocument, config: RuleConfigMap[K]): SubtitleDocument;
  /**
   * Cue-local auto-fix variant (cue-forge-zxw.12), for rules whose fix is purely
   * intra-cue. When present, {@link import('./autofix').autoFix} fixes only the
   * cues named by the issues being fixed — so fix-one lands the clicked cue even
   * when the whole-document {@link RuleDefinition.fix} would be reverted by an
   * unrelated cue — while `fix` still drives fix-all. It MUST produce the same
   * cue as fixing that one cue via `fix`, and rules that read neighbouring cues
   * (CPS / min-gap / overlap) MUST NOT implement it (the guard would still catch
   * a mistake, but the scoping assumes no cross-cue effect).
   */
  fixCue?(cue: Cue, config: RuleConfigMap[K]): Cue;
  /**
   * Conditionally-fixable rules only (cue-forge-8b4): given the document and the
   * full ruleset, return a predicate deciding per-violation whether this rule's
   * auto-fix would actually help in context (rather than be reverted by the
   * zero-new-issues guard). Returned once per evaluation so the rule can do any
   * O(n) prep (e.g. index cues) up front. When omitted, every violation is as
   * fixable as the static {@link RuleDefinition.fixable} flag. The engine stamps
   * the result onto {@link import('./types').QCIssue.effectivelyFixable} so the
   * UI can offer a manual remedy instead of a dead Fix button.
   */
  fixableInContext?(doc: SubtitleDocument, ruleset: Ruleset): (violation: RuleViolation) => boolean;
}

/** A registry maps every rule id to its definition. */
export type RuleRegistry = { [K in RuleId]: RuleDefinition<K> };
