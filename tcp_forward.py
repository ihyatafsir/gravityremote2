#!/usr/bin/env python3
"""
Remote Access Proxy for Antigravity v2.1
- Patches chatParams URLs for remote access
- Auto-detects and injects CSRF token for LSP requests
"""
import http.server
import http.client
import socketserver
import threading
import re
import base64
import json
import socket

def get_external_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"

EXTERNAL_IP = get_external_ip()
UI_PORT = 8890
LSP_PORT = 8891
MOBILE_PORT = 8892  # Mobile-friendly interface
UI_TARGET = ('127.0.0.1', 9090)
LSP_TARGET_PORT = 37417
CSRF_TOKEN = None  # Will be extracted from chatParams

def find_lsp_port():
    import subprocess
    try:
        result = subprocess.run(['ss', '-tunlp'], capture_output=True, text=True)
        for line in result.stdout.split('\n'):
            if 'language_server' in line:
                match = re.search(r'127\.0\.0\.1:(\d+)', line)
                if match:
                    return int(match.group(1))
    except:
        pass
    return 37417

class ProxyHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.proxy_request('GET')
    def do_POST(self): self.proxy_request('POST')
    def do_HEAD(self): self.proxy_request('HEAD')
    def do_PUT(self): self.proxy_request('PUT')
    def do_DELETE(self): self.proxy_request('DELETE')
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Credentials', 'true')
        self.end_headers()
    
    def log_message(self, *args): pass
    
    def proxy_request(self, method):
        global LSP_TARGET_PORT, CSRF_TOKEN
        port = self.server.server_address[1]
        
        try:
            if port in (UI_PORT, MOBILE_PORT):
                target_host, target_port = UI_TARGET
            else:
                target_host, target_port = '127.0.0.1', LSP_TARGET_PORT
            
            # Read request body
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length) if content_length > 0 else None
            
            # Forward headers
            headers = {}
            for k, v in self.headers.items():
                if k.lower() not in ['host', 'accept-encoding']:
                    headers[k] = v
            headers['Host'] = f'{target_host}:{target_port}'
            
            # Inject CSRF token for LSP requests
            if port == LSP_PORT and CSRF_TOKEN:
                headers['x-codeium-csrf-token'] = CSRF_TOKEN
            
            conn = http.client.HTTPConnection(target_host, target_port, timeout=600)
            # Enable TCP keepalive to prevent idle disconnects
            conn.sock = None  # Will be set on connect
            conn.request(method, self.path, body, headers)
            response = conn.getresponse()
            
            # For LSP: Stream response immediately for lower latency
            if port == LSP_PORT:
                self.send_response(response.status)
                for k, v in response.getheaders():
                    if k.lower() not in ['transfer-encoding', 'connection']:
                        self.send_header(k, v)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Credentials', 'true')
                self.end_headers()
                
                # Stream chunks immediately
                while True:
                    chunk = response.read(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            else:
                # For UI/Mobile: Buffer for HTML patching
                response_body = response.read()
                
                if port in (UI_PORT, MOBILE_PORT) and 'text/html' in response.getheader('Content-Type', ''):
                    is_mobile = (port == MOBILE_PORT)
                    response_body = self.patch_html(response_body, mobile=is_mobile)
                
                self.send_response(response.status)
                for k, v in response.getheaders():
                    if k.lower() not in ['content-length', 'transfer-encoding', 'content-encoding', 'connection']:
                        self.send_header(k, v)
                self.send_header('Content-Length', len(response_body))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Credentials', 'true')
                self.end_headers()
                self.wfile.write(response_body)
            
            conn.close()
        except Exception as e:
            print(f"[ERROR] {e}")
            self.send_error(502, str(e))
    
    def patch_html(self, body, mobile=False):
        """Patch Base64-encoded chatParams for remote access"""
        global LSP_TARGET_PORT, CSRF_TOKEN
        
        # Mobile CSS injection for better touch experience
        if mobile:
            mobile_css = b'''<style>
/* Mobile-friendly adjustments */
html, body { touch-action: manipulation; }
* { -webkit-tap-highlight-color: transparent; }
:root {
  --mobile-font-scale: 1.1;
  --mobile-touch-target: 44px;
}
/* Larger touch targets */
button, input, textarea, [role="button"] {
  min-height: var(--mobile-touch-target) !important;
  font-size: calc(1em * var(--mobile-font-scale)) !important;
}
/* Better text sizing */
.message-content, .chat-message, p, span {
  font-size: 16px !important;
  line-height: 1.5 !important;
}
/* Improve scrolling */
[class*="scroll"], [class*="list"] {
  -webkit-overflow-scrolling: touch;
  scroll-behavior: smooth;
}
/* Hide desktop-only elements */
.sidebar, .file-explorer, [class*="panel"]:not([class*="chat"]) {
  display: none !important;
}
/* Fullscreen chat */
[class*="chat"], [class*="message"] {
  width: 100% !important;
  max-width: 100vw !important;
}
/* Viewport meta */
</style>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
'''  
            if b'<head>' in body:
                body = body.replace(b'<head>', b'<head>' + mobile_css)
            elif b'<body' in body:
                body = body.replace(b'<body', mobile_css + b'<body')
        
        # Inject crypto.randomUUID polyfill for non-HTTPS contexts
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
        # Inject polyfill right after <head> or at start of <body>
        if b'<head>' in body:
            body = body.replace(b'<head>', b'<head>' + polyfill)
        elif b'<body' in body:
            body = body.replace(b'<body', polyfill + b'<body')
        
        try:
            match = re.search(b"window\\.chatParams\\s*=\\s*['\"]([A-Za-z0-9+/=]+)['\"]", body)
            if match:
                old_b64 = match.group(1)
                params = json.loads(base64.b64decode(old_b64))
                
                # Extract port from URL
                orig_url = params.get('languageServerUrl', '')
                port_match = re.search(r':(\d+)/', orig_url)
                if port_match:
                    LSP_TARGET_PORT = int(port_match.group(1))
                
                # Extract and store CSRF token
                token = params.get('csrfToken', '')
                if token:
                    CSRF_TOKEN = token
                    print(f"[SYNC] CSRF Token: {token[:16]}...")
                
                # Update URLs to point to our proxy
                new_url = f'http://{EXTERNAL_IP}:{LSP_PORT}/'
                params['languageServerUrl'] = new_url
                params['httpLanguageServerUrl'] = new_url
                
                # Re-encode
                new_b64 = base64.b64encode(json.dumps(params).encode()).decode()
                old_full = b"window.chatParams = '" + old_b64 + b"'"
                new_full = b"window.chatParams = '" + new_b64.encode() + b"'"
                body = body.replace(old_full, new_full)
                print(f"[PATCH] LSP: 127.0.0.1:{LSP_TARGET_PORT} -> {EXTERNAL_IP}:{LSP_PORT}")
        except Exception as e:
            print(f"[!] Patch error: {e}")
        return body

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    timeout = 600  # Socket timeout for long-idle connections
    
    def server_bind(self):
        # Enable TCP keepalive on the server socket
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        # Linux-specific keepalive tuning
        try:
            self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60)   # Start keepalive after 60s idle
            self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 30)  # Send keepalive every 30s
            self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 10)    # 10 retries before giving up
        except AttributeError:
            pass  # Not all platforms support these
        super().server_bind()

