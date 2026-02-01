import WebSocket from 'ws';
import http from 'http';

// Configuration
const CDP_PORT = 9000;
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
  
  // 1. Find the editor
  const editors = [...document.querySelectorAll('#cascade [data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
    .filter(el => el.offsetParent !== null);
  const editor = editors.at(-1);
  
  if (!editor) return { ok: false, error: "editor_not_found" };

  // 2. Check busy state again
  const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
  if (cancel && cancel.offsetParent !== null) return { ok: false, reason: "busy_cancel_visible" };

  // 3. Clear and Focus
  editor.focus();
  document.execCommand?.("selectAll", false, null);
  document.execCommand?.("delete", false, null);

  // 4. Insert Text
  let inserted = false;
  try { inserted = !!document.execCommand?.("insertText", false, text); } catch {}
  if (!inserted) {
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text }));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  // Allow UI updates
  await new Promise(r => setTimeout(r, 100));

  // 5. Submit
  const submit = document.querySelector("svg.lucide-arrow-right")?.closest("button");
  if (submit && !submit.disabled) {
    setTimeout(() => submit.click(), 50); // Delay click to allow return value to pass
    return { ok: true, method: "click_submit" };
  }

  // Fallback: Enter key
  editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
  editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));

  return { ok: true, method: "enter_fallback" };
})()`;

// Logic: Get History List logic
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
        this.connect();
    }

    async connect() {
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
            http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const list = JSON.parse(data);
                        // Prioritize IDE window or windows with Antigravity title
                        let found = list.find(t =>
                            t.url.includes('localhost:9090') ||
                            (t.title && t.title.toLowerCase().includes('antigravity'))
                        );

                        // Fallback logic from poke.mjs
                        if (!found) found = list.find(t => t.url.includes('workbench.html'));
                        if (!found) found = list.find(t => t.type === 'page');

                        resolve(found);
                    } catch { resolve(null); }
                });
            }).on('error', () => resolve(null));
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

            // 2. If failed, force refresh frame tree and try to find iframe
            log(`[Retry ${i + 1}/${attempts}] Refreshing DOM tree to find chat iframe...`);
            try {
                // Force full deep document retrieval to populate frame Ids
                await this.send('DOM.enable');
                const doc = await this.send('DOM.getDocument', { depth: -1, pierce: true });
                // We don't use 'doc' directly but this forces the browser to know about all frames
            } catch (e) { }

            // Wait briefly before retry
            await new Promise(r => setTimeout(r, 800));

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
                    expression: `document.querySelector('textarea, [contenteditable="true"]') ? true : false`,
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

    // Polling Loop for State Sync
    startPolling(broadcastFn) {
        setInterval(async () => {
            if (!this.isConnected) return;

            // Check busy state
            const script = `(() => {
                const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                return !!(cancel && cancel.offsetParent !== null);
             })()`;

            let isBusy = false;
            const contextIds = [...this.contexts.keys()];
            for (const contextId of contextIds.reverse()) {
                try {
                    const res = await this.send('Runtime.evaluate', {
                        expression: script,
                        contextId,
                        returnByValue: true
                    });
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
        }, 1000);
    }

    // Observer for new messages
    // We inject a MutationObserver into the IDE context
    async startObserver() {
        if (!this.isConnected) return;

        const contextIds = [...this.contexts.keys()].reverse();
        for (const contextId of contextIds) {
            try {
                // Check if already observing? (Hard to know)
                // Just inject logic
                await this.send('Runtime.evaluate', {
                    expression: `(() => {
                        if (window._agObserver) return;
                        
                        window._agMessagesSeen = new Set();
                        
                        // Find a stable container. Usually the list of items.
                        // We'll observe document body or strict selector if known.
                        // VS Code chat list is usually dynamic.
                        
                        const observer = new MutationObserver((mutations) => {
                             // Find new messages
                             const items = [...document.querySelectorAll('.monaco-list-row, .chat-message-item, [role="listitem"]')];
                             const newMessages = [];
                             
                             items.forEach(el => {
                                 // Basic heuristic: check if it has text
                                 const text = el.innerText;
                                 if (!text || text.length < 2) return;
                                 
                                 // Generate simple hash or ID
                                 const hash = text.substring(0, 50) + text.length;
                                 
                                 if (!window._agMessagesSeen.has(hash)) {
                                     window._agMessagesSeen.add(hash);
                                     
                                     // Determine Sender
                                     const isUser = el.className.includes('user') || el.innerText.startsWith('You');
                                     const from = isUser ? 'user' : 'agent';
                                     
                                     // Send to bridge (console.log special format)
                                     console.log('__AG_MSG__:' + JSON.stringify({ from, text }));
                                 }
                             });
                        });
                        
                        observer.observe(document.body, { childList: true, subtree: true });
                        window._agObserver = observer;
                        console.log('AG Observer Started');
                    })()`,
                    contextId
                });
            } catch (e) { }
        }

        // Listen for console logs
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
                            // Emit to formatting
                            // We need access to the WS broadcasting function.
                            // We'll emit an event or call a callback.
                            if (this.onNewMessage) this.onNewMessage(payload);
                        }
                    }
                }
            } catch (e) { }
        });
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
}

export const cdpBridge = new CdpBridge();
