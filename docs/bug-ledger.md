# Bug Ledger — Casa D'Karmen (and the voice-client onboarding process)

*Every bug we've caught bringing up the Karmen voice agent — and, more usefully,
the **process** bugs that make the NEXT voice client slower. Consult before each
stage and at every new-client kickoff. Append, never rewrite. Started 2026-07-05.*

Sibling ledgers: the engine's code-invariant bugs live in
`loga-agent-core/docs/bug-ledger.md` (B-series); the voice-fabrication classes
(V1/V2/V4/V7) referenced in `karmen-elevenlabs-rewire.md` live in the
agent-core voice ledger. This file holds the **client-onboarding / operability**
classes — the ones about getting a new brand live, not about the code.

## How to use this
- **At client kickoff / before a stage:** read the prevention rules below as a
  pre-flight checklist. Most delays on the next client will rhyme with one of these.
- **After a bug is caught:** add an entry — symptom, root cause, prevention rule,
  and who/what caught it. The prevention rule is the transferable asset.

---

## Ledger

### K1 — CREDENTIAL HANDOFF STALL
- **Symptom:** The whole ElevenLabs rewire was blocked for a session — no tool could be created, no prompt swapped — because the ElevenLabs API key never actually reached the builder.
- **Root cause:** The key was delivered by `!printf '…' > .el_key`, which **silently failed twice** (the file was empty/absent), and nothing checked that the key was readable before ElevenLabs work began. A missing credential surfaced only when the first API call failed, deep into the session.
- **Prevention rule:** At client kickoff, **verify the ElevenLabs key is readable before any ElevenLabs work** — `wc -c < .el_key` must return `> 20`. Treat an unreadable/short key as a hard stop, not a warning. Same check for every provider credential the stage needs (Supabase token, shared secret) — prove the credential loads before building on it.

### K2 — COWORK CANNOT CREATE ELEVENLABS TOOLS
- **Symptom:** Attempts to create/save the `get_daily_menu` webhook tool through Cowork's path did nothing — the tool never persisted with its auth header.
- **Root cause:** Cowork's ElevenLabs **MCP only updates prompt + voice**; it cannot create tools. And the ElevenLabs **website UI silently refuses to save a webhook tool that carries a raw `Authorization` header** (no error, just no save). Two dead ends that both *look* like success.
- **Prevention rule:** **ALL ElevenLabs tool creation and agent wiring goes through the ElevenLabs API (Claude Code)** — `POST /v1/convai/tools` then attach the returned `tool_id` to `prompt.tool_ids` via `PATCH /v1/convai/agents/{id}`. Never create/wire tools via Cowork's MCP or the browser UI. (Cowork's MCP is fine for reading config and for prompt/voice-only tweaks, and Cowork still owns live verification.)

### K3 — MULTI-SUPABASE-ORG BLINDSPOT
- **Symptom:** The Supabase MCP could not see the client's project at all — `list_projects` didn't include it, so MCP-based schema/seed/deploy were impossible.
- **Root cause:** The MCP is **scoped to the logamarketing org**. Casa D'Karmen's Supabase project (ref `edcjcehfedwxxucktxoj`) lives in a **separate org** (`nncpmrizsddribljpdlv`). A clone in a different org is invisible to the logamarketing-scoped MCP.
- **Prevention rule:** At intake, **record the client's Supabase org + project ref**. If the project is **not** in logamarketing, all DB/gateway work uses the **Supabase CLI (`--project-ref`) or the Management API** (`POST /v1/projects/<ref>/database/query`) with `SUPABASE_ACCESS_TOKEN` — **never the MCP**. Put the org/ref in the client's README and secrets inventory so the next session doesn't rediscover this the hard way.

### K4 — STALE-DAY SEED
- **Symptom:** The agent returned `menu_not_set` on a day the restaurant was open, as if no menu existed.
- **Root cause:** The daily menu was seeded for the **wrong local date** — 2026-07-04 when "today" in Sinaloa was already 2026-07-05. The gateway correctly resolves "today" in **America/Mazatlan** (UTC-7, no DST) and found zero rows for the real current date. Seeding against a UTC/laptop date, not the client's local date, produced a menu that existed but for yesterday.
- **Prevention rule:** **Seed and verify daily data against the client's CURRENT local date**, and confirm through **the gateway's own resolved "today"** (call `get_daily_menu` and check `service_date` == the client-local date with a non-empty menu). Never trust the host/laptop/UTC date for a client in another timezone. The `menu_not_set` path is working-as-designed truth-telling — the fix is the seed date, never a fallback to another day (that would resurrect B12).