def main():
    global LSP_TARGET_PORT
    LSP_TARGET_PORT = find_lsp_port()
    
    print("=" * 60)
    print("Antigravity Remote Access Proxy v2.2")
    print("=" * 60)
    print(f"External IP: {EXTERNAL_IP}")
    print(f"LSP Port: {LSP_TARGET_PORT}")
    print(f"\nUI:     http://0.0.0.0:{UI_PORT} -> http://127.0.0.1:9090")
    print(f"Mobile: http://0.0.0.0:{MOBILE_PORT} -> http://127.0.0.1:9090 (mobile-optimized)")
    print(f"LSP:    http://0.0.0.0:{LSP_PORT} -> http://127.0.0.1:{LSP_TARGET_PORT}")
    print(f"\nAccess:")
    print(f"  Desktop: http://{EXTERNAL_IP}:{UI_PORT}")
    print(f"  Mobile:  http://{EXTERNAL_IP}:{MOBILE_PORT}")
    
    ui_server = ThreadedHTTPServer(('0.0.0.0', UI_PORT), ProxyHandler)
    mobile_server = ThreadedHTTPServer(('0.0.0.0', MOBILE_PORT), ProxyHandler)
    lsp_server = ThreadedHTTPServer(('0.0.0.0', LSP_PORT), ProxyHandler)
    
    t1 = threading.Thread(target=ui_server.serve_forever, daemon=True)
    t2 = threading.Thread(target=mobile_server.serve_forever, daemon=True)
    t3 = threading.Thread(target=lsp_server.serve_forever, daemon=True)
    t1.start()
    t2.start()
    t3.start()
    
    print("\nPress Ctrl+C to stop\n")
    try:
        t1.join()
    except KeyboardInterrupt:
        print("Stopping...")

if __name__ == "__main__":
    main()
