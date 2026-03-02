import {
  ProposedAction, PageState, PolicyViolation, RiskLevel, SiteConfig, ElementRule,
} from '../../types';

// ── Default patterns (used when no site-specific config overrides them) ──

const DESTRUCTIVE_PATTERNS = [
  /delete/i, /remove/i, /cancel/i, /reset/i, /clear all/i,
  /destroy/i, /terminate/i, /revoke/i, /purge/i,
];

const IRREVERSIBLE_PATTERNS = [
  /process payment/i, /charge/i, /bind policy/i, /issue/i,
  /delete all/i, /remove all/i, /purge/i,
];

const SUBMISSION_PATTERNS = [
  /submit/i, /finalize/i, /confirm purchase/i, /place order/i,
  /process payment/i, /bind/i, /issue policy/i,
];

// ── Helpers ──

function matchesPatterns(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

function toRegexArray(strings: string[]): RegExp[] {
  return strings.map(s => new RegExp(s, 'i'));
}

function elementMatchesRule(action: ProposedAction, page: PageState, rule: ElementRule): boolean {
  const text = action.target.text?.toLowerCase() ?? '';
  const classes = action.target.classes?.join(' ') ?? '';

  if (rule.text && !text.includes(rule.text.toLowerCase())) return false;
  if (rule.selector && !classes.includes(rule.selector)) return false;
  if (rule.urlPattern) {
    const urlRegex = rule.urlPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    if (!new RegExp(urlRegex, 'i').test(page.url)) return false;
  }

  return true;
}

// ── Risk Classification ──

export function classifyActionRisk(
  action: ProposedAction,
  page: PageState,
  config: SiteConfig
): RiskLevel {
  const text = `${action.target.text} ${action.value ?? ''}`;
  const targetClasses = action.target.classes?.join(' ') ?? '';

  // Check whitelist first — whitelisted elements are always safe
  const isWhitelisted = config.whitelistedElements.some(rule =>
    elementMatchesRule(action, page, rule)
  );
  if (isWhitelisted) return 'safe';

  // Check blacklist — blacklisted elements use their configured severity
  const blacklistMatch = config.blacklistedElements.find(rule =>
    elementMatchesRule(action, page, rule)
  );
  if (blacklistMatch) return blacklistMatch.severity ?? 'high';

  // Build patterns: defaults + custom from config
  const destructive = [
    ...DESTRUCTIVE_PATTERNS,
    ...toRegexArray(config.customDestructivePatterns ?? []),
  ];
  const irreversible = IRREVERSIBLE_PATTERNS;

  if (action.type === 'submit') return 'high';
  if (matchesPatterns(text, irreversible)) return 'critical';
  if (matchesPatterns(text, destructive)) return 'high';
  if (targetClasses.includes('btn-danger')) return 'high';
  if (matchesPatterns(text, SUBMISSION_PATTERNS)) return 'high';

  // Check custom safe patterns from config
  const safePatterns = toRegexArray(config.customSafePatterns ?? []);
  if (matchesPatterns(text, safePatterns)) return 'safe';

  if (action.type === 'fill') return 'safe';
  if (action.type === 'wait') return 'safe';
  if (action.type === 'click') return 'low';
  if (action.type === 'select') return 'low';

  return 'low';
}

// ── Violation Detection ──

export function evaluateDestructiveAction(
  action: ProposedAction,
  page: PageState,
  config: SiteConfig
): PolicyViolation[] {
  if (!config.policySettings.destructiveActionGuard.enabled) return [];

  const violations: PolicyViolation[] = [];
  const text = action.target.text;
  const targetClasses = action.target.classes?.join(' ') ?? '';

  // ── Whitelist check: if element is whitelisted, skip all checks ──
  const whitelistMatch = config.whitelistedElements.find(rule =>
    elementMatchesRule(action, page, rule)
  );
  if (whitelistMatch) return [];

  // ── Blacklist check: if element is blacklisted, always flag it ──
  const blacklistMatch = config.blacklistedElements.find(rule =>
    elementMatchesRule(action, page, rule)
  );
  if (blacklistMatch) {
    violations.push({
      policyId: 'destructive-blacklisted-element',
      policyName: 'Blacklisted Element Detection',
      severity: blacklistMatch.severity ?? 'high',
      message: `Element "${text}" is blacklisted for this site. Reason: ${blacklistMatch.reason}`,
      suggestion: 'Do not interact with this element. It is marked as dangerous for this carrier.',
    });
    return violations;
  }

  // ── Field overwrite detection ──
  if (action.type === 'fill' || action.type === 'select') {
    const targetField = page.fields.find(f => f.id === action.target.id);
    if (targetField) {
      const currentValue = (targetField.attributes?.value ?? '').trim();
      const isPlaceholder = !currentValue
        || /^--\s*select/i.test(currentValue)
        || /^choose/i.test(currentValue)
        || /^please select/i.test(currentValue)
        || /^[0-9]{10,}$/.test(currentValue)
        || /^[a-f0-9]{24,}$/i.test(currentValue)
        || /^PLACEHOLDER/i.test(currentValue);

      if (currentValue !== '' && !isPlaceholder) {
        violations.push({
          policyId: 'destructive-field-overwrite',
          policyName: 'Field Overwrite Detection',
          severity: 'medium',
          message: `Field "${targetField.text}" already has value "${currentValue}". Agent is attempting to overwrite with "${action.value ?? ''}".`,
          suggestion: 'Only overwrite filled fields if explicitly requested by the user.',
        });
      }
    }
  }

  // ── Destructive click detection (defaults + custom patterns) ──
  const destructive = [
    ...DESTRUCTIVE_PATTERNS,
    ...toRegexArray(config.customDestructivePatterns ?? []),
  ];

  if (action.type === 'click' && matchesPatterns(text, destructive)) {
    violations.push({
      policyId: 'destructive-action-click',
      policyName: 'Destructive Action Prevention',
      severity: 'high',
      message: `Attempted to click destructive button: "${text}"`,
      suggestion: 'Skip this action. If deletion is intended, require explicit human confirmation.',
    });
  }

  // ── Danger-styled button detection ──
  if (targetClasses.includes('btn-danger') && action.type === 'click') {
    violations.push({
      policyId: 'destructive-danger-class',
      policyName: 'Danger-Styled Button Prevention',
      severity: 'high',
      message: `Button "${text}" has danger styling (btn-danger class), indicating a destructive action.`,
      suggestion: 'Never click danger-styled buttons autonomously.',
    });
  }

  // ── Irreversible action detection ──
  if (matchesPatterns(text, IRREVERSIBLE_PATTERNS)) {
    violations.push({
      policyId: 'destructive-irreversible',
      policyName: 'Irreversible Action Prevention',
      severity: 'critical',
      message: `Action "${text}" appears irreversible (payment, policy binding, or mass deletion).`,
      suggestion: 'This action requires explicit human authorization before execution.',
    });
  }

  return violations;
}

