#!/usr/bin/env node
/**
 * AG Bridge MCP Server (Resilient Version)
 * 
 * This MCP server exposes tools for the Antigravity agent to interact with
 * the AG Bridge message inbox. When users send messages from mobile,
 * the agent can read them via these tools and respond.
 * 
 * RESILIENCE FEATURES:
 * - Retry logic with exponential backoff
 * - Health check ping every 30 seconds
 * - Connection state tracking
 * - Graceful error handling
 * 
 * Tools:
 * - messages_inbox: Read new messages from mobile users
 * - messages_reply: Send a response back to the mobile user
 * - messages_ack: Mark a message as read/done
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BRIDGE_URL = process.env.AG_BRIDGE_URL || 'http://localhost:8787';
const MAX_RETRIES = 5;  // Increased from 3
const RETRY_DELAY_MS = 500;  // Faster initial retry
const HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds

// Connection state tracking
let bridgeState = {
    connected: false,
    lastHealthCheck: null,
    lastError: null,
    consecutiveFailures: 0
};

// Health check ping - runs in background
async function healthCheck() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(`${BRIDGE_URL}/health`, { signal: controller.signal });
        clearTimeout(timeout);

        if (response.ok) {
            bridgeState.connected = true;
            bridgeState.lastHealthCheck = new Date().toISOString();
            bridgeState.consecutiveFailures = 0;
            bridgeState.lastError = null;
        } else {
            throw new Error(`Health check failed: ${response.status}`);
        }
    } catch (error) {
        bridgeState.connected = false;
        bridgeState.lastError = error.message;
        bridgeState.consecutiveFailures++;
        console.error(`[MCP] Health check failed (${bridgeState.consecutiveFailures}): ${error.message}`);
    }
}

// Start background health check
setInterval(healthCheck, HEALTH_CHECK_INTERVAL_MS);
healthCheck(); // Initial check


// Helper to make HTTP requests with retry logic
async function bridgeRequest(method, path, body = null) {
    const url = `${BRIDGE_URL}${path}`;
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return await response.json();
        } catch (error) {
            lastError = error;
            console.error(`[MCP Bridge] Attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`);

            if (attempt < MAX_RETRIES) {
                // Exponential backoff
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    // All retries exhausted
    return { ok: false, error: `Bridge request failed after ${MAX_RETRIES} attempts: ${lastError?.message}` };
}

// Create MCP Server
const server = new Server(
    { name: 'ag-bridge-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'messages_inbox',
                description: 'Read new messages from the AG Bridge inbox. Use this when asked to "check inbox" or when you need to see what the mobile user has sent.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        limit: {
                            type: 'number',
                            description: 'Maximum number of messages to retrieve (default: 10)',
                        },
                        status: {
                            type: 'string',
                            enum: ['new', 'read', 'done'],
                            description: 'Filter by message status (default: new)',
                        },
                    },
                },
            },
            {
                name: 'messages_reply',
                description: 'Send a reply to the mobile user via AG Bridge. Use this to respond to messages from the inbox.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'The message text to send to the user',
                        },
                    },
                    required: ['text'],
                },
            },
            {
                name: 'ide_write',
                description: 'Write text directly into the IDE chat input. Use this to control the IDE or simulate user input.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'The text to type into the IDE',
                        },
                    },
                    required: ['text'],
                },
            },
            {
                name: 'messages_ack',
                description: 'Acknowledge a message as read or done.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description: 'The message ID to acknowledge',
                        },
                        status: {
                            type: 'string',
                            enum: ['read', 'done'],
                            description: 'The new status for the message',
                        },
                    },
                    required: ['id'],
                },
            },
            {
                name: 'ide_queue_write',
                description: 'Queue text to be written to the IDE when it becomes idle. Use this to avoid "Busy" errors.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: 'The text to queue' }
                    },
                    required: ['text']
                }
            },
            {
                name: 'get_ide_tabs',
                description: 'Get a list of open tabs in the IDE to see what agents/files are active.',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'focus_tab',
                description: 'Switch the active tab in the IDE by name.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Name or partial name of the tab to focus' }
                    },
                    required: ['name']
                }
            },
            {
                name: 'delegation_create',
                description: 'Create a delegated task for another agent with optional model selection. Enables supervisor pattern multi-agent orchestration.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        target_tab: { type: 'string', description: 'Tab name to delegate to (e.g., "RewardsClaim.tsx")' },
                        task: { type: 'string', description: 'Task description to send to the agent' },
                        model: { type: ['number', 'string'], description: 'Model to use: 0=Gemini Pro High, 1=Gemini Pro Low, 2=Gemini Flash, 3=Claude Sonnet, 4=Claude Sonnet Thinking, 5=Claude Opus Thinking, 6=GPT-OSS 120B. Can also use name or key.' },
                        priority: { type: 'string', enum: ['normal', 'high'], description: 'Task priority (default: normal)' },
                        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 300000 = 5 min)' }
                    },
                    required: ['target_tab', 'task']
                }
            },
            {
                name: 'list_models',
                description: 'List available AI models for delegation.',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'delegation_status',
                description: 'Check status of all delegated tasks or a specific one.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Optional delegation ID to check specific task' },
                        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed', 'timeout'], description: 'Filter by status' }
                    }
                }
            },
            {
                name: 'delegation_complete',
                description: 'Mark a delegation as complete (usually called by the delegated agent).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Delegation ID to mark complete' },
                        result: { type: 'string', description: 'Result or output from the task' },
                        error: { type: 'string', description: 'Error message if task failed' }
                    },
                    required: ['id']
                }
            },
            {
                name: 'delegation_inbox',
                description: 'Check inbox for delegated tasks assigned to this agent. Target agents should call this to see what work is pending for them.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        my_tab: { type: 'string', description: 'Your tab name to filter tasks assigned to you (optional - will try to auto-detect)' },
                        status: { type: 'string', enum: ['pending', 'in_progress', 'all'], description: 'Filter by status (default: in_progress)' }
                    }
                }
            },
            {
                name: 'delegation_accept',
                description: 'Accept/claim a delegated task. Call this to signal you are starting work on a delegation.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Delegation ID to accept' }
                    },
                    required: ['id']
                }
            },
        ],
    };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'messages_inbox': {
                const limit = args?.limit || 10;
                const status = args?.status || 'new';
                const result = await bridgeRequest('GET', `/messages/inbox?to=agent&status=${status}&limit=${limit}`);

                if (result.ok && result.messages.length > 0) {
                    const formatted = result.messages.map(m =>
                        `[${m.id}] (${m.createdAt}): ${m.text}`
                    ).join('\n');
                    return { content: [{ type: 'text', text: `Found ${result.messages.length} message(s):\n${formatted}` }] };
                } else {
                    return { content: [{ type: 'text', text: 'No new messages in inbox.' }] };
                }
            }

            case 'messages_reply': {
                const text = args?.text;
                if (!text) {
                    return { content: [{ type: 'text', text: 'Error: text is required' }], isError: true };
                }

                // كفل (Kafal) - DUAL SEND: Both to /messages/send AND /api/outbox for guaranteed delivery
                const [messageResult, outboxResult] = await Promise.all([
                    bridgeRequest('POST', '/messages/send', {
                        from: 'agent',
                        to: 'user',
                        text,
                    }),
                    bridgeRequest('POST', '/api/outbox', { text, priority: 'normal' })
                ]);

                // Success if EITHER channel works
                if (messageResult.ok || outboxResult.ok) {
                    const channels = [];
                    if (messageResult.ok) channels.push('message');
                    if (outboxResult.ok) channels.push('sanad');
                    return { content: [{ type: 'text', text: `Reply sent via ${channels.join('+')}. "${text.substring(0, 50)}..."` }] };
                } else {
                    return { content: [{ type: 'text', text: `Error sending reply: ${messageResult.error || outboxResult.error}` }], isError: true };
                }
            }

            case 'ide_write': {
                const text = args?.text;
                if (!text) {
                    return { content: [{ type: 'text', text: 'Error: text is required' }], isError: true };
                }

                // Sending to 'agent' triggers the CDP injection in server.mjs
                const result = await bridgeRequest('POST', '/messages/send', {
                    from: 'agent_mcp',
                    to: 'agent',
                    text,
                });

                if (result.ok && result.injection?.ok) {
                    return { content: [{ type: 'text', text: `Successfully wrote to IDE: "${text.substring(0, 50)}..."` }] };
                } else {
                    const error = result.injection?.error || result.error || 'Unknown error';
                    return { content: [{ type: 'text', text: `Failed to write to IDE: ${error}` }], isError: true };
                }
            }

            case 'messages_ack': {
                const { id, status = 'read' } = args || {};
                if (!id) {
                    return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };
                }

                const result = await bridgeRequest('POST', `/messages/${id}/ack`, { status });

                if (result.ok) {
                    return { content: [{ type: 'text', text: `Message ${id} marked as ${status}` }] };
                } else {
                    return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
                }
            }

            case 'ide_queue_write': {
                const text = args?.text;
                if (!text) return { content: [{ type: 'text', text: 'Error: text is required' }], isError: true };

                const result = await bridgeRequest('POST', '/api/queue', { text, from: 'agent_mcp_queue' });

                if (result.ok) {
                    return { content: [{ type: 'text', text: `Action queued! Position: ${result.position}` }] };
                } else {
                    return { content: [{ type: 'text', text: `Failed to queue: ${result.error}` }], isError: true };
                }
            }

            case 'get_ide_tabs': {
                const result = await bridgeRequest('GET', '/api/tabs');

                if (result.ok && result.tabs) {
                    const tabList = result.tabs.map(t => `- [${t.index}] ${t.name} ${t.active ? '(ACTIVE)' : ''}`).join('\n');
                    return { content: [{ type: 'text', text: `Open Tabs:\n${tabList}` }] };
                } else {
                    return { content: [{ type: 'text', text: `Failed to get tabs: ${result.error || 'Unknown error'}` }], isError: true };
                }
            }

            case 'focus_tab': {
                const name = args?.name;
                if (!name) return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };

                const result = await bridgeRequest('POST', '/api/tabs/focus', { name });

                if (result.ok) {
                    return { content: [{ type: 'text', text: `Success! Switched to tab: ${result.target}` }] };
                } else {
                    return { content: [{ type: 'text', text: `Failed to switch tab: ${result.error}` }], isError: true };
                }
            }

            case 'delegation_create': {
                const { target_tab, task, model, priority, timeout_ms } = args || {};
                if (!target_tab || !task) {
                    return { content: [{ type: 'text', text: 'Error: target_tab and task are required' }], isError: true };
                }

                const result = await bridgeRequest('POST', '/api/delegation', { target_tab, task, model, priority, timeout_ms });

                if (result.ok) {
                    const d = result.delegation;
                    const modelInfo = d.model ? `\nModel: ${d.model}` : '';
                    return { content: [{ type: 'text', text: `Delegation created: ${d.id}\nTarget: ${d.target_tab}${modelInfo}\nStatus: ${d.status}` }] };
                } else {
                    return { content: [{ type: 'text', text: `Failed to create delegation: ${result.error}` }], isError: true };
                }
            }

            case 'list_models': {
                const models = [
                    '0: Gemini 3 Pro (High) - key: gemini-pro-high',
                    '1: Gemini 3 Pro (Low) - key: gemini-pro-low',
                    '2: Gemini 3 Flash ⚡ - key: gemini-flash',
                    '3: Claude Sonnet 4.5 - key: claude-sonnet',
                    '4: Claude Sonnet 4.5 (Thinking) - key: claude-sonnet-thinking',
                    '5: Claude Opus 4.5 (Thinking) 💎 - key: claude-opus-thinking',
                    '6: GPT-OSS 120B (Medium) - key: gpt-oss-120b'
                ];
                return { content: [{ type: 'text', text: 'Available Models:\n' + models.join('\n') }] };
            }

            case 'delegation_status': {
                const { id, status } = args || {};
                const query = [];
                if (id) query.push(`id=${id}`);
                if (status) query.push(`status=${status}`);
                const qs = query.length > 0 ? '?' + query.join('&') : '';

                const result = await bridgeRequest('GET', `/api/delegation${qs}`);

                if (result.ok) {
                    const summary = result.summary;
                    let text = `Delegations Summary:\n- Pending: ${summary.pending}\n- In Progress: ${summary.in_progress}\n- Completed: ${summary.completed}\n- Failed: ${summary.failed}\n\n`;
                    if (result.delegations.length > 0) {
                        text += 'Details:\n';
                        result.delegations.forEach(d => {
                            text += `- [${d.id}] ${d.target_tab}: ${d.status} (${d.task.substring(0, 50)}...)\n`;
                        });
                    }
                    return { content: [{ type: 'text', text }] };
                } else {
                    return { content: [{ type: 'text', text: `Failed to get status: ${result.error}` }], isError: true };
                }
            }

            case 'delegation_complete': {
                const { id, result: taskResult, error } = args || {};
                if (!id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };

                const result = await bridgeRequest('POST', `/api/delegation/${id}/complete`, { result: taskResult, error });

                if (result.ok) {
                    return { content: [{ type: 'text', text: `Delegation ${id} marked as ${result.delegation.status}` }] };
                } else {
                    return { content: [{ type: 'text', text: `Failed to complete: ${result.error}` }], isError: true };
                }
            }

            case 'delegation_inbox': {
                const { my_tab, status } = args || {};
                const filterStatus = status || 'in_progress';

                // Get all delegations
                const result = await bridgeRequest('GET', '/api/delegation');

                if (result.ok) {
                    // Filter to tasks for this agent's tab
                    let myTasks = result.delegations;

                    if (my_tab) {
                        myTasks = myTasks.filter(d =>
                            d.target_tab.toLowerCase().includes(my_tab.toLowerCase())
                        );
                    }

                    if (filterStatus !== 'all') {
                        myTasks = myTasks.filter(d => d.status === filterStatus);
                    }

                    if (myTasks.length === 0) {
                        return { content: [{ type: 'text', text: `📭 No delegated tasks found${my_tab ? ` for ${my_tab}` : ''}` }] };
                    }

                    let text = `📬 DELEGATION INBOX${my_tab ? ` for ${my_tab}` : ''}:\\n\\n`;
                    myTasks.forEach(d => {
                        const priority = d.priority === 'high' ? '🔴' : '🟢';
                        const model = d.model ? ` [${d.model}]` : '';
                        text += `${priority} [${d.id}]${model}\\n`;
                        text += `   Task: ${d.task}\\n`;
                        text += `   Status: ${d.status.toUpperCase()}\\n\\n`;
                    });
                    text += `To accept a task, call: delegation_accept(id)\\n`;
                    text += `To complete, call: delegation_complete(id, result)`;

                    return { content: [{ type: 'text', text }] };
                } else {
                    return { content: [{ type: 'text', text: `Failed to get inbox: ${result.error}` }], isError: true };
                }
            }

            case 'delegation_accept': {
                const { id } = args || {};
                if (!id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };

                const result = await bridgeRequest('POST', `/api/delegation/${id}/accept`);

                if (result.ok) {
                    const d = result.delegation;
                    let text = `✅ TASK ACCEPTED: ${d.id}\\n\\n`;
                    text += `📋 Task: ${d.task}\\n\\n`;
                    text += `Priority: ${d.priority}\\n`;
                    if (d.model) text += `Model: ${d.model}\\n`;
                    text += `\\nWhen done, call: delegation_complete("${d.id}", "your result here")`;
                    return { content: [{ type: 'text', text }] };
                } else {
                    return { content: [{ type: 'text', text: `Failed to accept: ${result.error}` }], isError: true };
                }
            }

            default:
                return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        }
    } catch (error) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
});

// Start server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[AG Bridge MCP] Server started');
}

main().catch(console.error);
