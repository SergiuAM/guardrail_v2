import {
  ProposedAction, AgentContext, GuardrailDecision,
  GuardrailVerdict, PolicyViolation, RiskLevel,
} from '../types';
import { evaluateActionRisk, classifyActionRisk } from './policies/action-risk';
import { evaluateWorkflowCompliance } from './policies/workflow-guard';
import { evaluateLoopRisk } from './policies/loop-detector';
import { evaluatePageSafety, evaluateEnvironment } from './policies/page-classifier';
import { evaluateSubmission } from './policies/submission-guard';
import { evaluateStalePage } from './policies/stale-page-guard';

export class GuardrailEngine {
  private evaluationLog: GuardrailDecision[] = [];

  evaluate(action: ProposedAction, context: AgentContext): GuardrailDecision {
    const allViolations: PolicyViolation[] = [];

    allViolations.push(...evaluateActionRisk(action, context.currentPage));
    allViolations.push(...evaluateWorkflowCompliance(action, context.currentPage));
    allViolations.push(...evaluateLoopRisk(action, context.actionHistory));
    allViolations.push(...evaluatePageSafety(action, context.currentPage));
    allViolations.push(...evaluateSubmission(action, context.currentPage, context));
    allViolations.push(...evaluateStalePage(action, context.currentPage, context.previousPages));
    allViolations.push(...evaluateEnvironment(context.currentPage));

    const riskLevel = classifyActionRisk(action, context.currentPage);
    const verdict = this.determineVerdict(allViolations, riskLevel);
    const reasoning = this.buildReasoning(allViolations, riskLevel, verdict);

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

  private determineVerdict(violations: PolicyViolation[], riskLevel: RiskLevel): GuardrailVerdict {
    if (violations.length === 0) return 'ALLOW';

    const hasCritical = violations.some(v => v.severity === 'critical');
    const hasHigh = violations.some(v => v.severity === 'high');
    const hasMedium = violations.some(v => v.severity === 'medium');

    if (hasCritical) return 'BLOCK';
    if (hasHigh) return 'BLOCK';
    if (hasMedium) return 'FLAG';

    return 'ALLOW';
  }

  private buildReasoning(
    violations: PolicyViolation[],
    riskLevel: RiskLevel,
    verdict: GuardrailVerdict
  ): string {
    if (violations.length === 0) {
      return `Action classified as ${riskLevel} risk. No policy violations detected. Allowing execution.`;
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


