# Karmen — Latency Benchmark (2026-07-06)

Measured from the ElevenLabs conversation API (`conversation_turn_metrics`). **Real
numbers only.** Where a number can only come from a real audio call, it is marked
**NOT MEASURED** rather than estimated.

## Hard limitation (proven, not assumed)
The `simulate-conversation` endpoint returns `conversation_turn_metrics: null` — it
carries **no latency data**. Per-turn ASR/LLM/TTS/end-of-turn ms exist **only on real
audio calls**. So the LATENCY of any config change (Turn V3, a different LLM) can only
be measured by placing real calls on that config — the simulator cannot do it, and
neither can Claude Code. Quality, however, *can* be tested in the simulator.

## Metric fields the API exposes (per agent turn, seconds → ms here)
- `convai_llm_service_ttfb` — LLM time-to-first-byte (the core LLM latency)
- `convai_llm_service_ttf_sentence` — LLM time-to-first-sentence
- `convai_tts_service_ttfb` — TTS time-to-first-byte
- `convai_ttf_audio_since_silence` — **end-of-turn**: user-silence → first audio (this
  is the user-perceived lag; it bundles turn detection + ASR + LLM + TTS)
- **ASR latency: NO discrete field** (`convai_asr_provider` is null). Cowork's ~20 ms
  cannot be confirmed from this API.

Reproduce any time: `python3 scripts/latency-measure.py 10`

---

## 1. BASELINE — config: turn_v2 + gpt-5-mini (reasoning=minimal), flash_v2_5 TTS
Last ~10 real calls, deduped (tool-continuation turns repeat the prior LLM value):

| Metric | Median | n | p25–p75 |
|---|---|---|---|
| **LLM TTFB** | **~815 ms** | 116 | 743–950 |
| LLM time-to-first-sentence | ~900 ms | 96 | 810–1025 |
| **TTS TTFB** | **~102 ms** | 116 | 95–115 |
| **End-of-turn (silence→first audio)** | **~2400 ms** | 102 | 1488–2677 |

Confirms Cowork's LLM ~830 / TTS ~100. **The dominant cost is the ~2.4 s end-of-turn**,
most of which is turn-detection wait under `turn_v2` — the largest opportunity.

## 2. LEVER A — Turn V3 (turn-taking model)
- **Settable:** yes — `turn.turn_model = "turn_v3"` accepted (HTTP 200, verified).
- **Latency delta: NOT MEASURED.** Turn V3 changes end-of-turn *detection*, whose only
  metric (`convai_ttf_audio_since_silence`) requires real audio. The simulator yields
  nothing. Honest status: **untested for latency**; not left enabled.
- **Quality:** turn model does not affect answer quality (it is detection only).

## 3. LEVER B — faster LLM (one at a time; quality via simulator, latency needs real calls)
| Candidate | Quality (sim acid-test) | Latency |
|---|---|---|
| **gpt-5-mini** (baseline) | PASS (proven over prior work) | LLM TTFB ~815 ms (measured) |
| **gpt-4o-mini** | **FAIL — hard** | not measured (rejected on quality) |
| **claude-haiku-4-5** | PASS (1 sim run) | **NOT MEASURED** (needs real calls) |

- **gpt-4o-mini rejected:** in the delivery acid-test it **invented a fake menu** (never
  called `get_daily_menu`), did **mental math** for the total and got it wrong
  ("$140" for a $285 order — BUG 2 returns), and **never fired `order_ready`**. A model
  that won't reliably call tools breaks the whole architecture. Latency is irrelevant.
- **claude-haiku-4-5 passed quality:** clean `get_daily_menu → compute_total →
  order_ready → end_call`, exact $285 total, warm tone, no leak, full order data. It is a
  **viable candidate pending a real-call latency measurement.** (Requires
  `reasoning_effort=null`.)

## 4. DECISION
No **measured** latency win exists yet (both levers need real calls), so — per "keep only
measured wins, real numbers only" — **Karmen is left on the proven baseline:
turn_v2 + gpt-5-mini (reasoning=minimal)**. Everything else (prompt, 4 tools, flash voice,
transfer +526878711111) untouched and verified.

**Rollback snapshot:** `.karmen-agent-rollback-20260705-pre-latency.json` (full pre-test
agent config). The intra-test probe configs were reverted; final live == baseline.

---

## Turnkey real-call A/B (for Edgar / Cowork — the only way to get the numbers)
For each config: place **2–3 real calls** (a normal order each), then measure.

**A) Baseline is already measured** (table above).

**B) Turn V3:**
```
KEY=$(cat .el_key)
# enable
curl -s -X PATCH https://api.elevenlabs.io/v1/convai/agents/agent_9901k5y1nqype69akbe3j8swwwat \
  -H "xi-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"conversation_config":{"turn":{"turn_model":"turn_v3"}}}'
# >>> place 2-3 real calls <<<
python3 scripts/latency-measure.py 3        # compare End-of-turn median vs ~2400ms baseline
# revert if no win:
curl -s -X PATCH .../agents/agent_9901k5y1nqype69akbe3j8swwwat -H "xi-api-key: $KEY" \
  -H "Content-Type: application/json" -d '{"conversation_config":{"turn":{"turn_model":"turn_v2"}}}'
```

**C) claude-haiku-4-5 (quality already passed sim):**
```
curl -s -X PATCH .../agents/agent_9901k5y1nqype69akbe3j8swwwat -H "xi-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"conversation_config":{"agent":{"prompt":{"llm":"claude-haiku-4-5","reasoning_effort":null}}}}'
# >>> place 2-3 real calls <<<  then measure; compare LLM TTFB vs ~815ms baseline
# revert:
-d '{"conversation_config":{"agent":{"prompt":{"llm":"gpt-5-mini","reasoning_effort":"minimal"}}}}'
```
Keep a config only if its real-call median beats baseline **and** the order acid-test
still passes on a live call.
