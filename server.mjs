import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { networkInterfaces } from 'os';
import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cdpBridge } from './cdp_bridge.mjs';
import { exec } from 'child_process';
import { readFileSync } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import multer from 'multer';

const upload = multer({ dest: '/tmp/ag_uploads/' });

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const STATE_FILE = join(DATA_DIR, 'state.json');

// ----------------------------------------------------------------------
// CDP <-> WS Binding
// ----------------------------------------------------------------------

cdpBridge.onNewMessage = (msg) => {
    // Broadcast to mobile clients
    broadcast({ event: 'message_new', payload: msg });
};

// Start Observer periodically to catch new contexts
setInterval(() => {
    cdpBridge.startObserver();
}, 5000);

// CDP is initialized in main()
const PORT = parseInt(process.env.PORT || '8787');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// --- State (with سند - persistent outbox for agent replies) ---
let STATE = {
    messages: [],
    agent: { state: 'idle', lastSeen: null, task: '', busy: false },
    actionQueue: [], // Async Action Queue
    delegations: [],  // Agent Delegation Tasks
    outbox: []       // سند (Sanad) - Persistent outbox for agent replies when MCP is down
};

async function loadState() {
    try {
        await mkdir(DATA_DIR, { recursive: true });
        const raw = await readFile(STATE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.messages)) STATE.messages = data.messages;
        if (Array.isArray(data.messages)) STATE.messages = data.messages;
        if (data.agent) STATE.agent = { ...STATE.agent, ...data.agent };
        if (Array.isArray(data.actionQueue)) STATE.actionQueue = data.actionQueue;
        if (Array.isArray(data.delegations)) STATE.delegations = data.delegations;
        if (Array.isArray(data.outbox)) STATE.outbox = data.outbox;
        console.log(`[PERSIST] State loaded. ${STATE.messages.length} msgs, ${STATE.actionQueue.length} queued, ${STATE.delegations.length} delegations, ${STATE.outbox.length} outbox.`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log('[PERSIST]', 'No state file found. Starting fresh.');
        }
    }
}

async function saveState() {
    try {
        const tempFile = `${STATE_FILE}.tmp`;
        await writeFile(tempFile, JSON.stringify(STATE, null, 2));
        await rename(tempFile, STATE_FILE);
    } catch (err) {
        console.log('[PERSIST]', 'Failed to save state:', err.message);
    }
}

function broadcast(event, payload) {
    const msg = JSON.stringify({ event, payload, ts: new Date().toISOString() });
    for (const client of wss.clients) {
        if (client.readyState === 1) { // OPEN
            client.send(msg);
        }
    }
}

function getLocalIPs() {
    const nets = networkInterfaces();
    const results = new Set();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('100.')) {
                results.add(net.address);
            }
        }
    }
    return Array.from(results);
}

// --- Middleware ---
app.use(express.json());
app.use(express.static('public'));

// --- HTTP Endpoints ---
app.get('/health', (req, res) => {
    res.json({
        ok: true,
        name: "ag_bridge",
        version: "0.2.0 (CDP)",
        cdp: cdpBridge.isConnected ? 'connected' : 'disconnected',
        ts: new Date().toISOString()
    });
});

// GET /api/lisan - Serve Lisan al-Arab sentences
app.get('/api/lisan', (req, res) => {
    const sentences = [
        "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ",
        "اقْرَأْ بِاسْمِ رَبِّكَ الَّذِي خَلَقَ",
        "خَلَقَ الْإِنسَانَ مِنْ عَلَقٍ",
        "اقْرَأْ وَرَبُّكَ الْأَكْرَمُ",
        "الَّذِي عَلَّمَ بِالْقَلَمِ",
        "عَلَّمَ الْإِنسَانَ مَا لَمْ يَعْلَمْ",
        "الَّذِي يَرَ الْيَقِينُ مِفَتَاحُ الْفَرَجِ",
        "الْعِلْمُ نُورٌ وَالْجَهْلُ ظَلَامٌ",
        "كُنْ مَعَ اللَّهِ تَرَ اللَّهَ مَعَكَ",
        "الصَّبْرُ مِفْتَاحُ الْفَرَجِ"
    ];
    res.json(sentences);
});

