import asyncio
import socket
import threading
import time
import unittest
import subprocess
import sys
import os

# Configuration matching the proxy_server.py defaults
PROXY_HOST = "127.0.0.1"
PROXY_PORT = 8889
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 9090

def run_echo_server(stop_event):
    """A simple echo server handling one connection at a time for testing."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((TARGET_HOST, TARGET_PORT))
    s.listen(1)
    s.settimeout(1.0) # Check stop_event periodically
    
    print(f"[TEST TARGET] Listening on {TARGET_HOST}:{TARGET_PORT}")
    
    while not stop_event.is_set():
        try:
            conn, addr = s.accept()
            print(f"[TEST TARGET] Connected by {addr}")
            with conn:
                while True:
                    data = conn.recv(1024)
                    if not data:
                        break
                    conn.sendall(data) # Echo back
        except socket.timeout:
            continue
        except Exception as e:
            if not stop_event.is_set():
                print(f"[TEST TARGET] Error: {e}")
    s.close()
    print("[TEST TARGET] Stopped")

class TestAsyncProxy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 1. Start Echo Server (Target)
        cls.stop_echo = threading.Event()
        cls.echo_thread = threading.Thread(target=run_echo_server, args=(cls.stop_echo,))
        cls.echo_thread.start()
        time.sleep(1) # Wait for startup

        # 2. Start Proxy Server
        # We run it as a subprocess to ensure it runs fully independently
        env = os.environ.copy()
        env['PYTHONUNBUFFERED'] = '1'
        cls.proxy_proc = subprocess.Popen(
            [sys.executable, "proxy_server.py"],
            cwd="/root/Documents/REMOTEGRAVITY",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env
        )
        time.sleep(2) # Wait for proxy to bind

        # Verify proxy is running
        if cls.proxy_proc.poll() is not None:
            stdout, stderr = cls.proxy_proc.communicate()
            raise RuntimeError(f"Proxy failed to start:\nSTDOUT: {stdout}\nSTDERR: {stderr}")

    @classmethod
    def tearDownClass(cls):
        # Stop Proxy
        cls.proxy_proc.terminate()
        try:
            cls.proxy_proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            cls.proxy_proc.kill()
        
        # Stop Echo Server
        cls.stop_echo.set()
        cls.echo_thread.join()

    def test_proxy_echo(self):
        """Test sending message through proxy and getting it back."""
        try:
            with socket.create_connection((PROXY_HOST, PROXY_PORT), timeout=5) as s:
                msg = b"Hello Async Proxy!"
                s.sendall(msg)
                
                response = s.recv(1024)
                self.assertEqual(response, msg, "Proxy did not echo the correct data")
                print("Test Passed: Echo received successfully via proxy.")
        except Exception as e:
            self.fail(f"Failed to connect or receive from proxy: {e}")

if __name__ == '__main__':
    unittest.main()
