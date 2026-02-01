#!/usr/bin/env node
/**
 * AG Bridge MCP Server
 * 
 * This MCP server exposes tools for the Antigravity agent to interact with
 * the AG Bridge message inbox. When users send messages from mobile,
 * the agent can read them via these tools and respond.
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

// Helper to make HTTP requests
async function bridgeRequest(method, path, body = null) {
    const url = `${BRIDGE_URL}${path}`;
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    return response.json();
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

                const result = await bridgeRequest('POST', '/messages/send', {
                    from: 'agent',
                    to: 'user',
                    text,
                });

                if (result.ok) {
                    return { content: [{ type: 'text', text: `Reply sent: "${text.substring(0, 50)}..."` }] };
                } else {
                    return { content: [{ type: 'text', text: `Error sending reply: ${result.error}` }], isError: true };
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
