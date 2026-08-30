import asyncio
import json
import random
import os
from aiohttp import web

# Maxlow Designs - Player Cam PIN Signalling Server
# Local-network test version

clients = {}
pins = {}


async def send_json(ws, data):
    if ws is not None and not ws.closed:
        await ws.send_str(json.dumps(data))


def make_pin():
    while True:
        pin = f"{random.randint(0, 999999):06d}"
        if pin not in pins:
            return pin


async def websocket_handler(request):
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    client_id = None

    print("Browser connected")

    try:
        async for msg in ws:

            if msg.type != web.WSMsgType.TEXT:
                continue

            try:
                data = json.loads(msg.data)
            except Exception:
                continue

            message_type = data.get("type")

            # ---------------------------------
            # NORMAL CLIENT REGISTRATION
            # ---------------------------------

            if message_type == "register":
                client_id = data.get("id")

                if client_id:
                    clients[client_id] = ws

                    print(f"Registered: {client_id}")

                    await send_json(ws, {
                        "type": "registered",
                        "id": client_id
                    })

                continue

            # ---------------------------------
            # AUTODARTS CREATES A PIN
            # ---------------------------------

            if message_type == "create_pin":

                pin = make_pin()

                autodarts_id = data.get("id")

                if not autodarts_id:
                    continue

                client_id = autodarts_id
                clients[client_id] = ws

                pins[pin] = {
                    "autodarts": autodarts_id,
                    "camera": None
                }

                print(
                    f"PIN created: {pin} -> {autodarts_id}"
                )

                await send_json(ws, {
                    "type": "pin_created",
                    "pin": pin
                })

                continue

            # ---------------------------------
            # CAMERA ENTERS THE PIN
            # ---------------------------------

            if message_type == "join_pin":

                pin = str(data.get("pin", "")).strip()
                camera_id = data.get("id")

                room = pins.get(pin)

                if not room:
                    await send_json(ws, {
                        "type": "pin_error",
                        "message": "PIN not found"
                    })
                    continue

                if not camera_id:
                    continue

                client_id = camera_id
                clients[client_id] = ws

                room["camera"] = camera_id

                autodarts_id = room["autodarts"]

                print(
                    f"PIN paired: {pin} | "
                    f"{autodarts_id} <-> {camera_id}"
                )

                await send_json(ws, {
                    "type": "pin_joined",
                    "pin": pin,
                    "peer": autodarts_id
                })

                await send_json(
                    clients.get(autodarts_id),
                    {
                        "type": "camera_paired",
                        "pin": pin,
                        "peer": camera_id
                    }
                )

                continue

            # ---------------------------------
            # WEBRTC SIGNALLING
            # offer / answer / ICE
            # ---------------------------------

            if message_type in (
                "offer",
                "answer",
                "ice"
            ):

                target = data.get("target")

                if target in clients:
                    await send_json(
                        clients[target],
                        data
                    )

                continue

    finally:

        if client_id:

            if clients.get(client_id) is ws:
                clients.pop(client_id, None)

            print(
                f"Browser disconnected: {client_id}"
            )

        # Remove any PIN room belonging
        # to the disconnected Autodarts client.
        dead_pins = []

        for pin, room in pins.items():
            if room["autodarts"] == client_id:
                dead_pins.append(pin)

        for pin in dead_pins:
            pins.pop(pin, None)
            print(f"PIN removed: {pin}")

    return ws


async def status(request):
    return web.json_response({
        "service": "Maxlow Player Cam",
        "status": "online",
        "clients": len(clients),
        "pins": len(pins)
    })


app = web.Application()

app.router.add_get("/", status)
app.router.add_get("/ws", websocket_handler)


if __name__ == "__main__":

    print("")
    print("===================================")
    print(" MAXLOW PLAYER CAM PIN SERVER")
    print("===================================")
    print("")
    print("WebSocket:")
    print("ws://192.168.1.100:8000/ws")
    print("")
    print("Waiting for connections...")
    print("")

    web.run_app(
        app,
        host="0.0.0.0",
    port=int(os.environ.get("PORT", 8000))
    )
