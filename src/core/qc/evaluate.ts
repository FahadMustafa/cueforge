/**
 * QC engine (spec §5.1): evaluate a {@link SubtitleDocument} against a
 * {@link Ruleset} and return {@link QCIssue}s. The engine is pure — it never
 * mutates the document. It runs only rules that are present and enabled, looks
 * each one up in the rule registry, and stamps the configured severity and the
 * rule's `fixable` flag onto every violation. Issues are ordered by cue index so
 * a report reads top-to-bottom (document-level issues, cueIndex -1, sort first).
 */

import type { SubtitleDocument } from '../model/types';
import { RULES } from './rules';
import type { RuleRegistry } from './rule';
import type { Ruleset } from './ruleset.schema';
import type { QCIssue, RuleId } from './types';

/**
 * ASS Comment (and other non-Dialogue) events are not visible subtitles.
 * Shared with the auto-fix framework: rules never see invisible cues, so
 * fixers must not either (autofix.ts extracts and re-merges them).
 */
export function isVisibleCue(cue: SubtitleDocument['cues'][number]): boolean {
  if (cue.raw === null || typeof cue.raw !== 'object' || !('kind' in cue.raw)) return true;
  const kind = (cue.raw as { kind?: unknown }).kind;
  return typeof kind !== 'string' || kind === 'Dialogue';
}

export function evaluate(
  doc: SubtitleDocument,
  ruleset: Ruleset,
  registry: Partial<RuleRegistry> = RULES,
): QCIssue[] {
  const issues: QCIssue[] = [];

  // Rules only see visible cues, so e.g. an ASS Comment event never triggers
  // overlap/min-duration/duplicate findings (cue-forge-hop).
  const visible = doc.cues.filter(isVisibleCue);
  if (visible.length !== doc.cues.length) doc = { ...doc, cues: visible };

  for (const [id, config] of Object.entries(ruleset.rules)) {
    if (config === undefined || config.enabled === false) continue;
    const def = registry[id as RuleId];
    if (def === undefined) continue;

    // The registry entry's config type matches its id; the ruleset pairs them by
    // the same key, so this call is sound across the union.
    const violations = (def.evaluate as (d: SubtitleDocument, c: typeof config) => unknown[])(
      doc,
      config,
    ) as { cueIndex: number; message: string }[];

    // Conditionally-fixable rules supply a per-violation predicate (cue-forge-8b4);
    // prepared once so any O(n) setup (indexing cues) happens outside the loop.
    const inContext =
      def.fixable && def.fixableInContext !== undefined ? def.fixableInContext(doc, ruleset) : null;

    for (const v of violations) {
      const issue: QCIssue = {
        ruleId: id as RuleId,
        cueIndex: v.cueIndex,
        severity: config.severity,
        message: v.message,
        fixable: def.fixable,
      };
      if (inContext) issue.effectivelyFixable = inContext(v);
      issues.push(issue);
    }
  }

  // Stable sort (V8) keeps per-rule insertion order within a cue.
  return issues.sort((a, b) => a.cueIndex - b.cueIndex);
}
