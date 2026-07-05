# Casa D'Karmen — Stage Recaps

*One recap per stage; never rewritten (append a correction note instead). Numbers from real measurement.*

---

## Stage 1 Recap — Storage / daily_menu (2026-07-04)
**(a) What shipped** — `daily_menu` table + idempotent 2026-07-04 seed (38 rows: 21 comida @120, 11 bebida @25, 6 extra 0–15), applied byte-exact to `edcjcehfedwxxucktxoj` via the Management API. Live-verified: counts by category, `$120` correction (0 rows at 110), idempotent re-run holds, RLS on, order tables untouched.
**(b) Findings** — none (clean). Two engineering calls flagged: RLS-enabled-no-policy (defensive default), and migration-history not recorded via API (idempotent → a later `db push` reconciles).
**(c) Fixed/hardened** — n/a.
**(d) Carry-forward** — Stage 2: resolve "today" in America/Mazatlan; `menu_not_set` never serves a stale day. (Both done in Stage 2.)
**(e) Risks/numbers** — n/a (no runtime this stage).

---

## Stage 2 Recap — Read path + Karmen rewire (2026-07-04)

**(a) What shipped — verifiable artifacts + live-verified DoD**
- `supabase/functions/karmen-gateway/index.ts` — one action `get_daily_menu`. **Deployed** to `edcjcehfedwxxucktxoj`, `verify_jwt=true`, via CLI `--project-ref` + access token (no DB password; `loga-agent-core` link untouched).
- `supabase/migrations/20260704190500_voice_events.sql` — telemetry table (applied via Management API).
- `docs/stage-2-read-path.md` (design + GREEN architect verdict), `docs/karmen-elevenlabs-rewire.md` (exact tool JSON + prompt diff + voice recs + live-call DoD for Cowork).
- **Live-proven at the gateway (real HTTP, not a code read):**
  - Auth fail-closed: no-secret / wrong-secret → 401; no-bearer → platform 401 (`verify_jwt` on); unknown action → 400.
  - Happy path (no override → today resolved in America/Mazatlan = 2026-07-04): 38 items grouped comida/bebida/extra, sorted by `sort_order`, `$120` comidas (**0 at $110**), free extra `$0` kept, Nachos `sides` omitted (was NULL).
  - `menu_not_set` (empty day): `ok:true`, empty groups, instruction, **echoes the requested date — never falls back** to another day (B12).
  - Sold-out: flip one dish `is_available=false` → **drops from 38→37 in 0.6s**; restore → back to 38; DB left at seeded state.
  - Malformed `service_date` override → 400.
  - Telemetry landed in `voice_events` (item_count/menu_not_set/ms/cache_hit + unauthorized).

**(b) What the Reviewer / retro found** — adversarial `reviewer` verdict **GO, no Blockers**. One **Major (M1)**: DB-error path returned HTTP 500, which ElevenLabs may treat as an opaque failure and let the model improvise a price (V1/V2 fabrication). Two **Minors**: `Number(null)→0` could survive as a fake free item if the column ever loses NOT NULL (m1); cache map never evicted stale date keys (m2). All nine hammered invariants (auth, no-fabricate, no-fallback, timezone, no-raw-DB-text, sort/group, cache-by-date, additive-only, latency) held in source.

