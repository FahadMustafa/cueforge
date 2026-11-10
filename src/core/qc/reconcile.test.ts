import { describe, expect, it } from 'vitest';
import { resolvedIssues } from './reconcile';
import type { QCIssue } from './types';

const issue = (cueIndex: number, message: string): QCIssue => ({
  ruleId: 'min-duration',
  cueIndex,
  message,
  severity: 'error',
  fixable: true,
});
const key = (issue: QCIssue) => `${issue.ruleId}:${issue.cueIndex}`;

describe('resolvedIssues', () => {
  it('matches exact messages before pairing changed measurements', () => {
    const baseline = [issue(1, 'changed'), issue(1, 'unchanged'), issue(1, 'removed')];
    expect(
      resolvedIssues(baseline, [issue(1, 'unchanged'), issue(1, 'new measurement')], key),
    ).toEqual([baseline[2]]);
  });

  it('counts identical occurrences and ignores unrelated new issues', () => {
    const repeated = issue(1, 'same');
    expect(resolvedIssues([repeated, repeated], [repeated, issue(2, 'new')], key)).toEqual([
      repeated,
    ]);
  });

  it('handles empty baselines, resolved document-level issues, and retained document-level issues', () => {
    const documentIssue = issue(-1, 'document');
    expect(resolvedIssues([], [documentIssue], key)).toEqual([]);
    expect(resolvedIssues([documentIssue], [], key)).toEqual([documentIssue]);
    expect(resolvedIssues([documentIssue], [issue(-1, 'changed')], key)).toEqual([]);
  });

  it('uses the supplied identity mappings rather than renumbered indices', () => {
    const original = issue(3, 'short');
    expect(
      resolvedIssues(
        [original],
        [issue(2, 'longer but still short')],
        () => 'stable',
        () => 'stable',
      ),
    ).toEqual([]);
  });
});
