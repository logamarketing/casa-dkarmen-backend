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

---

## Pre-flight checklist (derived from the ledger)
1. **Credentials load?** ElevenLabs key `wc -c > 20`; Supabase token present; shared secret present — **before** any build (K1).
2. **Which Supabase org?** Record org + project ref at intake; if not logamarketing → CLI / Management API only, never MCP (K3).
3. **ElevenLabs tools?** Create + wire via the **API**, never MCP or the web UI (K2).
4. **Daily data seeded for the right day?** Seed against the **client-local** date; verify via the gateway's resolved `service_date` (K4).
5. **Resolve "today" in the client TZ, never UTC** — and never serve a stale day; `menu_not_set` is the correct honest state (K4, engine B12).
6. **Prove with the live surface, not a code read** — auth (401 on missing/wrong secret), happy path, and one real call (K1/K4; engine meta-lesson).