### K5 — ORDER FIRED WITH EMPTY REQUIRED FIELDS (voice never-confirm gap)
- **Symptom:** In a simulated call, when the caller answered the drinks question with "sería todo, gracias," Karmen jumped straight to `order_ready` and fired the order with `cliente_nombre:""`, `telefono:""`, and a **fabricated** `modalidad:"pickup"` — the modality was never asked, name/phone never collected, and the mandatory spoken read-back of dishes+total was skipped. An unfulfillable order (no name, no callback number) reached the n8n webhook.
- **Root cause:** Two prompt gaps compounding. (1) The `order_ready` gate said only "después de que el cliente confirme," enumerating **zero** required fields — and the tool schema's `required` list is satisfied by **empty strings**, so `""` passes. (2) The final-confirmation trigger was the literal phrase "¿Sería todo?", which collides with the caller spontaneously saying "sería todo"; the model treated the caller's utterance as the confirmation and skipped the read-back. "No repitas el pedido" further licensed skipping it.
- **Prevention rule:** Gate `order_ready` on **actually-collected, non-empty, non-invented** values — enumerate them explicitly in the prompt (modalidad chosen by the caller, nombre, teléfono of 10 digits; + dirección and cash_amount if delivery). Require an explicit agent **read-back of dishes+total and a "sí/correcto"** before firing, *even if the caller already said "sería todo"* — and disambiguate that "sería todo" **in reply to the drinks question means "no drink," not "close the order."** A provider's `required` schema flag is NOT a runtime guard against empty strings — enforce presence in the prompt. Mirrors engine Stage 4C never-confirm and B16.

### K6 — PROMPT ASSUMED ALL THREE CATEGORIES ALWAYS PRESENT
- **Symptom:** The prompt hardcoded "hoy tengo comidas, bebidas y extras" and "SIEMPRE pregunta '¿Te gustaría agregar alguna bebida?'" — but `get_daily_menu` can return an empty `bebida` or `extra` category on a given day, so the agent would offer/announce a category it has nothing to read from (risking a self-contradiction or an invented item to satisfy its own offer).
- **Prevention rule:** Offer, announce, and read **only the categories the tool returned with ≥1 item today**; never mention or offer a category that came back empty. Applies to the menu-read line AND the bebidas/extras up-sell line.

### K7 — MODEL SPOKE ITS INTERNAL PROCESS OUT LOUD (brain leak)
- **Symptom:** On real calls Karmen narrated her internal process to the caller: "Un momento, **proceso** tu pedido…", "**envío** tu pedido para confirmar…", "**preparo** tu pedido…", "**lo anoto**…", "te **pregunto** las bebidas disponibles…", and once she literally spoke the word "**Silencio…**" (reading her own stage direction). The HIGIENE rule (don't read internal notes/tool names) did not stop it.
- **Root cause (from the transcripts, not a guess):** RULE #0 mandated "say a short line before **any** tool call, in the same turn." For `get_daily_menu` that yields a natural courtesy. But before `order_ready`/`end_call` there is no natural customer-facing line, so the model filled the mandated slot with **process-narration** of the internal action. LLM = gpt-5-mini, `reasoning_effort=minimal` — ruled OUT a reasoning/verbosity chain-of-thought leak; it was prompt-driven. The prohibited-words list ("proceso/anoto/registro") was overridden by the RULE #0 pressure.
- **Prevention rule:** Scope the pre-tool line to **lookup** tools only (`get_daily_menu`, `compute_total`); before `order_ready`/`end_call` the model announces **nothing** (its only pre-order_ready line is the fixed farewell). Add a hard rule: **everything the agent outputs is spoken directly to the customer** — it never narrates its plan, the order it is tracking, "el cliente quiere…", tool/field names, or its own stage directions (never says the word "silencio"). If a host wouldn't say it aloud, don't say it.

### K8 — WRONG TOTAL FROM LLM MENTAL MATH (V2 violation)
- **Symptom:** On a real call (2× Chile relleno $120 + Aguacate extra $15 + $20 delivery = **$275**) Karmen spoke a total of "**trescientos setenta pesos**" ($370) and only corrected to $275 **after the caller did the arithmetic for her**. Totals were inconsistent across calls (right on some, wrong on others) — the signature of LLM mental math.
- **Root cause:** No compute-total tool existed; `get_daily_menu` returns per-item prices but the **sum** was left to the model. V2 says numbers come from tools, not the model — the arithmetic step violated it.
- **Prevention rule:** Compute the total **in code**, never in the model. Added a gateway `compute_total` action: it re-reads TODAY's `daily_menu` prices (authoritative, not the model's read), sums `price × qty` for each item deterministically, adds the flat delivery fee, and returns the exact `total` (+ `breakdown`, `all_matched`, `unmatched`). Wired as an ElevenLabs tool (`compute_total`). The prompt: **always** call `compute_total`, **read the exact `total` field**, **always** state it and ask "…¿es correcto?", and `order_ready` never fires until the caller confirms the total. If `all_matched=false`, do not quote — re-verify the `unmatched` items. Proven live: the exact $370 order now returns $275.