// POST /messages/send
app.post('/messages/send', async (req, res) => {
    const { to, text, from } = req.body;
    if (!to || !text) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const msg = {
        id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        createdAt: new Date().toISOString(),
        from: from || 'user',
        to,
        text,
        status: 'new'
    };

    STATE.messages.push(msg);
    if (STATE.messages.length > 200) STATE.messages.shift();
    saveState();

    broadcast('message_new', msg);

    // If message is for agent, Try to inject directly via CDP
    let injectionResult = null;
    if (to === 'agent') {
        console.log(`[MSG] Injecting via CDP: "${text.substring(0, 30)}..."`);
        injectionResult = await cdpBridge.injectMessage(text);
        console.log('[MSG] CDP Result:', injectionResult);
    }

    const startOk = injectionResult ? injectionResult.ok : true;
    res.json({ ok: startOk, message: msg, injection: injectionResult });
});

// GET /messages/inbox (for Agent/MCP to poll)
app.get('/messages/inbox', (req, res) => {
    const { to, status, limit } = req.query;
    let items = STATE.messages;

    if (to) items = items.filter(m => m.to === to);
    if (status) items = items.filter(m => m.status === status);

    items = [...items].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (limit) items = items.slice(0, parseInt(limit));

    res.json({ ok: true, messages: items });
});

// POST /messages/:id/ack
app.post('/messages/:id/ack', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const msg = STATE.messages.find(m => m.id === id);
    if (!msg) return res.status(404).json({ ok: false, error: 'not_found' });

    if (status) msg.status = status;
    saveState();

    broadcast('message_update', msg);
    res.json({ ok: true, message: msg });
});

// ============================================================================
// سند (Sanad) - Persistent Outbox for Agent Replies (HTTP Fallback)
// When MCP is down, agent replies are stored here and can be polled by mobile
// ============================================================================

// POST /api/outbox - Agent adds a reply to the outbox (for mobile to poll)
app.post('/api/outbox', (req, res) => {
    const { text, priority } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: 'text_required' });

    const reply = {
        id: 'out_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        createdAt: new Date().toISOString(),
        text,
        priority: priority || 'normal',
        delivered: false
    };

    STATE.outbox.push(reply);
    if (STATE.outbox.length > 100) STATE.outbox.shift(); // Keep last 100
    saveState();

    broadcast('outbox_new', reply);
    console.log(`[SANAD] Agent reply queued: ${text.substring(0, 50)}...`);
    res.json({ ok: true, reply });
});

// GET /api/outbox - Mobile polls for agent replies
app.get('/api/outbox', (req, res) => {
    const { delivered, limit } = req.query;
    let items = STATE.outbox;

    // Filter by delivery status
    if (delivered === 'false') {
        items = items.filter(r => !r.delivered);
    } else if (delivered === 'true') {
        items = items.filter(r => r.delivered);
    }

    // Limit results
    const maxItems = parseInt(limit) || 50;
    items = items.slice(-maxItems);

    res.json({ ok: true, replies: items, count: items.length });
});

// POST /api/outbox/:id/ack - Mobile acknowledges receipt
app.post('/api/outbox/:id/ack', (req, res) => {
    const { id } = req.params;
    const reply = STATE.outbox.find(r => r.id === id);
    if (!reply) return res.status(404).json({ ok: false, error: 'not_found' });

    reply.delivered = true;
    reply.deliveredAt = new Date().toISOString();
    saveState();

    broadcast('outbox_ack', reply);
    res.json({ ok: true, reply });
});

// GET /status
app.get('/status', (req, res) => {
    res.json({
        ok: true,
        agent: STATE.agent,
        pendingMessages: STATE.messages.filter(m => m.status === 'new' && m.to === 'agent').length,
        cdp: cdpBridge.isConnected
    });
});

