/**
 * The shipped QC presets (spec §5.4), loaded from JSON data files and validated
 * against the ruleset schema at module load — a malformed preset fails fast. The
 * seed values are engineering defaults marked `verified: false`; the human owner
 * verifies each against current platform docs (the preset's `reference`) before
 * launch. `netflix-arabic` ships in M4 with the RTL rules.
 */

import { parseRuleset, type Ruleset } from '../ruleset.schema';
import generic from './generic.json';
import netflixLatin from './netflix-latin.json';
import youtube from './youtube.json';
import netflixArabic from './netflix-arabic.json';

export const PRESETS = {
  generic: parseRuleset(generic),
  'netflix-latin': parseRuleset(netflixLatin),
  youtube: parseRuleset(youtube),
  'netflix-arabic': parseRuleset(netflixArabic),
} satisfies Record<string, Ruleset>;

export type PresetName = keyof typeof PRESETS;

/** The default preset for the Free-tier basic QC report (spec §4.1 #4). */
export const DEFAULT_PRESET: PresetName = 'generic';