### K9 — DEFAULT-PICKUP TOTAL BEFORE MODE KNOWN (price flip-flop)
- **Symptom:** Karmen could quote a peso total before the caller ever chose pickup vs delivery; when delivery emerged a turn later, the recomputed total jumped +$20 — the spoken price flip-flopped mid-call.
- **Root cause:** `compute_total`'s `modalidad` input was **optional**. The handler coerced an absent/invalid value to `""`, computed `delivery_fee: 0`, and even **reported `modalidad:"pickup"`** in the response — a fulfillment mode the caller never chose (the same default-to-pickup fabrication shape as K5's `order_ready`). Only `order_ready` was gated on mode; nothing gated the *quote*. This is V2's sibling: the fee is a fact that must come from the caller's actual choice, never from a code default.
- **Prevention rule:** **A quote tool REQUIRES every input that changes the amount before it returns a speakable number.** `compute_total` now refuses to quote without a caller-chosen mode (`pickup|recoger|delivery|domicilio`): it returns `mode_missing:true` with a short Spanish ask-pickup-or-delivery instruction and **no total** (same ok:true/HTTP-200 shape as `all_matched:false`, so the instruction reaches the model). Prompt side: establish the modalidad BEFORE calling `compute_total`; on `mode_missing`, ask and recompute; never voice a total until mode is known. Cross-ref: voice ledger **V2** (numbers come from tool facts, never defaults/memory), K5, K8. Lockstep (V4): confirmed live 2026-07-17 — the ElevenLabs `compute_total` tool schema already lists `modalidad` in `required` (description steers the model to 'delivery'/'pickup'); per K5, a provider `required` flag still passes empty strings, so the gateway gate is the real guard. Natural spoken forms ("a domicilio", "para recoger") are accepted by stripping the leading preposition; ambiguous ones ("para llevar") deliberately fall to `mode_missing` — ask, never guess.

---

## Pre-flight checklist (derived from the ledger)
1. **Credentials load?** ElevenLabs key `wc -c > 20`; Supabase token present; shared secret present — **before** any build (K1).
2. **Which Supabase org?** Record org + project ref at intake; if not logamarketing → CLI / Management API only, never MCP (K3).
3. **ElevenLabs tools?** Create + wire via the **API**, never MCP or the web UI (K2).
4. **Daily data seeded for the right day?** Seed against the **client-local** date; verify via the gateway's resolved `service_date` (K4).
5. **Resolve "today" in the client TZ, never UTC** — and never serve a stale day; `menu_not_set` is the correct honest state (K4, engine B12).
6. **Prove with the live surface, not a code read** — auth (401 on missing/wrong secret), happy path, and one real call (K1/K4; engine meta-lesson).
7. **Order-firing tool hard-gated?** The order tool (`order_ready`) must NEVER fire without non-empty, caller-collected PLATILLOS + modalidad + nombre + teléfono (+ dirección-con-entre-calles + cash_amount if delivery) and an explicit spoken read-back + "sí" — a provider `required` flag passes empty strings, so enforce presence in the prompt (K5). Offer only categories the tool returned with items (K6).
8. **Total computed by the system, never the model** — read a `compute_total` tool's exact number; never let the model do order arithmetic (K8). State the total and ask "¿es correcto?"; `order_ready` waits on that "sí".
9. **Everything the agent says is spoken to the customer** — never let it narrate its process, order-tracking, tool/field names, or its own stage directions; scope pre-tool fillers to lookup tools only (K7).
