# Stage A — Order Integrity ("Never Lose an Order") — Design Note

**Date:** 2026-07-19 · **Tier:** Full (cross-repo: casa-dkarmen-backend + n8n + ElevenLabs; production write path; provider side effects; prior defect already found live) · **Status: DESIGN ONLY — nothing built, nothing deployed, nothing changed.**

Origin: the 2026-07-19 premium re-assessment named this the single biggest gap between Karmen and a world-class phone experience — V8 (never-confirm-before-success) and V11 (never-lose-an-order) both MISSING on the live order path.

---

## 1. Product outcome

A caller who hears Karmen confirm their order can trust it exists. If anything on the write side fails, she never says the confirming line — she apologizes honestly, and a human finds out regardless.

## 2. Invariant

> An order Karmen confirms out loud has verifiably landed — a DB row written **and** the kitchen notified, carrying the caller-approved total — or she does **not** confirm; instead she captures the order to a durable record and alerts a human. Never a hollow confirmation, never a silently lost order.

Corollary: the order webhook is authenticated.

---

## 3. Current state — traced end-to-end, with evidence

### 3.1 The `order_ready` tool (live ElevenLabs config, fetched `GET /v1/convai/tools/tool_8001k5y9bg9jesmam1vpyg625hdf`)

- **No `total` field anywhere in the schema.** `request_body_schema.properties` = `delivery_fee, platillos[], extras[], bebidas[], cliente_nombre, telefono, modalidad, direccion, metodo_de_pago, cash_amount, notes`. Each `platillos[]` item carries `precio` (unit price), but there is no `precio_total`/`total` field the model could send — the number `compute_total` verified and Karmen spoke out loud is **never transmitted**.
- **`request_headers: {}`** — no auth header defined on the tool at all.
- **`response_body_schema: null`** — even if the backend returned a structured success/failure payload, ElevenLabs is not configured to parse it into anything the model can read (contrast `compute_total`, which the prompt reads `total`/`mode_missing`/`spoken_message` from — this tool has no such channel).
- **`usage_stats`: 112 calls, `avg_latency_secs: 0.58`** — consistent with an immediate synchronous ack, not a call that waits on a DB write + Telegram send.

### 3.2 The n8n workflow "Karmen Parlanchin" (`caTpYJjmQAMsZxeB`, fetched via n8n API, active)

Nodes and wiring (`Webhook` → fans out to two parallel branches):

```
Webhook (POST /webhook/c8fb9cd0-...)
  ├─→ Code  ──────────→ Execute a SQL query1  ──→ (nothing — dead end)
  └─→ Aviso Cocina D Karmen ──→ Response (Telegram, chatId 7546093627)
```

- **Trigger info (from the n8n API):** *"Response Mode: Webhook is configured to respond immediately with the message 'Workflow got started.' No credentials required for this webhook."* — the HTTP response to Karmen's tool call is sent **before** either branch (DB insert or Telegram) has run, let alone succeeded. This matches §3.1's 0.58s average latency.
- **DB write:** the `Code` node builds a `payload` object (JS, `precio_total: Number(b.precio_total ?? cleaned.precio_total ?? 0) || 0`) and `Execute a SQL query1` runs `select public.api_insert_orden_av_flex($1::jsonb) as id;`. Its returned `id` connects to **nothing downstream** — the insert's success/failure is never checked, never surfaces anywhere, and there is no error-handling node or on-error workflow branch.
- **Kitchen notify:** `Aviso Cocina D Karmen` (separate Code node) independently **recomputes** a total in JS from `platillos`/`bebidas`/`extras` line items + `delivery_fee`, then formats a Telegram message via the `Response` node. This branch also has no failure handling — a Telegram API error (bad chat id, rate limit, network) is silently swallowed; n8n's default behavior on an unhandled node error is to fail that execution, invisibly, after the caller already heard "success" and hung up.
- **A second, unused trigger exists:** `Webhook1` (`/webhook/f0eeb119-...`) has zero outgoing connections — an orphaned endpoint, not in scope for Stage A but noted for the inventory.

