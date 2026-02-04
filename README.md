# GravityRemote Bridge v1.4

Antigravity Bridge (AG Bridge) is the core connectivity layer for the **GravityRemote** mobile experience. It provides a robust WebSocket and CDP (Chrome DevTools Protocol) link between your mobile device and the Antigravity IDE.

## 🚀 v1.4.0 - Cross-IDE Delegation & IDE Maxxing

This release introduces **IDE Maxxing** - advanced tools for agent-to-agent delegation and IDE control.

### New Features

#### 1. 🔌 Cross-IDE Delegation
- **HTTP Message Passing**: Send tasks between IDEs on different machines via HTTP
- **MCP Tools**: `messages_inbox`, `messages_reply`, `messages_ack` for agent communication
- **Remote Bridge**: Point `AG_BRIDGE_URL` to another machine's bridge for delegation

#### 2. 🚀 IDE Maxxing Tools
- **`ide_write`**: Inject text directly into IDE chat input
- **`ide_queue_write`**: Queue commands for when IDE is idle
- **`focus_tab`**: Switch active tabs in the IDE programmatically

#### 3. 🟢 Reliability & Hardening (v1.3)
- **Race Condition Fix**: Solved "System Error" failures
- **Active Frame Discovery**: Finds chat input across all iframes
- **Auto-Retry**: 3x retry with backoff for busy IDE

#### 4. 🎨 Mobile Interface
- **Green Theme**: Matrix-style green accent theme
- **Chat History**: Browse past conversations from drawer
- **New Chat**: Instant session reset button

## Installation & Usage

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start the Bridge**:
   ```bash
   node server.mjs
   ```
   *Runs on port 8787 by default.*

3. **For CDP Integration** (required for IDE Maxxing):
   ```bash
   antigravity --remote-debugging-port=9222
   ```

## Cross-IDE Setup

To delegate to another IDE on a different machine:

```json
// ~/.config/antigravity/mcp-servers.json
{
  "ag-bridge": {
    "command": "node",
    "args": ["mcp-server.mjs"],
    "cwd": "/path/to/gravityremote2",
    "env": {
      "AG_BRIDGE_URL": "http://REMOTE_IP:8787"
    }
  }
}
```

## Architecture
- **Server**: Node.js + Express + WebSocket
- **Bridge**: CDP (Chrome DevTools Protocol) to IDE port 9000/9222
- **MCP**: Model Context Protocol server for agent tools
- **Frontend**: Vanilla HTML/JS (Mobile Optimized)

---
*AG Bridge v1.4.0 - IDE Maxxing Edition*
