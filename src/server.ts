import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { GuardrailEngine } from './guardrail/engine';
import { BrowserAgent } from './agent/agent';
import { AgentContext, PageState, ActionHistoryEntry, ProposedAction, GuardrailDecision } from './types';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const engine = new GuardrailEngine();
const agent = new BrowserAgent();

const sessions: Record<string, AgentContext> = {};

function makeContext(page: PageState, overrides?: Partial<AgentContext>): AgentContext {
  return {
    sessionId: uuidv4(),
    actionHistory: [],
    currentPage: page,
    filledFields: {},
    startedAt: Date.now(),
    ...overrides,
  };
}

function snapshotToPageState(snapshot: any): PageState {
  return {
    url: snapshot.url || 'unknown',
    title: snapshot.title || 'unknown',
    pageType: snapshot.pageType || 'UNKNOWN',
    environment: snapshot.environment || 'unknown',
    fields: (snapshot.fields || []).map((field: any) => ({
      id: field.id,
      tag: field.tag || 'input',
      text: field.text || field.id,
      type: field.type,
      visible: field.visible !== false,
      disabled: field.disabled || false,
      classes: field.classes,
      attributes: field.attributes,
    })),
    buttons: (snapshot.buttons || []).map((button: any) => ({
      id: button.id,
      tag: button.tag || 'button',
      text: button.text || button.id,
      type: button.type,
      visible: button.visible !== false,
      disabled: button.disabled || false,
      classes: button.classes,
      attributes: button.attributes,
    })),
    links: (snapshot.links || []).map((link: any) => ({
      id: link.id,
      tag: link.tag || 'a',
      text: link.text || '',
      visible: link.visible !== false,
      attributes: link.attributes,
    })),
    visibleText: snapshot.visibleText || '',
    hasValidationErrors: snapshot.hasValidationErrors || false,
    errorMessages: snapshot.errorMessages || [],
    timestamp: snapshot.timestamp || Date.now(),
  };
}

function getOrCreateSession(page: PageState, reqSessionId?: string): { agentContext: AgentContext; sessionId: string } {
  const sessionId = reqSessionId || uuidv4();
  if (!sessions[sessionId]) {
    sessions[sessionId] = makeContext(page, { sessionId });
  }
  const agentContext = sessions[sessionId];
  agentContext.currentPage = page;
  return { agentContext, sessionId };
}

function recordEntry(agentContext: AgentContext, action: ProposedAction, decision: GuardrailDecision) {
  const entry: ActionHistoryEntry = { action, decision };

  if (decision.verdict === 'ALLOW' || decision.verdict === 'FLAG') {
    entry.result = 'success';
    entry.executedAt = Date.now();
    if (action.type === 'fill' && action.value) {
      agentContext.filledFields[action.target.id] = action.value;
    }
  } else {
    entry.result = 'blocked';
  }
  agentContext.actionHistory.push(entry);
}

function formatActionResponse(action: ProposedAction) {
  return {
    id: action.id,
    type: action.type,
    targetId: action.target.id,
    targetText: action.target.text,
    targetTag: action.target.tag,
    targetClasses: action.target.classes,
    value: action.value,
    description: action.description,
  };
}

function formatDecisionResponse(decision: GuardrailDecision) {
  return {
    verdict: decision.verdict,
    riskLevel: decision.riskLevel,
    reasoning: decision.reasoning,
    violations: decision.violations,
  };
}

// ═══════════════════════════════════════════════════════════════
// ENDPOINT 1: Single step — Claude proposes one action
// ═══════════════════════════════════════════════════════════════
app.post('/api/evaluate-live', async (req, res) => {
  const { pageSnapshot, sessionId: reqSessionId } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return void res.status(400).json({ error: 'ANTHROPIC_API_KEY not set. Add it to guardrail_v2/.env' });
  }
  if (!pageSnapshot) {
    return void res.status(400).json({ error: 'No pageSnapshot provided' });
  }

  const page = snapshotToPageState(pageSnapshot);
  const { agentContext, sessionId } = getOrCreateSession(page, reqSessionId);

  try {
    const action = await agent.proposeAction(agentContext);
    const decision = engine.evaluate(action, agentContext);
    recordEntry(agentContext, action, decision);

    res.json({
      action: formatActionResponse(action),
      decision: formatDecisionResponse(decision),
      sessionId,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT 2: Command — user tells agent what to do
// ═══════════════════════════════════════════════════════════════
app.post('/api/evaluate-command', async (req, res) => {
  const { pageSnapshot, command, sessionId: reqSessionId } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return void res.status(400).json({ error: 'ANTHROPIC_API_KEY not set.' });
  }
  if (!pageSnapshot || !command) {
    return void res.status(400).json({ error: 'Missing pageSnapshot or command.' });
  }

  const page = snapshotToPageState(pageSnapshot);
  const { agentContext, sessionId } = getOrCreateSession(page, reqSessionId);

  try {
    const action = await agent.proposeCommandAction(agentContext, command);
    const decision = engine.evaluate(action, agentContext);
    recordEntry(agentContext, action, decision);

    res.json({
      action: formatActionResponse(action),
      decision: formatDecisionResponse(decision),
      sessionId,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINT 3: Reset sessions
// ═══════════════════════════════════════════════════════════════
app.post('/api/reset', (_req, res) => {
  Object.keys(sessions).forEach(k => delete sessions[k]);
  engine.reset();
  res.json({ ok: true });
});

const PORT = 3200;
app.listen(PORT, () => {
  console.log(`\n  🛡️  Guardrail server running at http://localhost:${PORT}\n`);
});
