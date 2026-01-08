#!/usr/bin/env python3
"""
Port Watcher for GravityRemote Proxy v2.2

Monitors the Antigravity language_server ports and:
1. Waits for ports to stabilize after IDE restart
2. Polls Agent Tab until chatParams has a valid port
3. Restarts the gravityremote proxy service
4. [NEW] Probes for stalled/zombie IDEs via health checks

v2.2: Added health probing to detect stalled IDE (zombie process holding port
but not responding). Triggers restart when multiple consecutive health failures
are detected, even if ports haven't changed.
"""
import subprocess
import time
import os
import signal
import sys
import re
import json
import base64
import socket

CHECK_INTERVAL = 5       # seconds between checks
STABILIZE_CHECKS = 3     # number of consecutive stable checks required
CHATPARAMS_POLL_MAX = 60 # max seconds to wait for valid chatParams
HEALTH_FAIL_THRESHOLD = 3  # consecutive health failures before recovery
HEALTH_PROBE_TIMEOUT = 5   # seconds to wait for health response

AGENT_TAB_PORT = 9090    # Antigravity Agent Tab port (may drift to 9091)

def get_lsp_ports():
    """Get current language_server ports from ss"""
    try:
        result = subprocess.run(
            ['ss', '-tunlp'],
            capture_output=True,
            text=True,
            timeout=5
        )
        ports = set()
        for line in result.stdout.split('\n'):
            if 'language_server' in line:
                match = re.search(r'127\.0\.0\.1:(\d+)', line)
                if match:
                    ports.add(int(match.group(1)))
        return ports
    except Exception as e:
        print(f"[WARN] Failed to get ports: {e}")
        return set()

def get_chatparams_port():
    """Extract the LSP port from chatParams on port 9090"""
    try:
        result = subprocess.run(
            ['curl', '-s', '-H', 'Cache-Control: no-cache', f'http://127.0.0.1:{AGENT_TAB_PORT}'],
            capture_output=True,
            text=True,
            timeout=10
        )
        match = re.search(r"window\.chatParams\s*=\s*'([A-Za-z0-9+/=]+)'", result.stdout)
        if match:
            params = json.loads(base64.b64decode(match.group(1)))
            url = params.get('languageServerUrl', '')
            port_match = re.search(r':(\d+)/', url)
            if port_match:
                return int(port_match.group(1))
    except Exception as e:
        print(f"[WARN] Failed to get chatParams port: {e}")
    return None

def get_active_ide_port():
    """Find which port (9090 or 9091) the IDE is actually on"""
    for port in [9090, 9091]:
        try:
            result = subprocess.run(
                ['ss', '-tunlp'],
                capture_output=True,
                text=True,
                timeout=5
            )
            if f'127.0.0.1:{port}' in result.stdout and 'antigravity' in result.stdout:
                return port
        except Exception:
            pass
    return None

def health_probe_ide():
    """
    Test if the IDE backend is actually responding (not a zombie).
    Returns (is_healthy, detected_port, error_message)
    """
    # Try both possible ports
    for port in [9090, 9091]:
        try:
            # Use curl with a short timeout
            result = subprocess.run(
                ['curl', '-s', '-m', str(HEALTH_PROBE_TIMEOUT), 
                 '-H', 'Cache-Control: no-cache',
                 f'http://127.0.0.1:{port}'],
                capture_output=True,
                text=True,
                timeout=HEALTH_PROBE_TIMEOUT + 2
            )
            
            # Check if we got valid HTML with chatParams
            if result.stdout and 'chatParams' in result.stdout:
                return True, port, None
            
            # Got response but no chatParams - could be stale
            if result.stdout:
                return False, port, "Response received but no chatParams"
                
        except subprocess.TimeoutExpired:
            continue  # Try next port
        except Exception as e:
            continue  # Try next port
    
    return False, None, "All IDE ports unresponsive"

