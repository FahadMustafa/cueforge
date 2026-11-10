/**
 * Rule 3 (spec §5.2): `max-cps` — characters per second. The character count
 * excludes configurable characters: line breaks by default (`excludeLineBreaks`,
 * default true), plus any code-point ranges in `excludeRanges` (the Arabic preset
 * excludes diacritics U+064B–U+065F). Cues with a non-positive duration are
 * skipped (timing rules catch those separately).
 *
 * Auto-fix is the "CPS assist" (cue-forge-n3e.4): a too-fast cue's end is
 * extended forward to exactly the duration that brings reading speed down to the
 * max. The extension is capped by the gap to the next cue (less {@link
 * FIX_GAP_FLOOR_MS}) and a conservative max-duration ceiling, and the fix
 * declines (leaves the cue untouched) when it cannot reach that end — so it never
 * overlaps, never creates a min-gap or max-duration violation, and never shrinks.
 */

import { lineToText } from '../../model/cue';
import type { Cue } from '../../model/types';
import { BIDI_CONTROL_RANGES } from '../../rtl';
import type { RuleDefinition, RuleViolation } from '../rule';
import type { MaxCpsConfig } from '../ruleset.schema';
import { FIX_GAP_FLOOR_MS } from './durations';

/**
 * Conservative ceiling for the CPS-assist extension (zero-new-issues invariant,
 * spec §5.1). A fixer sees only its own config, so it cannot read the preset's
 * max-duration. 7000 ms matches the strictest shipped preset (Netflix), so the
 * extension can never produce a max-duration violation under any preset.
 */
export const FIX_MAX_DURATION_CEILING_MS = 7000;

function inRanges(code: number, ranges: [number, number][]): boolean {
  for (const [lo, hi] of ranges) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

function countedChars(text: string, ranges: [number, number][]): number {
  let n = 0;
  for (const ch of text) {
    if (ranges.length > 0 && inRanges(ch.codePointAt(0)!, ranges)) continue;
    n++;
  }
  return n;
}

/**
 * Counted characters for a cue, mirroring {@link maxCps.evaluate}. The invisible
 * bidi control marks are always excluded (on top of the configured ranges) so
 * the RTL fixers' inserted marks never change reading speed.
 */
function cueChars(cue: Cue, excludeLineBreaks: boolean, configRanges: [number, number][]): number {
  const ranges = [...BIDI_CONTROL_RANGES, ...configRanges];
  let chars = cue.lines.reduce((sum, line) => sum + countedChars(lineToText(line), ranges), 0);
  if (!excludeLineBreaks) chars += Math.max(0, cue.lines.length - 1);
  return chars;
}

export const maxCps: RuleDefinition<'max-cps'> = {
  id: 'max-cps',
  fixable: true,
  evaluate(doc, config: MaxCpsConfig) {
    const excludeLineBreaks = config.excludeLineBreaks ?? true;
    const ranges = config.excludeRanges ?? [];
    const out: RuleViolation[] = [];

    for (const cue of doc.cues) {
      const durationSec = (cue.endMs - cue.startMs) / 1000;
      if (durationSec <= 0) continue;

      const chars = cueChars(cue, excludeLineBreaks, ranges);

      const cps = chars / durationSec;
      if (cps > config.max) {
        out.push({
          cueIndex: cue.index,
          message: `Reading speed is ${cps.toFixed(1)} cps (max ${config.max}).`,
        });
      }
    }
    return out;
  },
  // Extend the end to the duration needed for cps <= max, but only as far as the
  // gap and the max-duration ceiling allow; otherwise leave the cue flagged.
  fix(doc, config) {
    const excludeLineBreaks = config.excludeLineBreaks ?? true;
    const ranges = config.excludeRanges ?? [];
    const cues = doc.cues.map((cue, i) => {
      const durationSec = (cue.endMs - cue.startMs) / 1000;
      if (durationSec <= 0) return cue;
      const chars = cueChars(cue, excludeLineBreaks, ranges);
      if (chars / durationSec <= config.max) return cue;

      // Smallest end that brings cps down to the max (ceil so cps lands <= max).
      const neededEnd = cue.startMs + Math.ceil((chars / config.max) * 1000);
      const next = doc.cues[i + 1];
      const limit = Math.min(
        next ? next.startMs - FIX_GAP_FLOOR_MS : Infinity,
        cue.startMs + FIX_MAX_DURATION_CEILING_MS,
      );
      // Only extend (never shrink) and only if the needed end fits the limit.
      if (neededEnd <= cue.endMs || neededEnd > limit) return cue;
      return { ...cue, endMs: neededEnd };
    });
    return { ...doc, cues };
  },
};
