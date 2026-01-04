# GravityRemote

> 🌐 Access your Antigravity AI Agent through any web browser - **Now with true remote access!**

GravityRemote provides a web-based interface for the Antigravity IDE, allowing you to interact with your AI agent remotely from any device with a browser.

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![Python](https://img.shields.io/badge/python-3.8+-green)
![License](https://img.shields.io/badge/license-MIT-orange)

---

## 🆕 What's New in v2.0

- **True Remote Access** - Access from any device on your network or via Tailscale
- **Smart URL Patching** - Automatically rewrites internal URLs for external access
- **Dynamic LSP Discovery** - Auto-detects the language server port on startup
- **Proper HTTP Handling** - Uses Python's http library for reliable request/response handling
- **Base64 Parameter Patching** - Patches encoded configuration for seamless remote connectivity

---

## ✨ Features

- **Web-Based IDE Interface** - Full IDE experience in your browser
- **Real Agent Integration** - Embedded Antigravity chat panel
- **File Explorer** - Browse and view workspace files
- **Code Viewer** - Syntax-highlighted file display
- **WebSocket Communication** - Real-time bidirectional messaging
- **Mobile Optimized** - Responsive design with automatic viewport injection
- **Remote Access** - Access from any device on your network

---

## 📋 Prerequisites

- **Antigravity IDE** installed and running on the host machine
- **Python 3.8+** (no additional packages required for basic functionality)
- Network access to the Antigravity host

---

## 🚀 Quick Start (v2.0 - Remote Access)

### Step 1: Clone and Run

```bash
git clone https://github.com/ihyatafsir/gravityremote.git
cd gravityremote
python3 tcp_forward.py
```

### Step 2: Access from Any Device

The script will display your external IP. Access from any device:

```
http://<your-ip>:8890
```

That's it! The proxy automatically:
- Detects the Antigravity LSP port
- Patches URLs for remote access
- Handles CORS and authentication headers

---

## 🏗️ Architecture (v2.0)

```
┌─────────────────────────────────────────────────────────────┐
│                    Remote Device                            │
│                http://<your-ip>:8890                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              tcp_forward.py (Proxy Server)                  │
│   Port 8890 (UI) ──────► 127.0.0.1:9090 (Agent Tab)        │
│   Port 8891 (LSP) ─────► 127.0.0.1:xxxxx (Dynamic)         │
│                                                             │
│   • Rewrites Host headers                                   │
│   • Patches Base64-encoded chatParams                       │
│   • Dynamic LSP port discovery                              │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Antigravity IDE                            │
│     Port 9090 (Agent Tab) + Dynamic LSP Port               │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 Configuration

### Port Reference

| Port | Service | Description |
|------|---------|-------------|
| 8890 | UI Proxy | Main entry point for remote access |
| 8891 | LSP Proxy | Language server communication |
| 9090 | Agent Tab | Antigravity internal UI (localhost only) |
| Dynamic | LSP | Language server (auto-detected) |

### Changing Ports

Edit `tcp_forward.py`:
```python
UI_PORT = 8890   # Change to your preferred port
LSP_PORT = 8891  # Change to your preferred port
```

---

## 📁 File Structure

```
gravityremote/
├── tcp_forward.py       # v2.0 Remote access proxy (main script)
├── index.html           # Web interface
├── websocket_server.py  # WebSocket backend for file operations
├── http_proxy.py        # v1.0 HTTP proxy (legacy)
├── proxy_server.py      # v1.0 TCP proxy (legacy)
├── README.md            # This file
└── .gitignore           # Git ignore rules
```

---

## 🔧 Troubleshooting

### Page loads but chat doesn't respond
- The proxy auto-patches URLs, but if the Antigravity LSP port changed, restart the proxy:
  ```bash
  pkill -f tcp_forward.py
  python3 tcp_forward.py
  ```

### Connection refused on external IP
- Make sure no firewall is blocking ports 8890 and 8891
- Verify Antigravity is running: `ps aux | grep antigravity`

### "Something went wrong" error
- Check the proxy console for `[PATCH]` messages
- Ensure the LSP port was correctly detected

---

## 📄 License

MIT License - Feel free to use, modify, and distribute.

---

## 🙏 Credits

Built with ❤️ by the Antigravity Agent

**Repository**: [github.com/ihyatafsir/gravityremote](https://github.com/ihyatafsir/gravityremote)