def restart_proxy():
    """Restart the gravityremote systemd service"""
    print("[ACTION] Restarting gravityremote proxy...")
    try:
        result = subprocess.run(
            ['systemctl', '--user', 'restart', 'gravityremote'],
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode == 0:
            print("[OK] Proxy restarted successfully")
            return True
        else:
            print(f"[ERROR] Failed to restart: {result.stderr}")
            return False
    except Exception as e:
        print(f"[ERROR] Restart failed: {e}")
        return False

def wait_for_stable_ports(initial_ports):
    """Wait for ports to stabilize before taking action"""
    print(f"[STABILIZE] Waiting for ports to stabilize...")
    stable_count = 0
    last_ports = initial_ports
    
    for i in range(30):  # Max 30 checks
        time.sleep(CHECK_INTERVAL)
        current_ports = get_lsp_ports()
        
        if current_ports == last_ports and len(current_ports) >= 2:
            stable_count += 1
            print(f"[STABILIZE] Stable {stable_count}/{STABILIZE_CHECKS} - {len(current_ports)} ports")
            if stable_count >= STABILIZE_CHECKS:
                print(f"[STABILIZE] Ports stable!")
                return current_ports
        else:
            stable_count = 0
            if current_ports != last_ports:
                print(f"[STABILIZE] Ports changing: {len(current_ports)} ports")
            last_ports = current_ports
    
    print("[WARN] Ports did not stabilize within timeout")
    return last_ports

def wait_for_valid_chatparams(valid_ports):
    """Poll Agent Tab until chatParams contains a port in valid_ports"""
    print(f"[POLL] Waiting for Agent Tab to update chatParams...")
    start_time = time.time()
    
    while time.time() - start_time < CHATPARAMS_POLL_MAX:
        chatparams_port = get_chatparams_port()
        
        if chatparams_port is not None:
            if chatparams_port in valid_ports:
                print(f"[POLL] chatParams port {chatparams_port} is valid!")
                return True, chatparams_port
            else:
                elapsed = int(time.time() - start_time)
                print(f"[POLL] chatParams port {chatparams_port} still stale ({elapsed}s)...")
        
        time.sleep(3)
    
    print(f"[TIMEOUT] chatParams did not update within {CHATPARAMS_POLL_MAX}s")
    chatparams_port = get_chatparams_port()
    return False, chatparams_port

def main():
    print("=" * 60)
    print("GravityRemote Port Watcher v2.2 (Health Probing)")
    print("=" * 60)
    print(f"Check interval: {CHECK_INTERVAL}s | Stabilize: {STABILIZE_CHECKS} checks")
    print(f"chatParams poll timeout: {CHATPARAMS_POLL_MAX}s")
    print(f"Health fail threshold: {HEALTH_FAIL_THRESHOLD} consecutive failures")
    print("Watching for language_server port changes AND stalled IDEs...")
    print()
    
    last_ports = get_lsp_ports()
    print(f"[INIT] Current ports: {sorted(last_ports) if last_ports else 'none'}")
    
    # Initial health probe
    is_healthy, active_port, error = health_probe_ide()
    if is_healthy:
        print(f"[INIT] IDE health: OK (port {active_port})")
    else:
        print(f"[INIT] IDE health: UNHEALTHY - {error}")
    
    # Initial validation
    chatparams_port = get_chatparams_port()
    if chatparams_port:
        if chatparams_port in last_ports:
            print(f"[INIT] chatParams port {chatparams_port} is valid")
        else:
            print(f"[INIT] chatParams port {chatparams_port} is STALE!")
            print(f"[INIT] Please close/reopen Agent Tab in Antigravity IDE")
    
    # Track consecutive health failures
    health_fail_count = 0
    last_healthy_time = time.time()
    
    def signal_handler(sig, frame):
        print("\n[STOP] Port watcher stopped")
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    while True:
        time.sleep(CHECK_INTERVAL)
        
        current_ports = get_lsp_ports()
        
        # === NEW: Health probe for stalled IDE detection ===
        is_healthy, active_port, error = health_probe_ide()
        
        if is_healthy:
            if health_fail_count > 0:
                print(f"[HEALTH] Recovered after {health_fail_count} failures")
            health_fail_count = 0
            last_healthy_time = time.time()
        else:
            health_fail_count += 1
            elapsed = int(time.time() - last_healthy_time)
            print(f"[HEALTH] FAIL {health_fail_count}/{HEALTH_FAIL_THRESHOLD}: {error} (unhealthy for {elapsed}s)")
            
            if health_fail_count >= HEALTH_FAIL_THRESHOLD:
                print(f"\n[STALLED] IDE appears stalled/zombie! Initiating recovery...")
                
                # Check if IDE port changed (9090 vs 9091)
                new_ide_port = get_active_ide_port()
                if new_ide_port:
                    print(f"[STALLED] Found IDE on port {new_ide_port}")
                else:
                    print(f"[STALLED] No IDE port detected - waiting for restart")
                
                # Wait for stabilization
                stable_ports = wait_for_stable_ports(current_ports)
                
                # Wait for chatParams
                valid, cp_port = wait_for_valid_chatparams(stable_ports)
                
                if valid:
                    print(f"[SUCCESS] chatParams updated with valid port {cp_port}")
                else:
                    print(f"[WARN] chatParams still stale (port {cp_port})")
                
                # Restart proxy
                restart_proxy()
                
                # Reset tracking
                health_fail_count = 0
                last_healthy_time = time.time()
                last_ports = stable_ports
                continue
        
        # === Existing port change detection ===
        if current_ports != last_ports:
            old_count = len(last_ports)
            new_count = len(current_ports)
            
            # If ports disappeared, wait for them to come back
            if new_count == 0 and old_count > 0:
                print(f"\n[CHANGE] All ports disappeared!")
                last_ports = current_ports
                continue
            
            # If new ports appeared or significant change
            if (old_count == 0 and new_count > 0) or (new_count > 0 and not current_ports.issubset(last_ports)):
                print(f"\n[CHANGE] Port change detected!")
                print(f"  Old: {len(last_ports)} ports | New: {len(current_ports)} ports")
                
                # Wait for stabilization
                stable_ports = wait_for_stable_ports(current_ports)
                
                # Wait for chatParams to update (Agent Tab refresh)
                valid, cp_port = wait_for_valid_chatparams(stable_ports)
                
                if valid:
                    print(f"[SUCCESS] chatParams updated with valid port {cp_port}")
                else:
                    print(f"[WARN] chatParams still stale (port {cp_port})")
                    print(f"[WARN] You may need to close/reopen Agent Tab manually")
                
                # Restart proxy regardless
                restart_proxy()
                
                # Reset health tracking after successful recovery
                health_fail_count = 0
                last_healthy_time = time.time()
                
                last_ports = stable_ports
            else:
                last_ports = current_ports

if __name__ == "__main__":
    main()