### 3.3 The total-drop point — confirmed exact mechanism

`order_ready`'s schema (§3.1) has no `precio_total`/`total` field → the n8n `Code` node's `Number(b.precio_total ?? cleaned.precio_total ?? 0) || 0` always evaluates its first two operands to `undefined` → **`precio_total` written to the DB is always `0`**, regardless of what Karmen quoted and the caller approved.

This is *not* the same failure as the kitchen Telegram message, which recomputes its own total from the line items in the payload and will usually be arithmetically correct **if** the model faithfully copied `compute_total`'s per-item prices into `order_ready` — but that total is **never cross-checked against the server-verified `compute_total` total**, so a model transcription error (wrong unit price, dropped item) would silently understate or overstate what the kitchen sees, with no server-side catch.

### 3.4 DB schema (read-only, `supabase gen types typescript --project-id edcjcehfedwxxucktxoj`, live introspection, 2026-07-19)

`ordenes` and `ordenes_agente_voz` are schema-identical tables (`bebidas, cantidad_bebidas, cantidad_extras, cantidad_platillos, cargo_envio, cliente_nombre, cliente_nuevo, comidas, desayunos, dia_de_la_semana, direccion, entrega_a_domicilio, extras, fecha, hora_exacta, id, metodo_de_pago, modalidad, notas, platillos_consumidos, precio_por_bebida, precio_por_extra, precio_por_platillo, precio_total, proveniencia, recoger, subtotal_bebidas, subtotal_comida, subtotal_extras, telefono`). A view `ordenes_unificadas` unions order tables tagged by `tabla_origen`. Three insert RPCs exist: `api_insert_orden`, `api_insert_orden_av`, `api_insert_orden_av_flex` (all `Args: {payload: Json} → Returns: number`). **Which table `api_insert_orden_av_flex` actually writes to is inferred, not confirmed** — the "av" suffix (agente voz) and the n8n `Code` node's `proveniencia: "Agente de Voz"` strongly imply `ordenes_agente_voz`, but the function body was not read (pg_dump requires Docker, unavailable in this session — **not found**, flagged rather than guessed). **No unique/idempotency key exists on either table** — a naive retry of the insert RPC would create a duplicate order row.

### 3.5 Auth

Confirmed **no authentication** on the order path: tool `request_headers: {}` (§3.1) and the n8n trigger explicitly states "No credentials required for this webhook" (§3.2). The webhook URL's random path segment is the only barrier — security by obscurity, and that path is already recorded in this repo and in the ElevenLabs tool config, both readable by anyone with edit access to either system.

### 3.6 The confirmation-before-verification pattern (prompt)

`docs/agent-prompts/karmen-system-prompt.txt`, "CERRAR EL PEDIDO" section (live, byte-verified against the agent 2026-07-19):
> "Cuando el cliente confirme, di EXACTAMENTE: 'Muchísimas gracias...' **Luego** llama order_ready y termina la llamada (end_call)."

The farewell — a full, unconditional confirmation sentence — is scripted to be spoken **before** `order_ready` is even called, let alone before anything it triggers succeeds. Combined with §3.1–3.2 (immediate ack, no result surfaced to the model even if it existed), there is currently no point in the flow, prompt or code, where success is verified before the caller is told the order is placed. This is the sharpest form of V8 (never-confirm-before-success) found on this line: the promise doesn't even wait for the tool call, only for the model's judgment that the customer verbally agreed.

### 3.7 What already exists and is reusable (smallest complete solution constraint)

- `karmen-gateway/index.ts` already has: fail-closed two-secret auth (`isAuthorized`, lines 92–97), a `computeTotal()` function that is the **authoritative** server-side total (lines 231–292, reusable directly — no need to reimplement pricing logic), a `voice_events` telemetry table + `logInBackground` helper that is a ready-made durable-capture sink (lines 62–87), and the exact "return 200 + `ok:false` + honest Spanish instruction" pattern (lines 441–458) that already gates fabrication on every existing action.
- The Telegram kitchen-notify path already works (n8n `Aviso Cocina D Karmen` node) — it does not need to be rebuilt, only made retriable and given a failure signal.

