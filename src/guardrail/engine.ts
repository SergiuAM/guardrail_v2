import {
  ProposedAction, AgentContext, GuardrailDecision,
  GuardrailVerdict, PolicyViolation, RiskLevel, SiteConfig,
} from '../types';
import { evaluateDestructiveAction, classifyActionRisk } from './policies/destructive-action-guard';
import { evaluateSubmission } from './policies/submission-guard';
import { evaluatePageSafety } from './policies/page-safety-guard';
import { evaluateLoopRisk } from './policies/loop-detector';

export class GuardrailEngine {
  evaluationLog: GuardrailDecision[] = [];

  evaluate(action: ProposedAction, context: AgentContext, config: SiteConfig): GuardrailDecision {
    const allViolations: PolicyViolation[] = [];

    allViolations.push(...evaluateDestructiveAction(action, context.currentPage, config));
    allViolations.push(...evaluateSubmission(action, context.currentPage, context, config));
    allViolations.push(...evaluatePageSafety(action, context.currentPage, config));
    allViolations.push(...evaluateLoopRisk(action, context.actionHistory, config));

    const riskLevel = classifyActionRisk(action, context.currentPage, config);
    const verdict = this.determineVerdict(allViolations);
    const reasoning = this.buildReasoning(allViolations, verdict);

    const decision: GuardrailDecision = {
      verdict,
      action,
      riskLevel,
      violations: allViolations,
      reasoning,
      timestamp: Date.now(),
    };

    this.evaluationLog.push(decision);
    return decision;
  }

  determineVerdict(violations: PolicyViolation[]): GuardrailVerdict {
    if (violations.length === 0) return 'ALLOW';

    const hasCritical = violations.some(v => v.severity === 'critical');
    const hasHigh = violations.some(v => v.severity === 'high');
    const hasMedium = violations.some(v => v.severity === 'medium');

    if (hasCritical) return 'BLOCK';
    if (hasHigh) return 'BLOCK';
    if (hasMedium) return 'FLAG';

    return 'ALLOW';
  }

  buildReasoning(violations: PolicyViolation[], verdict: GuardrailVerdict): string {
    if (violations.length === 0) {
      return 'No policy violations detected. Allowing execution.';
    }

    const critical = violations.filter(v => v.severity === 'critical');
    const high = violations.filter(v => v.severity === 'high');
    const medium = violations.filter(v => v.severity === 'medium');

    const parts: string[] = [];
    if (critical.length) parts.push(`${critical.length} CRITICAL violation(s)`);
    if (high.length) parts.push(`${high.length} HIGH violation(s)`);
    if (medium.length) parts.push(`${medium.length} MEDIUM violation(s)`);

    const topViolation = violations.sort(
      (a, b) => severityScore(b.severity) - severityScore(a.severity)
    )[0];

    return `${verdict}: ${parts.join(', ')}. Primary: ${topViolation.message}`;
  }

  reset() {
    this.evaluationLog = [];
  }
}

function severityScore(s: RiskLevel): number {
  switch (s) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    case 'safe': return 0;
  }
}
