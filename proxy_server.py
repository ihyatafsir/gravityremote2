import asyncio
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

TARGET_HOST = "127.0.0.1"
TARGET_PORT = 9090
LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 8889

async def handle_client(reader, writer):
    """
    Handles a single client connection, bridging it to the target server.
    """
    client_addr = writer.get_extra_info('peername')
    logger.info(f"Accepted connection from {client_addr}")

    try:
        # Connect to the target server
        remote_reader, remote_writer = await asyncio.open_connection(TARGET_HOST, TARGET_PORT)
    except Exception as e:
        logger.error(f"Failed to connect to target {TARGET_HOST}:{TARGET_PORT} - {e}")
        writer.close()
        await writer.wait_closed()
        return

    async def pipe(r, w, label):
        try:
            while True:
                data = await r.read(4096)
                if not data:
                    break
                w.write(data)
                await w.drain()
        except ConnectionResetError:
            pass  # Determine if this needs logging
        except Exception as e:
            logger.error(f"Error in pipe {label}: {e}")
        finally:
            try:
                w.close()
                # Optional: await w.wait_closed() usually not needed inside finally if closing blindly
                # but good practice in some contexts.
            except Exception:
                pass

    # Create tasks to pipe data in both directions
    client_to_remote = asyncio.create_task(pipe(reader, remote_writer, "CLIENT->REMOTE"))
    remote_to_client = asyncio.create_task(pipe(remote_reader, writer, "REMOTE->CLIENT"))

    # Wait for both pipes to close
    await asyncio.gather(client_to_remote, remote_to_client)
    logger.info(f"Connection closed for {client_addr}")

async def main():
    server = await asyncio.start_server(handle_client, LISTEN_HOST, LISTEN_PORT)
    addr = server.sockets[0].getsockname()
    logger.info(f"Async Proxy listening on {addr} -> {TARGET_HOST}:{TARGET_PORT}")

    async with server:
        await server.serve_forever()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Proxy server stopped by user")
