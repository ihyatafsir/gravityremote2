import asyncio
import websockets
import json

async def test():
    uri = "ws://localhost:8888"
    try:
        async with websockets.connect(uri) as websocket:
            print(f"Connected to {uri}")
            
            # Send test message
            msg = {"type": "chat", "content": "Hello"}
            await websocket.send(json.dumps(msg))
            print(f"Sent: {msg}")
            
            # Listen for responses
            try:
                while True:
                    response = await asyncio.wait_for(websocket.recv(), timeout=2.0)
                    print(f"Received: {response}")
                    data = json.loads(response)
                    if data.get("type") == "status" and data.get("is_busy") == False:
                        break
            except asyncio.TimeoutError:
                print("Timeout waiting for response")
                
    except Exception as e:
        print(f"Connection failed: {e}")

if __name__ == "__main__":
    asyncio.run(test())