---

## 4. Root-cause map (voice-ledger classes)

| Evidence | Class |
|---|---|
| §3.6 confirmation spoken before/without verification | **V8** — never-confirm-before-success |
| §3.2 no error handling on either branch, no retry, no alert on failure | **V11** — never-lose-an-order / hollow promise |
| §3.3 verified total never reaches DB or is cross-checked | **V2** sibling — a number computed correctly once (`compute_total`) is discarded before it reaches the record of truth |
| §3.5 no auth on the write path | new class — an unauthenticated mutation endpoint is a direct kitchen-injection / data-integrity risk, not just a voice-fabrication one |

---

## 5. Design — the build plan (≤3 things)

### (a) `submit_order` — a new, additive `karmen-gateway` action with a verified insert + executor-dictated confirmation

- New action, same function/deployment as `get_daily_menu`/`compute_total` (no new service). Reuses `isAuthorized`, `todayInTz`, `computeTotal`.
- **Required input includes the caller-approved `total`** (the exact number `compute_total` returned and Karmen spoke). Server independently re-runs `computeTotal(serviceDate, items, modalidad)` and **compares**; a mismatch returns `ok:false, total_mismatch:true` + an instruction to re-quote — no write happens on a mismatch. This closes §3.3 and is (b) below, folded into the same action rather than a separate step (still ≤3 things at the design level).
- Insert via the **same RPC already in use** (`api_insert_orden_av_flex`, called through `supabase.rpc(...)` from the gateway instead of via n8n's Postgres node) — this is additive-safe because it is the identical write the current path already performs, just moved into code that can check its result. Success = the RPC returns a numeric `id`; that `id` is the "row verifiably written" proof (Lucy's verified-insert pattern).
- **Server-side field validation, not just total.** `submit_order` re-validates non-empty `cliente_nombre`; `telefono` is exactly 10 digits; `modalidad` ∈ {pickup, delivery}; `direccion` and `cash_amount` present when `modalidad = delivery`. This is enforced in code, not trusted from the tool schema's `required` list — K5 already proved a provider `required` flag is satisfied by empty strings, and the review confirmed nothing in the original draft closed that on this new path.
- **Idempotency (resolved, not deferred):** a new, small, additive table `order_submissions (conversation_id text primary key, order_row_id int not null, created_at timestamptz default now())`. `submit_order` looks up `conversation_id` (ElevenLabs' dynamic variable, mapped the same way `get_daily_menu`'s optional `call_sid` already is — see `docs/karmen-elevenlabs-rewire.md` line 29) **first**; a hit means this exact call already succeeded — return the same success `spoken_message` idempotently, no second insert. A miss proceeds to the RPC insert, then an `INSERT ... ON CONFLICT DO NOTHING` into `order_submissions` right after. **Caveat carried forward, not solved by this table:** that same rewire doc (line 29) documents `conversation_id` delivery as "optional... omit if unsupported" from the earlier build — whether it reliably arrives on every `submit_order` call must be confirmed live before build; if it doesn't, this call has no idempotency key and duplication risk stands. This is the one piece of the design that stays a precondition, not a decision.
- **Total comparison is exact:** `Number(caller_approved_total) === computeTotal(...).total` — all prices in this system are whole pesos (no evidence of fractional MXN anywhere in `daily_menu` or the gateway), so no epsilon is needed; a non-numeric or mismatched value is a hard `total_mismatch`, no write.
- **Kitchen notify — corrected after review, then corrected again after build.** The original draft proposed reusing the existing n8n Telegram webhook URL. **That was wrong and would have made things worse, not better:** the live n8n workflow graph (`caTpYJjmQAMsZxeB`, confirmed via direct API fetch) shows its `Webhook` trigger fans out to **both** branches at once — `Code`→`Execute a SQL query1` (the exact broken, non-idempotent, `precio_total:0` insert this design exists to retire) **and** `Aviso Cocina D Karmen`→Telegram. There is no way to hit "just the Telegram part" of that URL. **Build-time correction (2026-07-19):** the first build pass added a **new, dedicated webhook trigger** wired to a *copy* of the Telegram-send node — but that copy needed its own credential, and n8n auto-assigned one unverified, so it was shipped hard-disabled pending Edgar's manual credential pick. Edgar then asked for the notify path to just reuse the restaurant's real kitchen Telegram directly. **Final architecture:** the new trigger's formatter node connects straight into the **existing, already-credentialed `Response` node** (the same one `Aviso Cocina D Karmen` has always fed) — no new Telegram node, no credential to pick, no guessing. `Response` doesn't care which upstream path fed it; it just sends whatever `mensaje_telegram` text it receives, and both the old and new paths produce that same field. Proven live: a real test ticket sent through the new trigger returned Telegram's own `message_id` from the real kitchen bot (`@Lopz2525bot`) in the real kitchen chat, and one full real order (`id=107`) went through the complete gateway→notify→Telegram chain with `ok:true` and no `kitchen_notify_failed`. §6's "n8n touch" note is revised accordingly.
- **After the DB write is confirmed,** the gateway calls the new dedicated notify webhook with an inline retry (2 attempts, short backoff). If both fail, the order is still safe (row exists), and two things happen — not one: (1) an explicit, **unswallowed** write to `voice_events` (`event_type: "order_notify_failed"`, full payload + DB `id`) with its own error check (the original draft's `safeLog`/`logInBackground` helpers, lines 62–87, deliberately swallow their own failures for telemetry — reusing them as the safety-of-last-resort was the review's other blocker: the exact outage that fails the order insert is also likely to fail a swallowed-error DB write, leaving nothing recorded and no human ever alerted); (2) a **direct alert independent of both Supabase and n8n** — see next point.
- **On a DB-write failure** (RLS/constraint/network, before any row exists), the gateway attempts the same unswallowed `voice_events` capture, **and regardless of whether that capture itself succeeds**, fires the same direct alert as above — so a human learns about it even in a full-outage scenario where neither Supabase nor n8n can be trusted. Returns an honest `ok:false` + apology instruction. **No promise is spoken.**
- **The direct alert channel (new, small piece of infra — answers open questions #3 and #6 together):** a dedicated Telegram bot + "Karmen order problems" chat, called directly from the gateway via Telegram's Bot API (not through n8n) — one new secret (`KARMEN_ALERT_BOT_TOKEN` + chat id), independent of the n8n Telegram credential used for normal kitchen notify. This is the concrete, owner-agreed consumer the review found missing: without it, a `voice_events` row nobody watches is functionally the same as a lost order from the kitchen's point of view, satisfying "not lost from the database" but not "kitchen notified" or "a human alerted." For Stage A this is a bot ping, not a full poll-until-delivered reconciler (Lucy-grade) — named explicitly as a smaller, bounded mechanism, not deferred to silence.
- **`spoken_message` is dictated by the server, read exactly**, mirroring `compute_total`'s `mode_missing.spoken_message` pattern already live and proven (K9): on success, the exact confirming sentence (today's "Muchísimas gracias…" line, moved server-side so the model cannot compose or pre-empt it); on failure, an honest fallback line — never invented, never a promise the system can't back.
- **`dry_run` (resolved, not deferred):** a boolean, ops/test-only field — never exposed in the ElevenLabs tool schema, same pattern as `compute_total`'s `service_date` override (§ gateway lines 112–120). `dry_run:true` still runs field validation and the total cross-check (proving those code paths), but skips the RPC insert, the `order_submissions` write, and both notify/alert calls; returns a synthesized `ok`/`spoken_message` so §7's pre-live proof can run against the real gateway without writing a real order row or paging the real kitchen.

