#!/usr/bin/env python3
"""
Remote Access Proxy for Antigravity - Using HTTP library for proper handling
"""
import http.server
import http.client
import socketserver
import threading
import re
import base64
import json
import gzip
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
UI_TARGET = ('127.0.0.1', 9090)
LSP_TARGET_PORT = 37417  # Will be updated dynamically

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
        self.end_headers()
    
    def log_message(self, *args): pass
    
    def proxy_request(self, method):
        global LSP_TARGET_PORT
        port = self.server.server_address[1]
        
        try:
            if port == UI_PORT:
                target_host, target_port = UI_TARGET
            else:
                target_host, target_port = '127.0.0.1', LSP_TARGET_PORT
            
            # Read request body
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length) if content_length > 0 else None
            
            # Forward to target
            headers = {}
            for k, v in self.headers.items():
                if k.lower() not in ['host', 'accept-encoding']:
                    headers[k] = v
            headers['Host'] = f'{target_host}:{target_port}'
            
            conn = http.client.HTTPConnection(target_host, target_port, timeout=120)
            conn.request(method, self.path, body, headers)
            response = conn.getresponse()
            
            # Read response
            response_body = response.read()
            
            # Patch HTML if UI port and HTML content
            if port == UI_PORT and 'text/html' in response.getheader('Content-Type', ''):
                response_body = self.patch_html(response_body)
            
            # Send response
            self.send_response(response.status)
            for k, v in response.getheaders():
                if k.lower() not in ['content-length', 'transfer-encoding', 'content-encoding', 'connection']:
                    self.send_header(k, v)
            self.send_header('Content-Length', len(response_body))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(response_body)
            
            conn.close()
        except Exception as e:
            print(f"[ERROR] {e}")
            self.send_error(502, str(e))
    
    def patch_html(self, body):
        """Patch Base64-encoded chatParams to fix LSP URLs"""
        global LSP_TARGET_PORT
        try:
            match = re.search(b"window\\.chatParams\\s*=\\s*['\"]([A-Za-z0-9+/=]+)['\"]", body)
            if match:
                old_b64 = match.group(1)
                params = json.loads(base64.b64decode(old_b64))
                
                # Extract and update port
                orig_url = params.get('languageServerUrl', '')
                port_match = re.search(r':(\d+)/', orig_url)
                if port_match:
                    LSP_TARGET_PORT = int(port_match.group(1))
                    
                    new_url = f'http://{EXTERNAL_IP}:{LSP_PORT}/'
                    params['languageServerUrl'] = new_url
                    params['httpLanguageServerUrl'] = new_url
                    
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

def main():
    global LSP_TARGET_PORT
    LSP_TARGET_PORT = find_lsp_port()
    
    print("=" * 60)
    print("Antigravity Remote Access Proxy (HTTP Library)")
    print("=" * 60)
    print(f"External IP: {EXTERNAL_IP}")
    print(f"LSP Port: {LSP_TARGET_PORT}")
    print(f"\nUI:  http://0.0.0.0:{UI_PORT} -> http://127.0.0.1:9090")
    print(f"LSP: http://0.0.0.0:{LSP_PORT} -> http://127.0.0.1:{LSP_TARGET_PORT}")
    print(f"\nAccess: http://{EXTERNAL_IP}:{UI_PORT}")
    
    ui_server = ThreadedHTTPServer(('0.0.0.0', UI_PORT), ProxyHandler)
    lsp_server = ThreadedHTTPServer(('0.0.0.0', LSP_PORT), ProxyHandler)
    
    t1 = threading.Thread(target=ui_server.serve_forever, daemon=True)
    t2 = threading.Thread(target=lsp_server.serve_forever, daemon=True)
    t1.start()
    t2.start()
    
    print("\nPress Ctrl+C to stop\n")
    try:
        t1.join()
    except KeyboardInterrupt:
        print("Stopping...")

if __name__ == "__main__":
    main()
