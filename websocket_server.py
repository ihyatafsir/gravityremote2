import asyncio
import websockets
import json
import os

connected_clients = set()
WORKSPACE = "/root/Documents/REMOTEGRAVITY"
LOG_FILE = os.path.join(WORKSPACE, "agent_stream.log")
current_cwd = WORKSPACE

async def tail_log_file():
    """Continuously checks the log file for new content and broadcasts it."""
    print(f"Monitoring {LOG_FILE}")
    last_pos = 0
    
    if not os.path.exists(LOG_FILE):
        with open(LOG_FILE, 'w') as f:
            f.write("[System] Agent stream initialized.\n")

    while True:
        try:
            if os.path.exists(LOG_FILE):
                with open(LOG_FILE, 'r') as f:
                    f.seek(last_pos)
                    new_data = f.read()
                    last_pos = f.tell()
                    
                    if new_data and connected_clients:
                        message = json.dumps({"type": "stream", "sender": "Agent", "content": new_data})
                        await asyncio.gather(*[client.send(message) for client in connected_clients], return_exceptions=True)
            
            await asyncio.sleep(0.2)
        except Exception as e:
            print(f"Error tailing file: {e}")
            await asyncio.sleep(1)

async def execute_command(websocket, command):
    """Execute a shell command and stream output back to the client."""
    global current_cwd
    
    # Handle 'cd' specially
    if command.strip().startswith("cd "):
        target = command.strip()[3:].strip()
        if target == "~":
            target = os.path.expanduser("~")
        new_path = os.path.abspath(os.path.join(current_cwd, target))
        if os.path.isdir(new_path):
            current_cwd = new_path
            await websocket.send(json.dumps({
                "type": "chat",
                "sender": "Agent",
                "content": f"Changed directory to: {current_cwd}"
            }))
        else:
            await websocket.send(json.dumps({
                "type": "chat",
                "sender": "Agent",
                "content": f"Directory not found: {target}"
            }))
        return
    
    # Handle 'pwd'
    if command.strip() == "pwd":
        await websocket.send(json.dumps({
            "type": "chat",
            "sender": "Agent",
            "content": current_cwd
        }))
        return

    try:
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=current_cwd
        )
        
        # Read output
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
        
        output = ""
        if stdout:
            output += stdout.decode('utf-8', errors='replace')
        if stderr:
            output += stderr.decode('utf-8', errors='replace')
        
        if not output.strip():
            output = "(Command completed with no output)"
        
        await websocket.send(json.dumps({
            "type": "chat",
            "sender": "Agent",
            "content": output
        }))
        
    except asyncio.TimeoutError:
        await websocket.send(json.dumps({
            "type": "chat",
            "sender": "Agent",
            "content": "Command timed out after 30 seconds."
        }))
    except Exception as e:
        await websocket.send(json.dumps({
            "type": "chat",
            "sender": "Agent",
            "content": f"Error: {str(e)}"
        }))

async def handler(websocket):
    connected_clients.add(websocket)
    print(f"Client connected. Total: {len(connected_clients)}")
    
    # Send welcome message
    await websocket.send(json.dumps({
        "type": "chat",
        "sender": "Agent",
        "content": "Connected to Antigravity Agent. Type commands to execute, or chat naturally."
    }))
    
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                msg_type = data.get("type")
                
                if msg_type == "chat":
                    content = data.get("content", "").strip()
                    print(f"User: {content}")
                    
                    # Log to file
                    with open(LOG_FILE, "a") as f:
                        f.write(f"\n[User]: {content}\n")
                    
                    # Execute as command
                    await execute_command(websocket, content)
                
                elif msg_type == "list_files":
                    path = data.get("path", WORKSPACE)
                    files = []
                    try:
                        for item in sorted(os.listdir(path)):
                            item_path = os.path.join(path, item)
                            files.append({
                                "name": item,
                                "path": item_path,
                                "isDir": os.path.isdir(item_path)
                            })
                        await websocket.send(json.dumps({"type": "file_list", "files": files}))
                    except Exception as e:
                        await websocket.send(json.dumps({"type": "error", "message": str(e)}))
                
                elif msg_type == "read_file":
                    file_path = data.get("path", "")
                    try:
                        with open(file_path, 'r', errors='replace') as f:
                            content = f.read()
                        filename = os.path.basename(file_path)
                        await websocket.send(json.dumps({
                            "type": "file_content",
                            "filename": filename,
                            "content": content
                        }))
                    except Exception as e:
                        await websocket.send(json.dumps({"type": "error", "message": str(e)}))
                
            except json.JSONDecodeError as e:
                print(f"JSON error: {e}")
            except Exception as e:
                print(f"Error handling message: {e}")
                
    finally:
        connected_clients.remove(websocket)
        print(f"Client disconnected. Total: {len(connected_clients)}")

async def main():
    print("=" * 50)
    print("Antigravity IDE - WebSocket Server")
    print("=" * 50)
    print(f"Listening on ws://0.0.0.0:8888")
    print(f"Workspace: {WORKSPACE}")
    print(f"Log File: {LOG_FILE}")
    print("Commands are executed and output returned.")
    print("=" * 50)
    
    asyncio.create_task(tail_log_file())
    
    async with websockets.serve(handler, "0.0.0.0", 8888, origins=None):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
