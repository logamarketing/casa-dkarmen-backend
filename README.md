# casa-dkarmen-backend

Backend for **Casa D'Karmen** (restaurant, Guasave, Sinaloa MX) and the **Karmen**
ElevenLabs voice agent that takes phone orders in Spanish.

A **Level-1 voice client** (single channel = phone, read-mostly; no bookings) —
follows the `loga-agent-core` voice-gateway pattern, the same shape as
`la-bodega-backend` (Lisa), scaled down. Engine = shared code; soul = this
client's data.

## Supabase project
- **Already exists** — ref `edcjcehfedwxxucktxoj`, name "Casa D Karmen Project",
  org `nncpmrizsddribljpdlv` (a **separate** org from logamarketing), region
  AWS us-west-1, Postgres 17.6.
- ⚠️ The Supabase **MCP** tools are scoped to the logamarketing org and **cannot
  reach this project**. Use the Supabase **CLI** (the logged-in user spans both
  orgs) or the **Management API** (`POST /v1/projects/edcjcehfedwxxucktxoj/database/query`
  with `Authorization: Bearer $SUPABASE_ACCESS_TOKEN`).

## What's here (Stage 1 — storage)
- `supabase/migrations/…_create_daily_menu.sql` — the `daily_menu` table.
- `supabase/migrations/…_seed_daily_menu_2026_07_04.sql` — one real day, ~38 rows.
- `docs/stage-1-storage.md` — scope, decisions, and how it was applied.

**Additive only.** Nothing here touches the existing order flow
(`ordenes`, `ordenes_agente_voz`, `ordenes_unificadas`, `chat_context`,
`n8n_chat_histories`) or the n8n order webhook.

## Roadmap
- **Stage 1 — storage** (this): `daily_menu` + seed. ✅
- **Stage 2 — read path:** an edge function that resolves "today" in
  **America/Mazatlan** (Sinaloa, UTC-7, no DST) and returns the day's available
  items; rewire Karmen off her hardcoded-prompt menu. Prove with one live call.
- **Stage 3 — edit path:** so the menu is updated without hand-editing a prompt.
