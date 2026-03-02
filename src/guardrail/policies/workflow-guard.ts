import { ProposedAction, PageState, PolicyViolation, PageType } from '../../types';

const BLOCKED_PAGE_TYPES: PageType[] = ['LOGIN'];

export function evaluateWorkflowCompliance(
  action: ProposedAction,
  currentPage: PageState
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  if (BLOCKED_PAGE_TYPES.includes(currentPage.pageType)) {
    violations.push({
      policyId: 'workflow-blocked-page',
      policyName: 'Blocked Page Type',
      severity: 'high',
      message: `Agent is on a ${currentPage.pageType} page ("${currentPage.title}"), which is outside the expected workflow.`,
      suggestion: 'Navigate back to the form flow. Do not interact with login pages.',
    });
  }

  if (currentPage.pageType === 'CONFIRMATION') {
    const isSubmit = /submit|finalize|process|bind/i.test(action.target.text);
    if (isSubmit) {
      violations.push({
        policyId: 'workflow-post-confirmation',
        policyName: 'Post-Confirmation Action Prevention',
        severity: 'high',
        message: 'Attempted submission on a confirmation page. The quote is already submitted.',
        suggestion: 'No further submissions needed. Only navigate to dashboard or start new quote.',
      });
    }
  }

  return violations;
}
