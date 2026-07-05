# Casa D'Karmen — Continuation & Doctrine

*Resume-in-a-fresh-chat source of truth for this client. Where we are, the open
follow-ups, and the standing rules specific to Casa D'Karmen. General voice-client
process lives in `docs/NEW-CLIENT-VOICE-CHECKLIST.md`; scars in `docs/bug-ledger.md`.*

---

## Where we are (2026-07-05)
- **Level-1 voice client** (phone only, read-mostly, no bookings). Engine cloned
  from **Lisa** (la-bodega-backend); soul = this client's `daily_menu` rows.
- **Stage 1 — storage:** ✅ `daily_menu` + seed.
- **Stage 2 — read path + Karmen rewire:** ✅ **shipped + live-verified.**
  `karmen-gateway` (action `get_daily_menu`) deployed to `edcjcehfedwxxucktxoj`;
  ElevenLabs agent `agent_9901k5y1nqype69akbe3j8swwwat` rewired via the API
  (tool + prompt + voice) and published to Main; Cowork confirmed a real call.
- **Stage 3 — edit path:** ⏳ not started (see follow-ups).

## Key facts to reload
- **Supabase:** project ref `edcjcehfedwxxucktxoj`, org `nncpmrizsddribljpdlv`
  (**NOT** logamarketing → CLI / Management API only, never the MCP — K3).
- **ElevenLabs:** agent `agent_9901k5y1nqype69akbe3j8swwwat`, language `es`,
  voice `qpw1Pr9hKQ9lsPLpeNcM`, LLM `gpt-5-mini`. Tools: `end_call`,
  `order_ready` (n8n webhook), `get_daily_menu` (`tool_9801kws1pvvxfsh87dr1be8q9kfq`).
  API key at `.el_key`. Menu tool + wiring are API-managed (K2).
- **Secrets** stashed in `loga-secrets` (`.env.local` + `secrets-inventory.md`):
  `CASA_DKARMEN_SUPABASE_ANON_KEY`, `KARMEN_SHARED_SECRET`, ElevenLabs-key location.
- **Timezone:** America/Mazatlan (UTC-7, no DST). Resolve "today" here, never UTC.

---

## Open follow-ups
1. **`transfer_to_number` self-transfer loop risk.** The human-handoff destination
   is currently `+526873350709` — **the same number as Karmen's own inbound line**.
   A transfer would route the caller back into the agent. **Needs the real staff
   number** before human handoff can be relied on. (Cowork owns the ElevenLabs
   transfer config; flag surfaced during the Stage 2 audit.)
2. **Stage 3 = the daily-menu admin page** (edit path). Goal: staff update the
   day's menu without hand-editing a prompt or running SQL — a simple authenticated
   page writing `daily_menu` for the client-local date. Additive; the gateway and
   `menu_not_set` behavior already handle whatever it writes.

---

## Standing rules (Casa-specific)
- **Additive only.** Never touch the existing order flow (`ordenes`,
  `ordenes_agente_voz`, `ordenes_unificadas`, `chat_context`,
  `n8n_chat_histories`) or the n8n order webhook.
- **Never fabricate the menu.** The menu comes from `get_daily_menu`, never the
  prompt or memory. An empty day is `menu_not_set` (honest), never a fallback to
  another day's rows.
- **Never confirm what didn't happen.** `order_ready` only after the caller
  confirms; on failure, retry once, then transfer — never a false confirmation.
- **Building via API, verifying via Cowork.** See `docs/NEW-CLIENT-VOICE-CHECKLIST.md`.
