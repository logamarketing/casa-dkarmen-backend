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

---

## V10 Model-Hardening Recap — "Model & mouth" overnight pass (2026-07-17/18)

*Follow-on to the same-day modalidad gate (K9, deployed 2026-07-17). Owner-authorized autonomous overnight run; deploy gates owned by auto-rollback discipline. Numbers from real measurement (WebSocket harness with synthesized caller audio; simulate-conversation for behavior gates).*

**(a) What shipped**
- LIVE agent `agent_9901k5y1nqype69akbe3j8swwwat` PATCHed: LLM `gpt-5-mini`@`minimal` → **`gpt-4.1`** (non-reasoning), `backup_llm_config` `{override, []}` → **`{override, [gpt-4.1-mini, gpt-4o]}`**. Prompt/tools/voice/turn settings byte-identical to the pre-change snapshot (`.karmen-agent-rollback-20260717-214256-pre-stage2.json` — the rollback target, kept).
- Karmen-adapted leak harness (Spanish scenarios; no script ever confirms an order) — scratchpad-only, reusable; per-run server-side rescan + turn metrics.

**(b) What the gates found**
- **gpt-4.1 on turn_v2: 173 agent turns total (128 duplicate-agent + 45 live acceptance), 0 V10-class leaks, `order_ready` never fired.** Regression gate on live: asks recoger/domicilio before any total-framed amount; totals verbatim from `compute_total` (240/260); `menu_not_set` honest.
- **`claude-haiku-4-5` REJECTED on behavior** (order mental math before mode — K8/K9 shape) despite 65 leak-free turns.
- **`turn_v3` measured, deferred:** end-of-turn 2611→1532ms (−41%) with 0 V10 leaks — strongest dead-air lever yet; adoption left as a daytime owner decision with one live call.
- Residual: gpt-4.1 sometimes says "te anoto…" (customer-directed; prompt's K7 word-ban technically hit; incumbent said worse on record) — logged in K10, morning-call listen item.
- Discovery: 4 undocumented ElevenLabs KB docs + an MCP server on the agent; hours answers come from the KB; static desayuno docx = V5 drift risk (K10).

**(c) Fixed/hardened** — live model chain per V10; judge-script false positives fixed during the run (menu unit-price vs total-framing; mode-question regex window) — both documented by transcript evidence before any gate ruling.

**(d) Carry-forward** — owner decisions queued: adopt turn_v3 after one live-call check; "anoto" one-word prompt tweak; KB docs → tables or documented+dated. Stage-1 (K9) and Stage-2 (V10) working trees both uncommitted; Edgar commits after the morning acceptance call.

**(e) Risks + numbers** — LLM TTFB median: baseline ~815ms → 587/603ms (duplicate) and 542ms (live). End-of-turn (harness context): 2611–2957ms on turn_v2, 2190ms in the live acceptance battery; turn_v3 candidate at 1532ms. Cost: ~15 harness conversations + sims (TTS/LLM credits, single-digit dollars). Risk register: live line spent ~4h overnight on the new chain with all gates green; rollback is one PATCH from the snapshot.

---

## Cleanup-Pass Recap — anotar ban + turn_v3 adoption + KB/MCP inventory (2026-07-18, daytime, owner-directed autonomous)

*Executes the three owner items queued by the V10 recap. Snapshot-first; every change proven on a duplicate agent before the live PATCH; numbers from real measurement (WebSocket leak harness + mocked simulate-conversation). Nothing committed — commit stays gated on Edgar's acceptance call.*

**(a) What shipped**
- **LIVE agent PATCH** (`agent_9901k5y1nqype69akbe3j8swwwat`): exactly two fields changed vs the pre-pass snapshot `.karmen-agent-rollback-20260718-113946-cleanup.json` (verified field-by-field: tools/TTS/KB/MCP/phone byte-identical) — (1) **prompt**: K7 hardening — anotar/apuntar banned in any conjugation + replacement phrasing ("claro / va / perfecto") + "Apunta lo que te den"→"Quédate con lo que te den"; (2) **`turn_model`: turn_v2 → turn_v3**.
- **Repo:** `docs/agent-prompts/karmen-system-prompt.txt` synced to live; harness persisted to `scripts/karmen_leak_harness.py` + `scripts/karmen_regression_sims.py` (with this pass's judge fixes); `docs/elevenlabs-kb-and-mcp-inventory-2026-07-18.md` (Fix 3); ledger K7/K10 addenda + new K11.

**(b) What the gates found**
- **Fix 1 proof (duplicate, prompt-only on turn_v2):** 135 agent turns / **0 leaks** on a STRICTER scanner (all anotar/apuntar conjugations added); mocked sims ALL PASS.
- **Fix 2 proof (combined config):** duplicate 136 turns + live 63 turns = **199 turns / 0 leaks / `order_ready` never fired**; sims ALL PASS on duplicate AND live (K9 mode-before-total, honest `menu_not_set`, totals 240/260 verbatim). Session total on the new prompt: **334 agent turns, 0 process-narration hits.**
- **Latency (the point of turn_v3):** live end-of-turn median **1325–1619 ms vs 2190 ms** overnight on turn_v2 (−26 to −40%); duplicate 1456–1630 vs 2702–3444 same-session turn_v2. LLM TTFB flat (546–604 vs 542 ms) — no regression.
- **Fix 3 discovery upgraded:** the attached "MCP server" is a **publicly-readable Google Doc still serving the menu at $110** (pre-Stage-1 price) — a fenced V5 relic, not an active leak (0 off-tool prices in all 173 overnight + 334 today's turns). Desayuno docx ($115/$140, 2026-03-28) now competes with live `daily_menu.desayuno`. Full inventory + owner-decision list in the dated doc; K11 carries the prevention rule.
- Real-world side-proof: today's menu was genuinely unseeded during the pass → live marathon runs exercised `menu_not_set` for real; she stayed fail-closed, offered transfer, answered hours from the KB.

**(c) Fixed / hardened** — two judge false-positives fixed with transcript evidence BEFORE any gate ruling (mode-question regex window 40→90 chars; menu unit-price "a ciento veinte cada uno" ≠ pre-mode total — K9 forbids totals, not menu reads). Harness scanner permanently stricter. Duplicate agent deleted after the pass (K10 rule).

**(d) Carry-forward**
- **Edgar's acceptance call remains THE gate**: one live call, then commit everything (K9 + K10 + this pass are all uncommitted by design).
- Owner decisions from K11: remove/archive the stale-$110 "Menu del dia" pseudo-MCP (recommended), resolve desayuno-docx vs `daily_menu`, Extras/Bebidas docs vs `daily_menu`.
- 2026-07-18 `daily_menu` was unseeded during the pass — staff's daily update workflow, not touched here (additive-only).

**(e) Risks + numbers** — ~17 harness conversations + 9 sims this pass (TTS/LLM credits, single-digit dollars). Live line carried the new config through the acceptance battery with every gate green. Rollback for the whole pass = one PATCH restoring `prompt` + `turn_model` from `.karmen-agent-rollback-20260718-113946-cleanup.json`.
