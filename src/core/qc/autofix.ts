/**
 * Auto-fix framework (spec §5.1): `(doc, issues, options) => { doc, fixed,
 * unfixable }`. Pure and deterministic — it never mutates the input document.
 * Each fixable rule supplies a fixer that re-resolves all its violations; the
 * framework runs the enabled fixers in catalog order (deterministic) and
 * classifies every input issue as `fixed` or still `unfixable` after the final
 * evaluation. `resolvedCount` includes collateral resolutions of other rules;
 * `changed` distinguishes partial improvements from unchanged/declined fixes.
 *
 * Fixes are individually toggleable via {@link AutoFixOptions.enabled}: omit it
 * to fix every fixable rule, or pass an allowlist of rule ids (e.g. the QC panel
 * fixing one rule at a time).
 *
 * Two engine-level guarantees (the fixers themselves cannot provide them):
 *
 * 1. **Zero new issues.** A fixer only knows its own rule's config, so its
 *    conservative floors cannot encode cross-rule constraints (e.g. a min-gap
 *    shift shortening a cue past the preset's CPS limit). After each rule's fix
 *    the fully merged document is re-evaluated against the full ruleset. If any
 *    rule's issue count rises, globally or on an individual cue, the fix is
 *    reverted. Transaction-local identities survive renumbering (empty-cue),
 *    so a legitimate deletion is not mistaken for a new issue (cue-forge-sgh),
 *    but moving a violation to a different cue is still rejected.
 * 2. **Invisible cues are untouched.** `evaluate` hides non-Dialogue (ASS
 *    Comment) events from the rules, so fixers must not see them either: the
 *    empty-cue fix would delete "empty" comments and the timing fixes would
 *    shift dialogue around invisible 0-length events. Comments are extracted
 *    before each fixer and restored in their original relative order before
 *    validation. The complete merged result is renumbered together.
 *
 * {@link AutoFixOptions.protect} cues remain visible timing neighbors. Their
 * original content and timing are restored before validation, so a whole-doc
 * fixer cannot rewrite an accepted cue or exploit its absence to overlap it.
 * Internal identities do not depend on app UIDs and never escape the result.
 */

import type { Cue, SubtitleDocument } from '../model/types';
import { evaluate, isVisibleCue } from './evaluate';
import { resolvedIssues } from './reconcile';
import { RULES } from './rules';
import type { RuleRegistry } from './rule';
import { RULE_IDS, type Ruleset } from './ruleset.schema';
import type { QCIssue, RuleId } from './types';

export interface AutoFixOptions {
  /** Supplies each fixer its parameters; pair the ruleset that produced the issues. */
  ruleset: Ruleset;
  /** Rule ids to fix; omit to fix every fixable rule. Lets the UI toggle fixes. */
  enabled?: RuleId[];
  /**
   * Cues to shield from the (whole-document) fixers — the operator's accepted
   * "intentional" cues (cue-forge-n3e.7). Matched by object identity, so pass
   * cue objects from the same document. They remain visible timing neighbors;
   * only their indices may change when the full result is renumbered.
   */
  protect?: ReadonlySet<Cue>;
}

export interface AutoFixResult {
  doc: SubtitleDocument;
  fixed: QCIssue[];
  unfixable: QCIssue[];
  resolvedCount: number;
  changed: boolean;
}

/**
 * Per-rule and per-identity counts for the zero-new-issues invariant. Neither
 * cue indices nor issue messages are stable across a fix. Private identities
 * persist through spread-based fixers, including deletion and renumbering.
 */