// POST /agent/heartbeat
app.post('/agent/heartbeat', (req, res) => {
    const { state, task } = req.body;

    STATE.agent = {
        ...STATE.agent,
        lastSeen: new Date().toISOString(),
        state: state || STATE.agent.state,
        task: task !== undefined ? task : STATE.agent.task
    };

    saveState();
    broadcast('agent_heartbeat', STATE.agent);
    saveState();
    broadcast('agent_heartbeat', STATE.agent);
    res.json({ ok: true });
});

// --- Async Queue Processor ---
setInterval(async () => {
    // If we have actions and agent is NOT busy
    if (STATE.actionQueue.length > 0 && !STATE.agent.busy) {
        const action = STATE.actionQueue[0];
        console.log(`[QUEUE] Processing action from ${action.from}: "${action.text.substring(0, 20)}..."`);

        try {
            // Verify BUSY state one last time via CDP live check
            // (Agent heartbeat might be slightly stale)
            const injection = await cdpBridge.injectMessage(action.text);

            if (injection.ok) {
                console.log('[QUEUE] Success! Removing from queue.');
                STATE.actionQueue.shift();
                saveState();
                broadcast('queue_update', { count: STATE.actionQueue.length, lastAction: 'success' });
            } else if (injection.error === 'busy') {
                console.log('[QUEUE] CDP reported BUSY. Retrying later.');
                // Update state to match reality
                STATE.agent.busy = true;
                broadcast('agent_state', { busy: true });
            } else {
                console.log('[QUEUE] Injection failed (non-busy). dropping.', injection.error);
                // Drop it to avoid infinite block? Or retry? 
                // For now, drop after 3 failures? We'll just drop for safety.
                STATE.actionQueue.shift();
                saveState();
            }
        } catch (e) {
            console.error('[QUEUE] Error processing:', e);
        }
    }
}, 2000); // Check every 2 seconds

// --- Tab & Queue API ---

// POST /api/queue
app.post('/api/queue', (req, res) => {
    const { text, from } = req.body;
    if (!text) return res.json({ ok: false, error: 'missing_text' });

    STATE.actionQueue.push({
        id: Date.now().toString(),
        text,
        from: from || 'api',
        addedAt: new Date().toISOString()
    });
    saveState();

    console.log(`[QUEUE] Added action. Size: ${STATE.actionQueue.length}`);
    broadcast('queue_update', { count: STATE.actionQueue.length });
    res.json({ ok: true, position: STATE.actionQueue.length });
});

