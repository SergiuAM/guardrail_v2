import { ProposedAction, PageState, PolicyViolation } from '../../types';

const MAX_PAGE_AGE_MS = 5 * 60 * 1000;

export function evaluateStalePage(
  action: ProposedAction,
  currentPage: PageState,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  const pageAge = Date.now() - currentPage.timestamp;
  if (pageAge > MAX_PAGE_AGE_MS) {
    violations.push({
      policyId: 'stale-page-age',
      policyName: 'Stale Page Detection',
      severity: 'medium',
      message: `Current page is ${Math.round(pageAge / 1000)}s old. Page state may be outdated.`,
      suggestion: 'Refresh the page or re-scan the DOM before taking action.',
    });
  }

  return violations;
}