function issueCounts(doc: SubtitleDocument, issues: QCIssue[]): Map<string, number> {
  const identities = new Map(doc.cues.map((cue) => [cue.index, (cue as TrackedCue)[cueIdentity]]));
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const identity = identities.get(issue.cueIndex) ?? 'document';
    for (const key of [issue.ruleId, `${issue.ruleId}:${identity}`]) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** True if any rule has more issues globally or on a particular cue. */
function introducesNewIssue(before: Map<string, number>, after: Map<string, number>): boolean {
  for (const [key, count] of after) {
    if (count > (before.get(key) ?? 0)) return true;
  }
  return false;
}

const cueIdentity = Symbol('autoFixCue');
type TrackedCue = Cue & { [cueIdentity]?: number };

function mergeCandidate(
  current: SubtitleDocument,
  candidate: SubtitleDocument,
  protectedIdentities: ReadonlySet<number>,
): SubtitleDocument | null {
  const visibleIdentities = new Set(
    current.cues.filter(isVisibleCue).map((cue) => (cue as TrackedCue)[cueIdentity]),
  );
  const replacements = new Map<number, Cue>();
  for (const cue of candidate.cues) {
    const identity = (cue as TrackedCue)[cueIdentity];
    if (identity === undefined || !visibleIdentities.has(identity) || replacements.has(identity)) {
      return null;
    }
    replacements.set(identity, cue);
  }
  const cues: Cue[] = [];
  for (const cue of current.cues) {
    const identity = (cue as TrackedCue)[cueIdentity]!;
    const restored =
      !isVisibleCue(cue) || protectedIdentities.has(identity) ? cue : replacements.get(identity);
    if (restored !== undefined) {
      const index = cues.length + 1;
      cues.push(restored.index === index ? restored : { ...restored, index });
    }
  }
  return { ...candidate, cues };
}

export function autoFix(
  doc: SubtitleDocument,
  issues: QCIssue[],
  options: AutoFixOptions,
  registry: Partial<RuleRegistry> = RULES,
): AutoFixResult {
  const allow = options.enabled ? new Set<RuleId>(options.enabled) : null;
  const fixed: QCIssue[] = [];
  const unfixable: QCIssue[] = [];

  const protectedIdentities = new Set<number>();
  const originalIdentities = new Map<number, number>();
  const tracked = doc.cues.map((cue, identity) => {
    if (options.protect?.has(cue)) protectedIdentities.add(identity);
    originalIdentities.set(cue.index, identity);
    return { ...cue, [cueIdentity]: identity };
  });

  let current: SubtitleDocument = { ...doc, cues: tracked };
  // Issue counts already flagged before the next fix runs — the baseline for
  // the zero-new-issues check. One full evaluation per *fixing* rule, well
  // inside the <1s full-QC budget (fixers are per-rule, not per-cue).
  const baseline = evaluate(current, options.ruleset, registry);
  let remaining = baseline;
  let known = issueCounts(current, baseline);

  for (const id of RULE_IDS) {
    const ruleIssues = issues.filter((i) => i.ruleId === id);
    if (ruleIssues.length === 0) continue;

    const def = registry[id];
    const config = options.ruleset.rules[id];
    const toggledOn = allow === null || allow.has(id);
    const canFix = def?.fix !== undefined && config !== undefined && def.fixable && toggledOn;

    if (!canFix) {
      continue;
    }

    // Config type matches the rule id by construction; the union is sound here.
    // A rule with a cue-local `fixCue` (cue-forge-zxw.12) is scoped to just the
    // cues named by the issues being fixed, so fix-one lands the clicked cue even
    // when the whole-document fix would be reverted by an unrelated cue. The
    // zero-new-issues guard below still runs doc-wide, so the scoping is safe.
    const visible = { ...current, cues: current.cues.filter(isVisibleCue) };
    let proposed: SubtitleDocument;
    if (def.fixCue !== undefined) {
      const targets = new Set(ruleIssues.map((issue) => originalIdentities.get(issue.cueIndex)));
      const fixOneCue = (cue: Cue): Cue =>
        (def.fixCue as (target: Cue, ruleConfig: typeof config) => Cue)(cue, config);
      proposed = {
        ...visible,
        cues: visible.cues.map((cue) => {
          const identity = (cue as TrackedCue)[cueIdentity]!;
          return targets.has(identity) && !protectedIdentities.has(identity) ? fixOneCue(cue) : cue;
        }),
      };
    } else {
      proposed = (
        def.fix as (input: SubtitleDocument, ruleConfig: typeof config) => SubtitleDocument
      )(visible, config);
    }
    const candidate = mergeCandidate(current, proposed, protectedIdentities);
    if (candidate === null) {
      continue;
    }
    const after = evaluate(candidate, options.ruleset, registry);
    const afterCounts = issueCounts(candidate, after);
    if (introducesNewIssue(known, afterCounts)) {
      // The fix would introduce a new issue (guarantee 1): revert it and leave
      // the rule's issues flagged, same as a fixer that declines.
      continue;
    }
    current = candidate;
    known = afterCounts;
    remaining = after;
  }

  const currentIdentities = new Map(
    current.cues.map((cue) => [cue.index, (cue as TrackedCue)[cueIdentity]]),
  );
  const beforeKey = (issue: QCIssue) =>
    `${issue.ruleId}:${originalIdentities.get(issue.cueIndex) ?? 'document'}`;
  const afterKey = (issue: QCIssue) =>
    `${issue.ruleId}:${currentIdentities.get(issue.cueIndex) ?? 'document'}`;
  const resolved = resolvedIssues(baseline, remaining, beforeKey, afterKey);
  const resolvedCounts = new Map<string, number>();
  const exactKey = (issue: QCIssue) => JSON.stringify([beforeKey(issue), issue.message]);
  const baselineKeys = new Set(baseline.map(exactKey));
  const resolvedExactCounts = new Map<string, number>();
  for (const issue of resolved) {
    const key = beforeKey(issue);
    resolvedCounts.set(key, (resolvedCounts.get(key) ?? 0) + 1);
    const exact = exactKey(issue);
    resolvedExactCounts.set(exact, (resolvedExactCounts.get(exact) ?? 0) + 1);
  }
  for (const issue of issues) {
    const key = beforeKey(issue);
    const count = resolvedCounts.get(key) ?? 0;
    const exact = exactKey(issue);
    const exactCount = resolvedExactCounts.get(exact) ?? 0;
    if (count > 0 && (exactCount > 0 || !baselineKeys.has(exact))) {
      fixed.push(issue);
      resolvedCounts.set(key, count - 1);
      if (exactCount > 0) resolvedExactCounts.set(exact, exactCount - 1);
    } else {
      unfixable.push(issue);
    }
  }

  const cues = current.cues.map((cue) => {
    const identity = (cue as TrackedCue)[cueIdentity]!;
    if (cue === tracked[identity]) return doc.cues[identity]!;
    const clean = { ...cue } as TrackedCue;
    delete clean[cueIdentity];
    return clean;
  });
  const output = { ...current, cues };
  const changed = JSON.stringify(output) !== JSON.stringify(doc);
  return { doc: changed ? output : doc, fixed, unfixable, resolvedCount: resolved.length, changed };
}