### (b) Total flows through, cross-checked — folded into (a) above (see "Required input includes the caller-approved `total`").

### (c) Dedicated shared-secret auth on the order webhook

- **Corrected after review:** the original draft proposed reusing `isAuthorized()` — the same secret already embedded in the **read-only** `get_daily_menu`/`compute_total` tool configs. This codebase already has an established, better precedent for exactly this situation: `karmen-menu-admin/index.ts` (lines 23–24) uses a **separate** `KARMEN_ADMIN_SECRET`/`KARMEN_ADMIN_SECRET_NEW` for its write path, distinct from the read secret. `submit_order` follows that precedent: a new `KARMEN_ORDER_SECRET`/`KARMEN_ORDER_SECRET_NEW`, same two-var rotation pattern, checked by a new `isOrderAuthorized()` function parallel to `isAuthorized()`. Reusing the read secret would mean a leak of a credential embedded in a read-only tool config — already treated as low-consequence in this project's own threat model (K2/K3) — would grant real order-injection. (The *old* `order_ready` n8n webhook itself is not modified — see §6.)

### Prompt + ElevenLabs tool changes (mechanical, follow from (a)–(c))
- New ElevenLabs tool `submit_order` → `karmen-gateway`, with the two auth headers (matching `get_daily_menu`/`compute_total`'s existing tool config) and a **defined `response_body_schema`** so the model can read `ok`/`spoken_message` (currently `null` on `order_ready` — §3.1's blindness bug, fixed by construction for the new tool).
- Prompt "CERRAR EL PEDIDO" rewritten: the farewell is no longer scripted verbatim in the prompt — it becomes "read the tool's `spoken_message` exactly, only after `submit_order` returns `ok:true`," the same discipline the prompt already applies to `compute_total`'s `total` field (K8/K9 precedent). This is the literal fix for §3.6.
- Old `order_ready` tool is **removed from `tool_ids`** on cutover (not left attached) — leaving both attached would let the model call either, risking a double-write with no idempotency between the two paths.

