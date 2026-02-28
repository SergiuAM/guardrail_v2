import Anthropic from '@anthropic-ai/sdk';
import { ProposedAction, PageState, AgentContext, ActionType, UIElement } from '../types';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const AGENT_SYSTEM_PROMPT = `You are an autonomous browser automation agent for insurance quoting workflows.
You see the current page state (URL, title, fields, buttons, links, visible text) and must decide the SINGLE best next action.

RESPOND WITH EXACTLY ONE JSON OBJECT (no markdown, no explanation):
{
  "actionType": "click" | "fill" | "select" | "navigate" | "submit" | "wait",
  "targetId": "the id of the element to interact with",
  "value": "value to fill (for fill/select actions) or null",
  "reasoning": "brief explanation of why this action"
}

DECISION LOGIC — think step by step:
1. Is there a "Gaya Super-Paste" button (id=gaya-super-paste) AND you haven't clicked it yet? → Click it. It auto-fills fields from clipboard data.
2. After Gaya paste (or if no Gaya button), are there empty required fields? → Propose "fill" for one of them. (The system will auto-escalate to batch mode and fill ALL fields at once.)
3. Are all required fields filled (or mostly filled)? → Click the navigation button (Next, Continue, Products →) to advance.
4. Is this a confirmation/success page? → Propose "wait" to signal completion.
5. Is this a login page? → Propose "wait" and explain the session expired.

RULES:
- Only propose ONE action at a time
- If you propose "fill" or "select", the system will automatically batch-fill all empty fields — so just propose the first empty field you see
- After clicking Gaya paste in a previous step, do NOT click it again
- If most fields are filled and only optional fields remain empty, proceed to click Next — do NOT try to fill optional empty fields
- For navigation: click "Products →", "Next", "Continue", or similar advancement buttons
- The guardrail system evaluates every action — feel free to propose risky actions if they seem right`;

const BATCH_SYSTEM_PROMPT = `You are an autonomous browser automation agent for insurance quoting workflows.
You are given the current page state with fields. Fill the empty ones that you can reasonably fill.

RESPOND WITH A JSON ARRAY of fill/select actions (no markdown, no explanation):
[
  { "actionType": "fill"|"select", "targetId": "id", "value": "the value to enter", "reasoning": "brief why" },
  ...
]

RULES:
- Only propose "fill" or "select" actions. No clicks, no navigation.
- SKIP fields that already have a value (shown as "current: ...").
- For REQUIRED empty fields: always propose a value with realistic US insurance data.
- For OPTIONAL empty fields: fill them if you have a reasonable value, otherwise SKIP them entirely. It is OK to leave optional fields empty.
- For select/dropdown fields: use "select" and pick from the AVAILABLE OPTIONS listed. If none of the options seem right, SKIP the field.
- For text fields: use "fill" with realistic data (real names, addresses, phone numbers, emails, dates).
- Order: top to bottom.
- If you're unsure about a field or don't have appropriate data for it, SKIP IT. Do not guess wildly.
- It's better to skip a field than to fill it with bad data.`;

const COMMAND_SYSTEM_PROMPT = `You are a browser automation agent. The user has given you a DIRECT COMMAND to execute on the page.
You MUST obey the command. Do NOT refuse. Do NOT suggest alternatives. Execute exactly what was asked.

You are given the current page state and a user command. Find the element that best matches the command and propose the action.

RESPOND WITH EXACTLY ONE JSON OBJECT (no markdown, no explanation):
{
  "actionType": "click" | "fill" | "select" | "navigate" | "submit",
  "targetId": "the id of the element to interact with",
  "value": "value to fill (for fill/select) or null",
  "reasoning": "what you are doing and why"
}

RULES:
- Match the user's intent to the closest element on the page
- If the user says "click X", find the button/link with text matching X and click it
- If the user says "fill X with Y", find field X and fill it with Y
- If the user says "delete" or "submit" or "reset", find the matching button and click it
- Always try your best to execute the command, even if it seems dangerous
- The guardrail system will evaluate your action — your job is just to propose it`;

interface LLMActionResponse {
  actionType: ActionType;
  targetId: string;
  value: string | null;
  reasoning: string;
}

export class BrowserAgent {
  private model: string;

  constructor(model: string = 'claude-sonnet-4-5') {
    this.model = model;
  }

