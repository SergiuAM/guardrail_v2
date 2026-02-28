// ── Page & UI Element Types ──────────────────────────────────────────────────

export type PageType =
  | 'QUOTE_FORM'
  | 'LOGIN'
  | 'ERROR'
  | 'CONFIRMATION'
  | 'ADMIN'
  | 'PAYMENT'
  | 'UNKNOWN';

export type Environment = 'production' | 'staging' | 'test' | 'sandbox' | 'unknown';

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
  hasUnsavedChanges?: boolean;
  hasValidationErrors?: boolean;
  errorMessages?: string[];
  timestamp: number;
}

// ── Action Types ─────────────────────────────────────────────────────────────

export type ActionType = 'click' | 'fill' | 'select' | 'navigate' | 'submit' | 'wait';

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface ProposedAction {
  id: string;
  type: ActionType;
  target: UIElement;
  value?: string;
  description: string;
  timestamp: number;
}

// ── Guardrail Decision Types ─────────────────────────────────────────────────

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

// ── Agent Session Context ────────────────────────────────────────────────────

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
  previousPages: PageState[];
  filledFields: Record<string, string>;
  submittedForms: string[];
  startedAt: number;
}


