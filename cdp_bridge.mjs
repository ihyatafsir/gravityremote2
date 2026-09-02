import WebSocket from 'ws';
import http from 'http';

// Configuration
const CDP_PORT = 9222;
const DEBUG = false; // Reduced logging

function log(...args) {
    if (DEBUG) console.log('[CDP]', ...args);
}

function error(...args) {
    console.error('[CDP]', ...args);
}

// Logic: Check if Agent is busy (Cancel button visible)
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
    const selector = '.history-item, [aria-label*="Chat History"] .monaco-list-row, .flex.flex-row.items-center.justify-between';
    const genericItems = Array.from(document.querySelectorAll('.flex.flex-row.items-center.justify-between'));
    const validGeneric = genericItems.filter(el => el.innerText.includes('ago') || el.innerText.includes('Just now'));
    const specificItems = Array.from(document.querySelectorAll('.history-item, [aria-label*="Chat History"] .monaco-list-row'));
    const items = [...new Set([...specificItems, ...validGeneric])];

    if (items.length === 0) return { ok: true, history: [] };

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

        // Optimizations: Track the active chat context
        this.activeChatContextId = null;
        this.lastBusyState = false;
        this._consoleListenerBound = false;
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
        this.activeChatContextId = null;
        this.ws = null;
        this._consoleListenerBound = false;
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
                        // Filter out browser tabs / web pages
                        const validList = list.filter(t => {
                            const url = (t.url || "").toLowerCase();
                            const title = (t.title || "").toLowerCase();
                            if (url.startsWith("http://") || url.startsWith("https://")) return false;
                            if (title.includes("phone connect") || title.includes("gravityrem")) return false;
                            return true;
                        });

                        // Priority 1: Main IDE window (workbench.html)
                        let found = validList.find(t => t.title && t.title.toLowerCase().includes('antigravity') && t.url.includes('workbench.html') && !t.url.includes('jetski'));
                        // Priority 2: Any workbench
                        if (!found) found = validList.find(t => t.url.includes('workbench.html') && !t.url.includes('jetski'));
                        // Priority 3: Jetski agent
                        if (!found) found = validList.find(t => t.url.includes('jetski-agent'));
                        // Fallback: non-http page only
                        if (!found) found = validList.find(t => t.type === 'page');

                        resolve(found);
                    } catch (e) {
                        resolve(null);
                    }
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
            if (msg.id && this.pendingRequests.has(msg.id)) {
                const { resolve, reject } = this.pendingRequests.get(msg.id);
                this.pendingRequests.delete(msg.id);
                if (msg.error) reject(msg.error);
                else resolve(msg.result);
                return;
            }

            // Context lifecycle
            if (msg.method === 'Runtime.executionContextCreated') {
                const ctx = msg.params.context;
                this.contexts.set(ctx.id, ctx);
            }
            if (msg.method === 'Runtime.executionContextDestroyed') {
                this.contexts.delete(msg.params.executionContextId);
                if (this.activeChatContextId === msg.params.executionContextId) {
                    this.activeChatContextId = null; // Reset if active context dies
                }
            }
            if (msg.method === 'Runtime.executionContextsCleared') {
                this.contexts.clear();
                this.activeChatContextId = null;
            }

        } catch (err) { }
    }

    async initializeSession() {
        try {
            await this.send('Runtime.enable');
            log('Runtime enabled.');
        } catch (err) { }
    }

    // --- Core Injection Logic (Optimized) ---

    async injectMessage(text) {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };

        // 1. Try Cached Context First
        if (this.activeChatContextId) {
            const res = await this.injectIntoContext(this.activeChatContextId, text);
            if (res.ok) return res;
            if (res.error === 'busy') return res;

            // If failed (e.g. context stale or element gone), clear cache and scan
            this.activeChatContextId = null;
        }

        // 2. Scan all contexts (reverse order)
        const contextIds = [...this.contexts.keys()].reverse();
        for (const contextId of contextIds) {
            const res = await this.injectIntoContext(contextId, text);
            if (res.ok) {
                this.activeChatContextId = contextId; // Cache success
                log(`[inject] Found active context: ${contextId}`);
                return res;
            }
            if (res.error === 'busy') {
                this.activeChatContextId = contextId; // Cache busy context too
                return res;
            }
        }

        return { ok: false, error: 'chat_input_not_found' };
    }

    async injectIntoContext(contextId, text) {
        try {
            // Check for input existence first (cheap)
            const check = await this.send('Runtime.evaluate', {
                expression: `document.querySelector('input.w-full.py-2, [data-lexical-editor="true"][contenteditable="true"][role="textbox"]') ? true : false`,
                contextId,
                returnByValue: true
            });

            if (!check.result || !check.result.value) return { ok: false };

            // Inject
            const result = await this.send('Runtime.evaluate', {
                expression: EXPRESSION_INJECT(text),
                contextId,
                returnByValue: true,
                awaitPromise: true
            });

            if (result.result?.value) {
                const val = result.result.value;
                if (val.ok) return val;
                if (val.reason === 'busy_cancel_visible') return { ok: false, error: 'busy' };
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }
        return { ok: false };
    }

    // --- State Polling (Optimized) ---

    // Stop Agent
    async stopAgent() {
        // Try active context first
        if (this.activeChatContextId) {
            if (await this.tryStop(this.activeChatContextId)) return { ok: true };
        }

        // Scan others
        const contextIds = [...this.contexts.keys()].reverse();
        for (const cid of contextIds) {
            if (cid === this.activeChatContextId) continue;
            if (await this.tryStop(cid)) {
                this.activeChatContextId = cid;
                return { ok: true };
            }
        }
        return { ok: false };
    }

    async tryStop(contextId) {
        try {
            const res = await this.send('Runtime.evaluate', {
                expression: `(() => {
                    const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                    if (cancel) { cancel.click(); return true; }
                    return false;
                })()`,
                contextId,
                returnByValue: true
            });
            return res.result?.value === true;
        } catch (e) { return false; }
    }

    // Polling Loop for State Sync
    // REDUCED FREQUENCY: 5s -> 10s (and uses active context opt)
    startPolling(broadcastFn) {
        setInterval(async () => {
            if (!this.isConnected) return;

            // 1. Check active context (cheap)
            let isBusy = false;
            if (this.activeChatContextId) {
                isBusy = await this.checkBusy(this.activeChatContextId);
            } else {
                // 2. Fallback: lightweight scan of last 3 contexts only
                const candidates = [...this.contexts.keys()].reverse().slice(0, 3);
                for (const cid of candidates) {
                    if (await this.checkBusy(cid)) {
                        isBusy = true;
                        this.activeChatContextId = cid; // Found it
                        break;
                    }
                }
            }

            if (isBusy !== this.lastBusyState) {
                this.lastBusyState = isBusy;
                broadcastFn('agent_state', { busy: isBusy });
            }
        }, 10000); // 10s interval
    }

    async checkBusy(contextId) {
        try {
            const res = await this.send('Runtime.evaluate', {
                expression: EXPRESSION_BUSY,
                contextId,
                returnByValue: true
            });
            return res.result?.value?.busy === true;
        } catch (e) { return false; }
    }

    // Observer for new messages
    // We inject a MutationObserver into the IDE context
    async startObserver() {
        if (!this.isConnected) return;

        // Ensure console listener is bound
        if (!this._consoleListenerBound) {
            this.send('Runtime.enable');
            this.ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw);
                    if (msg.method === 'Runtime.consoleAPICalled') {
                        const args = msg.params.args;
                        if (args?.[0]?.value?.startsWith('__AG_MSG__:')) {
                            const payload = JSON.parse(args[0].value.substring(11));
                            if (this.onNewMessage) this.onNewMessage(payload);
                        }
                    }
                } catch (e) { }
            });
            this._consoleListenerBound = true;
        }

        // Inject observer logic
        // Only target active context if known, otherwise scan last 5
        const targets = this.activeChatContextId
            ? [this.activeChatContextId]
            : [...this.contexts.keys()].reverse().slice(0, 5);

        const observerScript = `(() => {
            if (window._agObserver && document.body.contains(window._agObserverTarget)) return;
            
            window._agMessagesSeen = new Set();
            window._agObserverTarget = document.body;
            
            const observer = new MutationObserver((mutations) => {
                 const items = [...document.querySelectorAll('.monaco-list-row, .chat-message-item, [role="listitem"], .msg-content')];
                 items.forEach(el => {
                     const text = el.innerText;
                     if (!text || text.length < 2) return;
                     const hash = text.substring(0, 50) + text.length;
                     if (!window._agMessagesSeen.has(hash)) {
                         window._agMessagesSeen.add(hash);
                         const isUser = el.className.includes('user') || el.innerText.startsWith('You');
                         console.log('__AG_MSG__:' + JSON.stringify({ from: isUser ? 'user' : 'agent', text }));
                     }
                 });
            });
            
            observer.observe(document.body, { childList: true, subtree: true });
            window._agObserver = observer;
            console.log('__AG_OBSERVER_ACTIVE__');
        })()`;

        for (const contextId of targets) {
            this.send('Runtime.evaluate', { expression: observerScript, contextId }).catch(() => { });
        }
    }

    // --- Utils ---

    async getDOM(selector = 'body') {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };
        // Just inspect active or last context
        const contextId = this.activeChatContextId || [...this.contexts.keys()].pop();
        if (!contextId) return { ok: false, error: 'no_context' };

        const res = await this.send('Runtime.evaluate', {
            expression: `document.querySelector('${selector}')?.outerHTML.substring(0, 2000)`,
            contextId, returnByValue: true
        });
        return { ok: true, html: res.result?.value };
    }

    async evaluate(expression) {
        if (!this.isConnected) return { ok: false, error: 'not_connected' };
        const contextId = this.activeChatContextId || [...this.contexts.keys()].pop();
        const res = await this.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
        return { ok: true, result: res.result?.value };
    }

    async getHistory() {
        if (!this.isConnected) return { ok: false };
        const contextId = this.activeChatContextId || [...this.contexts.keys()].pop();
        const res = await this.send('Runtime.evaluate', { expression: EXPRESSION_GET_HISTORY, contextId, returnByValue: true });
        return res.result?.value || { ok: false };
    }

    async loadHistory(index) {
        if (!this.isConnected) return { ok: false };
        const contextId = this.activeChatContextId || [...this.contexts.keys()].pop();
        const res = await this.send('Runtime.evaluate', { expression: EXPRESSION_LOAD_HISTORY(index), contextId, returnByValue: true });
        return res.result?.value || { ok: false };
    }

    async uploadFile(path) {
        // Reduced to just finding the input in any context
        if (!this.isConnected) return { ok: false };
        await this.send('DOM.enable');
        await this.send('DOM.getDocument', { depth: -1, pierce: true });

        const contextIds = [...this.contexts.keys()].reverse();
        for (const contextId of contextIds) {
            const evalRes = await this.send('Runtime.evaluate', { expression: 'document.querySelector("input[type=file]")', contextId });
            if (evalRes.result?.objectId) {
                const { nodeId } = await this.send('DOM.requestNode', { objectId: evalRes.result.objectId });
                await this.send('DOM.setFileInputFiles', { nodeId, files: [path] });
                return { ok: true, contextId };
            }
        }
        return { ok: false };
    }

    async triggerShortcut(modifiers, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode) {
        if (!this.isConnected) return { ok: false };
        try {
            await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode });
            await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode });
            return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
    }

    async getTabs() {
        if (!this.isConnected) return { ok: false };
        const contextIds = [...this.contexts.keys()].reverse();
        const script = `(() => {
            const tabs = [...document.querySelectorAll('.tab')];
            if (tabs.length === 0) return null;
            return tabs.map((t, idx) => ({
                index: idx, 
                name: (t.querySelector('.tab-label') || t).innerText.trim(), 
                active: t.classList.contains('active')
            })).filter(t => t.name.length > 0);
        })()`;

        for (const contextId of contextIds) {
            const res = await this.send('Runtime.evaluate', { expression: script, contextId, returnByValue: true });
            if (res.result?.value) return { ok: true, tabs: res.result.value, contextId };
        }
        return { ok: false };
    }

    async focusTab(name) {
        if (!this.isConnected) return { ok: false };
        const { tabs, contextId } = await this.getTabs();
        if (!tabs) return { ok: false };

        const targetIdx = tabs.findIndex(t => t.name.toLowerCase().includes(name.toLowerCase()));
        if (targetIdx === -1) return { ok: false };

        await this.send('Runtime.evaluate', {
            expression: `document.querySelectorAll('.tab')[${targetIdx}].click()`,
            contextId
        });
        return { ok: true, target: tabs[targetIdx].name };
    }
}

export const cdpBridge = new CdpBridge();
