import { ProposedAction, RiskLevel, PolicyViolation, PageState } from '../../types';

const DESTRUCTIVE_PATTERNS = [
  /delete/i, /remove/i, /cancel/i, /reset/i, /clear all/i,
  /destroy/i, /terminate/i, /revoke/i, /purge/i,
];

const SUBMISSION_PATTERNS = [
  /submit/i, /finalize/i, /confirm purchase/i, /place order/i,
  /process payment/i, /bind/i, /issue policy/i,
];

const IRREVERSIBLE_PATTERNS = [
  /process payment/i, /charge/i, /bind policy/i, /issue/i,
  /delete all/i, /remove all/i, /purge/i,
];

const NAVIGATION_RISK_PATTERNS = [
  /admin/i, /settings/i, /system/i, /configuration/i,
  /user management/i, /billing/i,
];

function matchesPatterns(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

export function classifyActionRisk(action: ProposedAction, page: PageState): RiskLevel {
  const text = `${action.target.text} ${action.value ?? ''}`;
  const targetClasses = action.target.classes?.join(' ') ?? '';

  if (action.type === 'submit') return 'high';
  if (matchesPatterns(text, IRREVERSIBLE_PATTERNS)) return 'critical';
  if (matchesPatterns(text, DESTRUCTIVE_PATTERNS)) return 'high';
  if (targetClasses.includes('btn-danger')) return 'high';
  if (matchesPatterns(text, SUBMISSION_PATTERNS)) return 'high';
  if (action.type === 'navigate' && matchesPatterns(text, NAVIGATION_RISK_PATTERNS)) return 'medium';
  if (action.type === 'fill') return 'safe';
  if (action.type === 'wait') return 'safe';
  if (action.type === 'click') return 'low';
  if (action.type === 'select') return 'low';

  return 'low';
}

export function evaluateActionRisk(
  action: ProposedAction,
  page: PageState
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const text = action.target.text;
  const targetClasses = action.target.classes?.join(' ') ?? '';

  if (action.type === 'click' && matchesPatterns(text, DESTRUCTIVE_PATTERNS)) {
    violations.push({
      policyId: 'action-risk-destructive',
      policyName: 'Destructive Action Prevention',
      severity: 'high',
      message: `Attempted to click destructive button: "${text}"`,
      suggestion: `Skip this action. If deletion is intended, require explicit human confirmation.`,
    });
  }

  if (targetClasses.includes('btn-danger') && action.type === 'click') {
    violations.push({
      policyId: 'action-risk-danger-class',
      policyName: 'Danger-Styled Button Prevention',
      severity: 'high',
      message: `Button "${text}" has danger styling (btn-danger class), indicating a destructive action.`,
      suggestion: 'Never click danger-styled buttons autonomously.',
    });
  }

  if (matchesPatterns(text, IRREVERSIBLE_PATTERNS)) {
    violations.push({
      policyId: 'action-risk-irreversible',
      policyName: 'Irreversible Action Prevention',
      severity: 'critical',
      message: `Action "${text}" appears irreversible (payment, policy binding, or mass deletion).`,
      suggestion: 'This action requires explicit human authorization before execution.',
    });
  }

  if (action.type === 'submit' || (action.type === 'click' && matchesPatterns(text, SUBMISSION_PATTERNS))) {
    if (page.pageType === 'PAYMENT') {
      violations.push({
        policyId: 'action-risk-payment-submit',
        policyName: 'Payment Submission Prevention',
        severity: 'critical',
        message: `Attempted to submit payment on a payment page. Financial transactions must be human-initiated.`,
        suggestion: 'Flag this for human review. Agent must never process payments autonomously.',
      });
    }
  }

  return violations;
}


