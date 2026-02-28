import { ProposedAction, PageState, PolicyViolation } from '../../types';

const MAX_PAGE_AGE_MS = 5 * 60 * 1000;

export function evaluateStalePage(
  action: ProposedAction,
  currentPage: PageState,
  previousPages: PageState[]
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

  if (previousPages.length > 0) {
    const lastPage = previousPages[previousPages.length - 1];
    if (lastPage.url !== currentPage.url && action.target.id) {
      const targetExistsOnCurrent = currentPage.buttons.some(b => b.id === action.target.id)
        || currentPage.fields.some(f => f.id === action.target.id)
        || currentPage.links.some(l => l.id === action.target.id);

      if (!targetExistsOnCurrent) {
        violations.push({
          policyId: 'stale-target-missing',
          policyName: 'Target Element Missing',
          severity: 'high',
          message: `Action target "${action.target.id}" does not exist on the current page. Agent may be acting on stale page state.`,
          suggestion: 'Re-scan the current page before taking this action.',
        });
      }
    }
  }

  return violations;
}


