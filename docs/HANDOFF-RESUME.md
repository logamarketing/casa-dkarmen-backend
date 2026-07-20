# Karmen — HANDOFF / RESUME

*Read this first in any new session. Written 2026-07-20. It states where Karmen
stands **right now**, what happens next, every rollback, and every decision that
belongs to Edgar (owner) rather than to engineering.*

**Authority order when anything here disagrees with reality: live agent config >
deployed gateway > committed source > this doc.** Verify before acting; this doc
is a map, not the territory.

---

## 1. The system in one page

| Thing | Value |
|---|---|
| **LIVE agent** | `agent_9901k5y1nqype69akbe3j8swwwat` ("Karmen") — real inbound line **+526873350709** |
| **DUPLICATE (build/test)** | `agent_3101kxxq4cq8fvarsqddje6p83e0` ("Karmen CALIDA v1") — no phone number |
| **Gateway** | Supabase project **`edcjcehfedwxxucktxoj`** (org `nncpmrizsddribljpdlv`), function **`karmen-gateway`** |
| **Menu admin** | function `karmen-menu-admin` (Stage 3 write path, Bolt app) |
| **DB tables** | `daily_menu`, `ordenes_agente_voz`, `order_submissions` (idempotency), `voice_events` (telemetry) |
| **Kitchen notify** | n8n webhook → Telegram bot `@Lopz2525bot` |
| **ElevenLabs key** | `~/Projects/casa-dkarmen-backend/.el_key` (gitignored) |
| **Other secrets** | `~/Projects/loga-secrets/.env.local` (chmod 600) + inventory in `secrets-inventory.md` |

> **Supabase MCP cannot see this project** (different org). All DB/gateway work
> uses the **CLI `--project-ref`** or the **Management API** with
> `$SUPABASE_ACCESS_TOKEN`. Never the MCP.

### Live agent config as of 2026-07-20
- TTS **`eleven_v3_conversational`**, `expressive_mode: true`, Magda voice `qpw1Pr9hKQ9lsPLpeNcM`, stability 0.38 / similarity 0.75 / speed 1.1
- LLM **`gpt-4.1`**, **temperature 0.4**, `turn_v3`, `speculative_turn: true`
- Prompt: warm-v3 (`docs/agent-prompts/karmen-system-prompt-warm-v3.txt`, 7814 chars)
- Tools (3): `tool_9801…` `get_daily_menu` · `tool_8501…` `compute_total` · `tool_0901…` `submit_order` (**sends `style:"warm"`** → rotating name-aware farewell)
- KB (4 docs): Extras · Bebidas · **`DUinhY6brFXOlQlVNyKI` "Información" (STALE HOURS — see §4)** · Menú de Desayunos
- `conversation_initiation_client_data_webhook`: **null** (not yet wired live)

### Detached / historical ids (do not re-attach without reason)
`tool_1301…` old plain `submit_order` · `tool_2201…` redundant client `end_call` ·
`tool_3401ky02g0xde87vetmvd1q0f4x4` pinned-clock test `get_daily_menu` (kept for window testing).

---

## 2. Where each stage stands

### Stage A — order integrity: **LIVE and PROVEN** ✅
`submit_order` writes a verified row, is idempotent per `conversation_id`, refuses
on total mismatch, and notifies the kitchen. **Proven on real order #108**
(Ulises López, delivery, `precio_total=165` correct: flautas 120 + Coca 25 + envío 20),
one row, one ticket, confirmation spoken only after `ok:true`.
The closeout found and fixed **K12** (kitchen ticket showed only the drink / "$25").

### Stage B — warm personality + voice: **LIVE** ✅ (cut over 2026-07-20)
Warm-v3 prompt, temp 0.4, `eleven_v3_conversational` + expressive mode, muletillas
("órale/sale/va", max 1/turn) IN. Latency on this config: **TTS TTFB ~266ms**
(vs 89ms on old flash), **end-of-turn ~1.4–1.5s — unchanged from before**.
Guardrails re-proven at temp 0.4: sims ALL PASS ×2, leak battery 61 turns / 0 leaks.

> Voice decision record: **E** (`eleven_multilingual_v2`) costs **+800ms** TTS TTFB
> and +761ms end-of-turn — measured, 13 interleaved real calls. **D**
> (`eleven_v3_conversational`) costs only +177ms. D was chosen. `eleven_v3` (the
> NARRATION id) is rejected on agents (`expressive_tts_not_allowed`) — that is a
> different model, **not** a plan gate. Our tier is **Creator ($22/mo)** and it is
> sufficient. Do not tell the owner he needs an upgrade.

### V6 — business hours + service windows: **BUILT, PROVEN, HELD** ⏸️
Rules (America/Mazatlan, no DST): open **7:50 AM–4:50 PM**; closed 4:50 PM–7:50 AM;
**Sundays closed all day**; **7:50–11:30 = desayunos only**; **11:31–4:50 = comidas only**.
Bebidas + extras stay available in BOTH windows (the free-tea promo is a `bebida`).

