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
- KB (4 docs): Extras · Bebidas · **`xpNJs3xDhFwI8Ymv436i` "Información (horarios corregidos)" — CORRECTED HOURS, pushed live 2026-07-20, see §4** · Menú de Desayunos
- `conversation_initiation_client_data_webhook`: **SET** (2026-07-20) → `…/karmen-gateway`,
  headers `Authorization: Bearer <anon>` + `x-karmen-secret`, no now-override. Overrides
  `agent.first_message` + `agent.prompt.prompt` enabled. `KARMEN_HOURS_ENFORCED=true`.

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

### V6 — business hours + service windows: **LIVE and ENFORCED** ✅ (cut over 2026-07-20 ~13:44 MZT)
Rules (America/Mazatlan, no DST): open **7:50 AM–4:50 PM**; closed 4:50 PM–7:50 AM;
**Sundays closed all day**; **7:50–11:30 = desayunos only**; **11:31–4:50 = comidas only**.
Bebidas + extras stay available in BOTH windows (the free-tea promo is a `bebida`).

- Enforced **in code** in `karmen-gateway`: window-filtered menu, closed short-circuit
  with a server-dictated warm message, and server-side refusal of `compute_total` /
  `submit_order` when closed or off-window (off-window returns **no total at all**).
- **`KARMEN_HOURS_ENFORCED=true`** (flipped 2026-07-20, gateway redeployed to pick it up
  — the flag is read at module load). The gateway is SHARED by live and duplicate; the
  flag was default-off through the whole build precisely so the deploy couldn't change
  live. Cutover was run by `scripts/hours_cutover.py` with auto-rollback on any failed
  gate; all three gates passed (tool-path enforcement live, field-diff clean, webhook
  open/closed correct). Snapshot: `.karmen-agent-rollback-20260720-154448-hours-cutover.json`.
- **Conversation-initiation webhook is now SET on live** — url `…/karmen-gateway`, headers
  `Authorization: Bearer <anon>` + `x-karmen-secret` (NO now-override on live), and the
  two overrides `agent.first_message` + `agent.prompt.prompt` enabled. So a closed-time
  caller gets a server-dictated closed greeting + a prompt that forbids menu/order/transfer.
- **47/47 boundary assertions pass** (`scripts/hours_boundary_battery.py`); the shadow
  layer was corrected (V18) and re-proven before flipping (`scripts/shadow_hours_report.py`).
- **K15 gap closed:** hours are also injected at **conversation initiation** (see §4),
  because a caller can ask "¿están abiertos?" without firing any tool.

> **The ONE link not machine-provable:** that ElevenLabs actually *invokes* the initiation
> webhook on a real inbound PSTN call. The gateway half is fully proven (it returns the
> closed override at closed times — verified live). A WebSocket harness sends its own
> initiation data, so only a real phone call closes this. **This is Edgar's one action — see §3.**

---

## 3. What's left — Edgar's ONE action (everything else is DONE)

The cutover (enforcement flag + initiation webhook + corrected KB doc) is **complete and
self-verified on live** as of 2026-07-20. The only thing engineering cannot do is
originate a real inbound PSTN call: the LoGa Twilio account is **not authorized to dial
+52 Mexico** (error 21215), and enabling MX geo-permissions is an account-wide
toll-fraud/financial control that also affects Lucy & Lisa — owner's call, not automatable.

### Edgar: call **+526873350709** from your phone, TWICE — this is the definition of done
1. **During open hours (before 4:50 PM, not Sunday)** — confirm she offers only the
   CURRENT window's mains (comida after 11:31 / desayunos before 11:30), still offers the
   free té Jazmín on pickup, and an order lands with the correct total.
2. **After 4:50 PM (or any Sunday)** — confirm she opens with the closed message, states
   the real hours (7:50–4:50), **refuses to take an order, does not transfer**, and hangs up.

> **Call #2 is the whole point.** It is the ONLY way to prove the one link still
> unproven: that ElevenLabs actually invokes the initiation webhook on a real inbound
> phone call. The gateway half IS proven (it returns the closed override at 22:00 and on
> Sundays — verified live 2026-07-20). WebSocket harnesses send their own initiation data,
> so they structurally cannot prove the platform's invocation. Until call #2, the closed
> path is *implemented and gateway-proven*, **not** end-to-end proven.

