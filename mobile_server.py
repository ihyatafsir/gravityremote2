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
from urllib.parse import urlparse


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
            # Flatten or use as is depending on structure. 
            # Assuming lisanclean.json is a dict where values are definitions, 
            # or a list of sentences. The KI says "values".
            # Let's inspect it to be safe, but for now assuming it needs parsing.
            # Ideally we grab somewhat long strings.
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
    
    def do_GET(self):
        parsed = urlparse(self.path)
        
        # Serve mobile.html as default
        if parsed.path == '/' or parsed.path == '/mobile':
            self.path = '/mobile.html'
        elif parsed.path == '/api/stats':
            return self.handle_stats()
        elif parsed.path == '/api/lisan':
            return self.handle_lisan()
        
        return super().do_GET()
    
    def handle_lisan(self):
        """Return random Lisan al-Arab sentences"""
        try:
            # Select 10 random entries
            count = 10
            if not LISAN_CORPUS:
                sample = [
                    "البَرْقُ سَرِيعُ اللَّمْعِ",
                    "الأَدَبُ الَّذِي يَتَأَدَّبُ بِهِ الأَدِيبُ"
                ]
            else:
                sample = random.sample(LISAN_CORPUS, min(count, len(LISAN_CORPUS)))
                
                # Sanitize: Ensure they are strings
                sample = [str(s) for s in sample]

            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            # Prevent mobile caching of the random sample
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.end_headers()
            
            self.wfile.write(json.dumps(sample, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def handle_stats(self):
        """Return CPU and RAM usage for retro display"""
        try:
            cpu = int(psutil.cpu_percent(interval=0.1))
            ram = int(psutil.virtual_memory().used / 1024 / 1024)
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {'cpu': cpu, 'ram': ram}
            self.wfile.write(json.dumps(response).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
    
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
        elif parsed.path == '/api/set-model':
            return self.handle_set_model()
        
        self.send_error(404, 'Not Found')
    
    def handle_kill_ide(self):
        """Kill all Antigravity IDE processes"""
        print("[Mobile Server] Kill IDE requested")
        
        try:
            # Kill all antigravity processes
            result = subprocess.run(
                ['pkill', '-9', '-f', 'antigravity'],
                capture_output=True,
                text=True
            )
            
            print(f"[Mobile Server] pkill antigravity result: {result.returncode}")
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {
                'success': True,
                'message': 'All Antigravity processes killed'
            }
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            print(f"[Mobile Server] Kill IDE error: {e}")
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {'success': False, 'message': str(e)}
            self.wfile.write(json.dumps(response).encode())
    
    def handle_start_ide(self):
        """Start the Antigravity IDE if not running"""
        print("[Mobile Server] Start IDE requested")
        
        try:
            # Check if IDE is already running
            check = subprocess.run(['pgrep', '-f', 'antigravity'], capture_output=True)
            if check.returncode == 0:
                # Already running
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                response = {'success': True, 'message': 'IDE already running'}
                self.wfile.write(json.dumps(response).encode())
                return
            
            # Start the IDE with proper display environment
            env = os.environ.copy()
            env['DISPLAY'] = ':0'
            env['XDG_RUNTIME_DIR'] = f'/run/user/{os.getuid()}'
            
            subprocess.Popen(
                ['/usr/bin/antigravity', '--no-sandbox'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                env=env
            )
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {'success': True, 'message': 'IDE starting'}
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            print(f"[Mobile Server] Start IDE error: {e}")
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {'success': False, 'message': str(e)}
            self.wfile.write(json.dumps(response).encode())
    
    def handle_stop(self):
        """Stop the current agent operation by sending Escape key"""
        print("[Mobile Server] Stop requested (Escape)")
        
        try:
            # Use xdotool to send Escape key to stop current operation
            result = subprocess.run(
                ['xdotool', 'key', 'Escape'],
                capture_output=True,
                text=True
            )
            
            print(f"[Mobile Server] xdotool Escape result: {result.returncode}")
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {
                'success': True,
                'message': 'Stop signal sent (Escape)'
            }
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            print(f"[Mobile Server] Stop error: {e}")
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {
                'success': False,
                'message': str(e)
            }
            self.wfile.write(json.dumps(response).encode())
    
    def handle_agent_mode(self):
        """Send Ctrl+E to open Agent Mode in IDE"""
        print("[Mobile Server] Agent Mode requested (Ctrl+E)")
        
        try:
            # Use xdotool to send Ctrl+E to the active window
            result = subprocess.run(
                ['xdotool', 'key', 'ctrl+e'],
                capture_output=True,
                text=True
            )
            
            print(f"[Mobile Server] xdotool result: {result.returncode}")
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {
                'success': True,
                'message': 'Agent Mode signal sent (Ctrl+E)'
            }
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            print(f"[Mobile Server] Agent mode error: {e}")
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {
                'success': False,
                'message': str(e)
            }
            self.wfile.write(json.dumps(response).encode())
    
    def handle_set_model(self):
        """Set LLM model via xdotool - uses mouse clicks to select model"""
        print("[Mobile Server] Set Model requested")
        
        try:
            import time
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            data = json.loads(body) if body else {}
            model_index = data.get('index', 0)
            model_name = data.get('name', 'Unknown')
            
            env = os.environ.copy()
            env['DISPLAY'] = ':0'
            
            # Get Antigravity window ID and geometry
            result = subprocess.run(
                ['xdotool', 'search', '--name', 'Antigravity'],
                capture_output=True, text=True, env=env, timeout=3
            )
            window_ids = result.stdout.strip().split('\n')
            if not window_ids or not window_ids[0]:
                raise Exception("Antigravity window not found")
            
            window_id = window_ids[0]
            
            # Focus the window
            subprocess.run(['xdotool', 'windowactivate', '--sync', window_id], env=env, timeout=3)
            time.sleep(0.3)
            
            # Get window geometry to calculate click positions
            result = subprocess.run(
                ['xdotool', 'getwindowgeometry', '--shell', window_id],
                capture_output=True, text=True, env=env, timeout=3
            )
            
            # Parse geometry (X, Y, WIDTH, HEIGHT)
            geom = {}
            for line in result.stdout.strip().split('\n'):
                if '=' in line:
                    k, v = line.split('=')
                    geom[k] = int(v)
            
            # Model dropdown is approximately at:
            # X: 150px from left of window
            # Y: near bottom of window (window_height - 60)
            click_x = geom.get('X', 0) + 150
            click_y = geom.get('Y', 0) + geom.get('HEIGHT', 900) - 60
            
            print(f"[Mobile Server] Clicking model dropdown at ({click_x}, {click_y})")
            
            # Click to open model dropdown
            subprocess.run(['xdotool', 'mousemove', str(click_x), str(click_y)], env=env, timeout=2)
            subprocess.run(['xdotool', 'click', '1'], env=env, timeout=2)
            time.sleep(0.5)
            
            # Now click on the model option (each option is ~35px tall, menu opens upward)
            # Index 0 is at the top of the popup
            option_y = click_y - 50 - (model_index * 35)
            
            print(f"[Mobile Server] Clicking model option at ({click_x}, {option_y})")
            
            subprocess.run(['xdotool', 'mousemove', str(click_x), str(option_y)], env=env, timeout=2)
            subprocess.run(['xdotool', 'click', '1'], env=env, timeout=2)
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {'success': True, 'message': f'Model {model_name} selected'}
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            print(f"[Mobile Server] Set model error: {e}")
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            response = {'success': False, 'message': str(e)}
            self.wfile.write(json.dumps(response).encode())
    
    def handle_restart_ide(self):
        """Restart the Antigravity IDE process"""
        print("[Mobile Server] Restart IDE requested")
        
        try:
            # Find and kill language_server processes
            result = subprocess.run(
                ['pkill', '-f', 'language_server'],
                capture_output=True,
                text=True
            )
            
            # Log the result
            print(f"[Mobile Server] pkill result: {result.returncode}")
            
            # Send success response
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {
                'success': True,
                'message': 'IDE restart signal sent',
                'note': 'The IDE should restart automatically'
            }
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            print(f"[Mobile Server] Restart error: {e}")
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            response = {
                'success': False,
                'message': str(e)
            }
            self.wfile.write(json.dumps(response).encode())
    
    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def log_message(self, format, *args):
        print(f"[Mobile:{PORT}] {args[0]}")


def main():
    print(f"""
╔════════════════════════════════════════╗
║   GravityRemote Mobile Server          ║
║   Port: {PORT}                            ║
║   Theme: Dark                          ║
║   Features: IDE Restart, Touch-friendly║
╚════════════════════════════════════════╝
    """)
    
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), MobileHandler) as httpd:
        print(f"[Mobile Server] Running on http://0.0.0.0:{PORT}")
        print(f"[Mobile Server] Mobile UI: http://localhost:{PORT}/mobile")
        print(f"[Mobile Server] Restart API: POST /api/restart-ide")
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[Mobile Server] Shutting down...")


if __name__ == '__main__':
    main()
