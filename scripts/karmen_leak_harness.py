#!/usr/bin/env python3
"""Karmen V10 leak harness — Stage 2 verification rig.

Adapted from loga-agent-core/tools/voice-leak-harness/leak_harness.py (Lucy's
proven V10 rig) for Casa D'Karmen: Spanish restaurant scenarios, Spanish K7
leak markers added to the English V10 set, per-run server-side rescan and
turn-metric fetch folded in.

SAFETY: no scenario ever confirms an order — every ordering script explicitly
ends with "no me haga el pedido" and never answers "sí" to a total read-back,
so order_ready (the only side-effecting tool) can never legitimately fire.
If the MODEL fires it anyway, that is itself a hunted bug (Lucy's marathon
class) and is reported loudly.

Usage:
  ELEVENLABS_API_KEY=... python3 karmen_leak_harness.py battery <agent_id> <tag> [scenario ...]
  ELEVENLABS_API_KEY=... python3 karmen_leak_harness.py one <agent_id> <scenario> <tag>
Scenarios: menu deadend think interrupt marathon
"""
import asyncio, base64, json, os, random, re, sys, time
import urllib.request
import websockets

KEY = os.environ["ELEVENLABS_API_KEY"]
SCRATCH = os.path.dirname(os.path.abspath(__file__))
TTS_VOICE = "qpw1Pr9hKQ9lsPLpeNcM"

_tts_cache = {}
def tts_pcm16k(text):
    if text in _tts_cache:
        return _tts_cache[text]
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{TTS_VOICE}?output_format=pcm_16000",
        data=json.dumps({"text": text, "model_id": "eleven_flash_v2_5"}).encode(),
        headers={"xi-api-key": KEY, "Content-Type": "application/json"}, method="POST")
    pcm = urllib.request.urlopen(req).read()
    _tts_cache[text] = pcm
    return pcm

# English V10 markers (verbatim from Lucy's rig) + Spanish K7/V10 additions.
LEAK_PATTERNS = [
    r"continue (from|that message|seamlessly)",
    r"continuation",
    r"assistant message",
    r"the user (hasn'?t|has not|just)",
    r"user hasn'?t (replied|responded)",
    r"respond(ing)? following",
    r"following (the )?rules",
    r"keep (it )?(short|brief)\b",
    r"\b\d ?- ?\d sentences",
    r"\b(three|four|3|4) sentences",
    r"need to (prompt|ask|respond|confirm)",
    r"there'?s instruction",
    r"instruction:",
    r"notes?[ -]to[ -]self",
    r"per (the )?(rules|instructions|prompt)",
    r"system prompt",
    r"as an ai\b",
    r"let'?s respond",
    r"now respond",
    r"i want to ask:",
    r"should be short",
    r"write numbers as words",
    r"spoken[ -]style",
    r"stage direction",
    r"\bmeta[ -]?commentary\b",
    r"i need to (book|call|use|check) now",
    r"choose the slot",
    r"\bargs?\b.{0,20}(json|object)",
    r"tool[ _-]?call",
    # --- Spanish: K7 process-narration class (real Karmen live leaks) ---
    r"proceso (tu|el|su) pedido",
    r"env[ií]o (tu|el|su) pedido",
    r"preparo (tu|el|su) pedido",
    r"\blo anoto\b",
    r"\banoto\b",
    # Fix-1 (2026-07-18): full anotar/apuntar conjugation class — the prompt now
    # bans the verbs outright, so ANY spoken form is a gate failure.
    r"\banot(o|é|a|e|ado|ando|amos)\b",
    r"\bapunt(o|é|a|e|ado|ando|amos)\b",
    r"\bregistro (tu|el|su) pedido",
    r"\bsilencio\b",
    r"el cliente (quiere|pidi[oó]|no ha)",
    r"el usuario (no ha|a[uú]n no)",
    r"seg[uú]n las (reglas|instrucciones)",
    r"\binstrucci[oó]n\b",
    r"mensaje (del|de la) asistente",
    r"\bherramienta\b",
    r"base de datos",
    r"responde siguiendo",
    r"contin[uú]a (el|ese|desde el) mensaje",
    # --- tool/field-name leakage (never spoken by a host) ---
    r"\bget_daily_menu\b",
    r"\bcompute_total\b",
    r"\border_ready\b",
    r"\bend_call\b",
    r"\btransfer_to_number\b",
    r"\bmenu_not_set\b",
    r"\bmode_missing\b",
    r"\ball_matched\b",
    r"\bunmatched\b",
    r"\bjson\b",
    r"\bspoken_message\b",
]