Verify both calls from telemetry + DB, not the transcript alone:
```bash
# a real PSTN call carries a call_sid; a test-chat/simulate does not
select id,event_type,call_sid,payload->>'window',created_at at time zone 'America/Mazatlan'
  from voice_events where call_sid is not null order by id desc limit 20;
# the open-hours order row (correct total, correct window items)
select id,cliente_nombre,modalidad,precio_total,fecha from ordenes_agente_voz order by id desc limit 5;
```

---

## 4. Corrected hours KB doc — **DONE on live (2026-07-20)** ✅

Previously: live Karmen told callers **8:00 AM–5:00 PM with no Sunday rule** and
could claim to be open on a Sunday (old doc `DUinhY6brFXOlQlVNyKI`).

**Applied 2026-07-20, owner-authorized, as a STANDALONE truthfulness fix** — deliberately
*not* bundled with the hours cutover. The corrected doc `xpNJs3xDhFwI8Ymv436i`
("Información Casa D Karmen (horarios corregidos 2026-07-20)", source of truth
`docs/kb-informacion-corrected.md`) replaced it in the agent's `knowledge_base`.
It states 7:50–4:50, desayunos to 11:30, comida from 11:31, **domingos CERRADO** —
everything else verbatim, **promo/$20 fee/no-transferencias untouched** (both docs
were content-read before the swap, per scar 27).

- Snapshot: `.karmen-agent-rollback-20260720-131106-pre-kbdoc.json`
- Field-by-field diff vs snapshot: **only** `knowledge_base[2]` `.id`/`.name`/`.type`
  changed (+ `version_id`). Prompt (7814 chars), LLM, temperature, tool_ids,
  first_message, TTS model/voice, ASR all verified byte-identical.
- Verified live: states 7:50 / 4:50 and "los domingos sí cerramos todo el día";
  no trace of the old 8:00/5:00. Regression gate **ALL PASS** (mode-before-price,
  exact totals, verbatim farewell, honest empty menu) — the ordering path is unblocked.
- **`KARMEN_HOURS_ENFORCED` still unset and the initiation webhook still `null`** —
  this change touched neither. The §3 cutover is fully independent and still pending.

> The old doc `DUinhY6brFXOlQlVNyKI` was **detached, never deleted** — it remains in
> the ElevenLabs KB for rollback.

**KB docs are authoritative business truth and must never be deleted** — they carry the
real hours, payment rules, the $20 delivery fee, and the promotions.

---

## 5. Rollbacks (all one-liners, all tested paths)

| Change | Rollback |
|---|---|
| **Warm/D voice cutover (Stage B)** | `./scripts/rollback-warm-cutover.sh` — restores prompt, temperature, first_message, tool_ids, tts model/expressive, speculative_turn from `.karmen-agent-rollback-20260720-092953-warm-cutover.json` |
| **Hours enforcement** (now ON) | `supabase secrets unset KARMEN_HOURS_ENFORCED --project-ref edcjcehfedwxxucktxoj && supabase functions deploy karmen-gateway --project-ref edcjcehfedwxxucktxoj` (the flag is read at module load, so the redeploy is required to actually revert) |
| **Initiation webhook + overrides** (now SET) | Restore `platform_settings.overrides` + `workspace_overrides` from `.karmen-agent-rollback-20260720-154448-hours-cutover.json` (sets the webhook back to null and the two override booleans back to false). `scripts/hours_cutover.py` does this automatically on any failed gate. |
| **Corrected KB doc** (applied 2026-07-20) | PATCH `knowledge_base[2]` back to `{"type":"file","name":"Untitled document-2.docx","id":"DUinhY6brFXOlQlVNyKI","usage_mode":"auto"}` — the original was detached, never deleted. Full pre-state: `.karmen-agent-rollback-20260720-131106-pre-kbdoc.json` |
| **Initiation webhook** | PATCH `platform_settings.workspace_overrides.conversation_initiation_client_data_webhook = null` |
| **Any agent change** | Every snapshot is `.karmen-agent-rollback-<ts>-<label>.json` in the repo root — PATCH the fields back |

---

## 6. Open owner decisions (engineering has no say)

