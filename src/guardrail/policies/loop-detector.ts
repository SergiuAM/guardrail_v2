import { ProposedAction, PolicyViolation, ActionHistoryEntry } from '../../types';

const MAX_IDENTICAL_ACTIONS = 3;
const MAX_ACTIONS_PER_MINUTE = 30;
const LOOP_WINDOW_MS = 60_000;

function actionsAreSimilar(a: ProposedAction, b: ProposedAction): boolean {
  return a.type === b.type
    && a.target.id === b.target.id
    && (a.value ?? '') === (b.value ?? '');
}

export function evaluateLoopRisk(
  proposedAction: ProposedAction,
  history: ActionHistoryEntry[]
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  const recentIdentical = history
    .slice(-10)
    .filter(h => actionsAreSimilar(h.action, proposedAction));

  if (recentIdentical.length >= MAX_IDENTICAL_ACTIONS) {
    violations.push({
      policyId: 'loop-identical-actions',
      policyName: 'Identical Action Loop Detection',
      severity: 'medium',
      message: `Action "${proposedAction.description}" has been attempted ${recentIdentical.length} times. Possible loop.`,
      suggestion: 'Skip this action and try something else, or advance to the next page.',
    });
  }

  const consecutiveSame: ActionHistoryEntry[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (actionsAreSimilar(history[i].action, proposedAction)) {
      consecutiveSame.push(history[i]);
    } else {
      break;
    }
  }

  if (consecutiveSame.length >= 2) {
    violations.push({
      policyId: 'loop-consecutive',
      policyName: 'Consecutive Repeat Detection',
      severity: 'medium',
      message: `The same action has been repeated ${consecutiveSame.length} times in a row.`,
      suggestion: 'Consider a different approach or check if the page state actually changed.',
    });
  }

  const windowStart = Date.now() - LOOP_WINDOW_MS;
  const recentActions = history.filter(h =>
    h.action.timestamp > windowStart || (h.executedAt && h.executedAt > windowStart)
  );

  if (recentActions.length >= MAX_ACTIONS_PER_MINUTE) {
    violations.push({
      policyId: 'loop-rate-limit',
      policyName: 'Action Rate Limit',
      severity: 'medium',
      message: `${recentActions.length} actions in the last minute (limit: ${MAX_ACTIONS_PER_MINUTE}). Agent may be thrashing.`,
      suggestion: 'Slow down. Wait for page responses before taking further action.',
    });
  }

  const last5 = history.slice(-5).map(h => `${h.action.type}:${h.action.target.id}`);
  if (last5.length >= 4) {
    const pattern2 = `${last5[last5.length - 2]},${last5[last5.length - 1]}`;
    const pattern2prev = `${last5[last5.length - 4]},${last5[last5.length - 3]}`;
    if (pattern2 === pattern2prev) {
      violations.push({
        policyId: 'loop-oscillation',
        policyName: 'Oscillation Pattern Detection',
        severity: 'medium',
        message: 'Detected alternating action pattern (A→B→A→B). Agent may be stuck in a back-and-forth loop.',
        suggestion: 'Break the oscillation pattern. Pause and re-evaluate the page state.',
      });
    }
  }

  return violations;
}