- Enforced **in code** in `karmen-gateway`: window-filtered menu, closed short-circuit
  with a server-dictated warm message, and server-side refusal of `compute_total` /
  `submit_order` when closed or off-window (off-window returns **no total at all**).
- **Behind a default-off flag: `KARMEN_HOURS_ENFORCED` (currently `false`/unset).**
  The gateway is SHARED by live and duplicate, so this flag is the only thing keeping
  the deploy from changing live behavior. Unenforced requests still LOG
  `window: shadow:<window>` for pre-cutover observability.
- **47/47 boundary assertions pass** (`scripts/hours_boundary_battery.py`).
- **K15 gap closed:** hours are also injected at **conversation initiation** (see §4),
  because a caller can ask "¿están abiertos?" without firing any tool.

---

## 3. What to do next (the cutover, in order)

Each step is owner-gated. Do not run these without Edgar's go.

```bash
# 0) Snapshot live FIRST, always.
curl -s -H "xi-api-key: $(cat .el_key)" \
  "https://api.elevenlabs.io/v1/convai/agents/agent_9901k5y1nqype69akbe3j8swwwat" \
  -o ".karmen-agent-rollback-$(date +%Y%m%d-%H%M%S)-hours-cutover.json"

# 1) Turn hours enforcement ON.
supabase secrets set KARMEN_HOURS_ENFORCED=true --project-ref edcjcehfedwxxucktxoj

# 2) Attach the CORRECTED hours KB doc to live (swap DUinhY6brFXOlQlVNyKI -> xpNJs3xDhFwI8Ymv436i;
#    keep the other three docs; do NOT delete the original).

# 3) Set the conversation-initiation webhook on LIVE (per-agent — verified NOT workspace-wide).
#    url = https://edcjcehfedwxxucktxoj.supabase.co/functions/v1/karmen-gateway
#    headers = Authorization: Bearer <anon key>, x-karmen-secret: <read secret>
#    *** NO x-karmen-now-override header on live *** (that pinned clock is test-only).
#    Also enable platform_settings.overrides.conversation_config_override.agent.first_message = true
#    and .prompt.prompt = true, or the closed-state override cannot apply.
```

### 4) Then Edgar places **TWO real calls** — this is the definition of done
1. **During open hours** — confirm normal ordering still works end to end and the
   correct window's menu is offered.
2. **After 4:50 PM (or on a Sunday)** — confirm she opens with the closed message,
   states the real hours, refuses to take an order, **does not transfer**, and hangs up.

> **Call #2 is not optional.** It is the ONLY way to prove the one link still
> unproven: that ElevenLabs actually invokes the initiation webhook on a real
> inbound phone call. WebSocket test harnesses send their own initiation data, so
> they structurally cannot prove it (confirmed from telemetry). Until call #2, the
> closed path is *implemented and payload-proven*, **not** end-to-end proven.

---

## 4. Known live issue — decide before or with cutover

⚠️ **Live Karmen is telling callers the wrong hours today.** The live "Información"
KB doc (`DUinhY6brFXOlQlVNyKI`) says **8:00 AM–5:00 PM and states no Sunday rule**,
so she can tell a caller they are open on a Sunday.

The corrected doc (`xpNJs3xDhFwI8Ymv436i`, source of truth
`docs/kb-informacion-corrected.md`) states 7:50–4:50, desayunos to 11:30, comida
from 11:31, **domingos CERRADO** — everything else preserved verbatim, **promo text
untouched**. It is attached to the **duplicate only**.

**Recommendation: push the corrected doc to live now**, independent of the voice/hours
cutover — it is a truthfulness fix, not a behavior change. Edgar's call.

**KB docs are authoritative business truth and must never be deleted** — they carry the
real hours, payment rules, the $20 delivery fee, and the promotions.

---

## 5. Rollbacks (all one-liners, all tested paths)

| Change | Rollback |
|---|---|
| **Warm/D voice cutover (Stage B)** | `./scripts/rollback-warm-cutover.sh` — restores prompt, temperature, first_message, tool_ids, tts model/expressive, speculative_turn from `.karmen-agent-rollback-20260720-092953-warm-cutover.json` |
| **Hours enforcement** | `supabase secrets unset KARMEN_HOURS_ENFORCED --project-ref edcjcehfedwxxucktxoj` (instantly returns live to unenforced/shadow) |
| **Corrected KB doc** | PATCH the agent's `knowledge_base` back to `DUinhY6brFXOlQlVNyKI` (original never deleted) |
| **Initiation webhook** | PATCH `platform_settings.workspace_overrides.conversation_initiation_client_data_webhook = null` |
| **Any agent change** | Every snapshot is `.karmen-agent-rollback-<ts>-<label>.json` in the repo root — PATCH the fields back |