1. ~~**Hours cutover**~~ — **DONE 2026-07-20** (flag + webhook + KB all live, self-verified).
   Remaining: Edgar's two real calls (§3), the only end-to-end proof of webhook invocation.
2. ~~**Corrected hours KB to live NOW?**~~ — **RESOLVED 2026-07-20**: authorized and
   applied standalone. See §4. (Live now states the correct hours and the Sunday closure.)
3. **Failure-alert bot** — `KARMEN_ALERT_BOT_TOKEN` / `KARMEN_ALERT_CHAT_ID` are still
   **unprovisioned** (needs a @BotFather bot + chat id). Today a capture-worthy failure
   is durably logged to `voice_events` but **no human is pinged**. Accepted fast-follow,
   not an oversight — the gateway reports `alert_credential_missing` honestly rather
   than faking success.
4. ~~**Test rows in `ordenes_agente_voz`**~~ — **CLEANED 2026-07-20** (owner-authorized).
   Deleted ids **104, 105, 106, 110–117** (11 rows: STAGE-A-TEST-PROOF, Juan Pérez ×4,
   Ulises López ×4, Unisys Locos, Denise). Full pre-delete snapshot at
   `docs/evidence-cutover-20260720/deleted-test-rows-snapshot.json` (re-insertable).
   **Kept, flagged for Edgar:** #108 (the documented Stage-A proof row); #107
   (`PRUEBA FINAL SISTEMA` — a test but outside the authorized range, not deleted);
   ids 100–103 (older null-name partials). **Say the word to delete 107 and 100–103 too.**
5. ⚠️ **Row #118 — anomaly, left in place.** Appeared 13:32 MZT 2026-07-20: Lomo Mechado,
   $145, but **null name/phone/modalidad** and **no submit_order telemetry**. The live
   gateway's `submit_order` rejects null name/phone/modalidad (K5), so #118 **did not come
   through the voice gateway** — it was written by some other path (direct insert, WhatsApp
   agent, or a dashboard test). Provenance uncertain, so I did **not** delete it. Edgar:
   confirm what wrote it; if a test, remove it. (It carries no `call_sid`/`conversation_id`,
   so it is **not** evidence of a real inbound voice call.)
6. **Muletillas** ("órale/sale/va") — in and live; Edgar's ear decides if they stay.
7. **n8n kitchen Telegram credential** — the Stage-A notify node feeds the same
   already-credentialed `Response` node the real orders always used (no new credential
   was trusted). Confirm this stays the intended path.
8. 🔐 **Twilio auth token exposed — rotate.** Proving call-origination required listing the
   Twilio account via the n8n `LoGa Number` credential; Twilio's `Accounts.json` returns
   `auth_token` in plaintext, now sitting in n8n execution logs (execs 69967 and the
   archived TEMP workflows). No call was placed (MX dialing is not authorized — error
   21215). Recommend rotating `TWILIO_AUTH_TOKEN` and clearing those execution logs.

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
- `docs/bug-ledger.md` — **K1–K16**, each with symptom → root cause → fix → prevention rule.
- `docs/stage-A-order-integrity-design.md` — the Stage A design + review record.
- `docs/evidence-latency-battery-20260720/` — raw voice-model latency evidence.
- `voice-samples/` — `FINAL-D-karmen-calida.wav` (full real order on the live config),
  `HOURS-desayuno-D.wav` / `HOURS-comida-D.wav` / `HOURS-cerrado-D.wav`, plus the A–E
  voice comparison samples.
- **Generalized lessons for every future client** — three reusable assets in
  `~/Projects/loga-agent-core/`, none of them client-specific:
  - `docs/voice-agent-bug-ledger.md` — **V1–V17**, the bug CLASSES (V12–V17 came from
    this build), each with the guardrail that prevents it.
  - `.claude/skills/loga-voice-agent-build/` — the `/loga-voice-agent-build` skill: the
    staged path (order integrity → model/leak hardening → naturalness/voice → hours)
    with the proof gate for each stage.
  - `tools/voice-agent-toolkit/README.md` — the eight harnesses (the same ones in
    `scripts/` here) plus per-tool instructions for pointing each at a NEW client.
    Every script in `scripts/` is byte-identical to its counterpart there.