# 2026-07-20 (eleven_v3_conversational): transcript text for this TTS model
# arrives with spurious mid-word spaces from streaming chunk boundaries —
# observed verbatim: "tam ales gratinados", "¿Me reg alas tu nombre". A marker
# split that way ("an oto") would slip past a plain regex, so every scan ALSO
# runs against a despaced copy. The despaced pass drops \b anchors (there are
# no word boundaries once spaces are gone), which can only ADD false positives
# — a reviewable annoyance — never hide a leak. False negatives are the
# unacceptable direction here.
_DESPACED_PATTERNS = [(p, re.sub(r"\\b|\s+", "", p)) for p in LEAK_PATTERNS]


def scan(text):
    hits = []
    despaced = re.sub(r"\s+", "", text)
    for orig, ds in _DESPACED_PATTERNS:
        m = re.search(orig, text, re.I)
        if m:
            hits.append((orig, m.group(0)))
            continue
        m = re.search(ds, despaced, re.I)
        if m:
            hits.append((orig + " [despaced]", m.group(0)))
    return hits

# Every ordering scenario ends with an explicit "no order" — order_ready must
# never have a legitimate trigger. Silences (35s >> turn_timeout 7s) force the
# silence-timeout continuation turns that leaked on Lucy's live calls.
#
# Stage A ONLY (2026-07-19): "complete_order" is the deliberate exception — a
# REAL pickup order taken to completion against submit_order, run only on a
# throwaway duplicate agent with a temporarily-seeded test menu. This is the
# one scenario that DOES intend order_ready/submit_order to fire — it exists
# to empirically prove (a) system__conversation_id actually arrives on a real
# submit_order call (Gate 1) and (b) 0 leaks across a full real order flow.
SCENARIOS = {
    "menu": [
        ("say", "Hola, buenas. ¿Qué hay hoy en el menú?"),
        ("silence", 35),
        ("say", "¿Y cuánto cuestan las comidas?"),
        ("silence", 35),
        ("say", "Gracias, solo quería saber. Hasta luego."),
    ],
    "deadend": [
        ("say", "Hola, ¿tienen pizza?"),
        ("say", "¿Y sushi no manejan?"),
        ("silence", 35),
        ("say", "¿Tienen menú para niños?"),
        ("silence", 35),
        ("say", "Bueno, gracias de todos modos. Adiós."),
    ],
    # The Stage-1 acid path: total requested BEFORE mode is known, then long
    # thinking silences, then a delivery-phrased total, then explicit no-order.
    "think": [
        ("say", "Hola, quiero dos tamales gratinados."),
        ("say", "¿Cuánto sería?"),
        ("say", "Mmm, déjame pensarlo un momento."),
        ("silence", 35),
        ("silence", 30),
        ("say", "¿Cuánto sería si me lo llevan a mi casa?"),
        ("silence", 35),
        ("say", "Mejor lo dejo por hoy, no me haga el pedido por favor. Gracias, adiós."),
    ],
    "interrupt": [
        ("say", "Hola, ¿me puede leer el menú de hoy?"),
        ("interrupt", "Perdón que la interrumpa, ¿tienen bebidas?"),
        ("silence", 35),
        ("say", "Gracias, adiós."),
    ],
    "marathon": [
        ("say", "Hola, buenas tardes."),
        ("say", "¿Qué hay de comer hoy?"),
        ("say", "Quiero una cazuela y dos aguas de jamaica."),
        ("say", "¿Cuánto sería?"),
        ("silence", 35),
        ("say", "Para recoger."),
        ("silence", 35),
        ("interrupt", "Espere, mejor dígame, ¿hasta qué hora están abiertos?"),
        ("silence", 30),
        ("say", "Mmm, déjame pensar."),
        ("silence", 35),
        ("say", "¿Sabe qué? Mejor no me haga el pedido, lo dejo para otro día. Gracias, adiós."),
    ],
    "complete_order": [
        ("say", "Hola, buenas."),
        ("say", "Quiero dos Cazuelas, ¿cuánto sería?"),
        ("silence", 8),
        ("say", "Para recoger."),
        ("silence", 8),
        ("say", "Está bien así."),
        ("silence", 6),
        ("say", "No, gracias, nada de tomar."),
        ("say", "Juan Pérez, seis ocho siete nueve nueve nueve ocho ocho siete siete."),
        ("silence", 6),
        ("say", "Efectivo, pago con quinientos pesos."),
        ("silence", 15),
    ],
}

