import type { QCIssue } from './types';

export function resolvedIssues(
  before: QCIssue[],
  after: QCIssue[],
  beforeKey: (issue: QCIssue) => string,
  afterKey: (issue: QCIssue) => string = beforeKey,
): QCIssue[] {
  const counts = new Map<string, number>();
  const exactCounts = new Map<string, number>();
  for (const issue of after) {
    const key = afterKey(issue);
    const exact = JSON.stringify([key, issue.message]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    exactCounts.set(exact, (exactCounts.get(exact) ?? 0) + 1);
  }
  const unmatched = before.filter((issue) => {
    const key = beforeKey(issue);
    const exact = JSON.stringify([key, issue.message]);
    const count = exactCounts.get(exact) ?? 0;
    if (count === 0) return true;
    exactCounts.set(exact, count - 1);
    counts.set(key, counts.get(key)! - 1);
    return false;
  });
  return unmatched.filter((issue) => {
    const key = beforeKey(issue);
    const count = counts.get(key) ?? 0;
    if (count === 0) return true;
    counts.set(key, count - 1);
    return false;
  });
}
