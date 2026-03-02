import { ProposedAction, PageState, PolicyViolation, SiteConfig } from '../../types';

export function evaluatePageSafety(
  action: ProposedAction,
  page: PageState,
  config: SiteConfig
): PolicyViolation[] {
  if (!config.policySettings.pageSafetyGuard.enabled) return [];

  const violations: PolicyViolation[] = [];

  // ── Login page: agent should not be here ──
  if (page.pageType === 'LOGIN') {
    violations.push({
      policyId: 'page-login-detected',
      policyName: 'Login Page Detection',
      severity: 'high',
      message: 'Agent is on a login page. Session may have expired or agent navigated incorrectly.',
      suggestion: 'Escalate to human. Agent should not handle authentication.',
    });
  }

  // ── Error page: only allow retry/go-home actions ──
  if (page.pageType === 'ERROR') {
    const isSafeAction = action.type === 'click'
      && /retry|try again|go.*home|dashboard/i.test(action.target.text);

    if (!isSafeAction) {
      violations.push({
        policyId: 'page-error-state',
        policyName: 'Error Page Detection',
        severity: 'medium',
        message: `Page is in error state: ${(page.errorMessages ?? ['Unknown error']).join('; ')}.`,
        suggestion: 'Only retry or navigate home actions are safe on error pages.',
      });
    }
  }

  // ── Validation errors + submit attempt ──
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

  // ── Unknown environment ──
  if (page.environment === 'unknown') {
    violations.push({
      policyId: 'page-unknown-environment',
      policyName: 'Unknown Environment Warning',
      severity: 'medium',
      message: `Cannot determine environment for URL: ${page.url}.`,
      suggestion: 'Verify the environment before proceeding with any actions.',
    });
  }

  // ── Stale page detection ──
  const maxAge = config.policySettings.pageSafetyGuard.maxPageAgeMs ?? 300000;
  const pageAge = Date.now() - page.timestamp;
  if (pageAge > maxAge) {
    violations.push({
      policyId: 'page-stale',
      policyName: 'Stale Page Detection',
      severity: 'medium',
      message: `Page is ${Math.round(pageAge / 1000)}s old (limit: ${Math.round(maxAge / 1000)}s). Page state may be outdated.`,
      suggestion: 'Refresh the page or re-scan the DOM before taking action.',
    });
  }

  return violations;
}