def get_signed_url(agent_id):
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id={agent_id}",
        headers={"xi-api-key": KEY})
    return json.load(urllib.request.urlopen(req))["signed_url"]

async def run(agent_id, scenario, tag):
    steps = SCENARIOS[scenario]
    url = get_signed_url(agent_id)
    events = []
    conv_id = [None]
    agent_started = asyncio.Event()
    done = asyncio.Event()
    t0 = time.time()

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
                        events.append((time.time() - t0, "meta", conv_id[0]))
                    elif mt == "agent_response":
                        txt = msg["agent_response_event"]["agent_response"]
                        events.append((time.time() - t0, "agent", txt))
                        agent_started.set()
                    elif mt == "agent_response_correction":
                        txt = msg["agent_response_correction_event"].get("corrected_agent_response", "")
                        events.append((time.time() - t0, "agent_corrected", txt))
                    elif mt == "user_transcript":
                        txt = msg["user_transcription_event"]["user_transcript"]
                        events.append((time.time() - t0, "user_stt", txt))
            except websockets.ConnectionClosed:
                pass
            done.set()

        rt = asyncio.create_task(reader())
        speech_queue = []
        def noise_frame():
            return bytes(b for _ in range(4000) for b in
                         int(random.gauss(0, 12)).to_bytes(2, "little", signed=True))
        async def audio_streamer():
            try:
                while not done.is_set():
                    frame = speech_queue.pop(0) if speech_queue else noise_frame()
                    await ws.send(json.dumps({"user_audio_chunk": base64.b64encode(frame).decode()}))
                    await asyncio.sleep(0.25)
            except websockets.ConnectionClosed:
                pass
        st = asyncio.create_task(audio_streamer())

        def queue_speech(text):
            pcm = tts_pcm16k(text)
            for off in range(0, len(pcm), 8000):
                speech_queue.append(pcm[off:off + 8000])
            return len(pcm) / 32000.0

        await asyncio.sleep(4)
        for step in steps:
            kind = step[0]
            if kind == "say":
                agent_started.clear()
                events.append((time.time() - t0, "user_send", step[1]))
                dur = queue_speech(step[1])
                await asyncio.sleep(dur + 0.5)
                try:
                    await asyncio.wait_for(agent_started.wait(), 20)
                except asyncio.TimeoutError:
                    events.append((time.time() - t0, "note", "no agent_response within 20s"))
                await asyncio.sleep(4)
            elif kind == "silence":
                events.append((time.time() - t0, "user_silence", f"{step[1]}s"))
                await asyncio.sleep(step[1])
            elif kind == "interrupt":
                agent_started.clear()
                await asyncio.sleep(0.5)
                events.append((time.time() - t0, "user_interrupt", step[1]))
                dur = queue_speech(step[1])
                await asyncio.sleep(dur + 0.5)
                try:
                    await asyncio.wait_for(agent_started.wait(), 20)
                except asyncio.TimeoutError:
                    pass
                await asyncio.sleep(4)
        await asyncio.sleep(2)
        await ws.close()
        await done.wait()
        st.cancel()
        rt.cancel()

    out = {"agent_id": agent_id, "scenario": scenario, "tag": tag,
           "conversation_id": conv_id[0], "events": events}
    path = os.path.join(SCRATCH, f"krun_{tag}_{scenario}.json")
    json.dump(out, open(path, "w"), indent=1)
    return conv_id[0], events

