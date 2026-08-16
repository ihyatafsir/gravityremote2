// --- Elements ---
const chatContainer = document.getElementById('chatContainer');
const chatContent = document.getElementById('chatContent');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const queueBtn = document.getElementById('queueBtn');
const scrollToBottomBtn = document.getElementById('scrollToBottom');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const refreshBtn = document.getElementById('refreshBtn');
const stopBtn = document.getElementById('stopBtn');
const stopBarBtn = document.getElementById('stopBarBtn');
const queueTray = document.getElementById('queueTray');
const queueBadge = document.getElementById('queueBadge');
const queuePreview = document.getElementById('queuePreview');
const queueSendNowBtn = document.getElementById('queueSendNowBtn');
const queueClearBtn = document.getElementById('queueClearBtn');
const newChatBtn = document.getElementById('newChatBtn');
const historyBtn = document.getElementById('historyBtn');

const activeChatTitle = document.getElementById('activeChatTitle');
const historyCountBadge = document.getElementById('historyCountBadge');
const drawerCountTag = document.getElementById('drawerCountTag');
const historySearchInput = document.getElementById('historySearchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');

const modeBtn = document.getElementById('modeBtn');
const modelBtn = document.getElementById('modelBtn');
const modalOverlay = document.getElementById('modalOverlay');
const modalList = document.getElementById('modalList');
const modalTitle = document.getElementById('modalTitle');
const modeText = document.getElementById('modeText');
const modelText = document.getElementById('modelText');
const historyLayer = document.getElementById('historyLayer');
const historyList = document.getElementById('historyList');

const restartModalOverlay = document.getElementById('restartModalOverlay');
const restartProgressOverlay = document.getElementById('restartProgressOverlay');
const restartProgressTitle = document.getElementById('restartProgressTitle');
const restartProgressDesc = document.getElementById('restartProgressDesc');
const restartCountdownVal = document.getElementById('restartCountdownVal');

// --- State ---
let autoRefreshEnabled = true;
let userIsScrolling = false;
let userScrollLockUntil = 0;
let lastScrollPosition = 0;
let ws = null;
let idleTimer = null;
let lastHash = '';
let currentMode = 'Fast';
let chatIsOpen = true;
let currentChatTitle = 'Current Conversation';
let cachedConversations = [];

// --- Toast Notification ---
function showToast(message, duration = 3000) {
    let toast = document.getElementById('ag-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'ag-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(-10px)';
    }, duration);
}

// --- Auth Utilities ---
async function fetchWithAuth(url, options = {}) {
    if (!options.headers) options.headers = {};
    options.headers['ngrok-skip-browser-warning'] = 'true';
    try {
        const res = await fetch(url, options);
        return res;
    } catch (e) {
        throw e;
    }
}
const USER_SCROLL_LOCK_DURATION = 3000;

// --- Sync State (Desktop is Always Priority) ---
async function fetchAppState() {
    try {
        const res = await fetchWithAuth('/app-state');
        const data = await res.json();

        if (data.mode && data.mode !== 'Unknown') {
            modeText.textContent = data.mode;
            modeBtn.classList.toggle('active', data.mode === 'Planning');
            currentMode = data.mode;
        }

        if (data.model && data.model !== 'Unknown') {
            modelText.textContent = data.model;
        }
    } catch (e) { }
}

// --- SSL Banner ---
const sslBanner = document.getElementById('sslBanner');

async function checkSslStatus() {
    if (window.location.protocol === 'https:') return;
    if (localStorage.getItem('sslBannerDismissed')) return;
    if (sslBanner) sslBanner.style.display = 'flex';
}

async function enableHttps() {
    const btn = document.getElementById('enableHttpsBtn');
    if (btn) {
        btn.textContent = 'Generating...';
        btn.disabled = true;
    }

    try {
        const res = await fetchWithAuth('/generate-ssl', { method: 'POST' });
        const data = await res.json();

        if (data.success && sslBanner) {
            sslBanner.innerHTML = `
                <span>✅ ${data.message}</span>
                <button onclick="location.reload()">Reload After Restart</button>
            `;
            sslBanner.style.background = 'linear-gradient(90deg, #22c55e, #16a34a)';
        } else if (btn) {
            btn.textContent = 'Failed - Retry';
            btn.disabled = false;
        }
    } catch (e) {
        if (btn) {
            btn.textContent = 'Error - Retry';
            btn.disabled = false;
        }
    }
}

