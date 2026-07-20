#!/usr/bin/env python3
"""Record a full sample call against an agent as a listenable WAV.

Runs one scripted caller scenario over the ElevenLabs conversation WebSocket,
captures BOTH sides (the TTS-generated caller lines we send + every agent audio
chunk we receive), and stitches them onto a single real-time timeline so the
result sounds like an actual phone call recording.

Usage: ELEVENLABS_API_KEY=... python3 record_call.py <agent_id> <out.wav>
"""
import asyncio, base64, json, os, sys, time, wave
import urllib.request
import websockets

KEY = os.environ["ELEVENLABS_API_KEY"]
TTS_VOICE = "TxGEqnHWrfWFTfGW9XjX"  # a DIFFERENT voice for the caller so the two sides are distinguishable
SR = 16000  # pcm_16000 both directions on the WS

SCENARIO = [
    ("say", "Hola, buenas tardes."),
    ("say", "¿Qué me recomiendas hoy?"),
    ("say", "Mmm, se me antojan las flautas. Deme una orden."),
    ("say", "¿Cuánto sería?"),
    ("say", "Para llevar... digo, para recoger."),
    ("say", "Sí, está bien."),
    ("say", "Me llamo Ulises López, mi número es seis seis dos, uno siete seis, ocho cinco seis seis."),
    ("say", "Con doscientos pesos, en efectivo."),
    ("silence", 10),
]

def tts_pcm16k(text):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{TTS_VOICE}?output_format=pcm_16000",
        data=json.dumps({"text": text, "model_id": "eleven_flash_v2_5"}).encode(),
        headers={"xi-api-key": KEY, "Content-Type": "application/json"}, method="POST")
    return urllib.request.urlopen(req).read()

def get_signed_url(agent_id):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id={agent_id}",
        headers={"xi-api-key": KEY})
    return json.load(urllib.request.urlopen(req))["signed_url"]

async def main(agent_id, out_path):
    url = get_signed_url(agent_id)
    # (t_offset_seconds, pcm_bytes, source) — placed on a timeline at the end
    segments = []
    conv_id = [None]
    agent_started = asyncio.Event()
    done = asyncio.Event()
    t0 = time.time()
    # per-source "write head" so contiguous chunks append instead of overlapping
    agent_head = [0.0]

    async with websockets.connect(url, max_size=16 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"type": "conversation_initiation_client_data"}))

        async def reader():
            try:
                async for raw in ws:
                    msg = json.loads(raw)
                    mt = msg.get("type")
                    if mt == "ping":
                        await ws.send(json.dumps({"type": "pong", "event_id": msg["ping_event"]["event_id"]}))
                    elif mt == "conversation_initiation_metadata":
                        conv_id[0] = msg["conversation_initiation_metadata_event"]["conversation_id"]
                    elif mt == "audio":
                        pcm = base64.b64decode(msg["audio_event"]["audio_base_64"])
                        now = time.time() - t0
                        # contiguous agent speech: append at max(arrival, current head)
                        start = max(now, agent_head[0])
                        segments.append((start, pcm, "agent"))
                        agent_head[0] = start + len(pcm) / (2 * SR)
                    elif mt == "agent_response":
                        agent_started.set()
            except websockets.ConnectionClosed:
                pass
            done.set()

        rt = asyncio.create_task(reader())
        speech_queue = []

        async def audio_streamer():
            silence = b"\x00" * 4000
            try:
                while not done.is_set():
                    frame = speech_queue.pop(0) if speech_queue else silence
                    await ws.send(json.dumps({"user_audio_chunk": base64.b64encode(frame).decode()}))
                    await asyncio.sleep(0.25)
            except websockets.ConnectionClosed:
                pass
        st = asyncio.create_task(audio_streamer())

        def queue_speech(text):
            pcm = tts_pcm16k(text)
            segments.append((time.time() - t0, pcm, "user"))
            for off in range(0, len(pcm), 8000):
                speech_queue.append(pcm[off:off + 8000])
            return len(pcm) / (2 * SR)

        await asyncio.sleep(6)  # let the greeting play
        for kind, val in SCENARIO:
            if kind == "say":
                agent_started.clear()
                dur = queue_speech(val)
                await asyncio.sleep(dur + 0.5)
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

    # ---- stitch the timeline ----
    total_s = max(t + len(p) / (2 * SR) for t, p, _ in segments) + 0.5
    buf = bytearray(int(total_s * SR) * 2)
    for t, pcm, _src in sorted(segments, key=lambda s: s[0]):
        off = int(t * SR) * 2
        end = min(off + len(pcm), len(buf))
        buf[off:end] = pcm[: end - off]

    with wave.open(out_path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(bytes(buf))
    print(f"conversation_id: {conv_id[0]}")
    print(f"wrote {out_path} ({total_s:.0f}s)")
    return conv_id[0]

if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
