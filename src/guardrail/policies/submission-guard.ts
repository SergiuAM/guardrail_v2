import { ProposedAction, PageState, PolicyViolation, AgentContext } from '../../types';

const SUBMIT_PATTERNS = [
  /submit/i, /finalize/i, /complete/i, /process/i,
  /bind/i, /issue/i, /place order/i, /confirm purchase/i,
];

function isSubmissionAction(action: ProposedAction): boolean {
  if (action.type === 'submit') return true;
  if (action.type === 'click') {
    return SUBMIT_PATTERNS.some(p => p.test(action.target.text));
  }
  return false;
}

export function evaluateSubmission(
  action: ProposedAction,
  page: PageState,
  context: AgentContext
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  if (!isSubmissionAction(action)) return violations;

  violations.push({
    policyId: 'submission-autonomous-blocked',
    policyName: 'Autonomous Submission Prevention',
    severity: 'critical',
    message: `Agent attempted autonomous submission: "${action.target.text}". Final submissions must be human-initiated.`,
    suggestion: 'Flag for human review. The agent must never submit quotes, payments, or binding actions autonomously.',
  });

  const pageUrl = page.url;
  if (context.submittedForms.includes(pageUrl)) {
    violations.push({
      policyId: 'submission-duplicate',
      policyName: 'Duplicate Submission Prevention',
      severity: 'critical',
      message: `This form/page (${pageUrl}) has already been submitted in this session.`,
      suggestion: 'Do not submit again. Navigate to dashboard or start a new quote.',
    });
  }

  if (page.hasValidationErrors) {
    violations.push({
      policyId: 'submission-with-errors',
      policyName: 'Submission With Errors Prevention',
      severity: 'high',
      message: `Cannot submit: page has validation errors: ${(page.errorMessages ?? []).join(', ')}.`,
      suggestion: 'Fix all validation errors before attempting submission.',
    });
  }

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


