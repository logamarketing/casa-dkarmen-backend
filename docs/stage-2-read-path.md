# Stage 2 — Read path + rewire Karmen (design + architect verdict)

**Date:** 2026-07-04 · **Project:** Casa D Karmen Project (`edcjcehfedwxxucktxoj`) · **Level 1** (voice-gateway pattern, cloned from Lisa).

## Goal
Karmen reads **today's** menu live from `daily_menu` instead of her hardcoded
prompt. The $110→$120 fix lands automatically (DB is the source of truth).
Count-agnostic: she reads whatever rows exist. Proven with ONE real call.

## The ≤3 new things
1. **`karmen-gateway` edge function** — one action `get_daily_menu`.
2. **`voice_events` table** — best-effort telemetry (menu_not_set signal, errors, latency).
3. **ElevenLabs `get_daily_menu` tool + prompt rewire** (lockstep; Cowork applies).

## Verified facts (live, 2026-07-04)
- `daily_menu` has **38** rows for 2026-07-04 (21 comida @120 / 11 bebida @25 / 6 extra 0–15). RLS on, no policies.
- No `voice_events` table exists yet (only chat_context, daily_menu, n8n_chat_histories, ordenes, ordenes_agente_voz, view ordenes_unificadas).
- Karmen agent `agent_9901k5y1nqype69akbe3j8swwwat`, `es`, voice `qpw1Pr9hKQ9lsPLpeNcM`, temp 0.15, stability 0.18, similarity 0.5. Tools: `order_ready`→n8n, `end_call`; system End-conversation + Transfer-to-number ON.
- Karmen's prompt hardcodes the menu and says "$110" (undercharging).
- Supabase MCP cannot reach this org → deploy via **CLI `--project-ref` + `$SUPABASE_ACCESS_TOKEN`** (no DB password, `loga-agent-core` link untouched).

## `karmen-gateway` — `get_daily_menu`
**Auth (fail-closed, cloned from Lisa):** `verify_jwt=true` (platform checks `Authorization: Bearer <anon>`) **+** `x-karmen-secret` header matched against two rotating env secrets (`KARMEN_SHARED_SECRET` / `KARMEN_SHARED_SECRET_NEW`). Neither set OR no match → 401. Raw DB text never reaches the model.

**"Today":** resolved in **America/Mazatlan** (Sinaloa, UTC-7, no DST) via `Intl.DateTimeFormat('en-CA', {timeZone})` — **never UTC**. Optional `service_date` body override is accepted for ops/tests only and is **not** in the ElevenLabs tool schema (the model always gets today). A malformed override → 400 (never a silent wrong day).

**Read:** service role (bypasses RLS) → `select category,item_name,price,sides,sort_order from daily_menu where service_date=<today> and is_available=true`. Group into `comida|bebida|extra`, each sorted by `sort_order` (nulls last). Price coerced to a number; a non-finite price drops that item + logs (truthfulness, V1/V2 — never read a broken price).

**Response (has menu):**
```jsonc
{ "ok": true, "service_date": "2026-07-04", "timezone": "America/Mazatlan",
  "menu_available": true, "currency": "MXN", "item_count": 38,
  "menu": { "comida": [{"name":"Cazuela","price":120,"sides":"arroz"}, ...],
            "bebida": [{"name":"Té de Jazmín","price":25}, ...],
            "extra":  [{"name":"Aguacate extra","price":15}, {"name":"Cuchara extra","price":0}, ...] } }
```
**Response (no rows for today) — `menu_not_set`, NEVER a stale day:**
```jsonc
{ "ok": true, "service_date": "2026-07-05", "timezone": "America/Mazatlan",
  "menu_available": false, "menu_not_set": true, "item_count": 0,
  "menu": {"comida":[],"bebida":[],"extra":[]},
  "instruction": "El menú de hoy aún no está cargado. No inventes platillos; ofrece verificar o transferir con una persona." }
```
**DB error →** `ok:false, error:{code:"temporarily_unavailable", message:"<Spanish instruction, never read aloud>"}`, 500. Unknown/missing action → 400.

**Latency (V3):** one small indexed SELECT; short cache keyed by `service_date` (TTL `KARMEN_MENU_CACHE_MS`, default 15s — short so a sold-out flip reflects fast); telemetry via `EdgeRuntime.waitUntil` (off the response path).

## `voice_events` (telemetry)
`id, call_sid text, event_type text, payload jsonb, created_at`. RLS on; service role writes. Logs `get_daily_menu` (item_count, menu_not_set, ms, cache_hit), `error`, `unauthorized`. Additive; unrelated to `ordenes`/n8n.

## ElevenLabs rewire (Cowork applies in lockstep — I produce exact text/JSON)
- **Delete** the hardcoded menu block and the "$110 / cada platillo cuesta" line — **no menu facts remain in the prompt.**
- **Add** the `get_daily_menu` webhook tool; enum/name matches the gateway **exactly**; headers carry `Authorization: Bearer <anon>` + `x-karmen-secret`.
- **Prompt rules** (Lisa-proven shape): RULE #0 speak-before-tool (V3); read the menu the tool returns and nothing else (V1/V2); on `menu_not_set` offer to check / Transfer-to-number, never invent (V6); never confirm a dish/price not in the tool result.
- **Cheap live-call defect fixes folded in** (all prompt-side): give a clear **order total** by summing the tool-provided prices (removes the forbidding rule); read numbers/prices **naturally** in Spanish ("ciento veinte pesos", "sin costo" for 0); **never read system/internal text aloud**; **say nothing after `end_call`**; one consolidated filler policy.
- **Recommended (Cowork's call):** align voice to Lisa — stability 0.18→0.45, similarity 0.5→0.75.

## Deferred (stated, not silently dropped)
- **`quote_order` grounded-total action** (DB computes the sum) — only if model arithmetic on the totals proves unreliable. Stage 2 sums tool-provided prices in-prompt (round numbers, 2–4 items — reliable).
- Any ElevenLabs platform config beyond prompt/tool/voice (post-`end_call` TTS at the engine level) — Cowork's domain if the prompt rule doesn't fully settle it.

## Bug-ledger pre-flight
- **V1/V2 fabrication/numbers-from-memory:** every menu fact from the tool; nothing in the prompt. ✅
- **V3 dead air:** speak-before-tool + one call/turn + short cache + waitUntil telemetry. ✅
- **V4 tool-schema gap:** enum `["get_daily_menu"]` == gateway action; ship lockstep; not done until the agent invokes it live. ✅
- **V6 over/under-transfer:** menu_not_set pairs "can't answer" with an alternative (check / transfer). ✅
- **V7 "looks right":** DoD = real runtime (gateway proven by live HTTP; agent proven by one live call). ✅
- **Core B12 stale-read:** menu_not_set never falls back to another date. ✅
- **Guardrail:** additive only; `ordenes*`/`chat_context`/`n8n_chat_histories`/`ordenes_unificadas`/n8n webhook untouched. Never leave Karmen broken — keep her current prompt until the rewire is proven.

## Architect verdict: **GREEN**
Single read action, additive, fail-closed, cloned from a shipped reference. Risk is low and bounded; the one true gate is the live call (Cowork verifies independently). Proceed to build → adversarial review → deploy → prove → hand off artifacts.
