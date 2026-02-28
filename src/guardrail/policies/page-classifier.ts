import { PageState, PolicyViolation, ProposedAction } from '../../types';

export function evaluatePageSafety(
  action: ProposedAction,
  page: PageState
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  if (page.hasValidationErrors && (action.type === 'submit' || action.type === 'click')) {
    const isSubmitLike = /submit|next|continue|finalize/i.test(action.target.text);
    if (isSubmitLike) {
      violations.push({
        policyId: 'page-validation-errors',
        policyName: 'Validation Error Prevention',
        severity: 'high',
        message: `Page has validation errors: ${(page.errorMessages ?? []).join('; ')}. Cannot advance.`,
        suggestion: 'Fix the validation errors before attempting to proceed.',
      });
    }
  }

  if (page.pageType === 'LOGIN') {
    violations.push({
      policyId: 'page-login-detected',
      policyName: 'Login Page Detection',
      severity: 'high',
      message: 'Agent is on a login page. Session may have expired or agent navigated incorrectly.',
      suggestion: 'Escalate to human. Agent should not handle authentication.',
    });
  }

  if (page.pageType === 'ERROR') {
    if (action.type !== 'click' || !/retry|try again|go.*home|dashboard/i.test(action.target.text)) {
      violations.push({
        policyId: 'page-error-state',
        policyName: 'Error Page Detection',
        severity: 'medium',
        message: `Page is in error state: ${(page.errorMessages ?? ['Unknown error']).join('; ')}.`,
        suggestion: 'Only retry or navigate home actions are safe on error pages.',
      });
    }
  }

  if (page.pageType === 'ADMIN') {
    violations.push({
      policyId: 'page-admin-access',
      policyName: 'Admin Page Prevention',
      severity: 'critical',
      message: `Agent is on an admin page: "${page.title}". This is outside the expected workflow scope.`,
      suggestion: 'Navigate back to the form flow immediately. Agent must never interact with admin pages.',
    });
  }

  if (page.pageType === 'CONFIRMATION') {
    const isSubmit = /submit|finalize|process|bind/i.test(action.target.text);
    if (isSubmit) {
      violations.push({
        policyId: 'page-post-confirmation-submit',
        policyName: 'Post-Confirmation Action Prevention',
        severity: 'high',
        message: 'Attempted submission action on a confirmation page. The quote is already submitted.',
        suggestion: 'No further submissions needed. Only navigate to dashboard or start new quote.',
      });
    }
  }

  return violations;
}

export function evaluateEnvironment(page: PageState): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  if (page.environment === 'unknown') {
    violations.push({
      policyId: 'env-unknown',
      policyName: 'Unknown Environment Warning',
      severity: 'medium',
      message: `Cannot determine environment for URL: ${page.url}.`,
      suggestion: 'Verify the environment before proceeding with any actions.',
    });
  }

  return violations;
}


