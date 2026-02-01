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

// Initialize CDP
cdpBridge.start();
const PORT = parseInt(process.env.PORT || '8787');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// --- State ---
let STATE = {
    messages: [],
    agent: { state: 'idle', lastSeen: null, task: '' }
};

async function loadState() {
    try {
        await mkdir(DATA_DIR, { recursive: true });
        const raw = await readFile(STATE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.messages)) STATE.messages = data.messages;
        if (data.agent) STATE.agent = data.agent;
        console.log(`[PERSIST] State loaded. ${STATE.messages.length} messages.`);
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
    res.json({ ok: true });
});

// --- Control API Helpers ---

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

// POST /api/stop
app.post('/api/stop', async (req, res) => {
    try {
        await run("xdotool key Escape");
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

// POST /api/set-model
app.post('/api/set-model', async (req, res) => {
    try {
        await run("xdotool key ctrl+shift+m");
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
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
    ws.send(JSON.stringify({ event: 'hello', payload: { name: 'ag_bridge' } }));

    ws.on('close', () => console.log('[WS] Client disconnected'));
});

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
