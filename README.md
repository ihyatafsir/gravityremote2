# GravityRemote2

Mobile control interface for the **Antigravity IDE** via Chrome DevTools Protocol (CDP).

## 📱 Phone Chat (Primary)

The **Phone Chat** server is the main way to interact with the IDE from your mobile device. It provides a full chat interface, agent control, file uploads, and IDE shortcuts — all from your phone's browser.

### Quick Start

```bash
cd antigravity_phone_chat
npm install
node server.js
```

Runs on **port 3000** by default (`PORT` env to override).

### Prerequisites

Start Antigravity with remote debugging enabled:

```bash
antigravity --remote-debugging-port=9222
```

### Features

- 💬 **Chat**: Send messages to the IDE agent directly
- 🛑 **Stop/Cancel**: Interrupt running agent tasks
- 📎 **File Upload**: Send files to the IDE via CDP
- 🔄 **New Chat / History**: Manage conversation sessions
- 🎛️ **Model Switching**: Change AI model from your phone
- 🟢 **Live Status**: Real-time busy/idle indicator via WebSocket
- 🎨 **Matrix Green Theme**: Dark mobile-optimised UI

### systemd Service

```bash
# Enable auto-start
systemctl --user enable antigravity-phone-chat.service
systemctl --user start antigravity-phone-chat.service

# Check status
systemctl --user status antigravity-phone-chat.service
```

---

## ⚠️ AG Bridge (`server.mjs`) — Do NOT Run In Parallel

> [!CAUTION]
> **Do NOT run `server.mjs` (AG Bridge) alongside the Phone Chat server.**
> Both servers connect to the same CDP port (9222) and will fight for control,
> causing **terminal stalling**, high CPU usage, and unresponsive IDE.

The AG Bridge (`server.mjs` on port 8787) was the original connectivity layer but is now superseded by the Phone Chat server. If you previously had systemd services for AG Bridge, **disable them**:

```bash
systemctl --user stop ag-bridge.service gravityremote.service
systemctl --user disable ag-bridge.service gravityremote.service
```

---

## 🔌 MCP Server

The MCP (Model Context Protocol) server provides tool access for agent-to-agent communication:

```bash
node mcp-server.mjs
```

**Tools provided**: `messages_inbox`, `messages_reply`, `messages_ack`, `ide_write`, `ide_queue_write`, `focus_tab`, `get_ide_tabs`, `delegation_create/status/complete`

### MCP Config

```json
{
  "ag-bridge": {
    "command": "node",
    "args": ["mcp-server.mjs"],
    "cwd": "/path/to/gravityremote2"
  }
}
```

---

## Architecture

| Component | Port | Purpose |
|-----------|------|---------|
| Phone Chat (`server.js`) | 3000 | Mobile UI + CDP bridge |
| MCP Server (`mcp-server.mjs`) | — | Agent tools (stdio) |
| ~~AG Bridge (`server.mjs`)~~ | ~~8787~~ | ~~Legacy — do not use~~ |

**CDP Target**: Antigravity IDE on port `9222` (or `9022`)

---

*GravityRemote2 — Phone Chat Edition*
