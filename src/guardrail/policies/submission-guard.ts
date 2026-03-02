import { ProposedAction, PageState, PolicyViolation, AgentContext, SiteConfig } from '../../types';

function isSubmissionAction(action: ProposedAction, config: SiteConfig): boolean {
  if (action.type === 'submit') return true;
  if (action.type === 'click') {
    const patterns = config.submissionPatterns.map(s => new RegExp(s, 'i'));
    return patterns.some(p => p.test(action.target.text));
  }
  return false;
}

export function evaluateSubmission(
  action: ProposedAction,
  page: PageState,
  context: AgentContext,
  config: SiteConfig
): PolicyViolation[] {
  if (!config.policySettings.submissionGuard.enabled) return [];
  if (!isSubmissionAction(action, config)) return [];

  const violations: PolicyViolation[] = [];
  const severity = config.policySettings.submissionGuard.submissionSeverity ?? 'critical';

  // ── Autonomous submission: always blocked ──
  violations.push({
    policyId: 'submission-autonomous-blocked',
    policyName: 'Autonomous Submission Prevention',
    severity,
    message: `Agent attempted autonomous submission: "${action.target.text}". Final submissions must be human-initiated.`,
    suggestion: 'Flag for human review. The agent must never submit quotes, payments, or binding actions autonomously.',
  });

  // ── Submission on confirmation page ──
  if (page.pageType === 'CONFIRMATION') {
    violations.push({
      policyId: 'submission-post-confirmation',
      policyName: 'Post-Confirmation Submission Prevention',
      severity: 'high',
      message: 'Attempted submission on a confirmation page. The quote is already submitted.',
      suggestion: 'No further submissions needed. Only navigate to dashboard or start new quote.',
    });
  }

  // ── Submission with validation errors ──
  if (page.hasValidationErrors) {
    violations.push({
      policyId: 'submission-with-errors',
      policyName: 'Submission With Errors Prevention',
      severity: 'high',
      message: `Cannot submit: page has validation errors: ${(page.errorMessages ?? []).join(', ')}.`,
      suggestion: 'Fix all validation errors before attempting submission.',
    });
  }

  // ── Submission with incomplete required fields ──
  const requiredFields = page.fields.filter(f => f.attributes?.required === 'true');
  const emptyRequired = requiredFields.filter(f => {
    const val = f.attributes?.value ?? '';
    return val.trim() === '';
  });

  if (emptyRequired.length > 0) {
    violations.push({
      policyId: 'submission-incomplete-form',
      policyName: 'Incomplete Form Submission Prevention',
      severity: 'high',
      message: `Cannot submit: ${emptyRequired.length} required field(s) are empty: ${emptyRequired.map(f => f.text).join(', ')}.`,
      suggestion: 'Fill all required fields before submission.',
    });
  }

  return violations;
}
