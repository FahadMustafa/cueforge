/**
 * Rules 4–6 (spec §5.2): `min-duration`, `max-duration`, `min-gap`. All three are
 * auto-fixable (extend/trim toward gaps without creating overlaps). The duration
 * rules ignore reversed cues — `reversed-timing` owns those — and `min-gap`
 * ignores overlapping pairs, which `overlap` owns; each rule reports one concern.
 */

import { durationLabel } from '../format';
import type { RuleDefinition, RuleViolation } from '../rule';
import type { MinGapConfig } from '../ruleset.schema';

/**
 * Conservative floors for timing fixers (zero-new-issues invariant, spec §5.1).
 * A fixer receives only its own rule's config, so it cannot read the active
 * preset's min-duration / min-gap thresholds. These floors match the strictest
 * built-in preset (Netflix: 833 ms minimum duration, 2 frames ≈ 83 ms gap), so
 * a fix never creates a violation under any shipped preset; when a floor cannot
 * be honoured the fixer declines and the original issue stays flagged.
 */
export const FIX_DURATION_FLOOR_MS = 833;
export const FIX_GAP_FLOOR_MS = 100;

export const minDuration: RuleDefinition<'min-duration'> = {
  id: 'min-duration',
  fixable: true,
  evaluate(doc, config) {
    const fps = doc.metadata.frameRate;
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      const dur = cue.endMs - cue.startMs;
      if (dur < 0) continue;
      if (dur < config.ms) {
        out.push({
          cueIndex: cue.index,
          message: `Duration ${durationLabel(dur, fps)} is below ${durationLabel(config.ms, fps)}.`,
        });
      }
    }
    return out;
  },
  // Extend the end toward the next cue, stopping {@link FIX_GAP_FLOOR_MS} short
  // of its start so the extension cannot create an overlap or a new min-gap
  // violation. `Math.max` keeps the fix from ever shrinking the cue.
  fix(doc, config) {
    const cues = doc.cues.map((cue, i) => {
      const dur = cue.endMs - cue.startMs;
      if (dur < 0 || dur >= config.ms) return cue;
      const next = doc.cues[i + 1];
      const limit = next ? next.startMs - FIX_GAP_FLOOR_MS : Infinity;
      const endMs = Math.max(cue.endMs, Math.min(cue.startMs + config.ms, limit));
      return { ...cue, endMs };
    });
    return { ...doc, cues };
  },
};

export const maxDuration: RuleDefinition<'max-duration'> = {
  id: 'max-duration',
  fixable: true,
  evaluate(doc, config) {
    const fps = doc.metadata.frameRate;
    const out: RuleViolation[] = [];
    for (const cue of doc.cues) {
      const dur = cue.endMs - cue.startMs;
      if (dur > config.ms) {
        out.push({
          cueIndex: cue.index,
          message: `Duration ${durationLabel(dur, fps)} exceeds ${durationLabel(config.ms, fps)}.`,
        });
      }
    }
    return out;
  },
  // Trim the end so the cue is exactly the maximum length.
  fix(doc, config) {
    const cues = doc.cues.map((cue) =>
      cue.endMs - cue.startMs > config.ms ? { ...cue, endMs: cue.startMs + config.ms } : cue,
    );
    return { ...doc, cues };
  },
};

/**
 * The required gap in ms: frames at the document frame rate when both are known,
 * otherwise the `ms` fallback (spec §5.4: "2 frames @ doc fps (default 83 ms)").
 */
export function requiredGapMs(config: MinGapConfig, frameRate: number | undefined): number {
  if (config.frames !== undefined && frameRate) {
    return Math.round((config.frames / frameRate) * 1000);
  }
  return config.ms ?? 0;
}

export const minGap: RuleDefinition<'min-gap'> = {
  id: 'min-gap',
  fixable: true,
  evaluate(doc, config) {
    const fps = doc.metadata.frameRate;
    const required = requiredGapMs(config, fps);
    const out: RuleViolation[] = [];
    for (let i = 0; i + 1 < doc.cues.length; i++) {
      const cur = doc.cues[i]!;
      const next = doc.cues[i + 1]!;
      const gap = next.startMs - cur.endMs;
      // Negative gaps are overlaps (rule 7); only flag too-small non-negative gaps.
      if (gap >= 0 && gap < required) {
        out.push({
          cueIndex: next.index,
          message: `Gap before this cue is ${durationLabel(gap, fps)}; minimum ${durationLabel(required, fps)}.`,
        });
      }
    }
    return out;
  },
  // Create the gap without pushing either cue below {@link FIX_DURATION_FLOOR_MS}
  // (cue-forge-mz1: the old fix shortened the earlier cue below min-duration):
  // prefer moving the next cue's start forward, fall back to trimming the
  // earlier cue's end, otherwise decline and leave the pair flagged.
  // Overlapping pairs are left to the overlap fix.
  fix(doc, config) {
    const required = requiredGapMs(config, doc.metadata.frameRate);
    const cues = doc.cues.map((c) => ({ ...c }));
    for (let i = 0; i + 1 < cues.length; i++) {
      const cur = cues[i]!;
      const next = cues[i + 1]!;
      const gap = next.startMs - cur.endMs;
      if (gap < 0 || gap >= required) continue;
      const deficit = required - gap;
      if (next.endMs - (next.startMs + deficit) >= FIX_DURATION_FLOOR_MS) {
        next.startMs += deficit;
      } else if (next.startMs - required - cur.startMs >= FIX_DURATION_FLOOR_MS) {
        cur.endMs = next.startMs - required;
      }
    }
    return { ...doc, cues };
  },
};
