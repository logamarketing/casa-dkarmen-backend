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
