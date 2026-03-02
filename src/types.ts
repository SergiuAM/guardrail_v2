// Page & UI Element Types

export type PageType =
  | 'QUOTE_FORM'
  | 'LOGIN'
  | 'ERROR'
  | 'CONFIRMATION'
  | 'UNKNOWN';

export type Environment = 'production' | 'test' | 'unknown';

export interface UIElement {
  id: string;
  tag: string;
  text: string;
  type?: string;
  classes?: string[];
  disabled?: boolean;
  visible?: boolean;
  attributes?: Record<string, string>;
}

export interface PageState {
  url: string;
  title: string;
  pageType: PageType;
  environment: Environment;
  fields: UIElement[];
  buttons: UIElement[];
  links: UIElement[];
  visibleText: string;
  hasValidationErrors?: boolean;
  errorMessages?: string[];
  timestamp: number;
}

// Action Types

export type ActionType = 'click' | 'fill' | 'select' | 'submit' | 'wait';

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface ProposedAction {
  id: string;
  type: ActionType;
  target: UIElement;
  value?: string;
  description: string;
  timestamp: number;
}

// Guardrail Decision Types

export type GuardrailVerdict = 'ALLOW' | 'BLOCK' | 'FLAG';

export interface PolicyViolation {
  policyId: string;
  policyName: string;
  severity: RiskLevel;
  message: string;
  suggestion?: string;
}

export interface GuardrailDecision {
  verdict: GuardrailVerdict;
  action: ProposedAction;
  riskLevel: RiskLevel;
  violations: PolicyViolation[];
  reasoning: string;
  timestamp: number;
}

// Site Configuration Types

export interface ElementRule {
  text?: string;
  selector?: string;
  urlPattern?: string;
  severity?: RiskLevel;
  reason: string;
}

export interface PolicySettings {
  enabled: boolean;
  maxIdenticalActions?: number;
  maxActionsPerMinute?: number;
  maxPageAgeMs?: number;
  submissionSeverity?: RiskLevel;
}

export interface SiteConfig {
  siteId: string;
  displayName: string;
  urlPatterns: string[];

  // Element-level rules
  whitelistedElements: ElementRule[];
  blacklistedElements: ElementRule[];

  // Pattern lists (all patterns are case-insensitive regex strings)
  destructivePatterns: string[];
  irreversiblePatterns: string[];
  submissionPatterns: string[];
  safePatterns: string[];

  // Page type detection hints (CSS selectors)
  pageTypeIndicators?: {
    confirmation?: string[];
    error?: string[];
    login?: string[];
  };

  // Per-policy settings
  policySettings: {
    destructiveActionGuard: PolicySettings;
    submissionGuard: PolicySettings;
    pageSafetyGuard: PolicySettings;
    loopDetector: PolicySettings;
  };
}

// Carrier Config Override (raw JSON format — merged with default by config-loader)

export interface CarrierConfigOverride {
  siteId: string;
  displayName: string;
  extends: 'default';
  urlPatterns: string[];

  // Element-level rules (carrier-specific)
  whitelistedElements?: ElementRule[];
  blacklistedElements?: ElementRule[];

  // Add/remove patterns relative to default
  addDestructivePatterns?: string[];
  removeDestructivePatterns?: string[];
  addIrreversiblePatterns?: string[];
  removeIrreversiblePatterns?: string[];
  addSubmissionPatterns?: string[];
  removeSubmissionPatterns?: string[];
  addSafePatterns?: string[];

  // Page type detection hints (CSS selectors)
  pageTypeIndicators?: {
    confirmation?: string[];
    error?: string[];
    login?: string[];
  };

  // Per-policy overrides (partial — only what differs from default)
  policySettings?: Partial<{
    destructiveActionGuard: Partial<PolicySettings>;
    submissionGuard: Partial<PolicySettings>;
    pageSafetyGuard: Partial<PolicySettings>;
    loopDetector: Partial<PolicySettings>;
  }>;
}

// Agent Session Context

export interface ActionHistoryEntry {
  action: ProposedAction;
  decision: GuardrailDecision;
  executedAt?: number;
  result?: 'success' | 'failure' | 'blocked';
}

export interface AgentContext {
  sessionId: string;
  actionHistory: ActionHistoryEntry[];
  currentPage: PageState;
  filledFields: Record<string, string>;
  startedAt: number;
}