function dismissSslBanner() {
    if (sslBanner) sslBanner.style.display = 'none';
    localStorage.setItem('sslBannerDismissed', 'true');
}

checkSslStatus();

// --- Models ---
const MODELS = [
    "Gemini 3.7 Flash (High)",
    "Gemini 3.7 Flash (Medium)",
    "Gemini 3.7 Flash (Low)",
    "Gemini 3.6 Flash (High)",
    "Claude Sonnet 4.6 (Thinking)",
    "Claude Opus 4.6 (Thinking) 💎",
    "GPT-OSS 120B (Medium)",
    "DeepSeek R1 (Reasoning) ⚡"
];


// --- Message Queue & Agent State UI ---
let currentQueueItems = [];

async function refreshQueueStatus() {
    try {
        const res = await fetchWithAuth('/api/queue');
        if (res.ok) {
            const data = await res.json();
            updateQueueUI(data.items || []);
            if (data.isAgentBusy !== undefined) {
                updateAgentBusyState(data.isAgentBusy);
            }
        }
    } catch (e) { }
}

function updateQueueUI(items) {
    currentQueueItems = items || [];
    if (!queueTray) return;

    if (currentQueueItems.length > 0) {
        queueTray.style.display = 'flex';
        if (queueBadge) queueBadge.textContent = `${currentQueueItems.length} Queued`;
        const first = currentQueueItems[0];
        const previewText = first.text.length > 35 ? first.text.substring(0, 35) + '...' : first.text;
        if (queuePreview) queuePreview.textContent = `Next: "${previewText}"`;
    } else {
        queueTray.style.display = 'none';
    }
}

function updateAgentBusyState(isBusy) {
    if (stopBtn) {
        if (isBusy) {
            stopBtn.classList.add('is-active');
            stopBtn.title = 'Stop active agent execution (Ctrl+D)';
        } else {
            stopBtn.classList.remove('is-active');
            stopBtn.title = 'Stop agent execution';
        }
    }
    if (stopBarBtn) {
        stopBarBtn.style.display = isBusy ? 'flex' : 'none';
    }
}

if (queueSendNowBtn) {
    queueSendNowBtn.addEventListener('click', async () => {
        queueSendNowBtn.disabled = true;
        showToast('⚡ Force-sending next queued message...');
        try {
            const res = await fetchWithAuth('/api/queue/send-now', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showToast('🚀 Message sent to agent!');
                setTimeout(loadSnapshot, 300);
            } else {
                showToast('Send failed: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            showToast('Error: ' + e.message);
        } finally {
            queueSendNowBtn.disabled = false;
            refreshQueueStatus();
        }
    });
}

if (queueClearBtn) {
    queueClearBtn.addEventListener('click', async () => {
        queueClearBtn.disabled = true;
        try {
            const res = await fetchWithAuth('/api/queue/clear', { method: 'POST' });
            const data = await res.json();
            showToast(`🗑️ Cleared ${data.cleared || 0} queued message(s)`);
            updateQueueUI([]);
        } catch (e) {
            showToast('Clear failed: ' + e.message);
        } finally {
            queueClearBtn.disabled = false;
        }
    });
}

// --- WebSocket ---
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        console.log('WS Connected');
        updateStatus(true);
        loadSnapshot();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'snapshot_update' && autoRefreshEnabled && !userIsScrolling) {
                loadSnapshot();
            } else if (data.type === 'queue_update') {
                updateQueueUI(data.items || []);
            }
        } catch (e) { }
    };

    ws.onclose = () => {
        console.log('WS Disconnected');
        updateStatus(false);
        setTimeout(connectWebSocket, 2000);
    };
}

function updateStatus(connected) {
    if (connected) {
        statusDot.classList.remove('disconnected');
        statusDot.classList.add('connected');
        statusText.textContent = 'Live';
    } else {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Reconnecting';
    }
}

