// ═══════════════════════════════════════════════════════════════════════════════
// Gaya Guardrail — Chrome Extension Content Script
// Runs on: https://gaya-test-1.bubbleapps.io/*
// Uses: Real Claude (claude-sonnet-4-5) via Anthropic API
// ═══════════════════════════════════════════════════════════════════════════════

const API_BASE = 'http://localhost:3200';
const MAX_AGENT_STEPS = 1000;
const GAYA_PASTE_WAIT_MS = 4000;
let sessionId = null;
let stepCount = 0;
let stats = { total: 0, allowed: 0, blocked: 0, flagged: 0 };
let agentRunning = false;
let panelCollapsed = false;
let currentSnapshot = null;
let confirmAll = false;

// ── Wait for page to fully load ──
function waitForReady() {
  return new Promise(resolve => {
    if (document.readyState === 'complete') return resolve();
    window.addEventListener('load', resolve);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// DOM SCRAPER — reads the real page and creates a structured snapshot
// ══════════════════════════════════════════════════════════════════════════════
function scrapePage() {
  const fields = [];
  const buttons = [];
  const links = [];

  // ── Fields ──
  document.querySelectorAll('input, textarea, select').forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return;
    if (el.type === 'hidden') return;
    if (el.closest('#gaya-guardrail-panel')) return;

    const label = findLabel(el);
    const id = el.id || el.name || `field_${i}`;

    // Required detection: standard attr, OR * in label if label is clean (single *)
    let required = el.required || el.getAttribute('aria-required') === 'true';
    if (!required) {
      // Only trust * in label if exactly one * (avoids concatenated Bubble labels)
      const starCount = (label.match(/\*/g) || []).length;
      if (starCount === 1) required = true;
    }
    if (!required) {
      required = detectRequiredFromDOM(el);
    }

    // Value: filter out Bubble.io placeholder IDs and select defaults
    let value = el.value || '';
    if (isBubblePlaceholder(value)) value = '';
    if (el.tagName === 'SELECT') {
      // Treat default/placeholder select options as empty
      const selText = el.options?.[el.selectedIndex]?.text || '';
      if (el.selectedIndex <= 0 || /^--\s*|^select|^choose|^please/i.test(selText.trim())) value = '';
    }

    // Placeholder: also filter Bubble IDs
    let placeholder = el.placeholder || '';
    if (isBubblePlaceholder(placeholder)) placeholder = '';

    fields.push({
      id, tag: el.tagName.toLowerCase(), text: label,
      type: el.type || el.tagName.toLowerCase(),
      visible: true, disabled: el.disabled,
      attributes: {
        value,
        required: required ? 'true' : 'false',
        placeholder,
        ...(el.tagName === 'SELECT' ? { options: Array.from(el.options).map(o => o.text).join('|') } : {}),
      },
      _sel: buildSelector(el),
    });
  });

  // ── Buttons ──
  const seenBtnText = new Set();
  document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    if (el.closest('#gaya-guardrail-panel')) return;
    const text = (el.textContent?.trim() || el.value || el.getAttribute('aria-label') || '').substring(0, 80);
    if (!text || seenBtnText.has(text)) return;
    seenBtnText.add(text);

    buttons.push({
      id: el.id || `btn_${text.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30)}_${i}`,
      tag: 'button', text, type: el.type || 'button',
      visible: true, disabled: el.disabled,
      classes: Array.from(el.classList),
      _sel: buildSelector(el),
    });
  });

  // Also find clickable divs styled as buttons
  document.querySelectorAll('[class*="button" i], [class*="btn" i]').forEach((el, i) => {
    if (el.tagName === 'BUTTON' || el.tagName === 'INPUT') return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    if (el.closest('#gaya-guardrail-panel')) return;
    const text = (el.textContent?.trim() || '').substring(0, 80);
    if (!text || seenBtnText.has(text)) return;
    seenBtnText.add(text);
    buttons.push({
      id: el.id || `cbtn_${i}`, tag: 'button', text, type: 'button',
      visible: true, classes: Array.from(el.classList), _sel: buildSelector(el),
    });
  });

  // ── Links ──
  document.querySelectorAll('a[href]').forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return;
    if (el.closest('#gaya-guardrail-panel')) return;
    const text = (el.textContent?.trim() || '').substring(0, 80);
    if (!text) return;
    links.push({
      id: el.id || `link_${i}`, tag: 'a', text, visible: true,
      attributes: { href: el.href || '' }, _sel: buildSelector(el),
    });
  });

  // ── Detect Gaya extension paste button ──
  const gayaShadowHost = document.getElementById('gaya_panel_shadow_root');
  if (gayaShadowHost && gayaShadowHost.shadowRoot) {
    const gayaPanel = gayaShadowHost.shadowRoot.querySelector('.gaya_panel');
    const isPaste = gayaPanel && (gayaPanel.classList.contains('paste') || gayaPanel.classList.contains('default'));
    if (isPaste) {
      buttons.push({
        id: 'gaya-super-paste',
        tag: 'button',
        text: 'Gaya Super-Paste',
        type: 'button',
        visible: true,
        disabled: false,
        classes: ['gaya-paste-trigger'],
        _sel: null,
        _isGayaPaste: true,
      });
    }
  }

  // ── Page classification ──
  let pageType = 'UNKNOWN';
  const urlLow = window.location.href.toLowerCase();
  const bodyText = (document.body?.innerText || '').substring(0, 3000).toLowerCase();
  if (/login|sign.?in/i.test(document.title + bodyText.substring(0, 500))) pageType = 'LOGIN';
  else if (/confirm|success|submitted/i.test(document.title)) pageType = 'CONFIRMATION';
  else if (fields.length > 0) pageType = 'QUOTE_FORM';

  // ── Errors ──
  const errorMessages = [];
  document.querySelectorAll('.error, .invalid, [class*="error" i], [aria-invalid="true"]').forEach(el => {
    if (el.closest('#gaya-guardrail-panel')) return;
    // Skip hidden/invisible error elements
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden') return;
    const t = el.textContent?.trim();
    if (t && t.length > 2 && t.length < 200) errorMessages.push(t);
  });

  // ── Environment ──
  let environment = 'production';
  if (/test|dev|localhost/i.test(urlLow)) environment = 'test';

  return {
    url: window.location.href,
    title: document.title,
    pageType, environment, fields, buttons, links,
    visibleText: (document.title + '. ' + fields.map(f =>
      `${f.text} ${f.attributes?.value ? '(filled)' : '(empty)'}`
    ).join(', ')).substring(0, 2000),
    hasValidationErrors: errorMessages.length > 0,
    errorMessages,
    timestamp: Date.now(),
  };
}

