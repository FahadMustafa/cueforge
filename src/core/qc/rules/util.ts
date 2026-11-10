/** Shared helpers for rule implementations. */

/** Count Unicode code points (so a surrogate-pair emoji counts as one). */
export function countCodePoints(text: string): number {
  return [...text].length;
}