// GET /api/tabs
app.get('/api/tabs', async (req, res) => {
    try {
        const result = await cdpBridge.getTabs();
        res.json(result);
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

// POST /api/tabs/focus
app.post('/api/tabs/focus', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.json({ ok: false, error: 'missing_name' });

    try {
        const result = await cdpBridge.focusTab(name);
        res.json(result);
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});


// --- Delegation API (Supervisor Pattern) ---

// Model configuration for delegation
const AVAILABLE_MODELS = [
    { index: 0, name: 'Gemini 3 Pro (High)', key: 'gemini-pro-high' },
    { index: 1, name: 'Gemini 3 Pro (Low)', key: 'gemini-pro-low' },
    { index: 2, name: 'Gemini 3 Flash', key: 'gemini-flash' },
    { index: 3, name: 'Claude Sonnet 4.5', key: 'claude-sonnet' },
    { index: 4, name: 'Claude Sonnet 4.5 (Thinking)', key: 'claude-sonnet-thinking' },
    { index: 5, name: 'Claude Opus 4.5 (Thinking)', key: 'claude-opus-thinking' },
    { index: 6, name: 'GPT-OSS 120B (Medium)', key: 'gpt-oss-120b' }
];

// POST /api/delegation - Create a new delegation task with optional model selection
app.post('/api/delegation', async (req, res) => {
    const { target_tab, task, priority, timeout_ms, model } = req.body;
    if (!target_tab || !task) {
        return res.json({ ok: false, error: 'missing_target_tab_or_task' });
    }

    // Resolve model - can be index (0-6), name, or key
    let modelInfo = null;
    if (model !== undefined && model !== null) {
        if (typeof model === 'number') {
            modelInfo = AVAILABLE_MODELS.find(m => m.index === model);
        } else if (typeof model === 'string') {
            modelInfo = AVAILABLE_MODELS.find(m =>
                m.name.toLowerCase().includes(model.toLowerCase()) ||
                m.key.toLowerCase() === model.toLowerCase()
            );
        }
    }

    const delegation = {
        id: 'del_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        target_tab,
        task,
        model: modelInfo ? modelInfo.name : null,
        modelIndex: modelInfo ? modelInfo.index : null,
        priority: priority || 'normal',
        timeout_ms: timeout_ms || 300000,
        status: 'pending',
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        result: null,
        error: null
    };

    STATE.delegations.push(delegation);
    if (STATE.delegations.length > 50) STATE.delegations.shift();
    saveState();
    console.log(`[DELEGATION] Created: ${delegation.id} -> ${target_tab}${modelInfo ? ` (model: ${modelInfo.name})` : ''}`);

    try {
        // Step 1: Focus the target tab
        const focusResult = await cdpBridge.focusTab(target_tab);
        if (!focusResult.ok) {
            delegation.status = 'failed';
            delegation.error = `Tab focus failed: ${focusResult.error}`;
            saveState();
            broadcast('delegation_update', delegation);
            return res.json({ ok: true, delegation });
        }

        // Step 2: Switch model if specified (give time for tab to focus)
        if (modelInfo) {
            console.log(`[DELEGATION] Switching to model ${modelInfo.index}: ${modelInfo.name}`);
            await new Promise(r => setTimeout(r, 500)); // Wait for focus

            // Click the model selector and choose model
            const modelSwitchCode = `
                (function() {
                    try {
                        // Find model selector button and click it
                        const modelButton = document.querySelector('[data-testid="model-selector-button"]') 
                            || Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Model'));
                        if (modelButton) {
                            modelButton.click();
                            setTimeout(() => {
                                // Click the specific model option
                                const options = document.querySelectorAll('[role="option"], [data-model-index="${modelInfo.index}"]');
                                if (options[${modelInfo.index}]) options[${modelInfo.index}].click();
                            }, 200);
                        }
                        return { ok: true };
                    } catch(e) {
                        return { ok: false, error: e.message };
                    }
                })()
            `;
            // Model switch attempted - continue even if it fails
            await cdpBridge.evaluate(modelSwitchCode).catch(() => { });
            await new Promise(r => setTimeout(r, 300)); // Wait for model switch
        }

        // Step 3: Queue the task
        delegation.status = 'in_progress';
        delegation.startedAt = new Date().toISOString();
        STATE.actionQueue.push({
            id: delegation.id,
            text: task,
            from: 'delegation',
            model: modelInfo ? modelInfo.name : null,
            addedAt: new Date().toISOString()
        });
        saveState();
        console.log(`[DELEGATION] Dispatched to ${target_tab}`);

    } catch (e) {
        delegation.status = 'failed';
        delegation.error = e.message;
        saveState();
    }

    broadcast('delegation_update', delegation);
    res.json({ ok: true, delegation });
});

// GET /api/delegation - Get all delegations or specific one
app.get('/api/delegation', (req, res) => {
    const { id, status } = req.query;
    let items = STATE.delegations;
    if (id) items = items.filter(d => d.id === id);
    if (status) items = items.filter(d => d.status === status);

    const now = Date.now();
    for (const d of items) {
        if (d.status === 'in_progress' && d.startedAt) {
            const elapsed = now - new Date(d.startedAt).getTime();
            if (elapsed > d.timeout_ms) {
                d.status = 'timeout';
                d.error = `Timeout after ${Math.round(elapsed / 1000)}s`;
                saveState();
            }
        }
    }

    res.json({
        ok: true,
        delegations: items,
        summary: {
            pending: STATE.delegations.filter(d => d.status === 'pending').length,
            in_progress: STATE.delegations.filter(d => d.status === 'in_progress').length,
            completed: STATE.delegations.filter(d => d.status === 'completed').length,
            failed: STATE.delegations.filter(d => d.status === 'failed' || d.status === 'timeout').length
        }
    });
});

// POST /api/delegation/:id/complete - Mark delegation as complete
app.post('/api/delegation/:id/complete', (req, res) => {
    const { id } = req.params;
    const { result, error } = req.body;
    const delegation = STATE.delegations.find(d => d.id === id);
    if (!delegation) return res.json({ ok: false, error: 'not_found' });

    delegation.status = error ? 'failed' : 'completed';
    delegation.completedAt = new Date().toISOString();
    delegation.result = result || null;
    delegation.error = error || null;
    saveState();

    console.log(`[DELEGATION] ${id} marked as ${delegation.status}`);
    broadcast('delegation_update', delegation);
    res.json({ ok: true, delegation });
});

// POST /api/delegation/:id/accept - Accept/claim a delegation task
app.post('/api/delegation/:id/accept', (req, res) => {
    const { id } = req.params;
    const delegation = STATE.delegations.find(d => d.id === id);
    if (!delegation) return res.json({ ok: false, error: 'not_found' });

    if (delegation.status === 'completed') {
        return res.json({ ok: false, error: 'already_completed' });
    }

    // Mark as accepted/in_progress and reset timeout
    delegation.status = 'in_progress';
    delegation.acceptedAt = new Date().toISOString();
    delegation.startedAt = new Date().toISOString(); // Reset timeout clock
    saveState();

    console.log(`[DELEGATION] ${id} accepted by agent`);
    broadcast('delegation_update', delegation);
    res.json({ ok: true, delegation });
});


// Load Lisan
let LISAN_CORPUS = [];
try {
    const lisanPath = join(__dirname, 'lisanclean.json');
    try {
        const raw = readFileSync(lisanPath, 'utf-8');
        const data = JSON.parse(raw);
        LISAN_CORPUS = Array.isArray(data) ? data : Object.values(data);
        console.log(`[LISAN] Loaded ${LISAN_CORPUS.length} entries`);
    } catch (e) {
        // Silent
    }
} catch (e) {
    console.log('[LISAN] Failed to load:', e.message);
}

function run(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve(stdout.trim());
        });
    });
}

