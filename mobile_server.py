#!/usr/bin/env python3
"""
GravityRemote Mobile Server - Port 8893
Dark mobile-friendly version with IDE restart capability
"""

import http.server
import socketserver
import subprocess
import json
import os
import psutil
from urllib.parse import urlparse, parse_qs
import urllib.request
import re
import random

PORT = 8893
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# Load Lisan al-Arab Corpus
LISAN_CORPUS = []
try:
    lisan_path = os.path.join(DIRECTORY, 'lisanclean.json')
    if os.path.exists(lisan_path):
        with open(lisan_path, 'r', encoding='utf-8') as f:
            raw_data = json.load(f)
            if isinstance(raw_data, dict):
                LISAN_CORPUS = list(raw_data.values())
            elif isinstance(raw_data, list):
                LISAN_CORPUS = raw_data
            print(f"[Mobile Server] Loaded {len(LISAN_CORPUS)} Lisan entries")
    else:
        print("[Mobile Server] Warning: lisanclean.json not found")
except Exception as e:
    print(f"[Mobile Server] Failed to load Lisan corpus: {e}")

class MobileHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)
    
    def log_message(self, format, *args):
        # Improved logging
        print(f"[Mobile:8893] {args[0]} - {args[1]}")

    def do_GET(self):
        parsed = urlparse(self.path)
        
        if parsed.path == '/' or parsed.path == '/mobile':
            self.path = '/mobile.html'
        elif parsed.path == '/health':
            return self.handle_jisr_proxy('GET')
        elif parsed.path == '/api/stats':
            return self.handle_stats()
        elif parsed.path == '/api/lisan':
            return self.handle_lisan()
        elif parsed.path == '/api/csrf':
            return self.handle_csrf()
        elif parsed.path == '/api/lsp':
            return self.handle_lsp()
        elif parsed.path.startswith('/api/lsp-proxy'):
            return self.handle_lsp_proxy('GET')
        elif parsed.path == '/irsaal' or parsed.path == '/send':
            return self.handle_jisr_proxy('POST')
        elif parsed.path == '/sse' or parsed.path == '/wasl':
            return self.handle_jisr_proxy('GET')
        
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        
        if parsed.path == '/api/restart-ide':
            return self.handle_restart_ide()
        elif parsed.path == '/api/start-ide':
            return self.handle_start_ide()
        elif parsed.path == '/api/kill-ide':
            return self.handle_kill_ide()
        elif parsed.path == '/api/agent-mode':
            return self.handle_agent_mode()
        elif parsed.path == '/api/stop':
            return self.handle_stop()
        elif parsed.path == '/api/new-chat':
            return self.handle_new_chat()
        elif parsed.path == '/api/set-model':
            return self.handle_set_model()
        elif parsed.path.startswith('/api/lsp-proxy'):
            return self.handle_lsp_proxy('POST')
        elif parsed.path == '/irsaal' or parsed.path == '/send':
            return self.handle_jisr_proxy('POST')
        
        self.send_error(404, 'Not Found')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()

    def handle_csrf(self):
        try:
            csrf_token = None
            lsp_port = 44511
            
            ps_result = subprocess.run(['ps', 'auxww'], capture_output=True, text=True)
            for line in ps_result.stdout.split('\n'):
                if 'language_server' in line and 'csrf_token' in line:
                    port_match = re.search(r'extension_server_port\s+(\d+)', line)
                    token_match = re.search(r'csrf_token\s+([a-f0-9-]+)', line)
                    if port_match: lsp_port = int(port_match.group(1))
                    if token_match: csrf_token = token_match.group(1)
                    break
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {
                'csrf_token': csrf_token or '',
                'lsp_port': lsp_port,
                'language_server_url': f'http://127.0.0.1:{lsp_port}'
            }
            self.wfile.write(json.dumps(response).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def handle_lsp(self):
        return self.handle_csrf()

    def handle_lsp_proxy(self, method='GET'):
        """Unified gRPC proxy through Jisr point"""
        try:
            # Proxy through Jisr (8892) for capture and broadcast
            target_url = f'http://127.0.0.1:8892{self.path}'
            print(f'[LSP Proxy] Forwarding to Jisr: {method} {target_url}')
            
            body = None
            if method == 'POST':
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length > 0:
                    body = self.rfile.read(content_length)
            
            req = urllib.request.Request(target_url, data=body, method=method)
            for header, value in self.headers.items():
                if header.lower() not in ['host', 'connection']:
                    req.add_header(header, value)
            
            try:
                with urllib.request.urlopen(req, timeout=3600) as response:
                    self.send_response(response.status)
                    for header, value in response.getheaders():
                        if header.lower() not in ['content-length', 'transfer-encoding', 'content-encoding', 'connection']:
                            self.send_header(header, value)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    
                    while True:
                        chunk = response.read(4096)
                        if not chunk: break
                        self.wfile.write(chunk)
                        self.wfile.flush()
            except Exception as e:
                print(f'[LSP Proxy] Error: {e}')
                try: self.send_error(502, str(e))
                except: pass
        except Exception as e:
            self.send_error(500, str(e))

    def handle_jisr_proxy(self, method='GET'):
        try:
            target_url = f'http://127.0.0.1:8892{self.path}'
            body = None
            if method == 'POST':
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length > 0:
                    body = self.rfile.read(content_length)
            
            req = urllib.request.Request(target_url, data=body, method=method)
            for header, value in self.headers.items():
                if header.lower() not in ['host', 'connection']:
                    req.add_header(header, value)
            
            try:
                with urllib.request.urlopen(req, timeout=3600) as response:
                    self.send_response(response.status)
                    for header, value in response.getheaders():
                        if header.lower() not in ['content-length', 'transfer-encoding', 'content-encoding', 'connection']:
                            self.send_header(header, value)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    
                    while True:
                        line = response.readline()
                        if not line: break
                        self.wfile.write(line)
                        self.wfile.flush()
            except Exception as e:
                print(f"[Jisr Proxy] Error: {e}")
                try: self.send_error(502, str(e))
                except: pass
        except Exception as e:
            self.send_error(500, str(e))

    def handle_stats(self):
        try:
            cpu = int(psutil.cpu_percent(interval=0.1))
            ram = int(psutil.virtual_memory().used / 1024 / 1024)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'cpu': cpu, 'ram': ram}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def handle_lisan(self):
        try:
            count = 10
            if not LISAN_CORPUS:
                sample = ["البَرْقُ سَرِيعُ اللَّمْعِ"]
            else:
                sample = random.sample(LISAN_CORPUS, min(count, len(LISAN_CORPUS)))
                sample = [str(s) for s in sample]
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(sample, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            self.send_error(500, str(e))

    def handle_restart_ide(self):
        try:
            subprocess.run(['pkill', '-f', 'language_server'], capture_output=True)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'success': True, 'message': 'IDE restart signal sent'}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def handle_kill_ide(self):
        try:
            subprocess.run(['pkill', '-9', '-f', 'antigravity'], capture_output=True)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'success': True, 'message': 'All Antigravity processes killed'}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def handle_start_ide(self):
        try:
            env = os.environ.copy()
            env['DISPLAY'] = ':0'
            subprocess.Popen(['/usr/bin/antigravity', '--no-sandbox'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, env=env)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'success': True, 'message': 'IDE starting'}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def _send_keys(self, keystroke):
        """Helper to send keys to Antigravity window"""
        try:
            # First focus the Antigravity window, then send keys
            # Using --sync to ensure timing is correct
            cmd = f"xdotool search --onlyvisible --class antigravity windowactivate --sync key --clearmodifiers {keystroke}"
            subprocess.run(cmd, shell=True, timeout=2)
            return True
        except Exception as e:
            print(f"[Mobile Server] Key send error: {e}")
            return False

    def handle_stop(self):
        try:
            success = self._send_keys('Escape')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'success': success, 'message': 'Stop signal sent'}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def handle_agent_mode(self):
        try:
            success = self._send_keys('ctrl+e')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'success': success, 'message': 'Agent Mode signal sent'}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def handle_new_chat(self):
        try:
            success = self._send_keys('ctrl+l')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'success': success, 'message': 'New Chat signal sent'}).encode())
        except Exception as e:
            self.send_error(500, str(e))

    def handle_set_model(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            data = json.loads(body) if body else {}
            model_index = data.get('index', 0)
            
            # The correct shortcut for model selector is often Ctrl+L (New Chat) then Tab? 
            # Or is there a specific shortcut?
            # Assuming Ctrl+Shift+M for now as per previous code, but focusing window first.
            success = self._send_keys('ctrl+shift+m')
            
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'success': success}).encode())
        except Exception as e:
            self.send_error(500, str(e))

class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True

def main():
    socketserver.TCPServer.allow_reuse_address = True
    with ThreadingTCPServer(("", PORT), MobileHandler) as httpd:
        print(f"[Mobile Server] Running on http://0.0.0.0:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down...")

if __name__ == '__main__':
    main()
