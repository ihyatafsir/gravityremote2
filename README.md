# GravityRemote

A web-based interface for the Antigravity AI Agent IDE, allowing remote access to the agent through any web browser.

## Features

- **Web-Based IDE Interface** - Full IDE experience in your browser
- **Real Agent Integration** - Embedded Antigravity chat panel
- **File Explorer** - Browse and view workspace files
- **Code Viewer** - Syntax-highlighted file display
- **WebSocket Communication** - Real-time bidirectional messaging
- **Mobile Optimized** - Responsive design with HTTP proxy injection

## Architecture

| Component | Port | Description |
|-----------|------|-------------|
| HTTP Proxy | 8890 | Entry point with mobile optimization |
| WebSocket Server | 8888 | Real-time communication bridge |
| TCP Proxy | 8889 | Generic TCP forwarding |
| Static Server | 9090 | Serves the web interface |

## Quick Start

```bash
# Start all services
python3 websocket_server.py &
python3 http_proxy.py &
python3 proxy_server.py &
python3 -m http.server 9090 &

# Access the IDE
open http://localhost:8890
```

## Files

- `index.html` - Main IDE interface
- `websocket_server.py` - WebSocket backend with file operations
- `http_proxy.py` - HTTP proxy with mobile optimization
- `proxy_server.py` - Async TCP proxy

## Version

**v1.0.0** - Initial release

## License

MIT
