#!/usr/bin/env python3
"""
جِسْر (Jisr) - Native Antigravity Chat Proxy v5.0

Architecture (from tcp_forward.py pattern):
  Mobile --> Jisr Proxy --> Antigravity IDE HTML
                       \--> Patches chatParams --> Routes LSP through proxy
                       \--> Intercepts gRPC responses --> Streams to mobile

Key Insight (from lisanclean coding guide - tcp_forward.py):
  - Patch window.chatParams Base64 JSON to redirect languageServerUrl
  - This routes ALL chat gRPC through our proxy
  - We get full bidirectional chat with responses

Lisan Naming:
  وَصْل (Wasl) = Connection
  فَيْض (Fayd) = Streaming flow  
  إِرْسَال (Irsaal) = Sending
"""

import base64
import http.client
import http.server
import json
import os
import queue
import re
import socket
import subprocess
import ssl
import threading
import time
from socketserver import ThreadingMixIn
from urllib.parse import urlparse

# ============ Configuration ============
DISPLAY = ':0'
HOME = '/home/absolut7'
JISR_PORT = 8893  # Main entry point

# Global state
class JisrState:
    """Dynamic connection state"""
    lsp_port = None
    csrf_token = None
    ide_port = 9090  # Antigravity IDE web UI port
    ide_pid = None
    last_detect = 0
    external_ip = None
    
    @classmethod
    def get_external_ip(cls):
        if cls.external_ip:
            return cls.external_ip
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            cls.external_ip = s.getsockname()[0]
            s.close()
        except:
            cls.external_ip = "127.0.0.1"
        return cls.external_ip
    
    @classmethod
    def detect(cls):
        """Detect LSP port, CSRF token, and IDE port"""
        if time.time() - cls.last_detect < 3:
            return cls.lsp_port is not None
        
        try:
            result = subprocess.run(['ps', 'auxww'], capture_output=True, text=True)
            best_pair = None
            
            for line in result.stdout.split('\n'):
                if 'language_server' in line and 'extension_server_port' in line:
                    p = re.search(r'extension_server_port\s+(\d+)', line)
                    t = re.search(r'csrf_token\s+([a-f0-9-]+)', line)
                    
                    if p:
                        port = int(p.group(1))
                        token = t.group(1) if t else None
                        
                        # Prefer workspace-specific server
                        if 'workspace_id' in line:
                            cls.lsp_port = port
                            cls.csrf_token = token
                            break
                        best_pair = (port, token)
                
                # Detect IDE PID
                if '/usr/share/antigravity/antigravity' in line:
                    parts = line.split()
                    if len(parts) > 1:
                        cls.ide_pid = int(parts[1])
            
            if best_pair and not cls.lsp_port:
                cls.lsp_port, cls.csrf_token = best_pair
        except Exception as e:
            print(f"[Jisr] Detection error: {e}")
        
        # Find IDE web UI port
        for port in [9092, 9091, 9090]:
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(0.5)
                if s.connect_ex(('127.0.0.1', port)) == 0:
                    cls.ide_port = port
                    s.close()
                    break
                s.close()
            except:
                pass
        
        cls.last_detect = time.time()
        return cls.lsp_port is not None

# Response streaming to SSE clients
sse_clients = {}  # client_id -> queue.Queue

