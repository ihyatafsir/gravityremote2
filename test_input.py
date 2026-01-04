import asyncio
import websockets
import json

async def test_input():
    uri = "ws://127.0.0.1:8888"
    async with websockets.connect(uri) as ws:
        # Send a test message
        msg = "Hello Agent, this is a test."
        print(f"Sending: {msg}")
        await ws.send(json.dumps({"type": "chat", "content": msg}))
        
        # Give it a moment to write to file
        await asyncio.sleep(1)

if __name__ == "__main__":
    asyncio.run(test_input())