function isBubblePlaceholder(text) {
  if (!text) return false;
  const t = text.trim();
  // Bubble.io placeholder IDs, long numbers, UUIDs, hashes
  if (/^PLACEHOLDER_/i.test(t)) return true;
  if (/^[0-9]{10,}$/.test(t)) return true;           // Long numeric IDs (timestamps)
  if (/^[a-f0-9]{24,}$/i.test(t)) return true;       // MongoDB-style hashes
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-/i.test(t)) return true;  // UUIDs
  if (/^1[0-9]{12}$/.test(t)) return true;            // Unix timestamp in ms
  return false;
}

function isGoodLabel(text) {
  if (!text || text.length < 2 || text.length > 60) return false;
  if (isBubblePlaceholder(text)) return false;
  if (/^[^a-zA-Z]*$/.test(text)) return false;
  // Reject concatenated labels (multiple field names glued together)
  const colonCount = (text.match(/:/g) || []).length;
  if (colonCount > 1) return false;
  return true;
}

function detectRequiredFromDOM(el) {
  // Check the immediate container for * markers that are CLOSE to this field
  const container = el.parentElement;
  if (!container) return false;
  const elRect = el.getBoundingClientRect();

  for (const child of container.children) {
    if (child === el) continue;
    const tag = child.tagName;
    if (tag === 'LABEL' || tag === 'SPAN' || (tag === 'DIV' && (child.textContent || '').length < 40)) {
        const txt = child.textContent || '';
      if (txt.includes('*')) {
        // Proximity check: label must be near the field (< 50px vertically)
        const childRect = child.getBoundingClientRect();
        if (childRect.height > 0 && Math.abs(childRect.top - elRect.top) < 50) return true;
      }
    }
  }
  return false;
}