class ThreadingHTTPServer(ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class JisrProxyHandler(http.server.BaseHTTPRequestHandler):
    """
    Proxy handler that:
    1. Serves IDE HTML with patched chatParams
    2. Forwards and intercepts LSP/gRPC traffic
    3. Provides SSE stream for response capture
    """
    
    def log_message(self, format, *args):
        print(f"[Jisr] {args[0]}")
    
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Credentials', 'true')
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.cors()
        self.end_headers()
    
    def do_GET(self):
        path = urlparse(self.path).path
        
        if path == '/health':
            self.handle_health()
        elif path == '/sse' or path == '/wasl':
            self.handle_sse()
        elif path.startswith('/exa.'):
            self.forward_grpc(path)
        else:
            # Proxy IDE HTML with chatParams patching
            self.proxy_ide()
    
    def do_POST(self):
        path = urlparse(self.path).path
        
        if path == '/irsaal' or path == '/send':
            self.handle_irsaal()
        elif path.startswith('/exa.'):
            self.forward_grpc(path)
        else:
            self.proxy_ide()
    
    def handle_irsaal(self):
        """Send message via xdotool injection (إِرْسَال/Irsaal)"""
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        try:
            data = json.loads(body)
            message = data.get('message', '').strip()
            
            if not message:
                self._json_response({'sent': False, 'reason': 'empty message'})
                return
            
            env = os.environ.copy()
            env['DISPLAY'] = DISPLAY
            env['HOME'] = HOME
            
            # Focus Antigravity window
            try:
                subprocess.run(['wmctrl', '-a', 'Antigravity'], env=env, timeout=3, capture_output=True)
            except:
                pass
            
            time.sleep(0.2)
            
            # Open chat panel with Ctrl+E
            subprocess.run(['xdotool', 'key', 'ctrl+e'], env=env, timeout=5)
            time.sleep(0.3)
            
            # Type the message
            subprocess.run(
                ['xdotool', 'type', '--delay', '10', '--clearmodifiers', message],
                env=env, timeout=120
            )
            
            # Press Enter to send
            subprocess.run(['xdotool', 'key', 'Return'], env=env, timeout=5)
            
            # Broadcast to SSE clients
            for q in sse_clients.values():
                q.put({
                    'type': 'sent',
                    'message': message[:100],
                    'time': time.time()
                })
            
            self._json_response({'sent': True, 'length': len(message)})
            
        except subprocess.TimeoutExpired:
            self._json_response({'sent': False, 'reason': 'xdotool timeout'}, 500)
        except Exception as e:
            self._json_response({'sent': False, 'reason': str(e)}, 500)
    
    def _json_response(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.cors()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def handle_health(self):
        JisrState.detect()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.cors()
        self.end_headers()
        
        data = {
            'status': 'connected' if JisrState.lsp_port else 'detecting',
            'version': '5.0-proxy',
            'lsp_port': JisrState.lsp_port,
            'ide_port': JisrState.ide_port,
            'csrf': JisrState.csrf_token[:16] + '...' if JisrState.csrf_token else None,
            'sse_clients': len(sse_clients),
            'time': int(time.time())
        }
        self.wfile.write(json.dumps(data).encode())
    
    def handle_sse(self):
        """SSE stream for captured responses"""
        client_id = f"c{int(time.time()*1000)}"
        sse_clients[client_id] = queue.Queue()
        
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.send_header('X-Accel-Buffering', 'no')
        self.cors()
        self.end_headers()
        
        # Send connection event
        self._sse('connected', {'id': client_id, 'version': '5.0-proxy'})
        
        try:
            while True:
                try:
                    msg = sse_clients[client_id].get(timeout=25)
                    self._sse('response', msg)
                except queue.Empty:
                    self._sse('ping', {'t': int(time.time())})
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            sse_clients.pop(client_id, None)
    
    def _sse(self, event, data):
        try:
            self.wfile.write(f"event: {event}\n".encode())
            self.wfile.write(f"data: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()
        except:
            pass
    
    def proxy_ide(self):
        """Proxy Antigravity IDE HTML with chatParams patching"""
        JisrState.detect()
        
        if not JisrState.ide_port:
            self.send_error(503, 'IDE not detected')
            return
        
        try:
            # Read request body if present
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length) if content_length > 0 else None
            
            # Forward to IDE
            conn = http.client.HTTPConnection('127.0.0.1', JisrState.ide_port, timeout=60)
            
            # Forward headers
            headers = {}
            for k, v in self.headers.items():
                if k.lower() not in ['host', 'accept-encoding']:
                    headers[k] = v
            headers['Host'] = f'127.0.0.1:{JisrState.ide_port}'
            
            method = self.command
            conn.request(method, self.path, body, headers)
            response = conn.getresponse()
            response_body = response.read()
            
            # Patch HTML for chatParams
            content_type = response.getheader('Content-Type', '')
            if 'text/html' in content_type:
                response_body = self.patch_chat_params(response_body)
            
            # Send response
            self.send_response(response.status)
            for k, v in response.getheaders():
                if k.lower() not in ['content-length', 'transfer-encoding', 'content-encoding', 'connection']:
                    self.send_header(k, v)
            self.send_header('Content-Length', len(response_body))
            self.cors()
            self.end_headers()
            self.wfile.write(response_body)
            
            conn.close()
            
        except Exception as e:
            self.send_error(502, str(e))
    
    def patch_chat_params(self, body):
        """
        Patch window.chatParams to redirect LSP traffic through our proxy
        This is the key technique from tcp_forward.py
        """
        external_ip = JisrState.get_external_ip()
        
        # Mobile-friendly CSS
        mobile_css = b'''<style>
/* Jisr Mobile Optimization */
html, body { touch-action: manipulation; }
* { -webkit-tap-highlight-color: transparent; }
:root {
  --mobile-font-scale: 1.1;
  --mobile-touch-target: 44px;
}
button, input, textarea, [role="button"] {
  min-height: var(--mobile-touch-target) !important;
  font-size: calc(1em * var(--mobile-font-scale)) !important;
}
.message-content, .chat-message, p, span {
  font-size: 16px !important;
  line-height: 1.5 !important;
}
[class*="scroll"], [class*="list"] {
  -webkit-overflow-scrolling: touch;
  scroll-behavior: smooth;
}
/* Hide non-chat panels for mobile */
.sidebar, .file-explorer, [class*="panel"]:not([class*="chat"]) {
  display: none !important;
}
[class*="chat"], [class*="message"] {
  width: 100% !important;
  max-width: 100vw !important;
}
</style>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
'''
        
        # Inject mobile CSS
        if b'<head>' in body:
            body = body.replace(b'<head>', b'<head>' + mobile_css)
        
        # crypto.randomUUID polyfill for non-HTTPS
        polyfill = b'''<script>
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = function() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };
}
</script>'''
        if b'<head>' in body:
            body = body.replace(b'<head>', b'<head>' + polyfill)
        
        # Patch chatParams - the key technique!
        try:
            match = re.search(b"window\\.chatParams\\s*=\\s*['\"]([A-Za-z0-9+/=]+)['\"]", body)
            if match:
                old_b64 = match.group(1)
                params = json.loads(base64.b64decode(old_b64))
                
                # Redirect LSP through our proxy
                new_url = f'http://{external_ip}:{JISR_PORT}/'
                params['languageServerUrl'] = new_url
                params['httpLanguageServerUrl'] = new_url
                
                # Re-encode
                new_b64 = base64.b64encode(json.dumps(params).encode()).decode()
                old_full = b"window.chatParams = '" + old_b64 + b"'"
                new_full = b"window.chatParams = '" + new_b64.encode() + b"'"
                body = body.replace(old_full, new_full)
                
                print(f"[Jisr] Patched chatParams: LSP -> http://{external_ip}:{JISR_PORT}/")
        except Exception as e:
            print(f"[Jisr] chatParams patch error: {e}")
        
        return body
    
    def forward_grpc(self, path):
        """Forward gRPC-Web requests to LSP, capture and broadcast responses"""
        JisrState.detect()
        
        if not JisrState.lsp_port:
            self.send_error(503, 'LSP not available')
            return
        
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else None
        
        try:
            # Prepare headers with CSRF token
            headers = {
                'Host': f'localhost:{JisrState.lsp_port}',
                'Content-Type': self.headers.get('Content-Type', 'application/connect+proto')
            }
            if JisrState.csrf_token:
                headers['x-codeium-csrf-token'] = JisrState.csrf_token
            
            conn = http.client.HTTPConnection('localhost', JisrState.lsp_port, timeout=120)
            conn.request('POST', path, body, headers)
            response = conn.getresponse()
            
            # Send response headers
            self.send_response(response.status)
            for k, v in response.getheaders():
                if k.lower() not in ['transfer-encoding', 'connection']:
                    self.send_header(k, v)
            self.cors()
            self.end_headers()
            
            # Stream and capture response chunks
            all_chunks = []
            while True:
                chunk = response.read(4096)
                if not chunk:
                    break
                all_chunks.append(chunk)
                self.wfile.write(chunk)
                self.wfile.flush()
            
            conn.close()
            
            # Broadcast captured response to SSE clients
            if all_chunks and sse_clients:
                full_response = b''.join(all_chunks)
                # Try to decode as text for preview
                try:
                    preview = full_response[:500].decode('utf-8', errors='replace')
                except:
                    preview = f"[binary {len(full_response)} bytes]"
                
                for q in sse_clients.values():
                    q.put({
                        'path': path,
                        'size': len(full_response),
                        'preview': preview[:200],
                        'time': time.time()
                    })
            
        except Exception as e:
            self.send_error(502, str(e))


def main():
    JisrState.detect()
    JisrState.get_external_ip()
    
    external = JisrState.get_external_ip()
    access_url = f"http://{external}:{JISR_PORT}/"
    
    print(f"""
╔═══════════════════════════════════════════════════════════╗
║  جِسْر (Jisr) - Native Chat Proxy v5.0                   ║
╠═══════════════════════════════════════════════════════════╣
║  Port:     {JISR_PORT}                                         ║
║  External: {external:<15}                           ║
║  IDE:      127.0.0.1:{JisrState.ide_port}                                ║
║  LSP:      127.0.0.1:{JisrState.lsp_port if JisrState.lsp_port else 'detecting'}                               ║
╠═══════════════════════════════════════════════════════════╣
║  Mobile Access: {access_url:<40} ║
║                                                           ║
║  Endpoints:                                               ║
║    GET  /         - Proxied IDE with patched chatParams   ║
║    GET  /health   - Status & diagnostics                  ║
║    GET  /sse      - Response stream (SSE)                 ║
║    POST /exa.*    - gRPC forwarding with capture          ║
╚═══════════════════════════════════════════════════════════╝
""")
    
    if JisrState.lsp_port:
        print(f"[Jisr] ✓ LSP detected: localhost:{JisrState.lsp_port}")
    if JisrState.csrf_token:
        print(f"[Jisr] ✓ CSRF token: {JisrState.csrf_token[:16]}...")
    if JisrState.ide_port:
        print(f"[Jisr] ✓ IDE UI: localhost:{JisrState.ide_port}")
    
    server = ThreadingHTTPServer(('0.0.0.0', JISR_PORT), JisrProxyHandler)
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Jisr] Shutting down...")


if __name__ == '__main__':
    main()
