#!/usr/bin/env python3
"""Voice-model latency battery — REAL WebSocket calls, real per-turn metrics.

Interleaves arms (A=flash_v2_5, E=multilingual_v2, D=v3_conversational) against
ONE agent, PATCHing only tts.model_id between calls so the measured delta is the
TTS model and nothing else. Interleaving (not blocks) cancels platform drift —
prior batteries showed end-of-turn medians swinging 1224–2647ms across sessions.

The scenario deliberately stops BEFORE ordering: no submit_order, no kitchen
ticket, no order row. get_daily_menu/compute_total are read-only.

Metrics (server-side, only real audio calls carry them; sims return None):
  convai_tts_service_ttfb          TTS time-to-first-byte  <- the model cost
  convai_ttf_audio_since_silence   end-of-turn: user silence -> first audio
  convai_llm_service_ttfb          control: must be ~flat across arms

Usage:
  python3 scripts/voice_latency_ab.py run <agent_id> <outdir>   # battery + report
  python3 scripts/voice_latency_ab.py report <outdir>           # re-report from manifest
"""
import asyncio, base64, json, os, sys, time, wave, urllib.request, urllib.error
import statistics as st
import websockets

KEY = os.environ.get("ELEVENLABS_API_KEY") or open(".el_key").read().strip()
API = "https://api.elevenlabs.io/v1"
ARMS = {"A": "eleven_flash_v2_5", "E": "eleven_multilingual_v2", "D": "eleven_v3_conversational"}
ORDER = ["A", "E", "D", "A", "E", "D", "A", "E", "D", "A", "E", "A", "E"]
CALLER_VOICE = "TxGEqnHWrfWFTfGW9XjX"  # distinct voice for the caller side
SR = 16000
LINES = [
    "Hola, buenas tardes.",
    "¿Qué me recomiendas hoy de comer?",
    "¿Y a cómo está eso?",
    "Ah, está bien. Deje le pregunto a mi esposa y le marco al ratito. Gracias, ¿eh?",
]
FIELDS = ["convai_tts_service_ttfb", "convai_ttf_audio_since_silence", "convai_llm_service_ttfb"]
LABELS = {"convai_tts_service_ttfb": "TTS TTFB",
          "convai_ttf_audio_since_silence": "End-of-turn (silence->audio)",
          "convai_llm_service_ttfb": "LLM TTFB (control)"}


def api(path, data=None, method=None):
    req = urllib.request.Request(
        f"{API}{path}", data=json.dumps(data).encode() if data is not None else None,
        headers={"xi-api-key": KEY, "Content-Type": "application/json"},
        method=method or ("POST" if data is not None else "GET"))
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def caller_pcm(text, cache={}):
    if text not in cache:
        req = urllib.request.Request(
            f"{API}/text-to-speech/{CALLER_VOICE}?output_format=pcm_16000",
            data=json.dumps({"text": text, "model_id": "eleven_flash_v2_5"}).encode(),
            headers={"xi-api-key": KEY, "Content-Type": "application/json"}, method="POST")
        cache[text] = urllib.request.urlopen(req, timeout=60).read()
    return cache[text]


async def run_call(agent_id, wav_path):
    url = api(f"/convai/conversation/get-signed-url?agent_id={agent_id}")["signed_url"]
    segments, conv_id = [], [None]
    agent_started, done = asyncio.Event(), asyncio.Event()
    t0 = time.time()
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
                        start = max(time.time() - t0, agent_head[0])
                        segments.append((start, pcm))
                        agent_head[0] = start + len(pcm) / (2 * SR)
                    elif mt == "agent_response":
                        agent_started.set()
            except websockets.ConnectionClosed:
                pass
            done.set()

        rt = asyncio.create_task(reader())
        speech_queue = []

        async def streamer():
            silence = b"\x00" * 4000
            try:
                while not done.is_set():
                    frame = speech_queue.pop(0) if speech_queue else silence
                    await ws.send(json.dumps({"user_audio_chunk": base64.b64encode(frame).decode()}))
                    await asyncio.sleep(0.25)
            except websockets.ConnectionClosed:
                pass
        stask = asyncio.create_task(streamer())

        await asyncio.sleep(6)  # greeting
        for text in LINES:
            agent_started.clear()
            pcm = caller_pcm(text)
            segments.append((time.time() - t0, pcm))
            for off in range(0, len(pcm), 8000):
                speech_queue.append(pcm[off:off + 8000])
            await asyncio.sleep(len(pcm) / (2 * SR) + 0.5)
            try:
                await asyncio.wait_for(agent_started.wait(), 20)
            except asyncio.TimeoutError:
                pass
            await asyncio.sleep(5)
        await asyncio.sleep(4)
        await ws.close()
        await done.wait()
        stask.cancel(); rt.cancel()

    if segments:
        total_s = max(t + len(p) / (2 * SR) for t, p in segments) + 0.5
        buf = bytearray(int(total_s * SR) * 2)
        for t, pcm in sorted(segments, key=lambda s: s[0]):
            off = int(t * SR) * 2
            end = min(off + len(pcm), len(buf))
            buf[off:end] = pcm[: end - off]
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
            w.writeframes(bytes(buf))
    return conv_id[0]


