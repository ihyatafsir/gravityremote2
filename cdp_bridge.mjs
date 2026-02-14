import WebSocket from 'ws';
import http from 'http';

// Configuration
const CDP_PORT = 9222;
const DEBUG = true;

function log(...args) {
    if (DEBUG) console.log('[CDP]', ...args);
}

function error(...args) {
    console.error('[CDP]', ...args);
}

// Logic: Check if Agent is busy (Cancel button visible)
// This is evaluated in the browser context
const EXPRESSION_BUSY = `(() => {
  const cancelBtn = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
  const busy = !!cancelBtn && cancelBtn.offsetParent !== null;
  return { busy };
})()`;

// Logic: Inject message and submit
const EXPRESSION_INJECT = (message) => `(async () => {
  const text = ${JSON.stringify(message)};
  
  // Try 1: Launchpad input element (jetski-agent)
  const quickInput = document.querySelector('input.w-full.py-2');
  if (quickInput && quickInput.offsetParent !== null) {
    quickInput.focus();
    quickInput.value = text;
    quickInput.dispatchEvent(new Event('input', { bubbles: true }));
    
    await new Promise(r => setTimeout(r, 100));
    
    // Submit via Enter key
    quickInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
    quickInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
    
    return { ok: true, method: 'launchpad_input' };
  }
  
  // Try 2: IDE contenteditable editor (lexical)
  const editors = [...document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
    .filter(el => el.offsetParent !== null);
  const editor = editors.at(-1);
  
  if (!editor) return { ok: false, error: "editor_not_found" };

  // Check busy state
  const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
  if (cancel && cancel.offsetParent !== null) return { ok: false, reason: "busy_cancel_visible" };

  // Clear and Focus
  editor.focus();
  document.execCommand?.("selectAll", false, null);
  document.execCommand?.("delete", false, null);

  // Insert Text
  let inserted = false;
  try { inserted = !!document.execCommand?.("insertText", false, text); } catch {}
  if (!inserted) {
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text }));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  await new Promise(r => setTimeout(r, 100));

  // Submit — try multiple selectors
  const submit = document.querySelector("svg.lucide-arrow-right")?.closest("button")
    || document.querySelector('[data-tooltip-id="input-send-button-tooltip"]')
    || document.querySelector('button[type="submit"]');
  if (submit && !submit.disabled) {
    setTimeout(() => submit.click(), 50);
    return { ok: true, method: "click_submit" };
  }

  // Fallback: Enter key
  editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
  editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));

  return { ok: true, method: "enter_fallback" };
})()`;

// Logic: Get History List logic
const EXPRESSION_GET_HISTORY = `(() => {
    // Try to find the history list in the sidebar
    // Updated with observed flex-row classes for history items
    const selector = '.history-item, [aria-label*="Chat History"] .monaco-list-row, .flex.flex-row.items-center.justify-between';

    // Filter out non-history items from generic selector
    const genericItems = Array.from(document.querySelectorAll('.flex.flex-row.items-center.justify-between'));
    const validGeneric = genericItems.filter(el => el.innerText.includes('ago') || el.innerText.includes('Just now'));

    const specificItems = Array.from(document.querySelectorAll('.history-item, [aria-label*="Chat History"] .monaco-list-row'));

    const items = [...new Set([...specificItems, ...validGeneric])];

    if (items.length === 0) {
        return { ok: true, history: [] };
    }

    return {
        ok: true,
        history: items.map((el, idx) => ({
            index: idx,
            title: el.innerText.split('\\n')[0] || el.getAttribute('aria-label') || 'Untitled',
            active: el.classList.contains('focused') || el.classList.contains('selected') || el.classList.contains('bg-gray-500/10')
        }))
    };
})()`;

// Logic: Load History Item
const EXPRESSION_LOAD_HISTORY = (index) => `(() => {
    const selector = '.history-item, [aria-label*="Chat History"] .monaco-list-row, .flex.flex-row.items-center.justify-between';

    const genericItems = Array.from(document.querySelectorAll('.flex.flex-row.items-center.justify-between'));
    const validGeneric = genericItems.filter(el => el.innerText.includes('ago') || el.innerText.includes('Just now'));

    const specificItems = Array.from(document.querySelectorAll('.history-item, [aria-label*="Chat History"] .monaco-list-row'));

    const items = [...new Set([...specificItems, ...validGeneric])];

    const target = items[${index}];
    if (target) {
        target.click();
        return { ok: true };
    }
    return { ok: false, error: 'item_not_found' };
})()`;