**(c) What we fixed / hardened** — M1: error catch now returns **200 + `ok:false`** (parity with `menu_not_set`) so the fail-closed Spanish instruction reliably reaches the model. m1: explicit null-drop before `Number()` (kept `0` as a real free price — postgREST returns numeric as a string, so the reviewer's `typeof==='number'` guard would have been wrong; used `== null` instead). m2: opportunistic eviction of expired date keys. Re-typechecked clean; re-proven live.

**(d) Carry-forward + do-better-next-time**
- **BLOCKING for stage "done": the ONE live phone call.** Cowork applies `docs/karmen-elevenlabs-rewire.md` in lockstep (tool + prompt + voice), then a real call proves: reads today's menu ($120), gives a correct total, handles menu_not_set without inventing, no internal-text leaks, silent after `end_call`. Cowork verifies independently. Until then, **Karmen's current prompt stays** (no broken live state).
- **Deferred (stated):** `quote_order` grounded-total action (only if in-prompt summation proves unreliable); post-`end_call` TTS at the ElevenLabs engine level if the prompt rule doesn't fully settle it.
- **Do-better:** the anon key + shared secret are handoff-gated — get them into `loga-secrets` so the next session doesn't regenerate.

**(e) Risks + numbers**
- Gateway latency (client→edge→DB, from a laptop): **184–359 ms** per call; the DB read itself is a single indexed SELECT of ≤38 rows. ElevenLabs→Supabase (cloud-to-cloud) will be lower; a 15s per-date cache removes the DB hop under burst. Well within the voice budget once the client RTT is removed.
- Cost: negligible (one tiny table, one edge function).
- Risk register: the only open risk is the un-run live call (owner/Cowork-gated) — mitigated by exhaustive gateway proof + keep-current-prompt-until-proven.

---

## Stage 2 Recap — CLOSEOUT ADDENDUM: rewire shipped + live-verified (2026-07-05)

*Appended, not rewritten. The 2026-07-04 recap left ONE blocking item — the live phone call — and the rewire itself un-applied. Both are now done.*

**(a) What shipped — verifiable artifacts + live-verified DoD**
- **`get_daily_menu` webhook tool created via the ElevenLabs API** (`tool_9801kws1pvvxfsh87dr1be8q9kfq`) on agent `agent_9901k5y1nqype69akbe3j8swwwat`: POST → karmen-gateway, headers `Authorization: Bearer <anon>` + `x-karmen-secret`; `action` pinned as a **constant literal** (model never fills it), no `service_date` exposed.
- **Prompt swapped (4292 → 6260 chars):** removed the hardcoded `$110` and the whole prompt-menu gate; **removed the rule that forbade giving the order total** (the defect that left callers unable to learn what they owed); added tool-driven menu, honest `menu_not_set`/`temporarily_unavailable` handling, "the total CAN be given," RULE #0 (speak-before-tool), and a hygiene section (no internal-text leaks, silence after `end_call`). Preserved all order-flow rules + `order_ready` + the closing script.
- **Voice aligned** to the proven Lisa profile: stability 0.18 → **0.45**, similarity 0.5 → **0.75** (speed 1.1, voice `qpw1Pr9hKQ9lsPLpeNcM`, LLM `gpt-5-mini`/temp 0.15 untouched).
- **Published to the Main branch** (`branch_id == main_branch_id`), phone `+526873350709` attached, all three tools wired (`end_call`, `order_ready`, `get_daily_menu`). For ElevenLabs agents, a PATCH to Main **is** the publish.
- **Proven before wiring (real HTTP):** the exact tool headers (this anon key + secret) authenticate against the live gateway → `ok:true`, `service_date 2026-07-05`, 38 items, comidas at **$120**. A wrong anon key would have 401'd here.
- **Live-verified:** Cowork placed/observed the real phone call and confirmed the DoD (owner-side, per the division of labor). Karmen is live.

**(b) What the retro found** — four **process** bugs, now logged in the new `docs/bug-ledger.md` (K1–K4): credential handoff stall (`!printf > .el_key` silently failed twice), Cowork-can't-create-ElevenLabs-tools (MCP is prompt/voice-only; web UI silently refuses a raw-Authorization webhook tool), multi-Supabase-org blindspot (client project in a non-logamarketing org the MCP can't see), and stale-day seed (menu seeded for Jul 4 vs the real Jul 5 in Sinaloa → `menu_not_set`). No new code-invariant bugs beyond the Stage-2 (2026-07-04) reviewer findings.

**(c) What we fixed / hardened** — Stage-2 rewire applied end-to-end via the API (not the UI/MCP dead ends). Secrets stashed in `loga-secrets` (anon key + `x-karmen-secret` value + ElevenLabs-key location note) so no future session re-fetches. Reusable `docs/NEW-CLIENT-VOICE-CHECKLIST.md` created so the next client is faster.

**(d) Carry-forward + do-better-next-time**
- **Stage 3 = the daily-menu admin page** (edit path) so the menu is updated without hand-editing anything.
- **`transfer_to_number` currently equals Karmen's own inbound line `+526873350709`** — a self-transfer loop risk; needs the real staff number before relying on human handoff. (Both tracked in `docs/CONTINUATION-AND-DOCTRINE.md`.)
  - **Correction 2026-07-05:** RESOLVED — real staff line `+526878711111` set via the ElevenLabs API (confirmed `+526873350709` was Karmen's own inbound number via the phone-numbers API). Self-loop eliminated; see the Stage 2 hardening pass and `CONTINUATION-AND-DOCTRINE.md` follow-up #1.
- **Do-better (applied):** verify the ElevenLabs key is readable (`wc -c > 20`) at kickoff; record the client's Supabase org/ref at intake; seed against the client-local date and confirm via the gateway's resolved `service_date`.

**(e) Risks + numbers** — Gateway latency unchanged from the 2026-07-04 measurement (184–359 ms laptop RTT; lower cloud-to-cloud; 15s per-date cache under burst). Cost negligible. Risk register: the previously-open live-call risk is **closed**; open items are the two follow-ups above (owner-gated).
