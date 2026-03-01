import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { GuardrailEngine } from './guardrail/engine';
import { BrowserAgent } from './agent/agent';
import { AgentContext, PageState, ActionHistoryEntry } from './types';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const engine = new GuardrailEngine();
const agent = new BrowserAgent();

const sessions: Record<string, AgentContext> = {};

function makeContext(page: PageState, overrides?: Partial<AgentContext>): AgentContext {
  return {
    sessionId: `session_${Date.now()}`,
    actionHistory: [],
    currentPage: page,
    previousPages: [],
    filledFields: {},
    submittedForms: [],
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
    fields: (snapshot.fields || []).map((f: any) => ({
      id: f.id, tag: f.tag || 'input', text: f.text || f.id,
      type: f.type, visible: f.visible !== false, disabled: f.disabled || false,
      classes: f.classes, attributes: f.attributes,
    })),
    buttons: (snapshot.buttons || []).map((b: any) => ({
      id: b.id, tag: b.tag || 'button', text: b.text || b.id,
      type: b.type, visible: b.visible !== false, disabled: b.disabled || false,
      classes: b.classes, attributes: b.attributes,
    })),
    links: (snapshot.links || []).map((l: any) => ({
      id: l.id, tag: l.tag || 'a', text: l.text || '',
      visible: l.visible !== false, attributes: l.attributes,
    })),
    visibleText: snapshot.visibleText || '',
    hasValidationErrors: snapshot.hasValidationErrors || false,
    errorMessages: snapshot.errorMessages || [],
    hasUnsavedChanges: snapshot.hasUnsavedChanges || false,
    timestamp: snapshot.timestamp || Date.now(),
  };
}

function getOrCreateSession(page: PageState, reqSessionId?: string, prefix = 'live'): { ctx: AgentContext; sessionId: string } {
  const sessionId = reqSessionId || `${prefix}_${Date.now()}`;
  if (!sessions[sessionId]) {
    sessions[sessionId] = makeContext(page, { sessionId });
  }
  const ctx = sessions[sessionId];
  ctx.currentPage = page;
  return { ctx, sessionId };
}

function recordEntry(ctx: AgentContext, action: any, decision: any) {
  const entry: ActionHistoryEntry = { action, decision };
  if (decision.verdict === 'ALLOW' || decision.verdict === 'FLAG') {
    entry.result = 'success';
    entry.executedAt = Date.now();
    if (action.type === 'fill' && action.value) {
      ctx.filledFields[action.target.id] = action.value;
    }
  } else {
    entry.result = 'blocked';
  }
  ctx.actionHistory.push(entry);
}

function formatActionResponse(action: any) {
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

function formatDecisionResponse(decision: any) {
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
  const { ctx, sessionId } = getOrCreateSession(page, reqSessionId);

  try {
    const action = await agent.proposeAction(ctx);
    const decision = engine.evaluate(action, ctx);
    recordEntry(ctx, action, decision);

    res.json({
      action: formatActionResponse(action),
      decision: formatDecisionResponse(decision),
      context: { filledFields: ctx.filledFields, historyLength: ctx.actionHistory.length },
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
  const { ctx, sessionId } = getOrCreateSession(page, reqSessionId, 'cmd');

  try {
    const action = await agent.proposeCommandAction(ctx, command);
    const decision = engine.evaluate(action, ctx);
    recordEntry(ctx, action, decision);

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
// ENDPOINT 4: Reset sessions
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