---

## 6. Open owner decisions (engineering has no say)

1. **Hours cutover** — flip the flag + KB + webhook, then the two real calls (§3).
2. **Corrected hours KB to live NOW?** — recommended, see §4.
3. **Failure-alert bot** — `KARMEN_ALERT_BOT_TOKEN` / `KARMEN_ALERT_CHAT_ID` are still
   **unprovisioned** (needs a @BotFather bot + chat id). Today a capture-worthy failure
   is durably logged to `voice_events` but **no human is pinged**. Accepted fast-follow,
   not an oversight — the gateway reports `alert_credential_missing` honestly rather
   than faking success.
4. **Test rows in `ordenes_agente_voz`** — ids **104–106** (`STAGE-A-TEST-PROOF` / test
   phones) and **#115** (the FINAL-D sample call: Ulises López, flautas, $120 pickup,
   which also sent a **real kitchen Telegram ticket**). Order data is never deleted
   without an explicit ask. **Tell the kitchen #115 was a test.**
5. **Muletillas** ("órale/sale/va") — in and live; Edgar's ear decides if they stay.
6. **n8n kitchen Telegram credential** — the Stage-A notify node feeds the same
   already-credentialed `Response` node the real orders always used (no new credential
   was trusted). Confirm this stays the intended path.

---

## 7. How to verify anything (the commands that matter)

```bash
# Live agent config (read-only, safe)
curl -s -H "xi-api-key: $(cat .el_key)" \
  "https://api.elevenlabs.io/v1/convai/agents/agent_9901k5y1nqype69akbe3j8swwwat" | python3 -m json.tool | head -60

# Hours boundaries — 47 assertions, real HTTP (read path)
python3 scripts/hours_boundary_battery.py
#   add --with-order + KARMEN_ORDER_SECRET=... for the write path

# Guardrail sims (mode-before-price, verified totals, single farewell, honest empty)
ELEVENLABS_API_KEY=$(cat .el_key) python3 scripts/karmen_regression_sims.py <agent_id> <tag>

# Leak battery (real audio calls) + ALWAYS re-scan with the CURRENT scanner
ELEVENLABS_API_KEY=$(cat .el_key) python3 scripts/karmen_leak_harness.py battery <agent_id> <tag> menu deadend think interrupt marathon
python3 scripts/rescan_leaks.py <conversation_id> [...]

# Telemetry (what actually happened)
curl -s -X POST "https://api.supabase.com/v1/projects/edcjcehfedwxxucktxoj/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select event_type,payload,created_at from voice_events order by created_at desc limit 20;"}'

# Deploy the gateway (owner-gated)
supabase functions deploy karmen-gateway --project-ref edcjcehfedwxxucktxoj
```

---

## 8. Non-obvious things that will bite you

- **The gateway is shared by live and duplicate.** There is no per-agent field in a
  tool request. Any gateway behavior change hits live the moment it deploys — ship
  behind a default-off flag (that is exactly why `KARMEN_HOURS_ENFORCED` exists).
- **`now_override` / `service_date` / `dry_run` / `simulate_failure` are ops-only** and
  must NEVER appear in an ElevenLabs tool schema. The model must not be able to move
  the clock or suppress a write.
- **This TTS model's transcripts contain spurious mid-word spaces** ("tam ales",
  "dos cientos sesenta", "cortes ía"). Every content regex must also match a
  **despaced** copy — a split word silently defeated three separate judges (K13).
- **A leak battery loads `scan()` at process start** — a scanner fixed mid-run does not
  apply retroactively. Re-scan saved conversations with `scripts/rescan_leaks.py`.
- **Grounding = prompt + KB + tool results.** Do not call anything a hallucination
  after checking only the prompt (K14 — the "invented" free tea was a real KB promo).
- **Karmen's tier is Creator and it is enough.** `eleven_v3_conversational` works today.

---

## 9. Where the history lives

- `docs/stage-recaps.md` — one recap per stage, appended never rewritten, with real numbers.
- `docs/bug-ledger.md` — **K1–K15**, each with symptom → root cause → fix → prevention rule.
- `docs/stage-A-order-integrity-design.md` — the Stage A design + review record.
- `docs/evidence-latency-battery-20260720/` — raw voice-model latency evidence.
- `voice-samples/` — `FINAL-D-karmen-calida.wav` (full real order on the live config),
  `HOURS-desayuno-D.wav` / `HOURS-comida-D.wav` / `HOURS-cerrado-D.wav`, plus the A–E
  voice comparison samples.
- **Generalized lessons for every future client:** `~/Projects/loga-agent-core/docs/voice-agent-bug-ledger.md`
  (V-series) and the `/loga-voice-agent-build` skill.