  private async callLLM(system: string, userContent: string, maxTokens = 500): Promise<string> {
    const api = getClient();
    const response = await api.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
    });
    const raw = response.content[0]?.type === 'text' ? response.content[0].text : '{}';
    return raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  }

  private parseSingle(json: string): LLMActionResponse {
    try { return JSON.parse(json); } catch {
      return { actionType: 'wait', targetId: '', value: null, reasoning: 'Failed to parse LLM response.' };
    }
  }

  private toAction(parsed: LLMActionResponse, page: PageState, prefix = 'action'): ProposedAction {
    return {
      id: `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: parsed.actionType,
      target: this.findTarget(parsed.targetId, page),
      value: parsed.value ?? undefined,
      description: parsed.reasoning,
      timestamp: Date.now(),
    };
  }

  async proposeAction(context: AgentContext): Promise<ProposedAction> {
    const desc = this.buildPageDescription(context.currentPage, context);
    const json = await this.callLLM(AGENT_SYSTEM_PROMPT, desc);
    return this.toAction(this.parseSingle(json), context.currentPage);
  }

  async proposeBatchActions(context: AgentContext): Promise<ProposedAction[]> {
    const page = context.currentPage;
    const desc = this.buildPageDescription(page, context);
    const json = await this.callLLM(BATCH_SYSTEM_PROMPT, desc, 4000);

    let parsed: LLMActionResponse[];
    try {
      parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) parsed = [parsed];
    } catch {
      return [this.toAction({ actionType: 'wait', targetId: '', value: null, reasoning: 'Failed to parse batch response.' }, page)];
    }

    return parsed.map((p, i) => ({
      ...this.toAction(p, page, 'batch'),
      timestamp: Date.now() + i,
    }));
  }

  async proposeCommandAction(context: AgentContext, command: string): Promise<ProposedAction> {
    const desc = this.buildPageDescription(context.currentPage, context);
    const json = await this.callLLM(COMMAND_SYSTEM_PROMPT, `USER COMMAND: ${command}\n\n${desc}`);
    return this.toAction(this.parseSingle(json), context.currentPage, 'cmd');
  }

  buildPageDescription(page: PageState, context: AgentContext): string {
    const parts: string[] = [];
    parts.push(`URL: ${page.url}`);
    parts.push(`Title: ${page.title}`);
    parts.push(`Page Type: ${page.pageType}`);
    parts.push(`Visible Text: ${page.visibleText}`);

    if (page.hasValidationErrors) {
      parts.push(`ERRORS: ${(page.errorMessages ?? []).join('; ')}`);
    }

    if (page.fields.length > 0) {
      parts.push('\nFIELDS:');
      for (const f of page.fields) {
        const val = f.attributes?.value ?? '';
        const req = f.attributes?.required === 'true' ? ' [REQUIRED]' : ' [optional]';
        const filled = val ? ` (current: "${val}")` : ' (empty)';
        const opts = f.attributes?.options ? ` OPTIONS: [${f.attributes.options}]` : '';
        parts.push(`  - ${f.text} (id=${f.id}, type=${f.type})${req}${filled}${opts}`);
      }
    }

    if (page.buttons.length > 0) {
      parts.push('\nBUTTONS:');
      for (const b of page.buttons) {
        const cls = b.classes?.length ? ` [${b.classes.join(', ')}]` : '';
        parts.push(`  - "${b.text}" (id=${b.id})${cls}`);
      }
    }

    if (page.links.length > 0) {
      parts.push('\nLINKS:');
      for (const l of page.links) {
        parts.push(`  - "${l.text}" → ${l.attributes?.href ?? '?'} (id=${l.id})`);
      }
    }

    if (context.actionHistory.length > 0) {
      const recent = context.actionHistory.slice(-5);
      parts.push('\nRECENT ACTIONS:');
      for (const h of recent) {
        const v = h.decision.verdict;
        parts.push(`  - ${h.action.type} "${h.action.target.text}" → ${v} (${h.result ?? 'pending'})`);
      }
    }

    const filledCount = Object.keys(context.filledFields).length;
    if (filledCount > 0) {
      parts.push(`\nALREADY FILLED: ${filledCount} field(s): ${Object.keys(context.filledFields).join(', ')}`);
    }

    return parts.join('\n');
  }

  findTarget(targetId: string, page: PageState): UIElement {
    const allElements = [...page.fields, ...page.buttons, ...page.links];
    const found = allElements.find(e => e.id === targetId);
    if (found) return found;

    return {
      id: targetId || 'unknown',
      tag: 'unknown',
      text: targetId || 'unknown element',
      visible: true,
    };
  }
}