// --- Rendering ---
async function loadSnapshot() {
    try {
        const snapshotController = new AbortController();
        const snapshotTimeout = setTimeout(() => snapshotController.abort(), 8000);
        const response = await fetchWithAuth('/snapshot', { signal: snapshotController.signal });
        clearTimeout(snapshotTimeout);
        if (!response.ok) {
            if (response.status === 503) {
                chatIsOpen = false;
                showEmptyState();
                return;
            }
            throw new Error('Failed to load');
        }

        chatIsOpen = true;
        const data = await response.json();
        if (data.isAgentBusy !== undefined) {
            updateAgentBusyState(data.isAgentBusy);
        } else if (data.html) {
            const isBusy = data.html.includes('input-send-button-cancel-tooltip') ||
                           data.html.includes('lucide-square') ||
                           data.html.includes('bg-red-500');
            updateAgentBusyState(isBusy);
        }

        // Capture scroll state BEFORE updating content
        const scrollPos = chatContainer.scrollTop;
        const scrollHeight = chatContainer.scrollHeight;
        const clientHeight = chatContainer.clientHeight;
        const isNearBottom = scrollHeight - scrollPos - clientHeight < 120;
        const isUserScrollLocked = Date.now() < userScrollLockUntil;

        if (data.stats) {
            const kbs = Math.round((data.stats.htmlSize + data.stats.cssSize) / 1024);
            const nodes = data.stats.nodes;
            const statsText = document.getElementById('statsText');
            if (statsText) statsText.textContent = `${nodes} Nodes · ${kbs}KB`;
        }

        // CSS Injection
        let styleTag = document.getElementById('cdp-styles');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'cdp-styles';
            document.head.appendChild(styleTag);
        }

        const darkModeOverrides = `
${data.css || ''}

:root {
    --bg-app: #181818;
    --text-main: #CCCCCC;
    --text-muted: #858585;
    --border-color: #2B2B2B;
}

/* Global Mobile Resets inside chat */
#conversation, #conversation *, #chat, #chat *, #cascade, #cascade * {
    box-sizing: border-box !important;
    min-width: 0 !important;
}

[style*="container-type"], [class*="container-"] {
    container-type: normal !important;
}

#conversation, #chat, #cascade {
    background-color: transparent !important;
    color: var(--text-main) !important;
    font-family: 'Inter', system-ui, -apple-system, sans-serif !important;
    font-size: 14.5px !important;
    position: relative !important;
    height: auto !important;
    width: 100% !important;
    max-width: 100% !important;
    display: block !important;
    overflow-x: hidden !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
}

#conversation > div,
#conversation div[class*="overflow-"],
#conversation div[class*="grow"],
#conversation [tabindex="0"] {
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
    flex: none !important;
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    padding-left: 2px !important;
    padding-right: 2px !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
}

#conversation p, #chat p, #cascade p,
#conversation span, #chat span, #cascade span,
#conversation div, #chat div, #cascade div,
#conversation li, #chat li, #cascade li,
#conversation h1, #chat h1, #cascade h1,
#conversation h2, #chat h2, #cascade h2,
#conversation h3, #chat h3, #cascade h3,
#conversation h4, #chat h4, #cascade h4 {
    color: inherit !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
    max-width: 100% !important;
}

#conversation a, #chat a, #cascade a {
    color: #60a5fa !important;
    text-decoration: underline;
    overflow-wrap: anywhere !important;
    word-break: break-all !important;
}

/* User Message Bubble styling */
[role="article"],
[data-testid="user-input-step"],
.group\/user-input-step {
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    overflow: visible !important;
}

.whitespace-pre-wrap, .select-text, .leading-relaxed {
    white-space: pre-wrap !important;
    word-break: break-word !important;
    overflow-wrap: anywhere !important;
    max-width: 100% !important;
}

:not(pre) > code {
    padding: 1px 4px !important;
    border-radius: 3px !important;
    background-color: rgba(255, 255, 255, 0.1) !important;
    font-size: 0.88em !important;
    font-family: 'JetBrains Mono', monospace !important;
    word-break: break-all !important;
    overflow-wrap: anywhere !important;
    white-space: pre-wrap !important;
    max-width: 100% !important;
    display: inline !important;
}

pre, code, .monaco-editor-background {
    background-color: #1a1a1a !important;
    color: #e2e8f0 !important;
    font-family: 'JetBrains Mono', monospace !important;
    border-radius: 4px;
    border: 1px solid #333333;
}

[class*="terminal"] {
    background-color: #141414 !important;
    color: #4ade80 !important;
    font-family: 'JetBrains Mono', monospace !important;
    border-radius: 4px;
    border: 1px solid #2d2d2d;
    max-height: 320px !important;
    overflow-x: auto !important;
    overflow-y: auto !important;
    height: auto !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
}

[class*="terminal"]:empty,
[class*="terminal"]:not(:has(*)),
[class*="xterm"]:empty,
[class*="xterm"]:not(:has(*)) {
    display: none !important;
}

pre {
    position: relative !important;
    white-space: pre-wrap !important; 
    word-break: break-word !important;
    overflow-wrap: anywhere !important;
    padding: 8px 34px 8px 10px !important;
    margin: 6px 0 !important;
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    overflow-x: auto !important;
}

pre code {
    white-space: pre-wrap !important;
    word-break: break-word !important;
    overflow-wrap: anywhere !important;
    max-width: 100% !important;
}

pre.has-copy-btn {
    padding-right: 36px !important;
}

.mobile-copy-btn {
    position: absolute !important;
    top: 4px !important;
    right: 4px !important;
    background: rgba(40, 40, 40, 0.8) !important;
    color: #94a3b8 !important;
    border: 1px solid #444 !important;
    width: 26px !important; 
    height: 26px !important;
    padding: 0 !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 4px !important;
    transition: all 0.2s ease !important;
    z-index: 10 !important;
}

.mobile-copy-btn:hover {
    background: rgba(34, 197, 94, 0.2) !important;
    color: #4ade80 !important;
    border-color: #22c55e !important;
}

.mobile-copy-btn svg {
    width: 14px !important;
    height: 14px !important;
    stroke: currentColor !important;
    stroke-width: 2 !important;
    fill: none !important;
}

/* Tables in markdown */
table {
    width: 100% !important;
    max-width: 100% !important;
    display: block !important;
    overflow-x: auto !important;
    border-collapse: collapse !important;
    margin: 8px 0 !important;
}

table th, table td {
    word-break: break-word !important;
    overflow-wrap: anywhere !important;
    padding: 4px 8px !important;
}
`;
        styleTag.textContent = darkModeOverrides;
        chatContent.innerHTML = data.html;

        addMobileCopyButtons();

        if (isUserScrollLocked) {
            const scrollPercent = scrollHeight > 0 ? scrollPos / scrollHeight : 0;
            chatContainer.scrollTop = chatContainer.scrollHeight * scrollPercent;
        } else if (isNearBottom || scrollPos === 0) {
            scrollToBottom();
        }
    } catch (e) {
        console.error('Snapshot error:', e);
    }
}

