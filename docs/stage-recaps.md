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

---

## Stage A Recap — order-integrity BUILT + proven behind dry_run, HELD before live cutover (2026-07-19)

*Design: `docs/stage-A-order-integrity-design.md` (architect-reviewed, 10 findings folded in). Build authorized after two explicit pre-build gates. Karmen is LIVE throughout; nothing in this stage touched her live prompt, tools, or model config — everything new is additive and unattached.*

**(a) What shipped (all held, not live)**
- **Gateway:** `submit_order` action added to `karmen-gateway/index.ts` (deployed) — dedicated `KARMEN_ORDER_SECRET` auth (never the read secret), server-side field validation (K5), server-verified total cross-check against `computeTotal`, `order_submissions` idempotency table (migration applied), `dry_run`/`simulate_failure` test hooks, unswallowed failure capture + independent direct-Telegram alert, server-dictated `spoken_message`.
- **n8n:** one new, disclosed, additive notify-only trigger in `Karmen Parlanchin` (`Order Notify Webhook` → format copy → Telegram, `responseMode:lastNode` so success/failure is real) — the OLD broken $0/no-idempotency path is untouched and simply stops being called at cutover. **Telegram node hard-disabled** (n8n auto-assigned an unverified credential; not trusted, not guessed — Edgar must confirm/replace + re-enable).
- **ElevenLabs:** new `submit_order` tool created standalone (`tool_1301kxxcm1v8fz1rgp9ej9bpt0tx`) with `conversation_id`/`call_sid` wired to `system__conversation_id`; cutover prompt drafted (`karmen-system-prompt-stageA-cutover.txt`) — the confirmation is dictated by `spoken_message` only, pre-tool fillers banned from sounding like a done deal. **Neither is attached to live Karmen.**

**(b) Pre-build gates — both resolved with real evidence, not assumption**
- Gate 1 (conversation_id reliability): existing tools never sent it (0/176 real calls). Fixed by wiring it fresh into the new tool; proven live on 2 independent real conversations, arriving correctly on every call including a validation-retry.
- Gate 2 (`api_insert_orden_av_flex` contract): read directly via `supabase db query --linked`. Target confirmed `ordenes_agente_voz`, `SECURITY DEFINER` (no caller-role risk).

**(c) Proof (all real evidence, not self-reported)**
- Auth boundary: no secret / read-secret-on-write / order-secret-on-read all 401; existing `get_daily_menu` regression-checked unaffected.
- `dry_run` suite: success (correct total), forced DB failure (honest failure line, real unswallowed `voice_events` capture, alert attempt logged missing-credential honestly), forced notify failure (distinct "captured, not confirmed" message — never the full "ha sido un placer"), total-mismatch block.
- Idempotency: 1 real insert + 2 identical retries → exactly 1 DB row, 1 `order_submissions` row (verified by count, not claim).
- **The core defect, closed on a real row:** `ordenes_agente_voz.id=104/105/106.precio_total = "240"` — not `0`.
- Two full real phone-shaped conversations end-to-end (menu → total → order → confirmation) on a throwaway duplicate: 0 leaks / 36 agent turns combined, K9 mode-before-total intact, unit-price-vs-total distinction correct, field-validation caught a genuinely incomplete submission without a false confirmation, `spoken_message` read verbatim both times.

