import type { SubtitleDocument } from '../model/types';

/**
 * Charset-representability preflight for exports to legacy-charset targets
 * (CEA-608 for SCC, ISO 6937 for EBU-STL). The per-charset predicate lives with
 * its codec (lazy chunk); this module only walks the canonical document, so it
 * stays in the eager core bundle without pulling any codec in.
 */

export interface CharsetReport {
  /** Non-whitespace characters checked across all cue text. */
  total: number;
  /** Characters the target charset cannot represent. */
  unrepresentable: number;
  /** Up to three distinct examples of unrepresentable characters. */
  samples: string[];
  /** `unrepresentable / total` (0 for an empty document). */
  share: number;
}

const MAX_SAMPLES = 3;

/**
 * Count the document's non-whitespace characters that `canEncode` rejects.
 * Whitespace is skipped so the share reflects visible content only.
 */
export function checkCharset(
  doc: SubtitleDocument,
  canEncode: (ch: string) => boolean,
): CharsetReport {
  let total = 0;
  let unrepresentable = 0;
  const samples: string[] = [];
  for (const cue of doc.cues) {
    for (const line of cue.lines) {
      for (const span of line.spans) {
        for (const ch of span.text) {
          if (/\s/.test(ch)) continue;
          total++;
          if (canEncode(ch)) continue;
          unrepresentable++;
          if (samples.length < MAX_SAMPLES && !samples.includes(ch)) samples.push(ch);
        }
      }
    }
  }
  return { total, unrepresentable, samples, share: total === 0 ? 0 : unrepresentable / total };
}