def fetch_metrics(cid, tries=12, wait=5):
    """Per-turn metric samples, deduping tool-continuation repeats (same logic
    as latency-measure.py). Polls until metrics appear."""
    for _ in range(tries):
        d = api(f"/convai/conversations/{cid}")
        samples = {f: [] for f in FIELDS}
        prev = {f: None for f in FIELDS}
        got = False
        for t in d.get("transcript", []):
            if t.get("role") != "agent":
                continue
            m = (t.get("conversation_turn_metrics") or {}).get("metrics") or {}
            for f in FIELDS:
                v = m.get(f)
                val = v.get("elapsed_time") if isinstance(v, dict) else None
                if val is None:
                    continue
                got = True
                if prev[f] is not None and abs(val - prev[f]) < 1e-9:
                    prev[f] = val
                    continue
                samples[f].append(val * 1000.0)
                prev[f] = val
        if got:
            return samples
        time.sleep(wait)
    return {f: [] for f in FIELDS}


def report(outdir):
    manifest = json.load(open(os.path.join(outdir, "latency_manifest.json")))
    agg = {arm: {f: [] for f in FIELDS} for arm in ARMS}
    for entry in manifest["calls"]:
        if not entry.get("conversation_id"):
            continue
        s = fetch_metrics(entry["conversation_id"])
        for f in FIELDS:
            agg[entry["arm"]][f].extend(s[f])
        n = sum(len(s[f]) for f in FIELDS)
        print(f"  {entry['arm']} call {entry['i']:02d} {entry['conversation_id']}: {n} metric samples")
    print()
    for f in FIELDS:
        print(LABELS[f])
        for arm, model in ARMS.items():
            xs = sorted(agg[arm][f])
            if not xs:
                print(f"  {arm} {model:28s}   (no data)")
                continue
            p25 = xs[int(0.25 * (len(xs) - 1))]
            p75 = xs[int(0.75 * (len(xs) - 1))]
            print(f"  {arm} {model:28s} n={len(xs):>3} median={st.median(xs):>6.0f}ms  p25={p25:>6.0f}  p75={p75:>6.0f}")
        print()
    json.dump({a: {f: sorted(v) for f, v in fs.items()} for a, fs in agg.items()},
              open(os.path.join(outdir, "latency_samples.json"), "w"), indent=1)


def main():
    mode = sys.argv[1]
    if mode == "report":
        report(sys.argv[2]); return
    agent_id, outdir = sys.argv[2], sys.argv[3]
    os.makedirs(outdir, exist_ok=True)
    for text in LINES:  # pre-cache caller lines once (same audio every call)
        caller_pcm(text)
    manifest = {"agent_id": agent_id, "order": ORDER, "calls": []}
    current_model = None
    for i, arm in enumerate(ORDER):
        model = ARMS[arm]
        if model != current_model:
            api(f"/convai/agents/{agent_id}",
                {"conversation_config": {"tts": {"model_id": model}}}, method="PATCH")
            current_model = model
            time.sleep(2)
        wav = os.path.join(outdir, f"latcall_{i:02d}_{arm}.wav")
        entry = {"i": i, "arm": arm, "model": model, "conversation_id": None, "error": None}
        try:
            entry["conversation_id"] = asyncio.run(run_call(agent_id, wav))
            print(f"[{i:02d}] {arm} {model}: {entry['conversation_id']}", flush=True)
        except Exception as e:  # keep the battery going; report the hole honestly
            entry["error"] = f"{type(e).__name__}: {e}"
            print(f"[{i:02d}] {arm} {model}: FAILED {entry['error']}", flush=True)
        manifest["calls"].append(entry)
        json.dump(manifest, open(os.path.join(outdir, "latency_manifest.json"), "w"), indent=1)
        time.sleep(3)
    print("\n--- metrics ---", flush=True)
    report(outdir)


if __name__ == "__main__":
    main()
