# New-Client Voice Agent — Checklist & Playbook

*The proven flow for standing up a Level-1 voice client (single channel = phone,
read-mostly, no bookings), distilled from **Lisa** (la-bodega-backend) and
**Karmen** (casa-dkarmen-backend, shipped 2026-07-05). Engine = shared code;
soul = the client's data. Clone the shape, not the brand.*

Read this at kickoff. Every rule here was paid for by a real delay — the
matching scars are in `docs/bug-ledger.md` (K-series) and the engine ledger.

---

## Division of labor (do not blur these)
- **Cowork = architect + LIVE verification.** Writes the spec, holds the live
  tool connections, reads the agent config via the ElevenLabs MCP, checks
  `voice_events` telemetry, and **places/observes the one real phone call**.
  Cowork's MCP can update **prompt + voice only**.
- **Claude Code = ALL building.** The database (tables, seeds, migrations), the
  gateway edge function, and **every ElevenLabs change that isn't prompt/voice** —
  tool creation and agent wiring — via the **ElevenLabs API**. Also snapshots
  the agent config for rollback before touching it.

Why: Cowork's MCP **cannot create ElevenLabs tools**, and the ElevenLabs web UI
**silently refuses** to save a webhook tool with a raw `Authorization` header
(K2). Building goes through the API; verifying stays with Cowork.

---

## Order of operations

### 0. Credentials first (before anything)
- [ ] **ElevenLabs API key readable:** `wc -c < .el_key` returns `> 20` (K1). A silent `!printf > .el_key` failure has stalled a whole session — check, don't assume.
- [ ] **Supabase access token** present (`$SUPABASE_ACCESS_TOKEN`).
- [ ] **Shared secret** (`x-karmen-secret`-style) present and known.
- [ ] Stash all three in `loga-secrets` (`.env.local` values + `secrets-inventory.md` names/status) so the next session doesn't re-fetch.

### 1. Map the client's Supabase org/project (K3)
- [ ] Record the **org id + project ref** at intake.
- [ ] If the project is **not in logamarketing**, the Supabase **MCP cannot see it** → all DB work uses the **CLI (`--project-ref`) or Management API** with the access token. Put org/ref in the client README.

### 2. Stage 1 — storage
- [ ] Clone the Lisa/Karmen daily-data table shape (e.g. `daily_menu`), **additive only** — never touch the client's existing order/CRM tables or n8n flows.
- [ ] Seed the **current client-local date** (K4), idempotently. RLS on; no anon policy.
- [ ] Verify counts + prices live via the DB, not a code read.

### 3. Stage 2 — gateway + ElevenLabs rewire
- [ ] Clone the **Lisa Level-1 voice-gateway** edge function (`karmen-gateway` shape): one read action, resolves "today" in the **client TZ, never UTC**, returns the day's items; `verify_jwt=true` + app-secret header, fail-closed (401 on missing/wrong).
- [ ] Deploy the **exact committed file** via the CLI (byte-exact, no hand-inlining).
- [ ] **Snapshot the agent config FIRST** (`GET /v1/convai/agents/{id}` → save JSON) — this is your one-call rollback.
- [ ] **Create the tool via API** (`POST /v1/convai/tools`): webhook, name == the gateway action exactly, action pinned as a **constant literal** (model never fills it), both headers (`Authorization: Bearer <anon>` + app secret). Constant-value properties can carry **only** `constant_value` — no sibling `description`.
- [ ] **Verify your exact headers** authenticate against the live gateway (a 401 here = wrong anon key) BEFORE wiring.
- [ ] **Wire via API** (`PATCH …/agents/{id}`): add the new `tool_id` to `prompt.tool_ids` (keep the existing order/submission + end_call tools); swap the prompt (drop any hardcoded menu/prices; add tool-driven menu + honest `not_set`/error handling + order-total + hygiene); align voice to the proven profile.
- [ ] Confirm the change is on the **Main** branch (`branch_id == main_branch_id`) and the phone number is attached — for ElevenLabs agents, a PATCH to Main **is** the publish.

### 4. Verify (Definition of Done)
- [ ] **Telemetry, not code-reads:** confirm the gateway logged the call in `voice_events` (Cowork checks independently).
- [ ] **One real phone call** (Cowork places it): reads **today's** menu at the right prices, gives a **correct spoken total**, handles a no-menu day without inventing, leaks no internal text, silent after `end_call`.
- [ ] Until the real call passes, **keep the client's current prompt** — never leave a broken live agent.

---

## Standing rules (the non-negotiables)
1. **Resolve "today" in the client's timezone, never UTC** (K4).
2. **Never serve a stale day** — `menu_not_set` is the correct honest state; the fix for an empty menu is the seed date, never a fallback to another day.
3. **ElevenLabs tools via the API, never the MCP or the web UI** (K2).
4. **Prove with the live surface + telemetry, not code-reads** — auth, happy path, one real call.
5. **Clone the Lisa (la-bodega-backend) Level-1 voice-gateway shape** — engine identical across clients; only the data (soul) differs.
6. **Additive only** on a client's existing systems (orders, CRM, n8n). Snapshot before you touch the live agent.
7. **Naturalness lever = the TTS model, not Expressive Mode.** Expressive Mode forces `eleven_v3_conversational` and **drops a Professional Voice Clone (PVC)** + carries the highest latency. For a PVC voice, upgrade `eleven_flash_v2_5` → `eleven_turbo_v2_5` for warmth/expressiveness while keeping the exact voice identity (voice_id, stability, similarity, speed unchanged). Turbo is a drop-in PATCH — no re-clone, low latency (Karmen, 2026-07-05).