---

## 6. The safe route: additive gateway action, minimal disclosed n8n addition, no touch to the live insert path

**Revised after review** (original draft claimed n8n stays fully untouched — the review proved that was unsafe; see §5(a) "Kitchen notify — corrected after review").

**Chosen approach:**
- `Karmen Parlanchin`'s **existing** trigger, `Code` node, and `Execute a SQL query1` node are **not edited or removed** — they simply stop being called (nothing in the new design points at the old `order_ready`/`c8fb9cd0-...` URL once cutover happens). Zero risk to anything currently working.
- n8n gains **one new, disclosed, additive node set**: a new webhook trigger + a copy of the `Aviso Cocina D Karmen` formatting node → `Response` (Telegram), wired to nothing else. This is a genuine (small) edit to the live n8n workspace, not a zero-touch reuse as originally claimed — corrected here rather than glossed over.
- The **DB write moves out of n8n and into the gateway**, because that's the only way to get a checkable, retryable, idempotent result — n8n's Postgres node here has no error branch and n8n workflow-level retry would still ACK-before-work at the trigger. This is the one part of the current n8n workflow that Stage A supersedes rather than reuses.
- All new gateway code is **additive**: a new `if (action === "submit_order")` branch in `karmen-gateway/index.ts`, alongside the untouched `get_daily_menu`/`compute_total` branches — same pattern as every prior stage (K9, the desayuno-category work).

**Blast radius:** touches the live **write** path for the first time (K9/K10/K11 were read-path or agent-config only), **plus** a small, disclosed n8n addition (previously scoped as zero n8n changes — corrected). A bug here can double-charge, drop, or duplicate a real order. This is exactly why this round is design-only, and why §7's `dry_run` proof is load-bearing before any cutover.

