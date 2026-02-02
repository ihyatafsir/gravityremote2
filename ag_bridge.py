#!/usr/bin/env python3
"""
AG Bridge v2 - Zero Dependency Edition
Implements a raw WebSocket server/client using only standard library.
"""

import socket
import threading
import json
import logging
import hashlib
import base64
import struct
import time
import urllib.request
import urllib.error
from http.server import HTTPServer, SimpleHTTPRequestHandler

# Configuration
CDP_PORT = 9222
BRIDGE_PORT = 8893
WS_PORT = 8894
CHROME_HOST = "127.0.0.1"

logging.basicConfig(level=logging.INFO, format='[AG-Bridge] %(message)s')
logger = logging.getLogger("ag-bridge")

# Global State
mobile_clients = []  # List of socket objects
chrome_ws_url = None
cdp_socket = None

# ==========================================
# 1. Custom WebSocket Implementation
# ==========================================
def create_handshake_response(key):
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    token = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    return (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {token}\r\n\r\n"
    ).encode()

def send_frame(sock, message):
    """Send a text frame"""
    try:
        data = message.encode()
        header = bytearray()
        header.append(0x81) # Fin + Text Opcode
        payload_len = len(data)
        
        if payload_len <= 125:
            header.append(payload_len)
        elif payload_len <= 65535:
            header.append(126)
            header.extend(struct.pack("!H", payload_len))
        else:
            header.append(127)
            header.extend(struct.pack("!Q", payload_len))
            
        sock.sendall(header + data)
    except Exception as e:
        logger.error(f"Send Error: {e}")
        if sock in mobile_clients:
            mobile_clients.remove(sock)

def recv_frame(sock):
    """Read a frame (simple implementation)"""
    try:
        header = sock.recv(2)
        if not header: return None
        
        # Parse Header
        fin = header[0] & 0x80
        opcode = header[0] & 0x0F
        masked = header[1] & 0x80
        payload_len = header[1] & 0x7F
        
        if payload_len == 126:
            payload_len = struct.unpack("!H", sock.recv(2))[0]
        elif payload_len == 127:
            payload_len = struct.unpack("!Q", sock.recv(8))[0]
            
        if masked:
            mask = sock.recv(4)
            
        data = bytearray(sock.recv(payload_len))
        
        if masked:
            for i in range(len(data)):
                data[i] ^= mask[i % 4]
                
        if opcode == 0x8: # Close
            return None
            
        return data.decode('utf-8')
    except Exception:
        return None

# ==========================================
# 2. HTTP Server (UI)
# ==========================================
class MobileHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/': self.path = '/mobile.html'
        return SimpleHTTPRequestHandler.do_GET(self)
    def log_message(self, format, *args): pass

def run_http():
    logger.info(f"UI Server: http://0.0.0.0:{BRIDGE_PORT}/mobile.html")
    HTTPServer(('0.0.0.0', BRIDGE_PORT), MobileHandler).serve_forever()

# ==========================================
# 3. Mobile WebSocket Server
# ==========================================
def handle_mobile_client(client_sock):
    global cdp_socket
    mobile_clients.append(client_sock)
    try:
        # Handshake
        data = client_sock.recv(1024).decode()
        key = None
        for line in data.split('\r\n'):
            if "Sec-WebSocket-Key" in line:
                key = line.split(":")[1].strip()
        client_sock.sendall(create_handshake_response(key))
        
        send_frame(client_sock, json.dumps({"type": "info", "content": "Connected to Zero-Dep Bridge"}))
        
        while True:
            msg = recv_frame(client_sock)
            if not msg: break
            
            data = json.loads(msg)
            if data['type'] == 'input':
                # Relay to CDP
                logger.info(f"Input: {data['content']}")
                inject_input(data['content'])
                
    except Exception as e:
        logger.error(f"Mobile Client Error: {e}")
    finally:
        if client_sock in mobile_clients: mobile_clients.remove(client_sock)
        client_sock.close()

def run_ws_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', WS_PORT))
    server.listen(5)
    logger.info(f"WS Server: ws://0.0.0.0:{WS_PORT}")
    
    while True:
        client, addr = server.accept()
        threading.Thread(target=handle_mobile_client, args=(client,)).start()