function findLabel(el) {
  // 1. Standard <label for="...">
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label && isGoodLabel(label.textContent.trim())) return label.textContent.trim();
  }

  // 2. Wrapping <label>
  const parentLabel = el.closest('label');
  if (parentLabel && isGoodLabel(parentLabel.textContent.trim())) return parentLabel.textContent.trim();

  // 3. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (isGoodLabel(ariaLabel)) return ariaLabel;

  // 4. Placeholder (skip Bubble IDs)
  if (el.placeholder && isGoodLabel(el.placeholder)) return el.placeholder;

  // 5. Walk up the DOM looking for nearby text elements (Bubble.io pattern)
  // Bubble places labels as sibling text elements in parent containers
  let container = el.parentElement;
  for (let depth = 0; depth < 5 && container; depth++) {
    // Check preceding siblings at this level
    let sib = container.previousElementSibling;
    for (let s = 0; s < 3 && sib; s++) {
      const txt = sib.textContent?.trim();
      if (isGoodLabel(txt) && sib.getBoundingClientRect().height > 0) {
        return txt;
      }
      sib = sib.previousElementSibling;
    }

    // Check text-bearing children before the input's parent within this container
    if (container.parentElement) {
      const parent = container.parentElement;
      const children = Array.from(parent.children);
      const myIdx = children.indexOf(container);
      // Look at children before us
      for (let ci = myIdx - 1; ci >= Math.max(0, myIdx - 3); ci--) {
        const child = children[ci];
        // Skip if it contains another input (it's a different field's label)
        if (child.querySelector && child.querySelector('input, select, textarea')) continue;
        const txt = child.textContent?.trim();
        if (isGoodLabel(txt) && child.getBoundingClientRect().height > 0) {
          return txt;
        }
      }
    }

    container = container.parentElement;
  }

  // 6. Check the element's own parent for direct text nodes
  if (el.parentElement) {
    const parentText = Array.from(el.parentElement.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim())
      .filter(t => isGoodLabel(t))
      .join(' ');
    if (parentText) return parentText;
  }

  // 7. Fallback
  return el.name || el.id || 'unknown field';
}

function buildSelector(el) {
  if (el.id) return '#' + CSS.escape(el.id);
  if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
  const path = [];
  let cur = el;
  while (cur && cur !== document.body) {
    let seg = cur.tagName.toLowerCase();
    if (cur.id) { path.unshift('#' + CSS.escape(cur.id)); break; }
    const parent = cur.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
    }
    path.unshift(seg);
    cur = cur.parentElement;
  }
  return path.join(' > ');
}

// ══════════════════════════════════════════════════════════════════════════════
// ELEMENT FINDING + HIGHLIGHTING
// ══════════════════════════════════════════════════════════════════════════════
function findRealElement(actionData) {
  const tid = actionData.targetId || actionData.id;
  if (!tid) return null;

  let el = document.getElementById(tid);
  if (el) return el;
  el = document.querySelector(`[name="${tid}"]`);
  if (el) return el;

  // Search snapshot for stored selector
  if (currentSnapshot) {
    const all = [...(currentSnapshot.fields || []), ...(currentSnapshot.buttons || []), ...(currentSnapshot.links || [])];
    const item = all.find(i => i.id === tid);
    if (item?._sel) { try { el = document.querySelector(item._sel); } catch {} }
    if (el) return el;
  }

  // Text match for buttons
  const text = actionData.targetText || actionData.text;
  if (text) {
    for (const c of document.querySelectorAll('button, [role="button"], a, input[type="submit"]')) {
      if (c.textContent?.trim() === text || c.value === text) return c;
    }
  }
  return null;
}