// POST /messages/stop
app.post('/messages/stop', async (req, res) => {
    try {
        const result = await cdpBridge.stopAgent();
        broadcast('agent_state', { busy: false }); // Force idle update immediately
        res.json(result);
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
    try {
        const free = await run("free -m | grep Mem | awk '{print $3}'");
        const cpu = await run("grep 'cpu ' /proc/stat | awk '{usage=($2+$4)*100/($2+$4+$5)} END {print usage}'");

        res.json({
            ram: parseInt(free) || 0,
            cpu: parseInt(cpu) || 0
        });
    } catch (e) {
        res.json({ ram: 0, cpu: 0 }); // Fallback
    }
});

// GET /api/lisan
app.get('/api/lisan', (req, res) => {
    const count = 10;
    const pool = LISAN_CORPUS.length > 0 ? LISAN_CORPUS : ["البَرْقُ سَرِيعُ اللَّمْعِ"];
    const sample = [];
    for (let i = 0; i < count; i++) {
        sample.push(String(pool[Math.floor(Math.random() * pool.length)]));
    }
    res.json(sample);
});

// POST /api/start-ide
app.post('/api/start-ide', (req, res) => {
    // Fire and forget
    exec('/usr/bin/antigravity --no-sandbox', {
        env: { ...process.env, DISPLAY: ':0' },
        detached: true,
        stdio: 'ignore'
    }).unref();
    res.json({ success: true, message: 'IDE Starting' });
});

// POST /api/kill-ide
app.post('/api/kill-ide', async (req, res) => {
    try {
        await run("pkill -9 -f antigravity");
        res.json({ success: true, message: 'Killed' });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// POST /api/restart-ide
app.post('/api/restart-ide', async (req, res) => {
    try {
        await run("pkill -f language_server");
        res.json({ success: true, message: 'Restart sent' });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// POST /api/agent-mode
app.post('/api/agent-mode', async (req, res) => {
    try {
        await run("xdotool key ctrl+e");
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

// POST /api/stop - Enhanced: CDP first, xdotool fallback
app.post('/api/stop', async (req, res) => {
    try {
        // Layer 1: Try CDP cancel button click
        const cdpResult = await cdpBridge.stopAgent();
        if (cdpResult.ok) {
            STATE.agent.busy = false;
            broadcast('agent_state', { busy: false });
            saveState();
            return res.json({ success: true, method: 'cdp' });
        }

        // Layer 2: Fallback to xdotool Escape
        await run("xdotool key Escape");
        STATE.agent.busy = false;
        broadcast('agent_state', { busy: false });
        saveState();
        res.json({ success: true, method: 'xdotool' });
    } catch (e) {
        // Still mark as not busy even on error
        STATE.agent.busy = false;
        broadcast('agent_state', { busy: false });
        saveState();
        res.json({ success: false, error: e.message });
    }
});

// POST /api/new-chat
app.post('/api/new-chat', async (req, res) => {
    console.log('[API] New Chat requested');
    try {
        // Ctrl(2) + l
        const result = await cdpBridge.triggerShortcut(2, 'l', 'KeyL', 76, 38);
        console.log('[API] New Chat Result:', result);
        res.json({ success: result.ok, error: result.error });
    } catch (e) {
        console.error('[API] New Chat Error:', e);
        res.json({ success: false, error: e.message });
    }
});

// POST /api/set-model
app.post('/api/set-model', async (req, res) => {
    console.log('[API] Set Model requested', req.body);
    const { index } = req.body;
    const targetIndex = parseInt(index) || 0;

    try {
        // 1. Open Menu: Ctrl(2) + Shift(8) = 10 + m
        await cdpBridge.triggerShortcut(10, 'M', 'KeyM', 77, 50);

        // 2. Wait for menu
        await new Promise(r => setTimeout(r, 300));

        // 3. Arrow Down 'index' times
        for (let i = 0; i < targetIndex; i++) {
            // ArrowDown (0 modifiers)
            await cdpBridge.triggerShortcut(0, 'ArrowDown', 'ArrowDown', 40, 116);
            await new Promise(r => setTimeout(r, 50));
        }

        // 4. Select: Enter
        await new Promise(r => setTimeout(r, 100));
        await cdpBridge.triggerShortcut(0, 'Enter', 'Enter', 13, 36);

        console.log(`[API] Set Model: Selected index ${targetIndex}`);
        res.json({ success: true, index: targetIndex });
    } catch (e) {
        console.error('[API] Set Model Error:', e);
        res.json({ success: false, error: e.message });
    }
});

// GET /api/debug/dom
app.get('/api/debug/dom', async (req, res) => {
    try {
        const selector = req.query.selector || 'body';
        const result = await cdpBridge.getDOM(selector);
        res.json(result);
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

// POST /api/debug/eval
app.post('/api/debug/eval', async (req, res) => {
    try {
        const { expression } = req.body;
        const result = await cdpBridge.evaluate(expression);
        res.json(result);
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

// GET /api/history
// Helper to read titles from markdown files
async function getConversationTitle(dirPath) {
    try {
        const artifacts = ['implementation_plan.md', 'walkthrough.md', 'task.md'];
        for (const art of artifacts) {
            const artPath = path.join(dirPath, art);
            if (fs.existsSync(artPath)) {
                const content = await fs.promises.readFile(artPath, 'utf8');
                // Try to find a header
                const match = content.match(/^#\s+(.+)$/m);
                if (match) return match[1].trim();
            }
        }
    } catch (e) { }
    return null;
}

app.get('/api/history', async (req, res) => {
    try {
        // 1. Filesystem History (Persistent)
        const brainDir = path.join(os.homedir(), '.gemini/antigravity/brain');
        let fsItems = [];

        if (fs.existsSync(brainDir)) {
            const dirs = await fs.promises.readdir(brainDir, { withFileTypes: true });
            const tasks = dirs
                .filter(d => d.isDirectory() && !d.name.startsWith('.'))
                .map(async d => {
                    const fullPath = path.join(brainDir, d.name);
                    const stats = await fs.promises.stat(fullPath);
                    const title = await getConversationTitle(fullPath);
                    return {
                        id: d.name,
                        title: title || d.name, // Fallback to GUID
                        timestamp: stats.mtimeMs,
                        source: 'fs'
                    };
                });

            fsItems = await Promise.all(tasks);
            fsItems.sort((a, b) => b.timestamp - a.timestamp);
        }

        res.json({
            ok: true,
            history: fsItems.map((item, idx) => ({
                ...item,
                active: idx === 0 // Naive active check
            }))
        });

    } catch (e) {
        console.error('History error:', e);
        res.json({ ok: false, error: e.message });
    }
});

app.post('/api/history/load', express.json(), async (req, res) => {
    const { id, index } = req.body;

    // Legacy support
    if (index !== undefined && !id) {
        try {
            const result = await cdpBridge.loadHistory(index);
            return res.json(result);
        } catch (e) {
            return res.json({ ok: false, error: e.message });
        }
    }

    // ID-based load (Filesystem artifact)
    if (id) {
        try {
            const brainDir = path.join(os.homedir(), '.gemini/antigravity/brain');
            const targetDir = path.join(brainDir, id);

            // Find best artifact to open
            const artifacts = ['walkthrough.md', 'implementation_plan.md', 'task.md'];
            let targetFile = null;

            for (const art of artifacts) {
                if (fs.existsSync(path.join(targetDir, art))) {
                    targetFile = path.join(targetDir, art);
                    break;
                }
            }

            if (targetFile) {
                // Open in IDE using 'code' command
                const { exec } = await import('child_process');
                exec(`code "${targetFile}"`, (err) => {
                    if (err) console.error('Failed to open file:', err);
                });
                return res.json({ ok: true, opened: targetFile });
            } else {
                return res.json({ ok: false, error: 'no_artifacts_found' });
            }
        } catch (e) {
            return res.json({ ok: false, error: e.message });
        }
    }

    res.json({ ok: false, error: 'missing_id_or_index' });
});

// POST /api/history/new
app.post('/api/history/new', (req, res) => {
    STATE.messages = [];
    saveState();
    broadcast('history_cleared', {});
    res.json({ ok: true });
});

// POST /api/upload
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.json({ ok: false, error: 'no_file' });

        console.log('[UPLOAD] Received:', req.file.path, req.file.originalname);

        // Call CDP to upload
        // We'll pass the absolute path
        const result = await cdpBridge.uploadFile(req.file.path);

        res.json({ ok: true, cdp: result });
    } catch (e) {
        console.error('Upload error:', e);
        res.json({ ok: false, error: e.message });
    }
});

// --- WebSocket ---
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    ws.isAlive = true;
    ws.send(JSON.stringify({ event: 'hello', payload: { name: 'ag_bridge' } }));

    // Handle client messages (ping/pong for keep-alive)
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.event === 'ping') {
                ws.send(JSON.stringify({ event: 'pong' }));
            }
        } catch (e) { /* ignore non-JSON */ }
        ws.isAlive = true;
    });

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => console.log('[WS] Client disconnected'));
});

// Server-side keep-alive: ping all clients every 30s, terminate dead ones
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('[WS] Terminating dead client');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// --- Start ---
async function main() {
    await loadState();

    // Start CDP Bridge
    console.log('[CDP] Starting Bridge...');
    cdpBridge.start();

    // Start Polling for State Sync
    // (Wait 5s for connection stability)
    setTimeout(() => {
        cdpBridge.startPolling((event, payload) => broadcast(event, payload));
    }, 5000);

    server.listen(PORT, () => {
        const ips = getLocalIPs();
        console.log('======================================');
        console.log('         AG Bridge Started!');
        console.log('======================================');
        console.log(`Local:      http://localhost:${PORT}`);
        ips.forEach(ip => console.log(`Network:    http://${ip}:${PORT}`));
        console.log('======================================');
    });
}

main();