export class CdpBridge {
    constructor() {
        this.ws = null;
        this.contexts = new Map(); // id -> context info
        this.isConnected = false;
        this.reconnectTimer = null;
        this.requestId = 1;
        this.pendingRequests = new Map(); // id -> {resolve, reject}
    }

    start() {
        console.log('[CDP] start() called');
        this.connect();
    }

    async connect() {
        console.log('[CDP] connect() called');
        try {
            const target = await this.findTarget();
            if (!target) {
                this.scheduleReconnect();
                return;
            }

            log(`Connecting to ${target.title} (${target.url})`);
            this.ws = new WebSocket(target.webSocketDebuggerUrl);

            this.ws.on('open', () => {
                log('WebSocket Connected');
                this.isConnected = true;
                this.initializeSession();
            });

            this.ws.on('message', (data) => this.handleMessage(data));

            this.ws.on('close', () => {
                log('WebSocket Closed');
                this.cleanup();
                this.scheduleReconnect();
            });

            this.ws.on('error', (err) => {
                error('WebSocket Error:', err.message);
                // Close will trigger cleanup
            });

        } catch (err) {
            error('Connection failed:', err.message);
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 5000);
    }

    cleanup() {
        this.isConnected = false;
        this.contexts.clear();
        this.ws = null;
        // Reject all pending requests
        for (const [_, { reject }] of this.pendingRequests) {
            reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();
    }

    async findTarget() {
        return new Promise((resolve) => {
            log('Looking for target at', `http://127.0.0.1:${CDP_PORT}/json/list`);
            http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const list = JSON.parse(data);
                        log('Found', list.length, 'targets');

                        // Priority 1: Main IDE window with Antigravity title
                        let found = list.find(t =>
                            (t.title && t.title.toLowerCase().includes('antigravity')) &&
                            t.url.includes('workbench.html') && !t.url.includes('jetski')
                        );

                        // Priority 2: Any workbench.html page
                        if (!found) found = list.find(t =>
                            t.url.includes('workbench.html') && !t.url.includes('jetski')
                        );

                        // Priority 3: Launchpad (jetski-agent) as fallback
                        if (!found) found = list.find(t => t.url.includes('jetski-agent'));

                        // Fallback: any page
                        if (!found) found = list.find(t => t.type === 'page');

                        if (found) log('Selected target:', found.title);
                        else log('No suitable target found');
                        resolve(found);
                    } catch (e) {
                        log('Parse error:', e.message);
                        resolve(null);
                    }
                });
            }).on('error', (e) => {
                log('HTTP error:', e.message);
                resolve(null);
            });
        });
    }

    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            if (!this.isConnected || !this.ws) {
                return reject(new Error('Not connected'));
            }
            const id = this.requestId++;
            this.pendingRequests.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    handleMessage(raw) {
        try {
            const msg = JSON.parse(raw);

            // Handle Responses
            if (msg.id && this.pendingRequests.has(msg.id)) {
                const { resolve, reject } = this.pendingRequests.get(msg.id);
                this.pendingRequests.delete(msg.id);
                if (msg.error) reject(msg.error);
                else resolve(msg.result);
                return;
            }

            // Handle Events
            if (msg.method === 'Runtime.executionContextCreated') {
                const ctx = msg.params.context;
                // log('Context created:', ctx.id, ctx.name || ctx.origin);
                this.contexts.set(ctx.id, ctx);
            }
            if (msg.method === 'Runtime.executionContextDestroyed') {
                this.contexts.delete(msg.params.executionContextId);
            }
            if (msg.method === 'Runtime.executionContextsCleared') {
                this.contexts.clear();
            }

        } catch (err) {
            error('Message Parse Error:', err);
        }
    }

    async initializeSession() {
        try {
            await this.send('Runtime.enable');
            log('Runtime enabled. Monitoring contexts...');
        } catch (err) {
            error('Init failed:', err);
        }
    }

    async injectMessage(text) {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };

        const attempts = 3;
        for (let i = 0; i < attempts; i++) {
            // 1. Try standard context iteration (fastest)
            let result = await this.tryInjectAnyContext(text);
            if (result.ok) return result;
            if (result.error === 'busy') return result;

            // 2. Lightweight retry — just wait for context events to update
            log(`[Retry ${i + 1}/${attempts}] Waiting for contexts to refresh...`);
            await new Promise(r => setTimeout(r, 1000));

            // 3. Try again with refreshed context list (which updates via events)
            result = await this.tryInjectAnyContext(text);
            if (result.ok) return result;
        }

        return { ok: false, error: 'editor_not_found_in_any_context' };
    }

    async tryInjectAnyContext(text) {
        const contextIds = [...this.contexts.keys()];
        if (contextIds.length === 0) return { ok: false, error: 'no_contexts' };

        // Prioritize later contexts (usually iframes created last)
        for (const contextId of contextIds.reverse()) {
            try {
                // Quick check if this context has the chat input
                const check = await this.send('Runtime.evaluate', {
                    expression: `document.querySelector('input.w-full, textarea, [contenteditable="true"]') ? true : false`,
                    contextId,
                    returnByValue: true
                });

                if (!check.result || !check.result.value) continue;

                // If element exists, try to inject
                const result = await this.send('Runtime.evaluate', {
                    expression: EXPRESSION_INJECT(text),
                    contextId,
                    returnByValue: true,
                    awaitPromise: true
                });

                if (result.result && result.result.value) {
                    const value = result.result.value;
                    if (value.ok) {
                        log('Injection success in context', contextId);
                        return value;
                    } else if (value.reason === 'busy_cancel_visible') {
                        return { ok: false, error: 'busy' };
                    }
                }
            } catch (err) { }
        }
        return { ok: false, error: 'not_found' };
    }

    // Stop the Agent (Click Cancel)
    async stopAgent() {
        const script = `(() => {
            const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
            if (cancel) {
                cancel.click();
                return { ok: true };
            }
            return { ok: false, error: 'not_found' };
        })()`;

        const contextIds = [...this.contexts.keys()];
        for (const contextId of contextIds.reverse()) {
            try {
                const res = await this.send('Runtime.evaluate', {
                    expression: script,
                    contextId,
                    returnByValue: true
                });
                if (res.result?.value?.ok) return { ok: true };
            } catch (e) { }
        }
        return { ok: false };
    }

    // Polling Loop for State Sync (reduced from 1s to 5s to avoid IDE contention)
    startPolling(broadcastFn) {
        setInterval(async () => {
            if (!this.isConnected) return;

            const contextIds = [...this.contexts.keys()];
            if (contextIds.length === 0) return; // No contexts, skip

            // Check busy state
            const script = `(() => {
                const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                return !!(cancel && cancel.offsetParent !== null);
             })()`;

            let isBusy = false;
            for (const contextId of contextIds.reverse()) {
                try {
                    const res = await Promise.race([
                        this.send('Runtime.evaluate', {
                            expression: script,
                            contextId,
                            returnByValue: true
                        }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('poll_timeout')), 2000))
                    ]);
                    if (res.result && res.result.value === true) {
                        isBusy = true;
                        break;
                    }
                } catch (e) { }
            }

            if (isBusy !== this.lastBusyState) {
                this.lastBusyState = isBusy;
                broadcastFn('agent_state', { busy: isBusy });
            }
        }, 5000);
    }

    // Observer for new messages
    // We inject a MutationObserver into the IDE context
    // Observer for new messages
    // We inject a MutationObserver into the IDE context
    async startObserver() {
        if (!this.isConnected) return;

        // Ensure we only have one console listener
        if (!this._consoleListenerBound) {
            this.send('Runtime.enable'); // Ensure enabled
            this.ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw);
                    if (msg.method === 'Runtime.consoleAPICalled') {
                        const args = msg.params.args;
                        if (args && args[0] && args[0].value && typeof args[0].value === 'string') {
                            const text = args[0].value;
                            if (text.startsWith('__AG_MSG__:')) {
                                const payload = JSON.parse(text.substring(11));
                                if (this.onNewMessage) this.onNewMessage(payload);
                            }
                            // Also log observer heartbeat
                            if (text.startsWith('__AG_OBSERVER_ACTIVE__')) {
                                // log('Observer active in context');
                            }
                        }
                    }
                } catch (e) { }
            });
            this._consoleListenerBound = true;
        }

        const contextIds = [...this.contexts.keys()].reverse();
        for (const contextId of contextIds) {
            try {
                // Check if already observing? (Hard to know)
                // Just inject logic
                await this.send('Runtime.evaluate', {
                    expression: `(() => {
                        // Re-inject if missing or stale
                        if (window._agObserver && document.body.contains(window._agObserverTarget)) return;
                        
                        window._agMessagesSeen = new Set();
                        window._agObserverTarget = document.body;
                        
                        const observer = new MutationObserver((mutations) => {
                             // Find new messages - expanded selectors
                             const items = [...document.querySelectorAll('.monaco-list-row, .chat-message-item, [role="listitem"], .msg-content')];
                             
                             items.forEach(el => {
                                 const text = el.innerText;
                                 if (!text || text.length < 2) return;
                                 
                                 const hash = text.substring(0, 50) + text.length;
                                 
                                 if (!window._agMessagesSeen.has(hash)) {
                                     window._agMessagesSeen.add(hash);
                                     
                                     const isUser = el.className.includes('user') || el.innerText.startsWith('You');
                                     const from = isUser ? 'user' : 'agent';
                                     
                                     console.log('__AG_MSG__:' + JSON.stringify({ from, text }));
                                 }
                             });
                        });
                        
                        observer.observe(document.body, { childList: true, subtree: true });
                        window._agObserver = observer;
                        console.log('__AG_OBSERVER_ACTIVE__');
                    })()`,
                    contextId
                });
            } catch (e) { }
        }
    }

    async getDOM(selector = 'body') {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };
        const contextIds = [...this.contexts.keys()];
        let results = [];

        for (const contextId of contextIds.reverse()) {
            try {
                const res = await this.send('Runtime.evaluate', {
                    expression: `(() => {
                        const el = document.querySelector('${selector}');
                        return el ? el.outerHTML.substring(0, 2000) : null;
                    })()`,
                    contextId,
                    returnByValue: true
                });
                if (res.result?.value) results.push({ id: contextId, html: res.result.value });
            } catch (e) { }
        }
        return { ok: true, results };
    }

    async evaluate(expression) {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };
        const contextIds = [...this.contexts.keys()];
        let results = [];

        for (const contextId of contextIds.reverse()) {
            try {
                const res = await this.send('Runtime.evaluate', {
                    expression,
                    contextId,
                    returnByValue: true,
                    awaitPromise: true
                });
                if (res.result) results.push({ id: contextId, result: res.result.value });
            } catch (e) {
                results.push({ id: contextId, error: e.message });
            }
        }
        return { ok: true, results };
    }

    async getHistory() {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };

        const contextIds = [...this.contexts.keys()].reverse();

        for (const contextId of contextIds) {
            try {
                const res = await this.send('Runtime.evaluate', {
                    expression: EXPRESSION_GET_HISTORY,
                    contextId,
                    returnByValue: true
                });
                if (res.result?.value?.ok) {
                    return res.result.value;
                }
            } catch (e) { }
        }
        return { ok: false, error: 'history_ui_not_found' };
    }

    async loadHistory(index) {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };
        const contextIds = [...this.contexts.keys()].reverse();

        for (const contextId of contextIds) {
            try {
                const res = await this.send('Runtime.evaluate', {
                    expression: EXPRESSION_LOAD_HISTORY(index),
                    contextId,
                    returnByValue: true
                });
                if (res.result?.value?.ok) {
                    return res.result.value;
                }
            } catch (e) { }
        }
        return { ok: false, error: 'history_ui_not_found' };
    }

    async uploadFile(path) {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };

        // Ensure DOM is enabled and tree is populated
        await this.send('DOM.enable');
        await this.send('DOM.getDocument', { depth: -1, pierce: true });

        const contextIds = [...this.contexts.keys()].reverse();

        for (const contextId of contextIds) {
            try {
                // 1. Find input handle
                const evalRes = await this.send('Runtime.evaluate', {
                    expression: 'document.querySelector("input[type=file]")',
                    contextId
                });

                if (evalRes.result && evalRes.result.objectId && evalRes.result.subtype !== 'null') {
                    const objectId = evalRes.result.objectId;

                    // 2. Get Node ID
                    const nodeRes = await this.send('DOM.requestNode', { objectId });
                    const nodeId = nodeRes.nodeId;

                    // 3. Set Files
                    await this.send('DOM.setFileInputFiles', {
                        nodeId,
                        files: [path]
                    });

                    log('Uploaded file to context', contextId);
                    return { ok: true, contextId };
                }
            } catch (e) {
                // Context might not support DOM or other error
            }
        }
        return { ok: false, error: 'input_not_found' };
    }

    async triggerShortcut(modifiers, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode) {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };

        // We target the page directly via Input domain, usually doesn't need contextId if focused,
        // but let's try to focus the main page first just in case.

        try {
            // Modifiers: 1=Alt, 2=Ctrl, 4=Meta/Command, 8=Shift
            // cdp expects "modifiers" bitmask

            // RawKeyDown
            await this.send('Input.dispatchKeyEvent', {
                type: 'rawKeyDown',
                modifiers,
                key, // e.g. "l" or "M"
                code, // e.g. "KeyL"
                windowsVirtualKeyCode,
                nativeVirtualKeyCode
            });

            // KeyUp
            await this.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                modifiers,
                key,
                code,
                windowsVirtualKeyCode,
                nativeVirtualKeyCode
            });

            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    // --- Tab Management ---

    async getTabs() {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };

        // We'll iterate contexts to find the one with the tab bar
        const contextIds = [...this.contexts.keys()].reverse();

        // Script to scrape tabs
        const script = `(() => {
            // VS Code tabs usually have class 'tab' and contain 'tab-label'
            // We'll look for both standard and specific selectors
            const tabs = [...document.querySelectorAll('.tab')];
            if (tabs.length === 0) return null;

            return tabs.map((t, idx) => {
                const label = t.querySelector('.tab-label, .monaco-icon-label-container');
                const name = label ? label.innerText : t.innerText;
                const active = t.classList.contains('active');
                return { index: idx, name: name.trim(), active };
            }).filter(t => t.name.length > 0);
        })()`;

        for (const contextId of contextIds) {
            try {
                const res = await this.send('Runtime.evaluate', {
                    expression: script,
                    contextId,
                    returnByValue: true
                });

                if (res.result?.value) {
                    // Found a context that returned tabs
                    return { ok: true, tabs: res.result.value, contextId };
                }
            } catch (e) { }
        }

        return { ok: false, error: 'tabs_not_found' };
    }

    async focusTab(nameOrIndex) {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };

        // 1. Get current tabs to find the target
        const tabRes = await this.getTabs();
        if (!tabRes.ok || !tabRes.tabs) return { ok: false, error: 'tabs_not_found_for_focus' };

        const { tabs, contextId } = tabRes;
        let targetIdx = -1;

        if (typeof nameOrIndex === 'number') {
            targetIdx = nameOrIndex;
        } else {
            // Find by partial name match (case insensitive)
            const lowerQuery = String(nameOrIndex).toLowerCase();
            targetIdx = tabs.findIndex(t => t.name.toLowerCase().includes(lowerQuery));
        }

        if (targetIdx === -1) return { ok: false, error: 'tab_not_found' };

        // 2. Click the tab in the SAME context where we found it
        const script = `(() => {
            const tabs = [...document.querySelectorAll('.tab')];
            const target = tabs[${targetIdx}];
            if (target) {
                // Try multiple click methods
                target.click();
                target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                return { ok: true, name: target.innerText };
            }
            return { ok: false, error: 'dom_element_missing' };
        })()`;

        try {
            const clickRes = await this.send('Runtime.evaluate', {
                expression: script,
                contextId, // Use the context where we found the tabs
                returnByValue: true
            });

            if (clickRes.result?.value?.ok) {
                return { ok: true, target: tabs[targetIdx].name };
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }

        return { ok: false, error: 'click_failed' };
    }
}

export const cdpBridge = new CdpBridge();
