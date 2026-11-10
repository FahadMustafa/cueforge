import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TEXT_FORMATS, type TextFormatId } from './registry';
import { convert, interpretedCapabilities, CAN } from './convert';
import type { Cue } from '../model/types';

/**
 * Cross-format conversion matrix (spec §6.3 #2). For every ordered pair of the
 * four text formats and every shared fixture, converting A → B must preserve the
 * cue count, keep timings within the target's precision, keep the visible text
 * identical after styling-capability mapping, and emit a warning for every
 * capability the target cannot express.
 */

const FORMATS: TextFormatId[] = ['srt', 'vtt', 'sbv', 'ass'];
const FIXTURE_NAMES = ['minimal', 'typical', 'edge', 'arabic'] as const;
/** Timing precision (ms) each format can represent. ASS is centisecond. */
const PRECISION: Record<TextFormatId, number> = { srt: 1, vtt: 1, sbv: 1, ass: 10 };

const fixtureDir = resolve(process.cwd(), 'fixtures');

function readFixture(fmt: TextFormatId, name: string): string {
  const ext = TEXT_FORMATS[fmt].extensions[0].replace('.', '');
  return readFileSync(resolve(fixtureDir, fmt, `${name}.${ext}`), 'utf8');
}

/** Visible text of a cue: span text per line, lines joined by newline. */
function plainText(cue: Cue): string {
  return cue.lines.map((l) => l.spans.map((s) => s.text).join('')).join('\n');
}

/** ASS Comment (non-Dialogue) events are dropped when leaving ASS (cue-forge-hop). */
function isDialogue(cue: Cue): boolean {
  if (cue.raw === null || typeof cue.raw !== 'object' || !('kind' in cue.raw)) return true;
  return (cue.raw as { kind?: unknown }).kind === 'Dialogue';
}

/**
 * Visible text the target should show for a source cue. Leaving ASS interprets
 * the text escapes: `\h` → no-break space, `\n` → line break (cue-forge-91u).
 */
function expectedText(cue: Cue, from: TextFormatId): string {
  const text = plainText(cue);
  return from === 'ass' ? text.replace(/\\h/g, '\u00A0').replace(/\\n/g, '\n') : text;
}

describe('cross-format conversion matrix preserves content within capability', () => {
  for (const from of FORMATS) {
    for (const to of FORMATS) {
      if (from === to) continue;
      describe(`${from} → ${to}`, () => {
        for (const name of FIXTURE_NAMES) {
          it(`${name} fixture`, () => {
            const src = readFixture(from, name);
            const docA = TEXT_FORMATS[from].parse(src);
            const result = convert(src, from, to);
            const docB = TEXT_FORMATS[to].parse(result.text);

            // Cue count preserved for visible cues (no merge rules apply to
            // these fixtures; ASS Comment events are dropped by conversion).
            const visibleA = docA.cues.filter(isDialogue);
            expect(docB.cues.length).toBe(visibleA.length);

            const tol = PRECISION[to];
            for (let i = 0; i < visibleA.length; i++) {
              const a = visibleA[i]!;
              const b = docB.cues[i]!;
              // Visible text identical after styling-capability mapping.
              expect(plainText(b)).toBe(expectedText(a, from));
              // Timings within the target format's precision.
              expect(Math.abs(b.startMs - a.startMs)).toBeLessThanOrEqual(tol);
              expect(Math.abs(b.endMs - a.endMs)).toBeLessThanOrEqual(tol);
            }

            // A warning is emitted for every dropped capability.
            const dropped = [...interpretedCapabilities(docA)].filter((c) => !CAN[to].has(c));
            for (const cap of dropped) {
              expect(result.warnings.some((w) => w.message.includes(cap))).toBe(true);
            }
          });
        }
      });
    }
  }
});