function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// --- Mobile Code Copy Buttons ---
function addMobileCopyButtons() {
    const codeBlocks = chatContent.querySelectorAll('pre');
    codeBlocks.forEach(pre => {
        if (pre.querySelector('.mobile-copy-btn')) return;
        pre.classList.add('has-copy-btn');

        const btn = document.createElement('button');
        btn.className = 'mobile-copy-btn';
        btn.setAttribute('aria-label', 'Copy code');
        btn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

        btn.onclick = (e) => {
            e.stopPropagation();
            const code = pre.querySelector('code')?.innerText || pre.innerText;
            navigator.clipboard.writeText(code).then(() => {
                btn.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`;
                btn.style.color = '#22c55e';
                showToast('Code copied to clipboard');
                setTimeout(() => {
                    btn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
                    btn.style.color = '';
                }, 2000);
            });
        };
        pre.appendChild(btn);
    });
}

// --- Image Attachment Handling ---
let attachedImages = [];
const fileInput = document.getElementById('fileInput');
const attachBtn = document.getElementById('attachBtn');
const attachPreview = document.getElementById('attachPreview');
const attachPreviewInner = document.getElementById('attachPreviewInner');

function addImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        attachedImages.push({ file, dataUrl: ev.target.result });
        renderAttachPreview();
    };
    reader.readAsDataURL(file);
}

if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
            addImageFile(file);
        }
        fileInput.value = '';
    });
}

// Support pasting images directly from clipboard (Ctrl+V / long press)
if (messageInput) {
    messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 140) + 'px';
    });

    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage({ forceSend: false });
        }
    });

    messageInput.addEventListener('paste', (e) => {
        const items = (e.clipboardData || window.clipboardData)?.items;
        if (items) {
            for (const item of items) {
                if (item.type && item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) {
                        addImageFile(file);
                        showToast('📎 Image pasted from clipboard');
                        e.preventDefault();
                    }
                }
            }
        }
    });
}

function renderAttachPreview() {
    if (!attachPreview || !attachPreviewInner) return;
    if (attachedImages.length === 0) {
        attachPreview.style.display = 'none';
        attachPreviewInner.innerHTML = '';
        return;
    }
    attachPreview.style.display = 'block';
    attachPreviewInner.innerHTML = attachedImages.map((img, idx) => `
        <div class="attach-thumb">
            <img src="${img.dataUrl}" alt="attachment" />
            <button class="attach-thumb-remove" onclick="removeAttachedImage(${idx})">×</button>
        </div>
    `).join('');
}

window.removeAttachedImage = function (idx) {
    attachedImages.splice(idx, 1);
    renderAttachPreview();
};

// --- Send Message (Supports direct send, queue, and force-send) ---
async function sendMessage({ forceQueue = false, forceSend = false } = {}) {
    const text = messageInput.value.trim();
    if (!text && attachedImages.length === 0) return;

    if (sendBtn) sendBtn.disabled = true;
    if (queueBtn) queueBtn.disabled = true;
    messageInput.disabled = true;

    try {
        const uploadedPaths = [];
        // Upload images first if any
        if (attachedImages.length > 0) {
            showToast(`Uploading ${attachedImages.length} image(s)...`);
            for (const img of attachedImages) {
                try {
                    const res = await fetchWithAuth('/upload-image', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: img.file ? img.file.name : 'image.png',
                            dataUrl: img.dataUrl
                        })
                    });
                    const uData = await res.json();
                    if (uData.path) {
                        uploadedPaths.push(uData.path);
                    } else if (uData.error) {
                        console.warn('Image upload error:', uData.error);
                        showToast('Image upload: ' + uData.error);
                    }
                } catch (imgErr) {
                    console.error('Failed to upload image:', imgErr);
                }
            }
            attachedImages = [];
            renderAttachPreview();
        }

        let messageToSend = text;
        if (uploadedPaths.length > 0) {
            const fileRefs = uploadedPaths.map(p => `[Uploaded Image/Screenshot: ${p}]`).join('\n');
            if (messageToSend) {
                messageToSend = `${messageToSend}\n\n${fileRefs}`;
            } else {
                messageToSend = `I have uploaded the following screenshot(s)/image(s):\n${fileRefs}\nPlease inspect them and assist me.`;
            }
        }

        if (messageToSend) {
            const res = await fetchWithAuth('/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: messageToSend,
                    forceQueue: forceQueue,
                    forceSend: forceSend
                })
            });
            const data = await res.json();
            if (data.queued) {
                showToast(`📋 Message added to queue (#${data.queuePosition || 1}) — auto-sends when idle`);
                refreshQueueStatus();
            } else if (data.error) {
                showToast('Error: ' + data.error);
            } else {
                showToast('✅ Prompt sent to agent');
            }
        }

        messageInput.value = '';
        messageInput.style.height = 'auto';
        setTimeout(loadSnapshot, 300);
        setTimeout(loadSnapshot, 1000);
    } catch (e) {
        showToast('Failed to send: ' + e.message);
    } finally {
        if (sendBtn) sendBtn.disabled = false;
        if (queueBtn) queueBtn.disabled = false;
        messageInput.disabled = false;
        messageInput.focus();
    }
}

if (sendBtn) sendBtn.addEventListener('click', () => sendMessage({ forceSend: false }));
if (queueBtn) queueBtn.addEventListener('click', () => sendMessage({ forceQueue: true }));

// --- New Chat Logic ---
async function startNewChat() {
    newChatBtn.style.opacity = '0.5';
    newChatBtn.style.pointerEvents = 'none';
    showToast('✨ Starting new conversation...');

    // Optimistic UI state
    currentChatTitle = 'New Conversation';
    if (activeChatTitle) activeChatTitle.textContent = 'New Conversation';

    chatContent.innerHTML = `
        <div class="loading-state">
            <div class="loading-spinner"></div>
            <p>Creating fresh session...</p>
        </div>
    `;

    try {
        const res = await fetchWithAuth('/new-chat', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            showToast('✅ New conversation ready');
            setTimeout(loadSnapshot, 400);
            setTimeout(loadSnapshot, 1200);
            setTimeout(checkChatStatus, 1600);
        } else {
            showToast('Failed to start new chat: ' + (data.error || 'Unknown'));
        }
    } catch (e) {
        showToast('New chat error: ' + e.message);
    } finally {
        newChatBtn.style.opacity = '1';
        newChatBtn.style.pointerEvents = 'auto';
        messageInput.focus();
    }
}



if (newChatBtn) newChatBtn.addEventListener('click', startNewChat);

function startNewChatFromHistory() { hideChatHistory(); startNewChat(); }
function hideChatHistory() { if (historyLayer) historyLayer.classList.remove('show'); }

// --- Chat History Logic ---
if (historyBtn) historyBtn.addEventListener("click", showChatHistory);
window.showChatHistory = showChatHistory;
window.hideChatHistory = hideChatHistory;
window.startNewChatFromHistory = startNewChatFromHistory;
window.selectChat = selectChat;
window.refreshChatHistory = refreshChatHistory;
window.clearHistorySearch = clearHistorySearch;

async function showChatHistory() {
    historyLayer.classList.add('show');
    if (historySearchInput) {
        historySearchInput.value = '';
        if (clearSearchBtn) clearSearchBtn.style.display = 'none';
    }

    if (cachedConversations.length > 0) {
        renderHistoryList(cachedConversations);
    } else {
        historyList.innerHTML = `
            <div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">
                <div class="loading-spinner" style="margin: 0 auto 12px;"></div>
                <p>Loading conversations...</p>
            </div>
        `;
    }

    refreshChatHistory(false);
}

async function refreshChatHistory(showSpinner = true) {
    const refreshIcon = document.getElementById('historyRefreshBtn');
    if (refreshIcon && showSpinner) {
        refreshIcon.style.transform = 'rotate(360deg)';
        refreshIcon.style.transition = 'transform 0.5s';
        setTimeout(() => { refreshIcon.style.transform = ''; }, 500);
    }

    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();

        if (data.success && Array.isArray(data.chats)) {
            cachedConversations = data.chats;
            updateConversationBadges(cachedConversations.length);
            renderHistoryList(cachedConversations, historySearchInput?.value || '');
        } else if (cachedConversations.length === 0) {
            historyList.innerHTML = `
                <div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">
                    <div style="font-size: 28px; margin-bottom: 8px;">💬</div>
                    <div style="font-weight: 600; color: #eee; margin-bottom: 4px;">No conversations found</div>
                    <div style="font-size: 13px; opacity: 0.7;">Start a new conversation to begin.</div>
                    <div class="new-chat-card-pinned" onclick="startNewChatFromHistory()" style="margin-top: 16px;">
                        ＋ Start New Conversation
                    </div>
                </div>
            `;
        }
    } catch (e) {
        if (cachedConversations.length === 0) {
            historyList.innerHTML = `
                <div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">
                    <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
                    <div style="font-weight: 500;">Connection Error</div>
                    <div style="font-size: 13px; opacity: 0.7; margin-top: 4px;">Could not load history: ${e.message}</div>
                </div>
            `;
        }
    }
}

function updateConversationBadges(count) {
    if (historyCountBadge) {
        historyCountBadge.textContent = count;
        historyCountBadge.style.display = count > 0 ? 'inline-block' : 'none';
    }
    if (drawerCountTag) {
        drawerCountTag.textContent = count;
    }
}

function renderHistoryList(chats, filterText) {
    filterText = filterText || "";
    const query = filterText.trim().toLowerCase();
    const filtered = query
        ? chats.filter(function(c) { return ((c.title || "") + " " + (c.workspace || "")).toLowerCase().includes(query); })
        : chats;

    let html = '<div class="new-chat-card-pinned" onclick="startNewChatFromHistory()"><span>＋ Start New Conversation</span></div>';

    if (filtered.length === 0) {
        html += '<div style="padding: 30px 16px; text-align: center; color: var(--text-muted);"><div style="font-size: 20px; margin-bottom: 6px;">🔍</div><div style="font-size: 13px;">No conversations matching "' + escapeHtml(filterText) + '"</div></div>';
        historyList.innerHTML = html;
        return;
    }

    filtered.forEach(function(chat) {
        const title = chat.title || chat.name || "Untitled";
        const id = chat.id || "";
        const escapedTitle = title.replace(/'/g, "\\x27").replace(/"/g, "&quot;");
        const escapedId = id.replace(/'/g, "\\x27").replace(/"/g, "&quot;");
        const isActive = chat.isSelected || (currentChatTitle && (
            currentChatTitle.toLowerCase() === title.toLowerCase() ||
            title.toLowerCase().startsWith(currentChatTitle.toLowerCase().slice(0, 15))
        ));

        const activeTag = isActive ? '<span class="active-pill-indicator">Active</span>' : "";
        const wsTag = chat.workspace ? '<span class="workspace-pill-tag">' + escapeHtml(chat.workspace) + '</span>' : "";
        const dateTag = '<span>' + escapeHtml(chat.date || "Recent") + '</span>';

        html += '<div class="history-item ' + (isActive ? "active-chat-item" : "") + '" onclick="selectChat(\'' + escapedId + '\', \'' + escapedTitle + '\', this)">' +
            '<div class="history-item-icon">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
            '</div>' +
            '<div class="history-item-text">' +
                '<div class="history-item-title">' + escapeHtml(title) + '</div>' +
                '<div class="history-item-date">' + activeTag + wsTag + dateTag + '</div>' +
            '</div>' +
        '</div>';
    });

    historyList.innerHTML = html;
}

// History Search Input
if (historySearchInput) {
    historySearchInput.addEventListener("input", function(e) {
        const val = e.target.value;
        if (clearSearchBtn) clearSearchBtn.style.display = val ? "block" : "none";
        renderHistoryList(cachedConversations, val);
    });
}

function clearHistorySearch() {
    if (historySearchInput) historySearchInput.value = "";
    if (clearSearchBtn) clearSearchBtn.style.display = "none";
    renderHistoryList(cachedConversations);
}





async function selectChat(id, title, element) {
    if (element) {
        element.style.opacity = "0.6";
        const icon = element.querySelector(".history-item-icon");
        if (icon) icon.innerHTML = '<div class="loading-spinner" style="width:16px;height:16px;border-width:2px;"></div>';
    }

    currentChatTitle = title;
    if (activeChatTitle) activeChatTitle.textContent = title;

    try {
        const res = await fetchWithAuth("/select-chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: id, title: title })
        });
        const data = await res.json();

        if (data.success) {
            hideChatHistory();
            showToast("Switched to: " + title);
            chatContent.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>Loading ' + escapeHtml(title) + '...</p></div>';
            setTimeout(loadSnapshot, 300);
            setTimeout(loadSnapshot, 800);
            setTimeout(loadSnapshot, 1500);
        } else {
            showToast("Could not switch: " + (data.error || "Unknown error"));
        }
    } catch (e) {
        showToast("Select chat error: " + e.message);
    }
}

// --- Restart IDE & Reconnect Modals ---
function showRestartModal() {
    if (restartModalOverlay) restartModalOverlay.classList.add('show');
}

function closeRestartModal() {
    if (restartModalOverlay) restartModalOverlay.classList.remove('show');
}

if (refreshBtn) refreshBtn.addEventListener('click', showRestartModal);

if (restartModalOverlay) {
    restartModalOverlay.onclick = (e) => {
        if (e.target === restartModalOverlay) closeRestartModal();
    };
}

async function confirmRestartIDE() {
    closeRestartModal();
    if (restartProgressOverlay) restartProgressOverlay.style.display = 'flex';

    let secondsLeft = 12;
    if (restartCountdownVal) restartCountdownVal.textContent = `⏳ ${secondsLeft}s`;

    const stepKill = document.getElementById('stepKill');
    const stepLaunch = document.getElementById('stepLaunch');
    const stepDiscover = document.getElementById('stepDiscover');
    const stepConnect = document.getElementById('stepConnect');

    if (stepKill) stepKill.className = 'restart-step-item active';
    if (stepLaunch) stepLaunch.className = 'restart-step-item';
    if (stepDiscover) stepDiscover.className = 'restart-step-item';
    if (stepConnect) stepConnect.className = 'restart-step-item';

    try {
        await fetchWithAuth('/restart-ide', { method: 'POST' });
    } catch (e) {
        console.warn('Restart trigger error:', e.message);
    }

    const timer = setInterval(() => {
        secondsLeft--;
        if (restartCountdownVal) restartCountdownVal.textContent = `⏳ ${secondsLeft}s`;

        if (secondsLeft === 9) {
            if (stepKill) stepKill.className = 'restart-step-item done';
            if (stepLaunch) stepLaunch.className = 'restart-step-item active';
        } else if (secondsLeft === 6) {
            if (stepLaunch) stepLaunch.className = 'restart-step-item done';
            if (stepDiscover) stepDiscover.className = 'restart-step-item active';
        } else if (secondsLeft === 3) {
            if (stepDiscover) stepDiscover.className = 'restart-step-item done';
            if (stepConnect) stepConnect.className = 'restart-step-item active';
        }

        if (secondsLeft <= 0) {
            clearInterval(timer);
            if (stepConnect) stepConnect.className = 'restart-step-item done';
            if (restartProgressOverlay) restartProgressOverlay.style.display = 'none';
            showToast('✅ IDE restart complete');
            loadSnapshot();
            fetchAppState();
        }
    }, 1000);
}

async function executeQuickReconnect() {
    closeRestartModal();
    showToast('⏳ Reconnecting DevTools CDP...');

    try {
        const res = await fetchWithAuth('/reconnect-cdp', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('✅ CDP Reconnected successfully');
            loadSnapshot();
            fetchAppState();
        } else {
            showToast('Reconnect failed: ' + (data.error || 'Not found'));
        }
    } catch (e) {
        showToast('Reconnect error: ' + e.message);
    }
}

// --- Empty State ---
function showEmptyState() {
    chatContent.innerHTML = `
        <div class="loading-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--text-muted); opacity: 0.6; margin-bottom: 8px;">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <h2 style="font-size: 16px; color: #f1f5f9; margin-bottom: 6px;">No Conversation Open</h2>
            <p style="font-size: 13px; color: var(--text-muted); max-width: 260px; line-height: 1.4; margin-bottom: 16px;">
                Start a fresh conversation or pick one from history to chat with the agent.
            </p>
            <button class="new-chat-btn" onclick="startNewChat()" style="padding: 8px 18px; font-size: 13px;">
                ＋ Start New Conversation
            </button>
        </div>
    `;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Quick Actions ---
function quickAction(text) {
    messageInput.value = text;
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
    messageInput.focus();
}

// --- Stop Button Logic ---
async function handleStopAction() {
    if (stopBtn) {
        stopBtn.style.opacity = '0.5';
        stopBtn.disabled = true;
    }
    if (stopBarBtn) {
        stopBarBtn.style.opacity = '0.5';
        stopBarBtn.disabled = true;
    }
    showToast('■ Stopping generation and clearing queue...');
    try {
        const res = await fetchWithAuth('/stop', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            const queueMsg = data.clearedQueue ? ` (${data.clearedQueue} queued msg cleared)` : '';
            showToast(`■ Agent stopped${queueMsg}`);
            updateQueueUI([]);
            updateAgentBusyState(false);
            setTimeout(loadSnapshot, 300);
            setTimeout(loadSnapshot, 1000);
        } else {
            showToast('Stop: ' + (data.error || 'No active generation found'));
        }
    } catch (e) {
        showToast('Failed to stop: ' + e.message);
    } finally {
        setTimeout(() => {
            if (stopBtn) {
                stopBtn.style.opacity = '1';
                stopBtn.disabled = false;
            }
            if (stopBarBtn) {
                stopBarBtn.style.opacity = '1';
                stopBarBtn.disabled = false;
            }
        }, 400);
    }
}

if (stopBtn) stopBtn.addEventListener('click', handleStopAction);
if (stopBarBtn) stopBarBtn.addEventListener('click', handleStopAction);

// Check chat status
async function checkChatStatus() {
    try {
        const res = await fetchWithAuth('/chat-status');
        const data = await res.json();
        chatIsOpen = data.hasChat || data.editorFound;
        if (!chatIsOpen) showEmptyState();
    } catch (e) { }
}

// Prefetch conversations count on boot
async function prefetchHistory() {
    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();
        if (data.success && Array.isArray(data.chats)) {
            cachedConversations = data.chats;
            updateConversationBadges(cachedConversations.length);
        }
    } catch (e) { }
}

// --- Init ---
connectWebSocket();
fetchAppState();
setInterval(fetchAppState, 5000);
checkChatStatus();
prefetchHistory();