function highlightElement(actionData, state) {
  clearHighlights();
  const el = findRealElement(actionData);
  if (!el) return;
  const cls = {
    pending: 'gg-highlight-target',
    allowed: 'gg-highlight-allowed',
    blocked: 'gg-highlight-blocked',
    flagged: 'gg-highlight-flagged',
  }[state] || 'gg-highlight-target';
  el.classList.add(cls);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearHighlights() {
  document.querySelectorAll('.gg-highlight-target,.gg-highlight-allowed,.gg-highlight-blocked,.gg-highlight-flagged')
    .forEach(el => el.classList.remove('gg-highlight-target', 'gg-highlight-allowed', 'gg-highlight-blocked', 'gg-highlight-flagged'));
}

// ══════════════════════════════════════════════════════════════════════════════
// EXECUTE ALLOWED ACTIONS ON REAL PAGE
// ══════════════════════════════════════════════════════════════════════════════
function executeAction(actionData) {
  if (!currentSnapshot) return;
  const all = [...(currentSnapshot.fields || []), ...(currentSnapshot.buttons || []), ...(currentSnapshot.links || [])];
  const item = all.find(i => i.id === actionData.targetId);
  if (!item?._sel) return;

  let el;
  try { el = document.querySelector(item._sel); } catch { return; }
  if (!el) return;

  if ((actionData.type === 'fill') && actionData.value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(el, actionData.value);
    else el.value = actionData.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  } else if (actionData.type === 'select' && actionData.value && el.tagName === 'SELECT') {
    const wanted = actionData.value.toLowerCase().trim();
    let matched = false;

    // Exact match first
    for (const opt of el.options) {
      if (opt.text === actionData.value || opt.value === actionData.value) {
        el.value = opt.value; matched = true; break;
      }
    }

    // Fuzzy match: case-insensitive, partial, or includes
    if (!matched) {
      for (const opt of el.options) {
        const txt = opt.text.toLowerCase().trim();
        const val = opt.value.toLowerCase().trim();
        if (txt === wanted || val === wanted || txt.includes(wanted) || wanted.includes(txt)) {
          if (opt.value && opt.value !== '') {
            el.value = opt.value; matched = true; break;
          }
        }
      }
    }

    // Last resort: pick first non-empty option that's not a placeholder
    if (!matched) {
      for (const opt of el.options) {
        if (opt.value && opt.value !== '' && opt.index > 0) {
          el.value = opt.value; matched = true; break;
        }
      }
    }

    if (matched) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }
  return false;
}

function clickGayaPaste() {
  const shadowHost = document.getElementById('gaya_panel_shadow_root');
  if (!shadowHost || !shadowHost.shadowRoot) return false;
  const primaryButton = shadowHost.shadowRoot.querySelector('.gaya_panel_primary_button');
  if (!primaryButton) return false;
  primaryButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  return true;
}

function executeClickAction(actionData) {
  if (actionData.targetId === 'gaya-super-paste') {
    return clickGayaPaste();
  }
  const el = findRealElement(actionData);
  if (!el) return false;
  el.click();
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// PANEL UI
// ══════════════════════════════════════════════════════════════════════════════
function createPanel() {
  const toggle = document.createElement('button');
  toggle.id = 'gaya-guardrail-toggle';
  toggle.innerHTML = '🛡️';
  toggle.addEventListener('click', () => {
    panelCollapsed = !panelCollapsed;
    document.getElementById('gaya-guardrail-panel').classList.toggle('collapsed', panelCollapsed);
    toggle.classList.toggle('collapsed-tab', panelCollapsed);
    toggle.style.right = panelCollapsed ? '40px' : '400px';
    document.body.style.marginRight = panelCollapsed ? '0' : '400px';
  });
  document.body.appendChild(toggle);

  const panel = document.createElement('div');
  panel.id = 'gaya-guardrail-panel';
  panel.innerHTML = `
    <div class="gg-header">
      <div class="gg-logo">G</div>
      <div class="gg-header-text">
        <h2>Gaya Guardrail</h2>
        <span>Claude claude-sonnet-4-5 · Real-time LLM Guardrails</span>
      </div>
    </div>
    <div class="gg-stats">
      <div class="gg-stat"><div class="gg-stat-val sv-total" id="gg-total">0</div><div class="gg-stat-label">Total</div></div>
      <div class="gg-stat"><div class="gg-stat-val sv-allow" id="gg-allowed">0</div><div class="gg-stat-label">Allowed</div></div>
      <div class="gg-stat"><div class="gg-stat-val sv-block" id="gg-blocked">0</div><div class="gg-stat-label">Blocked</div></div>
      <div class="gg-stat"><div class="gg-stat-val sv-flag" id="gg-flagged">0</div><div class="gg-stat-label">Flagged</div></div>
    </div>
    <div class="gg-controls">
      <button class="gg-btn gg-btn-agent" id="gg-run-agent-btn">▶ Run Agent</button>
      <button class="gg-btn gg-btn-stop" id="gg-stop-agent-btn" style="display:none;">⏹ Stop</button>
      <button class="gg-btn gg-btn-secondary" id="gg-reset-btn">↻ Reset</button>
    </div>
    <div class="gg-options-bar">
      <label class="gg-toggle-label" for="gg-confirm-toggle">
        <input type="checkbox" id="gg-confirm-toggle" />
        <span class="gg-toggle-switch"></span>
        <span>Manual mode (approve each action)</span>
      </label>
      </div>
    <div class="gg-command-bar">
      <input type="text" id="gg-command-input" class="gg-command-input" placeholder="Tell agent what to do… e.g. 'Click Delete All Quotes'" />
      <button class="gg-btn gg-btn-command" id="gg-command-btn">Send</button>
    </div>
    <div class="gg-log" id="gg-log">
      <div class="gg-log-empty" id="gg-log-empty">
        <div class="gg-log-empty-icon">🛡️</div>
        <div class="gg-log-empty-text">
          Click <strong>▶ Run Agent</strong> to start.<br>
          The LLM agent will autonomously:<br>
          1. Scrape the page and decide the next action<br>
          2. Batch-fill form fields or click buttons step-by-step<br>
          3. <strong>Guardrail</strong> evaluates each step: ✅ / ❌ / ⚠️
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById('gg-reset-btn').addEventListener('click', handleReset);
  document.getElementById('gg-run-agent-btn').addEventListener('click', handleRunAgent);
  document.getElementById('gg-stop-agent-btn').addEventListener('click', handleStopAgent);
  document.getElementById('gg-confirm-toggle').addEventListener('change', (e) => {
    confirmAll = e.target.checked;
    addLogMessage(confirmAll ? '🔒 Manual mode ON — blocked & flagged actions need approval.' : '🔓 Manual mode OFF — only flagged actions pause.', 'info');
  });
  document.getElementById('gg-command-btn').addEventListener('click', handleCommand);
  document.getElementById('gg-command-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCommand();
  });

  document.body.style.marginRight = '400px';
  document.body.style.transition = 'margin-right 0.3s ease';
}

// ══════════════════════════════════════════════════════════════════════════════
// BUTTON HANDLERS
// ══════════════════════════════════════════════════════════════════════════════
// AUTONOMOUS AGENT LOOP (SMART)
// Claude is the brain — decides what to do at each step.
// If Claude proposes a fill/select → auto-escalate to batch (fill ALL at once).
// If Claude proposes click/wait → execute single step.
// No hardcoded phases. ~3 Claude calls total per page.
// ══════════════════════════════════════════════════════════════════════════════

async function agentStepSingle(snapshot) {
  const res = await fetch(API_BASE + '/api/evaluate-live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageSnapshot: snapshot, sessionId }),
  });
  return res.json();
}

async function handleRunAgent() {
  if (agentRunning) return;
  agentRunning = true;
  disableButtons(true);
  clearLog();

  document.getElementById('gg-run-agent-btn').style.display = 'none';
  document.getElementById('gg-stop-agent-btn').style.display = '';

  addLogMessage('🤖 Agent starting — Claude decides everything…', 'info');
  let nonproductiveSteps = 0;
  let lastFieldFingerprint = '';
  let gayaPasteUsedOnForm = false;
  const completedForms = new Set();  // Fingerprints of forms we already worked on

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (!agentRunning) {
      addLogMessage('⏹ Agent stopped by user.', 'warning');
      break;
    }

    currentSnapshot = scrapePage();

    // ── Detect page change by field fingerprint (works even if URL stays same) ──
    const fieldFingerprint = (currentSnapshot.fields || []).map(f => f.id).sort().join('|');
    if (lastFieldFingerprint && fieldFingerprint !== lastFieldFingerprint) {
      // Mark the previous form as completed
      completedForms.add(lastFieldFingerprint);
      addLogMessage('📄 New form detected — resetting…', 'info');
      nonproductiveSteps = 0;
      gayaPasteUsedOnForm = false;

      // If we've seen this form before → stop (we're looping)
      if (completedForms.has(fieldFingerprint)) {
        addLogMessage('🏁 Agent returned to a previously completed form — stopping.', 'success');
        break;
      }
    }
    lastFieldFingerprint = fieldFingerprint;

    // ── Hide Gaya paste button from snapshot if already used on this form ──
    if (gayaPasteUsedOnForm && currentSnapshot.buttons) {
      currentSnapshot.buttons = currentSnapshot.buttons.filter(b => b.id !== 'gaya-super-paste');
    }

    // ── Single-step: Claude proposes one action at a time ──
    stepCount++;
    const loading = showLoading(`Step ${stepCount} — Claude is thinking…`);

    try {
      const data = await agentStepSingle(currentSnapshot);
      loading.remove();

      if (data.error) { addLogMessage('⚠️ ' + data.error, 'error'); break; }
      sessionId = data.sessionId;

      const aType = data.action.type;
      const isGayaPaste = data.action.targetId === 'gaya-super-paste';

      recordStep(data);

      const verdict = data.decision.verdict;
      let canExecute = verdict === 'ALLOW' || verdict === 'FLAG';

      const needsConfirm = verdict === 'FLAG'
        || (confirmAll && verdict === 'BLOCK');

      if (needsConfirm) {
        const userChoice = await waitForUserDecision(data);
        if (userChoice === 'approve') {
          canExecute = true;
          if (verdict === 'BLOCK') {
            addLogMessage('⚠️ User overrode guardrail BLOCK — executing anyway.', 'warning');
          }
        } else {
          addLogMessage('⏭ User skipped this action.', 'warning');
          canExecute = false;
        }
      }

      if (canExecute) {
        nonproductiveSteps = 0;

        // ── CLICK actions (Gaya paste, Next, Submit, etc.) ──
        if (aType === 'click') {
          const clicked = executeClickAction(data.action);
          if (isGayaPaste && clicked) {
            gayaPasteUsedOnForm = true;  // Don't show Gaya paste to Claude again on this form
            addLogMessage('🟢 Gaya paste triggered — waiting for fields to fill…', 'info');
            await sleep(GAYA_PASTE_WAIT_MS);
          } else if (clicked) {
            const targetText = (data.action.targetText || '').toLowerCase();
            const isSubmit = /submit|finalize|complete|bind|issue|place order|confirm/i.test(targetText);
            if (isSubmit) {
              addLogMessage('🏁 Submission executed — waiting for page to update.', 'success');
              await sleep(2000);
              break;
            }
            await sleep(1500);
          } else {
            nonproductiveSteps++;
          }
        }

        // ── FILL / SELECT ──
        else if (aType === 'fill' || aType === 'select') {
          const ok = executeAction(data.action);
          if (!ok) nonproductiveSteps++;
        }

        // ── WAIT → agent says it's done ──
        else if (aType === 'wait') {
          addLogMessage('✅ Agent says workflow complete on this page.', 'success');
          break;
        }

      } else if (verdict === 'BLOCK' && !confirmAll) {
        addLogMessage(`🛑 Blocked: ${data.action.description}`, 'warning');
        if (aType === 'click') {
          addLogMessage('🏁 Page complete — submission/navigation requires human action.', 'info');
          break;
        }
        nonproductiveSteps++;
      } else {
        nonproductiveSteps++;
      }

      if (nonproductiveSteps >= 3) {
        addLogMessage('🚫 Agent stuck — no productive actions possible. Stopping.', 'error');
        break;
      }

      await sleep(400);
      clearHighlights();

    } catch (err) {
      loading.remove();
      addLogMessage('⚠️ Connection error: ' + err.message, 'error');
      break;
    }
  }

  if (agentRunning && stepCount >= MAX_AGENT_STEPS) {
    addLogMessage(`🏁 Agent reached max steps (${MAX_AGENT_STEPS}).`, 'warning');
  }

    addLogMessage(
    `📊 Done — ${stats.total} actions · ✅ ${stats.allowed} allowed · ❌ ${stats.blocked} blocked · ⚠️ ${stats.flagged} flagged`,
      'info'
    );

  agentRunning = false;
  document.getElementById('gg-run-agent-btn').style.display = '';
  document.getElementById('gg-stop-agent-btn').style.display = 'none';
  disableButtons(false);
}

function waitForUserDecision(data) {
  return new Promise(resolve => {
    const log = document.getElementById('gg-log');
    const prompt = document.createElement('div');
    prompt.className = 'gg-intervention';

    const aType = data.action.type;
    const target = data.action.targetText || data.action.targetId || '';
    const val = data.action.value ? ` → "${data.action.value}"` : '';
    const verdict = data.decision.verdict;
    const isBlock = verdict === 'BLOCK';
    const verdictClass = isBlock ? 'block' : verdict === 'FLAG' ? 'flag' : 'allow';

    const badgeText = isBlock ? '✗ BLOCKED' : verdict === 'FLAG' ? '⚑ FLAGGED' : '⏸ CONFIRM';
    const approveText = isBlock ? '⚠ Override & Execute' : '✓ Approve';
    const approveClass = isBlock ? 'gg-btn-override' : 'gg-btn-approve';

    let violationsHtml = '';
    if (isBlock && data.decision.violations?.length) {
      violationsHtml = '<div class="gg-intervention-violations">' +
        data.decision.violations.map(v =>
          `<div class="gg-intervention-viol"><span class="gg-risk-tag gg-risk-${v.severity}">${v.severity}</span> ${v.message}</div>`
        ).join('') + '</div>';
    }

    prompt.className = `gg-intervention ${isBlock ? 'gg-intervention-danger' : ''}`;

    prompt.innerHTML = `
      <div class="gg-intervention-header">
        <span class="gg-intervention-badge gg-intervention-${verdictClass}">${badgeText}</span>
        <span class="gg-intervention-label">${isBlock ? 'Guardrail blocked this — override?' : 'User decision required'}</span>
      </div>
      <div class="gg-intervention-action">
        <span class="gg-action-tag">${aType}</span>
        <span class="gg-action-target">${target}${val}</span>
      </div>
      <div class="gg-intervention-desc">${data.action.description}</div>
      ${violationsHtml}
      <div class="gg-intervention-buttons">
        <button class="gg-btn ${approveClass}" id="gg-approve-btn">${approveText}</button>
        <button class="gg-btn gg-btn-skip" id="gg-skip-btn">⏭ Skip</button>
      </div>
    `;
    log.appendChild(prompt);
    scrollLog();

    const cleanup = (result) => {
      prompt.querySelector('#gg-approve-btn').removeEventListener('click', onApprove);
      prompt.querySelector('#gg-skip-btn').removeEventListener('click', onSkip);
      prompt.querySelector('.gg-intervention-buttons').remove();
      const label = document.createElement('div');
      const approvedText = isBlock ? '⚠ Overridden by user' : '✓ Approved by user';
      const approvedClass = isBlock && result === 'approve' ? 'overridden' : (result === 'approve' ? 'approved' : 'skipped');
      label.className = 'gg-intervention-result ' + approvedClass;
      label.textContent = result === 'approve' ? approvedText : '⏭ Skipped by user';
      prompt.appendChild(label);
      resolve(result);
    };

    const onApprove = () => cleanup('approve');
    const onSkip = () => cleanup('skip');

    prompt.querySelector('#gg-approve-btn').addEventListener('click', onApprove);
    prompt.querySelector('#gg-skip-btn').addEventListener('click', onSkip);
  });
}

function showLoading(text) {
  const loading = document.createElement('div');
  loading.className = 'gg-loading';
  loading.innerHTML = `<div class="gg-spinner"></div> ${text}`;
  document.getElementById('gg-log').appendChild(loading);
  scrollLog();
  return loading;
}

function recordStep(data) {
      stats.total++;
  if (data.decision.verdict === 'ALLOW') stats.allowed++;
  else if (data.decision.verdict === 'BLOCK') stats.blocked++;
      else stats.flagged++;
      updateStatsUI();
  renderEntry(stepCount, data);

  const state = data.decision.verdict === 'ALLOW' ? 'allowed'
    : data.decision.verdict === 'BLOCK' ? 'blocked' : 'flagged';
  highlightElement(data.action, state);
}

function handleStopAgent() {
  agentRunning = false;
}

async function handleCommand() {
  const input = document.getElementById('gg-command-input');
  const command = input.value.trim();
  if (!command) return;

  input.value = '';
  const btn = document.getElementById('gg-command-btn');
  btn.disabled = true;

  currentSnapshot = scrapePage();
  stepCount++;

  addLogMessage(`💬 Command: "${command}"`, 'info');
  const loading = showLoading(`Step ${stepCount} — Claude executing command…`);

  try {
    const res = await fetch(API_BASE + '/api/evaluate-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageSnapshot: currentSnapshot, command, sessionId }),
    });
    const data = await res.json();
    loading.remove();

    if (data.error) {
      addLogMessage('⚠️ ' + data.error, 'error');
      btn.disabled = false;
      return;
    }

      sessionId = data.sessionId;
    recordStep(data);

    const cmdVerdict = data.decision.verdict;
    let cmdCanExecute = cmdVerdict === 'ALLOW' || cmdVerdict === 'FLAG';

    const cmdNeedsConfirm = cmdVerdict === 'FLAG'
      || (confirmAll && cmdVerdict === 'BLOCK');

    if (cmdNeedsConfirm) {
      const userChoice = await waitForUserDecision(data);
      if (userChoice === 'approve') {
        cmdCanExecute = true;
        if (cmdVerdict === 'BLOCK') addLogMessage('⚠️ User overrode guardrail BLOCK.', 'warning');
      } else {
        addLogMessage('⏭ User skipped this action.', 'warning');
        cmdCanExecute = false;
      }
    }

    if (cmdCanExecute) {
      const aType = data.action.type;
      if (aType === 'click') {
        const clicked = executeClickAction(data.action);
        if (clicked) addLogMessage('✅ Click executed.', 'success');
        else addLogMessage('⚠️ Could not find element to click.', 'warning');
      } else if (aType === 'fill' || aType === 'select') {
        executeAction(data.action);
        addLogMessage('✅ Action executed.', 'success');
      }
    } else if (cmdVerdict === 'BLOCK' && !confirmAll) {
      addLogMessage(`🛑 Guardrail blocked this command!`, 'error');
    }

      await sleep(300);
      clearHighlights();
  } catch (err) {
    loading.remove();
    addLogMessage('⚠️ Connection error: ' + err.message, 'error');
  }

  btn.disabled = false;
}

// ── RESET ──
async function handleReset() {
  try { await fetch(API_BASE + '/api/reset', { method: 'POST' }); } catch {}
  sessionId = null;
  stepCount = 0;
  stats = { total: 0, allowed: 0, blocked: 0, flagged: 0 };
  currentSnapshot = null;
  updateStatsUI();
  clearHighlights();
  agentRunning = false;
  disableButtons(false);
  document.getElementById('gg-run-agent-btn').style.display = '';
  document.getElementById('gg-stop-agent-btn').style.display = 'none';

  clearLog();
  document.getElementById('gg-log-empty').style.display = 'flex';
}

// ══════════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function renderEntry(num, data) {
  const { action, decision } = data;
  const log = document.getElementById('gg-log');

  let vioHtml = '';
  if (decision.violations?.length) {
    vioHtml = '<div class="gg-violations">';
    decision.violations.forEach(v => {
      vioHtml += `<div class="gg-viol-item">
        <span class="gg-viol-sev gg-risk-${v.severity}">${v.severity}</span>
        <div class="gg-viol-body">
          <div class="gg-viol-policy">${v.policyName}</div>
          <div class="gg-viol-msg">${v.message}</div>
          ${v.suggestion ? `<div class="gg-viol-sug">→ ${v.suggestion}</div>` : ''}
        </div></div>`;
    });
    vioHtml += '</div>';
  }

  const val = action.value ? ` → "${action.value}"` : '';
  const entry = document.createElement('div');
  entry.className = `gg-entry gg-v-${decision.verdict}`;
  entry.innerHTML = `
    <div class="gg-entry-top">
      <div class="gg-entry-num">${num}</div>
      <div class="gg-entry-body">
        <div class="gg-entry-action">
          <span class="gg-action-tag">${action.type}</span>
          <span class="gg-action-target">${action.targetText}${val}</span>
        </div>
        <div class="gg-entry-desc">${action.description}</div>
      </div>
      <div class="gg-verdict gg-vb-${decision.verdict}">${
        decision.verdict === 'ALLOW' ? '✓ ALLOW' :
        decision.verdict === 'BLOCK' ? '✗ BLOCK' : '⚑ FLAG'
      }</div>
    </div>
    <div class="gg-entry-details">
      <div class="gg-risk-line">Risk: <span class="gg-risk-tag gg-risk-${decision.riskLevel}">${decision.riskLevel}</span></div>
      ${vioHtml || '<div class="gg-no-violations">✓ No policy violations</div>'}
    </div>`;
  log.appendChild(entry);
  scrollLog();
}

function addLogMessage(msg, type) {
  document.getElementById('gg-log-empty').style.display = 'none';
  const div = document.createElement('div');
  div.className = 'gg-info-msg';
  const styles = {
    error:   'background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.25);color:#f87171;',
    warning: 'background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);color:#fbbf24;',
    success: 'background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);color:#34d399;',
    info:    'background:rgba(108,62,193,0.06);border:1px solid rgba(108,62,193,0.15);color:#a78bfa;',
  };
  div.style.cssText = (styles[type] || styles.info) + 'border-radius:6px;padding:8px 12px;margin:6px 0;font-size:11px;font-weight:500;';
  div.textContent = msg;
  document.getElementById('gg-log').appendChild(div);
  scrollLog();
}

function clearLog() {
  const log = document.getElementById('gg-log');
  log.querySelectorAll('.gg-entry, .gg-info-msg, .gg-error, .gg-loading').forEach(e => e.remove());
  document.getElementById('gg-log-empty').style.display = 'none';
}

function updateStatsUI() {
  const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  s('gg-total', stats.total);
  s('gg-allowed', stats.allowed);
  s('gg-blocked', stats.blocked);
  s('gg-flagged', stats.flagged);
}

function disableButtons(disabled) {
  ['gg-run-agent-btn', 'gg-reset-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

function scrollLog() {
  const log = document.getElementById('gg-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Init ──
async function init() {
  await waitForReady();
  await sleep(2000);
  createPanel();
  console.log('[Gaya Guardrail] ✅ Extension loaded. Using Claude claude-sonnet-4-5 via localhost:3200');
}

init();