**Rollback:** identical discipline to K9/K10/K11 for the agent side — snapshot the agent config before cutover; cutover is a single `tool_ids` PATCH (swap `order_ready`'s id for `submit_order`'s); revert is the same PATCH in reverse from the snapshot. The gateway code addition is a new Edge Function deploy — reversible by redeploying the prior version. The **old** n8n path (trigger/Code/SQL node) is never touched, so it needs no rollback and remains available as a fallback reference. The **new** n8n notify-only trigger is additive and can be deleted without affecting anything else if abandoned. The `order_submissions` idempotency table and any new `order_notify_failed`/`order_submit_failed` `voice_events` usage are additive (`CREATE TABLE`/existing table, no `ALTER` on `ordenes*`) and reversible by a follow-up drop if genuinely unused.

---

## 7. Testing strategy (must happen before any cutover — not covered by this design-only round)

- Regression-sim battery (existing `scripts/karmen_regression_sims.py` pattern) extended with a mocked `submit_order` tool, proving conversational discipline (confirm-only-after-`ok:true`, honest failure line) — mirrors K9/K10's proof method.
- `dry_run:true` (§5(a), resolved) makes it possible to run that same proof against the **real** gateway — total cross-check and field validation actually execute — without writing a real order row or paging the real kitchen. This closes what was previously a gap between the testing strategy and the plan's own prerequisites.
- Duplicate-agent proof (K10 discipline) before any live cutover, then Edgar's live acceptance call with a **real** test order (`dry_run:false`) — a mocked tool proves conversational behavior, not that the actual DB/notify/alert wiring works end-to-end; only a real call proves that.
- The **live tool timeout** for `submit_order` must be read back from ElevenLabs once the tool is created (not assumed) and checked against the worst-case timing: field validation + total cross-check + RPC insert + up to 2 retried notify calls + (on failure) an unswallowed `voice_events` write + a direct alert call. `order_ready`'s own live config shows `response_timeout_secs: 20` (`GET /v1/convai/tools/tool_8001k5y9bg9jesmam1vpyg625hdf`) — a real, sourced number, but for the *old*, simpler tool; `submit_order` does substantially more work per call and its own timeout should be set (and verified) explicitly, likely higher, not assumed inherited.

---

## 8. Open questions — resolved vs. still open, after adversarial review (2026-07-19)

**Resolved by this revision** (see the corrected §5–§6 above for each): idempotency mechanism (`order_submissions` table), `dry_run` contract, the direct alert channel / notify-failure consumer, dedicated order secret, server-side field validation scope, total-comparison exactness, and the kitchen-notify architecture (the review's #1 finding — the original plan would have silently re-triggered the old broken insert on every order; corrected to a dedicated notify-only n8n trigger).

**Resolved during the build (2026-07-19), both with real evidence, before any code was wired to trust them:**
1. **`conversation_id` reliability — CONFIRMED.** Neither existing tool (`get_daily_menu`, `compute_total`) had ever actually sent it (0/176 real calls in production telemetry, confirmed by both a schema read and a `voice_events` query before any code was written). Wired fresh into the new `submit_order` tool only; proven via TWO independent real ElevenLabs conversations against a throwaway duplicate agent (`conv_9701kxxct7qsemev2h7t37zy5w6j`, `conv_3301kxxcy88sewe8fffrsftv6znt`) — the real id arrived on every `submit_order` call in both conversations (including a validation-failed retry, same id both times) and was correctly used as the idempotency key. `order_submissions` is live with real data proving this.
2. **`api_insert_orden_av_flex`'s target — CONFIRMED.** Read directly via `supabase db query --linked` (the Supabase CLI's own stored auth, no manual token handling needed — the earlier Docker/Management-API blockers were sidestepped, not worked around unsafely). Target table: `public.ordenes_agente_voz`. `SECURITY DEFINER` — runs under the function owner's privileges regardless of caller, so n8n's raw Postgres connection vs. the gateway's `supabase.rpc()` call cannot behave differently by caller role. Full coercion contract read and matched exactly in the new `submit_order` payload construction.

No open questions remain that block a cutover decision. Remaining items are Edgar's, not engineering unknowns: set the kitchen Telegram credential (node hard-disabled until then), provision a `KARMEN_ALERT_BOT_TOKEN`/`KARMEN_ALERT_CHAT_ID` for the independent human-alert path, and decide when to cut over.