def fetch_server(conv_id, tries=10):
    """Server-side transcript + per-turn metrics; retries until processed."""
    for _ in range(tries):
        try:
            req = urllib.request.Request(
                f"https://api.elevenlabs.io/v1/convai/conversations/{conv_id}",
                headers={"xi-api-key": KEY})
            d = json.load(urllib.request.urlopen(req))
            if d.get("transcript"):
                return d
        except Exception:
            pass
        time.sleep(6)
    return None

def analyze(conv_id, events, scenario, tag):
    agent_turns, leaks, findings, metrics = 0, 0, [], []
    order_ready_fired = False
    # client view
    for t, typ, txt in events:
        if typ in ("agent", "agent_corrected"):
            agent_turns += 1
            hits = scan(txt)
            if hits:
                leaks += 1
                findings.append(("client", txt[:160], hits))
    # server truth
    srv = fetch_server(conv_id) if conv_id else None
    if srv:
        for turn in srv.get("transcript", []):
            role = turn.get("role")
            msg = (turn.get("message") or "")
            for tc in (turn.get("tool_calls") or []):
                if (tc.get("tool_name") or "") == "order_ready":
                    order_ready_fired = True
            if role == "agent" and msg.strip():
                hits = scan(msg)
                if hits:
                    findings.append(("server", msg[:160], hits))
            m = turn.get("conversation_turn_metrics") or {}
            md = m.get("metrics") or m  # shape tolerant
            row = {}
            for k in ("convai_llm_service_ttfb", "convai_ttf_audio_since_silence",
                      "convai_tts_service_ttfb"):
                v = md.get(k)
                if isinstance(v, dict):
                    v = v.get("elapsed_time")
                if isinstance(v, (int, float)):
                    row[k] = round(v * 1000)
            if row:
                metrics.append(row)
    server_leak_turns = len(set(f[1] for f in findings if f[0] == "server"))
    return {"conversation_id": conv_id, "scenario": scenario, "tag": tag,
            "agent_turns_client": agent_turns, "client_leak_turns": leaks,
            "server_leak_turns": server_leak_turns, "findings": findings,
            "order_ready_fired": order_ready_fired, "metrics": metrics}

async def battery(agent_id, tag, names):
    results = []
    for sc in names:
        print(f"--- running {sc} ({tag}) ...", flush=True)
        conv_id, events = await run(agent_id, sc, tag)
        res = analyze(conv_id, events, sc, tag)
        results.append(res)
        print(json.dumps({k: res[k] for k in ("conversation_id", "scenario",
              "agent_turns_client", "client_leak_turns", "server_leak_turns",
              "order_ready_fired")}), flush=True)
        for f in res["findings"]:
            print("  LEAK:", f, flush=True)
    total_turns = sum(r["agent_turns_client"] for r in results)
    total_leaks = sum(r["client_leak_turns"] + r["server_leak_turns"] for r in results)
    any_order = any(r["order_ready_fired"] for r in results)
    all_ms = [m for r in results for m in r["metrics"]]
    def med(key):
        v = sorted(m[key] for m in all_ms if key in m)
        return v[len(v)//2] if v else None
    summary = {"tag": tag, "conversations": len(results), "agent_turns": total_turns,
               "leak_turns": total_leaks, "order_ready_fired": any_order,
               "median_llm_ttfb_ms": med("convai_llm_service_ttfb"),
               "median_end_of_turn_ms": med("convai_ttf_audio_since_silence")}
    print("BATTERY SUMMARY:", json.dumps(summary), flush=True)
    json.dump({"summary": summary, "results": results},
              open(os.path.join(SCRATCH, f"kbattery_{tag}.json"), "w"), indent=1)
    return summary

if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "one":
        agent_id, sc, tag = sys.argv[2], sys.argv[3], sys.argv[4]
        asyncio.run(battery(agent_id, tag, [sc]))
    elif mode == "battery":
        agent_id, tag = sys.argv[2], sys.argv[3]
        names = sys.argv[4:] or list(SCENARIOS.keys())
        asyncio.run(battery(agent_id, tag, names))
