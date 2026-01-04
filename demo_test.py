import asyncio
import websockets
import json
import sys

async def send_command(ws, cmd_text):
    print(f"\n> Sending: {cmd_text}")
    await ws.send(json.dumps({"type": "chat", "content": cmd_text}))
    
    # capturing response for a bit
    full_response = ""
    try:
        while True:
            # Short timeout to gather immediate output for this command
            message = await asyncio.wait_for(ws.recv(), timeout=1.0)
            data = json.loads(message)
            
            if data.get("type") == "stream":
                content = data.get("content")
                sys.stdout.write(content)
                full_response += content
            elif data.get("type") == "chat":
                print(f"[System]: {data.get('content')}")
            elif data.get("type") == "status":
                pass # ignore status updates for cleaner output
    except asyncio.TimeoutError:
        pass # Command likely finished outputting
    return full_response

async def run_demo():
    uri = "ws://127.0.0.1:8888"
    print(f"Connecting to {uri}...")
    
    async with websockets.connect(uri) as ws:
        # 1. Check who we are
        await send_command(ws, "whoami")
        
        # 2. Check where we are
        await send_command(ws, "pwd")
        
        # 3. List files
        await send_command(ws, "ls -F")

        # 4. Change directory (Statefulness check)
        print("\n> Testing 'cd ..' (Statefulness)...")
        await send_command(ws, "cd ..")
        
        # 5. Check where we are now
        await send_command(ws, "pwd")

if __name__ == "__main__":
    try:
        asyncio.run(run_demo())
    except Exception as e:
        print(f"\nTest Failed: {e}")