# ==========================================
# 4. CDP Client (The "Poke")
# ==========================================
def inject_input(text):
    """Sends input command to Chrome via CDP"""
    global cdp_socket
    if not cdp_socket: return
    
    # Send Input
    js = f"""
    (function() {{
        const ta = document.querySelector('textarea');
        if (ta) {{
            ta.value = {json.dumps(text)};
            ta.dispatchEvent(new Event('input', {{ bubbles: true }}));
            const enter = new KeyboardEvent('keydown', {{
                key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
            }});
            ta.dispatchEvent(enter);
        }}
    }})()
    """
    cmd = json.dumps({
        "id": int(time.time()),
        "method": "Runtime.evaluate",
        "params": {"expression": js}
    })
    send_frame_to_chrome(cdp_socket, cmd)

def send_frame_to_chrome(sock, message):
    # Masking is required for Client -> Server
    data = message.encode()
    header = bytearray()
    header.append(0x81)
    
    payload_len = len(data)
    if payload_len <= 125:
        header.append(payload_len | 0x80)
    elif payload_len <= 65535:
        header.append(126 | 0x80)
        header.extend(struct.pack("!H", payload_len))
    else:
        header.append(127 | 0x80)
        header.extend(struct.pack("!Q", payload_len))
        
    mask = struct.pack("!I", 0x11223344) # Dummy mask
    header.extend(mask)
    
    masked_data = bytearray(len(data))
    for i in range(len(data)):
        masked_data[i] = data[i] ^ mask[i % 4]
        
    sock.sendall(header + masked_data)

def connect_to_chrome():
    """Connects to Chrome's WebSocket Debugger"""
    try:
        url = f"http://{CHROME_HOST}:{CDP_PORT}/json"
        with urllib.request.urlopen(url) as response:
            tabs = json.loads(response.read().decode())
            
        ws_url = None
        for tab in tabs:
            if "localhost:9090" in tab.get('url', '') or "Antigravity" in tab.get('title', ''):
                ws_url = tab.get('webSocketDebuggerUrl')
                break
        
        if not ws_url: return None
        
        # Parse WS URL
        # ws://127.0.0.1:9222/devtools/page/...
        path = ws_url.replace(f"ws://{CHROME_HOST}:{CDP_PORT}", "")
        
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.connect((CHROME_HOST, CDP_PORT))
        
        # Handshake
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {CHROME_HOST}:{CDP_PORT}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        s.sendall(req.encode())
        resp = s.recv(4096)
        if b"101 Switching Protocols" not in resp:
            return None
            
        return s
    except:
        return None

def cdp_loop():
    global cdp_socket, last_doc_text
    logger.info("Starting CDP Loop...")
    last_doc_text = ""
    
    while True:
        if not cdp_socket:
            cdp_socket = connect_to_chrome()
            if cdp_socket:
                logger.info("Connected to Chrome CDP")
                # Enable Runtime
                send_frame_to_chrome(cdp_socket, json.dumps({"id": 1, "method": "Runtime.enable"}))
            else:
                time.sleep(2)
                continue
        
        try:
            # Poll for updates
            js = "document.body.innerText"
            send_frame_to_chrome(cdp_socket, json.dumps({
                "id": 2, 
                "method": "Runtime.evaluate", 
                "params": {"expression": js}
            }))
            
            # Read Response (Simple parser)
            # Note: A real parser handles fragmentation. This is simplified.
            raw = recv_frame(cdp_socket) # Might need loop if fragmented
            if raw:
                try:
                    data = json.loads(raw)
                    if data.get('id') == 2:
                        current_text = data.get('result', {}).get('result', {}).get('value', '')
                        if len(current_text) > len(last_doc_text):
                            diff = current_text[len(last_doc_text):]
                            if diff.strip():
                                for c in mobile_clients:
                                    send_frame(c, json.dumps({"type": "stream", "content": diff}))
                            last_doc_text = current_text
                except:
                    pass
            else:
                # Connection might be closed?
                pass
                
            time.sleep(0.5)
            
        except Exception as e:
            logger.error(f"CDP Error: {e}")
            cdp_socket = None

if __name__ == "__main__":
    t_http = threading.Thread(target=run_http)
    t_ws = threading.Thread(target=run_ws_server)
    t_cdp = threading.Thread(target=cdp_loop)
    
    t_http.daemon = True
    t_ws.daemon = True
    t_cdp.daemon = True
    
    t_http.start()
    t_ws.start()
    t_cdp.start()
    
    while True: time.sleep(1)
