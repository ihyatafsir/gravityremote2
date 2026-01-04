import asyncio
import websockets
import json
import sys

async def test_shell():
    uri = "ws://127.0.0.1:8888"
    try:
        async with websockets.connect(uri) as websocket:
            # Send 'ls' command
            cmd = {"type": "chat", "content": "ls"}
            print(f"Sending: {cmd}")
            await websocket.send(json.dumps(cmd))
            
            # Wait for response
            full_response = ""
            try:
                while True:
                    message = await asyncio.wait_for(websocket.recv(), timeout=2.0)
                    data = json.loads(message)
                    
                    if data.get("type") == "stream":
                        content = data.get("content")
                        sys.stdout.write(content)
                        full_response += content
                    elif data.get("type") == "chat":
                        # Could be error or status
                        print(f"\n[Chat]: {data.get('content')}")
            except asyncio.TimeoutError:
                print("\nTimeout waiting for more data (expected if stream ended)")
            
            # Assertions
            if "proxy_server.py" in full_response:
                print("\nSUCCESS: Found 'proxy_server.py' in output -> Real Shell confirmed!")
            else:
                print(f"\nFAILURE: Did not find expected files. Output was:\n{full_response}")
                sys.exit(1)

    except Exception as e:
        print(f"Connection failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(test_shell())
