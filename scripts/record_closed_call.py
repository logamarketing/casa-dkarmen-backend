#!/usr/bin/env python3
"""Record a CLOSED-state call by forwarding the gateway's real initiation payload.

Why this exists: for a WebSocket session the CLIENT sends
`conversation_initiation_client_data`, so ElevenLabs does NOT call the
server-side conversation-initiation webhook (that path is used for
platform/phone-inbound calls). Verified from telemetry — a WS recording logged
`window: shadow:desayuno` on the real clock while zero `conversation_init` rows
appeared.

So the proof is split, honestly:
  (1) the GATEWAY returns the correct override payload  -> proven over HTTP, 5 states
  (2) GIVEN that payload, the AGENT behaves correctly   -> proven here, by fetching
      the gateway's real response and forwarding it in the WS init message,
      exactly as the platform would for a phone call
The only link this cannot prove is ElevenLabs invoking the webhook on a real
inbound call — a platform contract that needs one real call to Karmen's number.

Usage: ELEVENLABS_API_KEY=... python3 scripts/record_closed_call.py <agent_id> <pinned_time> <out.wav>
"""
import asyncio, base64, json, os, sys, time, wave, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record_call

KEY = os.environ["ELEVENLABS_API_KEY"]
GATEWAY = "https://edcjcehfedwxxucktxoj.supabase.co/functions/v1/karmen-gateway"
ENVFILE = os.path.expanduser("~/Projects/loga-secrets/.env.local")
SR = 16000

SCENARIO = [
    ("say", "Hola, buenas noches."),
    ("say", "¿Todavía están abiertos? Quiero pedir unas flautas."),
    ("say", "¿Y no me pueden pasar con alguien, aunque sea?"),
    ("silence", 6),
]


def env(name):
    for line in open(ENVFILE):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def fetch_init_payload(agent_id, pinned):
    """Ask the gateway for exactly what it would hand the platform."""
    req = urllib.request.Request(
        GATEWAY,
        data=json.dumps({"caller_id": "+526871234567", "agent_id": agent_id,
                         "called_number": "+526873350709",
                         "conversation_id": f"closed-proof-{pinned}"}).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {env('CASA_DKARMEN_SUPABASE_ANON_KEY')}",
                 "x-karmen-secret": env("KARMEN_SHARED_SECRET"),
                 "x-karmen-now-override": pinned},
        method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


async def main(agent_id, pinned, out_path):
    payload = fetch_init_payload(agent_id, pinned)
    ov = (payload.get("conversation_config_override") or {}).get("agent", {})
    print("gateway says -> is_open:", payload["dynamic_variables"]["karmen_is_open"],
          "| window:", payload["dynamic_variables"]["karmen_window"])
    print("first_message override:", (ov.get("first_message") or "(none)")[:90])
    init_msg = {
        "type": "conversation_initiation_client_data",
        "dynamic_variables": payload.get("dynamic_variables", {}),
    }
    if payload.get("conversation_config_override"):
        init_msg["conversation_config_override"] = payload["conversation_config_override"]

    url = record_call.get_signed_url(agent_id)
    segments, conv_id = [], [None]
    agent_started, done = asyncio.Event(), asyncio.Event()
    t0 = time.time()
    head = [0.0]
    import websockets
    async with websockets.connect(url, max_size=16 * 1024 * 1024) as ws:
        await ws.send(json.dumps(init_msg, ensure_ascii=False))

        async def reader():
            try:
                async for raw in ws:
                    m = json.loads(raw)
                    t = m.get("type")
                    if t == "ping":
                        await ws.send(json.dumps({"type": "pong", "event_id": m["ping_event"]["event_id"]}))
                    elif t == "conversation_initiation_metadata":
                        conv_id[0] = m["conversation_initiation_metadata_event"]["conversation_id"]
                    elif t == "audio":
                        pcm = base64.b64decode(m["audio_event"]["audio_base_64"])
                        start = max(time.time() - t0, head[0])
                        segments.append((start, pcm))
                        head[0] = start + len(pcm) / (2 * SR)
                    elif t == "agent_response":
                        agent_started.set()
            except Exception:
                pass
            done.set()

        rt = asyncio.create_task(reader())
        queue = []

        async def streamer():
            silence = b"\x00" * 4000
            try:
                while not done.is_set():
                    await ws.send(json.dumps({"user_audio_chunk": base64.b64encode(
                        queue.pop(0) if queue else silence).decode()}))
                    await asyncio.sleep(0.25)
            except Exception:
                pass
        st = asyncio.create_task(streamer())

        await asyncio.sleep(6)
        for kind, val in SCENARIO:
            if kind == "say":
                agent_started.clear()
                pcm = record_call.tts_pcm16k(val)
                segments.append((time.time() - t0, pcm))
                for off in range(0, len(pcm), 8000):
                    queue.append(pcm[off:off + 8000])
                await asyncio.sleep(len(pcm) / (2 * SR) + 0.5)
                try:
                    await asyncio.wait_for(agent_started.wait(), 20)
                except asyncio.TimeoutError:
                    pass
                await asyncio.sleep(5)
            else:
                await asyncio.sleep(val)
        await asyncio.sleep(2)
        await ws.close()
        await done.wait()
        st.cancel(); rt.cancel()

    if segments:
        total = max(t + len(p) / (2 * SR) for t, p in segments) + 0.5
        buf = bytearray(int(total * SR) * 2)
        for t, pcm in sorted(segments, key=lambda s: s[0]):
            off = int(t * SR) * 2
            end = min(off + len(pcm), len(buf))
            buf[off:end] = pcm[: end - off]
        with wave.open(out_path, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
            w.writeframes(bytes(buf))
        print(f"wrote {out_path} ({total:.0f}s)")
    print("conversation_id:", conv_id[0])
    return conv_id[0]


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3]))
