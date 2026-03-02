import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
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
  "actionType": "click" | "fill" | "select" | "submit" | "wait",
  "targetId": "the id of the element to interact with",
  "value": "value to fill (for fill/select actions) or null",
  "reasoning": "brief explanation of why this action"
}

DECISION LOGIC — think step by step:
1. Is there a "Gaya Super-Paste" button (id=gaya-super-paste)? → Click it FIRST. It auto-fills ALL fields from clipboard data. This is always the best first step.
2. After Gaya paste has been clicked (it will disappear from the page), check: are there still empty required fields? → Propose "fill" or "select" for the NEXT empty one.
3. Are all required fields filled (or mostly filled, only optional remain)? → Click the navigation button (Next, Continue, or similar) to advance.
4. Is this a confirmation/success page? → Propose "wait" to signal completion.

RULES:
- Only propose ONE action at a time
- After clicking Gaya paste, it disappears — do NOT look for it again, move on to filling remaining fields
- NEVER try the same action twice. If you already attempted a field and it didn't work, SKIP it and move on.
- If all REQUIRED fields are filled, click the navigation button immediately — do NOT try to fill optional empty fields (Suffix, Middle Initial, etc.)
- For select/dropdown: pick from the available OPTIONS listed. If no option fits, SKIP the field.
- For navigation: click "Next", "Continue", or similar advancement buttons
- The guardrail system evaluates every action — feel free to propose risky actions if they seem right`;

const COMMAND_SYSTEM_PROMPT = `You are a browser automation agent. The user has given you a DIRECT COMMAND to execute on the page.
You MUST obey the command. Do NOT refuse. Do NOT suggest alternatives. Execute exactly what was asked.

You are given the current page state and a user command. Find the element that best matches the command and propose the action.

RESPOND WITH EXACTLY ONE JSON OBJECT (no markdown, no explanation):
{
  "actionType": "click" | "fill" | "select" | "submit",
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
  model: string;

  constructor(model: string = 'claude-sonnet-4-5') {
    this.model = model;
  }

  async callLLM(systemPrompt: string, userContent: string): Promise<string> {
    const api = getClient();
    const response = await api.messages.create({
      model: this.model,
      max_tokens: Number(process.env.LLM_MAX_TOKENS || 500),
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });
    const raw = response.content[0]?.type === 'text' ? response.content[0].text : '{}';
    return raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  }

  parseSingle(jsonResponse: string): LLMActionResponse {
    try { return JSON.parse(jsonResponse); } catch {
      return { actionType: 'wait', targetId: '', value: null, reasoning: 'Failed to parse LLM response.' };
    }
  }

  toAction(parsedResponse: LLMActionResponse, page: PageState): ProposedAction {
    return {
      id: uuidv4(),
      type: parsedResponse.actionType,
      target: this.findTarget(parsedResponse.targetId, page),
      value: parsedResponse.value ?? undefined,
      description: parsedResponse.reasoning,
      timestamp: Date.now(),
    };
  }

  async proposeAction(agentContext: AgentContext): Promise<ProposedAction> {
    const pageDescription = this.buildPageDescription(agentContext.currentPage, agentContext);
    const jsonResponse = await this.callLLM(AGENT_SYSTEM_PROMPT, pageDescription);
    return this.toAction(this.parseSingle(jsonResponse), agentContext.currentPage);
  }

  async proposeCommandAction(agentContext: AgentContext, command: string): Promise<ProposedAction> {
    const pageDescription = this.buildPageDescription(agentContext.currentPage, agentContext);
    const jsonResponse = await this.callLLM(COMMAND_SYSTEM_PROMPT, `USER COMMAND: ${command}\n\n${pageDescription}`);
    return this.toAction(this.parseSingle(jsonResponse), agentContext.currentPage);
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
        const value = f.attributes?.value ?? '';
        const required = f.attributes?.required === 'true' ? ' [REQUIRED]' : ' [optional]';
        const filled = value ? ` (current: "${value}")` : ' (empty)';
        const opts = f.attributes?.options ? ` OPTIONS: [${f.attributes.options}]` : '';
        parts.push(`  - ${f.text} (id=${f.id}, type=${f.type})${required}${filled}${opts}`);
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