**(d) Carry-forward — Edgar's decisions, not engineering unknowns**
- Set the real kitchen Telegram credential on the new n8n node + re-enable it.
- Provision `KARMEN_ALERT_BOT_TOKEN`/`KARMEN_ALERT_CHAT_ID` (new @BotFather bot) for the independent alert path — currently honestly reports "not sent, credential missing" rather than pretending.
- Review the cutover prompt draft; decide when to cut over (swap `tool_ids`, matching K9/K10/K11's PATCH-and-snapshot discipline).
- Test order rows left in `ordenes_agente_voz` (ids 104–106, `cliente_nombre` clearly marked `STAGE-A-TEST-PROOF`/`Juan Pérez` test phone `6879999xxx`/`6879998877`) — not deleted (order-table data is never touched destructively without an explicit ask); Edgar's call whether to clean up.
- Today's `daily_menu` was temporarily seeded (copied from 2026-07-18) to run the real conversations, then deleted immediately after — confirmed restored to its natural unseeded state.

**(e) Risks + numbers** — 2 real conversations + several dry_run/direct-HTTP probes (low cost). Nothing live changed: Karmen's prompt/tools/model byte-identical to the pre-Stage-A snapshot (`.karmen-agent-rollback-20260719-093153-stageA.json`), verified field-by-field. Rollback is trivial because nothing was cut over — delete the standalone tool and the n8n addition if abandoning, or proceed to cutover when ready.

---

## Stage A — LIVE CUTOVER (2026-07-19, Edgar-authorized, alert bot deferred)

**Notify path finalized (revised from the original build):** rather than a new Telegram credential (n8n auto-assigned one unverified — rejected, not trusted), the new notify-only trigger's formatter now feeds directly into the SAME already-credentialed `Response` node the restaurant's real orders have always used. Zero new credentials. Proven with a real, clearly-marked test ticket (Telegram `message_id: 1750`, sent by the real kitchen bot `@Lopz2525bot`) and one full real order (`id=107`, `ok:true`, no `kitchen_notify_failed`) through the complete gateway→notify→Telegram chain.

**Cutover executed:** snapshot `.karmen-agent-rollback-20260719-101208-stageA-cutover.json` → live Karmen PATCHed to the Stage-A prompt + `submit_order` attached / `order_ready` removed. Field-by-field diff against the snapshot: **only `prompt` and `tool_ids` changed** — model, `backup_llm_config`, `turn` (incl. `turn_v3`), `tts`, `asr`, `knowledge_base`, `mcp_server_ids`, `first_message`, `language`, `phone_numbers`, `platform_settings` all byte-identical. Live tool schema re-confirmed: `dry_run`/`simulate_failure` are not present in `submit_order`'s model-facing fields — the live path can only ever be a real submission.

**Edgar's explicit call:** go live now without the independent failure-alert bot; on any capture-worthy failure the order is still durably logged to `voice_events` (unswallowed, checked), just without a human ping yet — a stated, accepted fast-follow, not an oversight.

**Rollback:** one PATCH restoring `prompt` + `tool_ids` from the pre-cutover snapshot (script kept in the build session's scratchpad) — reverts to `order_ready` + the pre-Stage-A prompt exactly.

**Still open, HOLDING for real evidence:** Edgar's first real order — to verify from the data (not self-reported) that the row lands with the correct total, the kitchen ticket is delivered, and no duplicate is written.

---

## Stage A CLOSEOUT on the first real order + K12 (2026-07-19)

Real order `id=108` (Ulises López, delivery): `precio_total=165` correct (flautas 120 + Coca 25 + envío 20), exactly one row, one idempotency entry, kitchen notify succeeded, zero failure captures, confirmation spoken only after `ok:true`. **The order-integrity invariant held on a real call.** But the closeout data-read found **K12** (see bug-ledger): the kitchen TICKET showed only the drink and "Total: $25" — the Stage-A notify formatter was a copy of the old order_ready formatter reading the old field names, and it recomputed its own total instead of using the verified one. Fixed same-day (dual-shape reader + `precio_total` verbatim + `used_verified_total` flag), proven by replaying #108's exact payload (ticket now $165 with all items) and re-testing the legacy path. Prevention rule: content-diff a rebuilt consumer against the source record — "the send succeeded" is not "the ticket is right"; anything rendering money reads the verified total, never recomputes.

---

## Naturalness Pass — "Karmen cálida" (2026-07-19, built on duplicate, HELD for Edgar's ear)

*100% caller-experience: voice, warmth, variety, conversation shape. Discipline unchanged — duplicate agent `agent_3101kxxq4cq8fvarsqddje6p83e0` ("Karmen CALIDA v1"), all money/order guardrails re-proven at the new settings; NOTHING live changed (live prompt/temp/tools byte-untouched this pass; the gateway gained only warm-gated additions proven inert for the live path).*

**(a) What was built (all on the duplicate / warm-gated)**
- **Voice A/B for Edgar's ear:** 5 samples in `voice-samples/` (same Magda voice, same script): A=today's flash config, B=flash warm-tuned, C=turbo warm, D=eleven_v3 expressive, E=multilingual_v2 rich. ~~Finding: eleven_v3 is PLAN-GATED for conversational agents~~ **CORRECTED 2026-07-20** (see "Voice-model latency battery" below): the gate was a wrong-model-ID artifact — agents use `eleven_v3_conversational`, which works on our Creator tier, proven on real calls. Only the narration id `eleven_v3` is rejected on agents.
- **Warm prompt v3** (`karmen-system-prompt-warm-v3.txt`): real Sinaloa-host persona (light órale/sale allowed, max 1/turn — Edgar's ear decides if they stay), hard variety rule (never repeat an ack word in a call), menu as 2-3-dish recommendation instead of recital, data collection folded into chat (hard max 2 asks/turn), call-state narration banned ("la llamada ha finalizado" class), farewell delivered via end_call's message. Temperature 0.15 → **0.4** (safe now: money-truth lives in code). `speculative_turn` enabled.
- **Rotating name-aware farewell, server-dictated** (V8 intact): gateway rotates 4 warm variants with the caller's first name — gated on the warm tool's constant `style:"warm"`; live path proven byte-identical without it. Success responses also carry a K9-style tool-result instruction enforcing the single-farewell-via-end_call discipline (prompt-only compliance was ~50/50 at temp 0.4).
- Redundant custom client `end_call` tool dropped on the duplicate (system end_call remains).

**(b) The tune-test loop (transcript-verified, 3 iterations)**
- v1 @0.4 broke discipline: silent close (submit_order→end_call with NO farewell spoken), K9-shape premature quote intent in mocks (live code gate would have caught it — the sims exist to catch the intent), 4-datum interrogation turn. v2 hardened wording → K9 intent fixed, silent close persisted. v3 + server-side instruction → **ALL PASS** (mode-before-price, exact totals, farewell verbatim exactly once, no call-state narration, variety OK, honest empty-menu). Judge false-positives fixed with evidence at each step (warm phrasings vs regexes).
- **Audio ground truth:** recorded sample call (`voice-samples/LLAMADA-COMPLETA-karmen-calida.wav`, 92s, real order end-to-end) — tail analysis shows ~4s of farewell speech, not ~8s: the feared double-goodbye is textual (transcript shows turn + end_call message), **audibly single**.

**(c) Guardrail re-proof at temp 0.4 — final numbers (2026-07-20)** — sims ALL PASS ×2 on the shipping config (mode-before-price, exact totals, farewell verbatim exactly once, no call-state narration, variety, honest empty). Batteries: **shipping config (v3 + offer-slot patch): 77 turns, 0 leaks** (warmfinal 46 + warmfinal2 31); broader warm-config family during tuning: +220 turns with exactly ONE flagged utterance ("¿Te anoto tu pedido?" — offer-slot gap, patched with explicit replacements, not re-observed). `order_ready`/`submit_order` never misfired in any battery. One platform transient documented: a ~10-min ElevenLabs ASR outage window silenced 3 scenarios (agent healthy — sims passed concurrently; re-runs clean). Latency: end-of-turn medians 1224–2647ms across batteries (platform variance) vs live's 1325–1619 pre-pass — **honestly: no latency win from this pass; `speculative_turn` produced no measurable change**; the big dead-air lever (turn_v3) was already live.

**(d) HELD FOR EDGAR'S EAR** — samples + recorded call + a talk-to-her path (ElevenLabs dashboard test on the duplicate; staged outbound-call script ready to ring his phone from Karmen's number on request). No cutover without his approval. Note: the recorded sample call placed a real order row + real kitchen ticket (clearly test-named); today's 73-item menu was seeded at 16:17Z by the admin app (not this session) — treated as real data, untouched.

---

## Voice-model latency battery — E vs A (+ D corrected) (2026-07-20, duplicate only, NO cutover)

*Edgar picked E (multilingual_v2). Task: put E on the warm duplicate and measure the REAL latency cost vs today's flash config; give a definitive answer on D (eleven_v3).*

**Method (`scripts/voice_latency_ab.py`):** 13 real WebSocket audio calls against the warm duplicate (`agent_3101kxxq4cq8fvarsqddje6p83e0`), PATCHing ONLY `tts.model_id` between calls — voice, stability 0.38, speed 1.1, streaming-latency 3, prompt, LLM, tools all byte-constant (duplicate's TTS block verified byte-identical to live's, so arm A IS today's config). Arms interleaved `A E D A E D…` (5×A, 5×E, 3×D) to cancel platform drift. Scenario stops before ordering — verified per-call: only `get_daily_menu`+`end_call` fired, 0 `submit_order`, 9 agent turns each, real audio in every WAV. Metrics are server-side per-turn values from the conversation API (sims carry none). Evidence: `docs/evidence-latency-battery-20260720/` (conversation IDs + raw samples).

**Numbers (median [p25–p75], n = deduped agent-turn samples):**

| arm | model | TTS TTFB | End-of-turn (silence→audio) | LLM TTFB (control) |
|---|---|---|---|---|
| A | eleven_flash_v2_5 | **89ms** [85–93] n=25 | **1397ms** [929–2352] n=25 | 833ms |
| E | eleven_multilingual_v2 | **890ms** [795–930] n=25 | **2158ms** [1686–2945] n=25 | 686ms |
| D | eleven_v3_conversational | **254ms** [232–273] n=15 | **1430ms** [1114–1858] n=15 | 669ms |

**Read:** E costs ~+800ms TTS TTFB vs flash, and it lands ~1:1 in end-of-turn (+761ms median, ~1.4s→~2.2s). The LLM control is flat-to-favoring-A, so the gap is the TTS model, not drift. D is ~+165ms TTFB vs flash; its end-of-turn is statistically indistinguishable from A.

**D corrected — no upgrade needed:** the agents API model enum includes `eleven_v3_conversational` (ElevenLabs' agents-optimized v3, shipped ~March 2026). It PATCHes onto an agent AND completes real calls on our **Creator ($22/mo)** tier; `expressive_mode:true` also accepted (HTTP 200, config-level). Only the narration id `eleven_v3` returns `expressive_tts_not_allowed` on agents — the prior "plan-gated" finding tested the wrong id. *Prevention rule: an API error is evidence about the exact request sent, not the feature family — enumerate the valid values (a bogus-value probe returns the enum) before concluding a gate.*

**End state:** duplicate left on **E** (`eleven_multilingual_v2`, expressive off, all other TTS fields unchanged) per Edgar's pick. Live Karmen untouched this session (nothing PATCHed on `agent_9901…`; read-only GETs only). Real-agent ear samples kept: `voice-samples/AGENT-REAL-E-multilingual-v2.wav`, `voice-samples/AGENT-REAL-D-v3-conversational.wav`. Cost: 13 calls ≈ 12 agent-minutes + caller-line TTS. **NO cutover — decision is Edgar's**, now with the option space corrected: D (near-flash latency, expressive) is available today on the current plan.

---

## Voice cutover prep — D (eleven_v3_conversational) set + re-proven (2026-07-20, duplicate only, HELD)

*Edgar's final pick: D. Config set on the warm duplicate `agent_3101kxxq4cq8fvarsqddje6p83e0`; live Karmen `agent_9901…` untouched this session (read-only GETs only). Muletillas left IN per Edgar — he judges them on the recording.*

**(a) Shipping config** — `tts.model_id=eleven_v3_conversational`, `expressive_mode=true`, Magda voice `qpw1Pr9hKQ9lsPLpeNcM`, stability 0.38 / similarity 0.75 / speed 1.1 / streaming-latency 3 unchanged; warm-v3 prompt (7814 chars), gpt-4.1 @ temp 0.4, `turn_v3` + speculative_turn, same 3 tools — all byte-untouched.

**(b) expressive_mode ON chosen — evidence:** 8 interleaved real calls (4 ON / 4 OFF, model constant, only the flag flipped). TTS TTFB **259ms ON vs 269ms OFF**; end-of-turn **1388ms ON vs 1465ms OFF** — i.e. no cost (ON nominally faster = noise). ON emitted inline audio tags (`[amable]`, `[contenta]`) in 2 turns; **Scribe transcription of that exact audio proves the tags are CONSUMED, not spoken** ("Qué gusto saludarte…", no "amable"). OFF emitted no tags. Both leak-safe; ON gets the expressive delivery that was the whole reason for choosing D.

**(c) Latency on the final config** — TTS TTFB **266ms**, end-of-turn **1480ms** (final recorded call, n=10/9); matches the ON-arm battery (259/1388ms). vs today's live flash: TTS TTFB 89ms, end-of-turn 1397ms. **Net: ~+177ms TTS TTFB, end-of-turn indistinguishable from today (~1.4–1.5s).** The leak battery's 4253ms median end-of-turn is NOT comparable — those scenarios contain deliberate 35s silences that force silence-timeout continuation turns.

**(d) Guardrails re-proven on this exact config** — regression sims **ALL PASS ×2** (mode-before-price, exact totals after `compute_total`, single verbatim farewell after `submit_order`, no call-state narration, variety, honest empty menu). Leak battery 5 scenarios (menu/deadend/think/interrupt/marathon): **61 client-side agent turns (51 non-empty server-side), 0 leaks, `order_ready`/`submit_order` never fired.** The battery ran with the pre-fix scanner, so all 5 conversations were **re-scanned server-side with the corrected scanner** (`scripts/rescan_leaks.py`) → still 0 leaks; "0 leaks" from an unproven scanner is not evidence.

**(e) Final recorded call** — `voice-samples/FINAL-D-karmen-calida.wav` (112s, `conv_7001kxzxqbfeexgt5hk4zen4n7z2`). Real pickup order end-to-end on today's real 61-item menu: flautas → `compute_total` returned 120 → she spoke "ciento veinte pesos" → `submit_order` total 120 → **`order_row_id=115`**, one insert, farewell spoken verbatim from `spoken_message`. **Audio ground truth (Scribe):** audio tags not spoken; farewell audibly ONCE (the transcript's turn-plus-end_call double is textual only, as in the prior pass). *This placed a REAL order row and a REAL kitchen Telegram ticket — test-named "Ulises López", tel 6621768566, $120 pickup. The kitchen should be told #115 is a test.*

**(f) DEFECT FOUND — K14, cutover blocker (see bug-ledger)** — Karmen **invents a free gift**: "te llevas un **té de jazmín gratis**" / "cortesía de la casa", when Té de Jazmín is a **$25 bebida**. Reproducible: **3/3 pickup sim scenarios + the real recorded call; 0/3 delivery.** The warm-v3 prompt contains no promo language — the persona improvises it at temp 0.4. **Not caused by D** (a TTS model cannot change LLM text) — it would ship identically on E or today's flash. No prior gate looked for fabricated commercial terms; a new invented-promo assertion was added to the sims judge and validated (3/6 correctly FAIL). **Prompt fix NOT applied** — it changes what the caller hears and would invalidate the recording Edgar is about to judge; Edgar's call, then re-record.

**(g) Judge bug found and fixed — K13** — first sims run on D reported R1/R2 FAIL/`exact_total@None` while the agent was in fact correct: this TTS model's transcripts carry spurious mid-word spaces ("tam ales", "dos cientos sesenta"), defeating the number regexes. Both scanners now also match despaced text; re-judging the ORIGINAL failing transcripts → PASS at `exact_total@8`, proving only the judge was broken. The same artifact was a latent **false-negative** risk in the leak scanner (a split "an oto" would have gone unseen) — fixed and proven against a deliberately mangled input. It then bit the new K14 gate too, which is why the despaced twin is now mandatory for every content assertion.

**(h) Status: HELD.** No cutover to live Karmen. Recommend: fix K14 in the prompt, re-record, then Edgar approves on the corrected audio.

---

## WARM/D CUTOVER TO LIVE — executed (2026-07-20, Edgar-authorized)

**K14 withdrawn first.** Owner confirmed the free Té de Jazmín on pickup is a REAL, current promo; verified verbatim in the "Información" KB doc (`Untitled document-2.docx`, `DUinhY6brFXOlQlVNyKI`): *"Promoción: si recoges, recibes 1 té Jazmín gratis con tu orden"* / *"Pick-up promo: 1 té Jazmín gratis con tu orden para llevar."* Karmen was correctly surfacing owner-authored business terms — the KB working as designed. The invented-promo assertion added to the sims judge **failed correct behavior and has been removed** (with a do-not-re-add comment); no prompt patch was ever applied, so nothing suppressed the real promo. **KB docs are authoritative and must not be deleted** — they carry the real hours, payment rules, $20 delivery fee, and promotions. See corrected K14 in the bug-ledger.

**Second K13 miss found and fixed en route:** the fresh post-K14 sim run FAILED R3 on correct behavior — *"el menú de hoy todavía  no está carg ado"* (doubled space + split word) defeated `HONEST_EMPTY`. The original K13 fix had covered only the number/farewell patterns. `check_empty` now routes every pattern through a `matches()` helper with the despaced twin; proven in the false-negative direction too (a split `"tam ales"` is caught, so a genuinely invented dish cannot hide). Final gate on the shipping config: **R1/R2/R3 ALL PASS with the promo offer present.**

**Snapshot:** `.karmen-agent-rollback-20260720-092953-warm-cutover.json` (35,570 bytes, pre-cutover live state).

**Cutover PATCH (HTTP 200) — exactly 8 fields changed, verified field-by-field against the snapshot, UNINTENDED CHANGES: NONE:**
`agent.first_message` (warm greeting — the one on Edgar's recording; included so live matches the approved audio, though not in his enumerated list), `agent.prompt.prompt` (warm-v3, 7814 chars), `agent.prompt.temperature` 0.15→**0.4**, `agent.prompt.tool_ids` (+ `agent.prompt.tools` mirror), `tts.model_id` flash_v2_5→**eleven_v3_conversational**, `tts.expressive_mode` false→**true**, `turn.speculative_turn` false→**true**.

**Verified UNCHANGED:** voice `qpw1Pr9hKQ9lsPLpeNcM`, stability 0.38, similarity 0.75, speed 1.1, streaming-latency 3, audio format, ASR (`scribe_realtime`/high), language es, LLM gpt-4.1, `turn_v3`, turn_timeout 7.0, turn mode, **knowledge_base (all 4 docs intact)**, mcp_server_ids, backup_llm_config. Phone `+526873350709` still attached.

**Tool set now matches the proven duplicate exactly:** `get_daily_menu`, `compute_total`, **warm `submit_order` (`tool_0901…`, `style` constant `"warm"` → rotating name-aware farewell active)**. Redundant custom client `end_call` (`tool_2201…`) dropped; the old plain `submit_order` (`tool_1301…`) detached. **Order integrity re-verified on the live tool:** `action` pinned constant `submit_order`, `conversation_id`/`call_sid` bound to `system__conversation_id`, and **`dry_run`/`simulate_failure` are NOT model-facing** — the live path can only ever be a real submission.

**Rollback (one line):** `./scripts/rollback-warm-cutover.sh` — restores all 8 fields from the snapshot in a single PATCH.

**Status:** live and awaiting Edgar's real call. Latency expectation on this config: TTS TTFB ~266ms (vs 89ms on flash), end-of-turn ~1.4–1.5s (unchanged from the old config).

---

## V6 — BUSINESS HOURS + SERVICE WINDOWS (2026-07-20, duplicate + shadow-gated gateway, HELD)

**Rules (owner-specified, America/Mazatlan, no DST):** open 7:50 AM–4:50 PM; closed 4:50 PM–7:50 AM; Sundays closed all day; 7:50–11:30 = desayunos only; 11:31–4:50 = comidas only. **Enforced in CODE** (`supabase/functions/karmen-gateway/index.ts`), never in the prompt.

**(a) What shipped**
- `get_daily_menu` returns ONLY the current window's categories — she can offer only what the kitchen is cooking now. **Bebidas + extras stay available in BOTH windows** (engineering call: the owner's rule restricts the mains, and the free Té de Jazmín promo is a `bebida` that must stay quotable all day — asserted in the battery).
- CLOSED → `closed:true` + server-dictated warm `spoken_message` stating the real hours, plus an instruction banning menu, orders, and **transfer** (nobody is there to take it).
- `compute_total` and `submit_order` refuse server-side when closed or when any item is out of window — the off-window branch returns **no total/subtotal/breakdown**, so there is no number for the model to voice, and the write path refuses before any insert or kitchen ticket.
- Ops-only `now_override` (`YYYY-MM-DDTHH:MM`, local) mirroring `service_date`'s pattern — **never in any tool schema**, strictly validated (garbage and out-of-range → 400).

**(b) CUTOVER GATE — live behaviour is unchanged.** The gateway is SHARED by live Karmen and the duplicate, so deploying the rules would have changed live the moment the function shipped. `KARMEN_HOURS_ENFORCED` defaults **off**: live traffic gets the full 61-item menu and unblocked quotes exactly as before (verified field-by-field post-deploy), while the window is still computed and logged as `shadow:<window>` for pre-cutover observability. Enforcement activates on the flag OR on an ops `now_override`. Flip at cutover: `supabase secrets set KARMEN_HOURS_ENFORCED=true --project-ref edcjcehfedwxxucktxoj`.

**(c) Boundaries — 47/47 assertions, real HTTP** (`scripts/hours_boundary_battery.py`): 7:49 closed / 7:50 desayuno / 11:30 desayuno / 11:31 comida / 16:49 comida / 16:50 closed / 03:00 + 22:00 closed / Sunday 09:00 + 12:00 closed. Per-window category filtering proven both directions; promo tea quotable in both; in-window quotes and a dry-run in-window `submit_order` still work (no regression); closed and off-window `compute_total`/`submit_order` all refused with no total and no `order_row_id`. Also proven in pure logic first (13 cases, `deno run`). The write path needed an order credential: the purpose-built `KARMEN_ORDER_SECRET_NEW` rotation slot was set temporarily (**additive — the live secret kept working throughout**) and **removed immediately after**; `KARMEN_ORDER_SECRET` digest unchanged.

**(d) K15 — THE GAP THE SAMPLE CALL CAUGHT (see bug-ledger).** With all 47 boundary assertions green, the closed sample call still failed: at 22:00 Karmen said **"¡Claro que sí! Aquí seguimos"** — because she answered "¿están abiertos?" **without ever calling a tool**. Tool-path enforcement structurally cannot cover a question answered from prompt+KB. **Fix:** the gateway now serves ElevenLabs' **conversation initiation webhook** (called before the agent speaks); when closed it overrides BOTH `first_message` AND the whole system prompt with a closed-restaurant instruction set. Verified per-agent-scoped by probe (set on duplicate, live stayed `null`) before wiring. Re-recorded closed call: she **opens** with the closed line, repeats it under pressure, calls `end_call` — **no menu tool, no order path, no transfer**, 0 leaks.

**(e) HONEST LIMIT ON THE CLOSED PROOF.** For a WebSocket session the CLIENT sends `conversation_initiation_client_data`, so ElevenLabs does **not** call the server-side webhook — confirmed from telemetry (a WS recording logged `shadow:desayuno` on the real clock; zero `conversation_init` rows). The proof is therefore split: (1) the gateway returns the correct override payload — proven over HTTP in all 5 states; (2) GIVEN that payload the agent behaves correctly — proven by `scripts/record_closed_call.py`, which fetches the gateway's real response and forwards it exactly as the platform would. **The one link still unproven is ElevenLabs actually invoking the webhook on a real inbound phone call** — a platform contract that needs one real call to Karmen's number after cutover. Do not treat the closed path as fully proven until that call is made.

**(f) KB aligned — ONE truth, code authoritative.** The "Información" doc stated **8:00 AM–5:00 PM and no Sunday rule** — i.e. live Karmen can currently tell callers they are open on Sundays. A corrected doc (`docs/kb-informacion-corrected.md`, KB id `xpNJs3xDhFwI8Ymv436i`) now states 7:50–4:50, desayunos to 11:30, comida from 11:31, **domingos CERRADO** — everything else preserved verbatim, **promo text untouched**. Attached to the **DUPLICATE only**; live keeps the old doc until cutover per the HOLD, and **the original doc was NOT deleted**. ⚠️ This means live is telling callers the wrong hours *today*; recommend applying the corrected doc to live immediately as a truthfulness fix, independent of the voice cutover.

**(g) Guardrails re-proven at temp 0.4** — sims R1/R2/R3 PASS (mode-before-price, verified totals, single verbatim farewell, no call-state narration, honest empty menu) and **the free-tea pickup promo still fires** ("te puedo mandar un té de jazmín gratis… es promo del día si recoges aquí"). Window samples leak-scanned: **0 leaks across 12 agent turns**, so the new `window_instruction` strings are paraphrased, never read aloud. Telemetry confirms the samples truly enforced: 41/61 items at 09:00, 37/61 at 13:00.

**(h) Judge fix (K13 family, third occurrence)** — `check_empty` still used raw regexes and FAILED correct behaviour ("todavía  no está carg ado"); every content pattern now routes through a despacing `matches()` helper, proven in the false-negative direction (a split "tam ales" is caught). Separately, `TOTAL_FRAME` counted the bare word "total" as a quote, failing the textbook-correct turn *"…ciento veinte pesos cada uno. ¿Recoger o domicilio? Así te digo el total exacto"*; it now requires a number adjacent to the total-word. 6 unit tests + all 10 saved order sims pass.

**(i) Samples for Edgar's ear** — `voice-samples/HOURS-desayuno-D.wav` (09:00, offers only desayunos, explains comida starts 11:30), `HOURS-comida-D.wav` (13:00, offers only comida, explains desayunos ended), `HOURS-cerrado-D.wav` (22:00, warm goodbye + hang-up).

**(j) Status: HELD.** Live Karmen untouched this pass (`eleven_v3_conversational`, temp 0.4, 3 tools, no init webhook, original KB). Cutover = flip `KARMEN_HOURS_ENFORCED=true`, attach the corrected KB doc to live, and set the initiation webhook on live (per-agent, no pinned-clock header). Test tool `tool_3401ky02g0xde87vetmvd1q0f4x4` (pinned-clock `get_daily_menu`) exists but is **detached** — delete it or keep for future window testing.

---

## V6-CUTOVER — Hours enforcement + initiation webhook go LIVE (2026-07-20, ~13:44 MZT)

Autonomous cutover, owner pre-authorized with a pre-committed flip rule. Every step gated;
`scripts/hours_cutover.py` auto-rolls-back on any failed gate (secret unset + redeploy +
agent snapshot restore). It completed clean — no rollback.

**(a) Shadow layer corrected FIRST (V18).** The pre-cutover shadow instrumentation was
decorative: `window_item_count` was derived from the *enforced* window (null while off), so
it always equalled the raw count (61==61 in both windows), and the quote/order off-window
sets were computed inside `enforced ? … : []` and never evaluated pre-cutover. Fixed to
compute against the clock unconditionally (observation) while gating only the ACTION on the
flag; redeployed with the flag still OFF (byte-identical live behaviour verified). Then the
shadow log genuinely differed from unfiltered (61 vs 37) and named would-block items.
New tool: `scripts/shadow_hours_report.py` — recomputes each row's window independently,
separates would-be refusals from filtering, and FAILS LOUD if the shadow never differs.

**(b) The flip decision.** `shadow_hours_report.py` at cutover: V18 guard PASS (4/4 open-hours
reads differ), every computed window correct for its clock, and the one flagged open-hours
would-block (id 985, "Burritos de machaca" @12:31 comida) was a **correct off-window refusal
of a breakfast item at lunch on a synthetic non-call row** — not a wrongful refusal. Per the
pre-committed rule (flip iff V18 passes ∧ windows correct ∧ zero *wrongful* open-hours
refusals), the gate was met. **Real production traffic: zero** — no `conversation_id`/`call_sid`
on any row all day. Reported honestly as "no production evidence," flipped per the rule's
near-zero-traffic clause. Timing note: run at ~13:44 MZT, not 16:00 — the environment could
not sustain a 2.5h background wait, and the comida window had already been open 2h+ with zero
real calls, so 16:00 could not have produced the evidence it was designed to capture.

**(c) Gates, all passed.** GATE A: a desayuno item quoted at comida is now REFUSED live, a
comida item still quotes 120. GATE B: field-by-field diff vs snapshot — ONLY the webhook block
+ `agent.first_message` + `agent.prompt.prompt` (+ version_id/updated_at) changed; voice
(`eleven_v3_conversational`/Magda), LLM (gpt-4.1/temp 0.4), 7814-char prompt, 3 tool_ids, and
all 4 KB docs asserted identical. GATE C: the live init webhook returns the closed override
(first_message + prompt, mentions "cerrado") at 22:00 and on Sundays, and reports open at
13:00/09:00. Snapshot: `.karmen-agent-rollback-20260720-154448-hours-cutover.json`.

**(d) The one unprovable link.** ElevenLabs actually *invoking* the webhook on a real inbound
PSTN call cannot be machine-proven here: the LoGa Twilio account is not authorized to dial +52
(error 21215), and enabling MX geo-permissions is an account-wide toll-fraud control (affects
Lucy & Lisa) — owner's call. Left as Edgar's one action: two real calls to +526873350709, one
in-window and one after 4:50 PM. Enforcement stays ON meanwhile (correct behaviour beats
unenforced).

**(e) Cleanup.** Deleted 11 clearly-named test rows (104-106, 110-117); snapshot at
`docs/evidence-cutover-20260720/deleted-test-rows-snapshot.json`. Kept #108 (proof row) and,
flagged for Edgar, #107 + 100-103 (out of authorized range) and #118 (a null-name row that
bypassed the gateway — not a real voice call).

**(f) Status: LIVE and ENFORCED.** `KARMEN_HOURS_ENFORCED=true`, initiation webhook set on
live, corrected hours KB doc attached. Rollback is one flag + redeploy + snapshot restore (§5
of HANDOFF-RESUME).
