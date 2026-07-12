# Stage 3 — Edit path (the daily-menu admin app) — BUILD BRIEF

**Date:** 2026-07-06 · **Project:** Casa D Karmen Project (`edcjcehfedwxxucktxoj`) ·
**Reference:** `la-bodega-admin-panel` Products surface (list + inline-edit + confirm + fail-closed auth).

## Goal
Karmen's owner sets **today's menu without hand-editing a prompt or a SQL seed.**
One Spanish, tablet-first screen writes `daily_menu` — the same rows the Stage-2
`karmen-gateway` already reads. Three ergonomics that make a 38-item day a
30-second job: **copy-yesterday**, **pick-from-catalog**, **toggle sold-out**.
Additive only; the gateway, `ordenes*`, `chat_context`, `n8n_chat_histories`,
`ordenes_unificadas`, and the n8n webhook are untouched.

## What this ISN'T (scope discipline — inherited from the La Bodega study)
No brands, no categories table, no price lists (retail/wholesale), no images/WebP,
no SKU/slug generation, no units-per-case/barcodes, no order-history delete guard,
no admin-vs-manager split. `daily_menu.category` is a fixed 3-value enum
(`comida|bebida|extra`), not a table. Everything La Bodega does around those is
deleted, not ported.

---

## ⚠️ ONE OPEN PRODUCT DECISION (owner's call — do not guess)
**Standing breakfast (desayuno permanente).** It does **not** exist today, and
Karmen's prompt *actively refuses* breakfast ("si te piden… desayuno… ofréceles
lo de hoy"). So this is a **new product decision**, not a port. Two questions for
the owner before Phase 3 is built:
1. Is there a fixed breakfast menu served **every day** regardless of the daily
   comida/bebida rows? (items + prices)
2. Should Karmen offer it **all day**, or only within breakfast hours?

Until answered, Phases 1–2 (copy-yesterday + catalog + sold-out) ship on their
own and deliver 90% of the value. Phase 3 is scoped below but **gated on this
answer** — because it also changes the read path (see §"Standing breakfast").

---

## Architecture verdict (committed, with the tradeoff stated)

**Writes go through a new edge function `karmen-menu-admin` (service role), NOT
direct table writes from the browser.** Rationale:
- This project already works exactly this way — the gateway reads via the service
  role and `daily_menu` is **RLS-enabled with no policies (deny-all)**. Adding
  owner-write RLS policies *and* shipping the anon key to a browser that mutates
  the live menu is a looser posture than the shipped reference.
- One edge function keeps `daily_menu` locked, mirrors the gateway's fail-closed
  shape, centralizes validation (category enum, price ≥ 0, date = today/future),
  and gives a single audit point via `voice_events`.
- **Tradeoff:** a little more backend code than direct `supabase.from().upsert()`,
  and every write is a function round-trip. Accepted — this is a low-frequency
  admin surface, not a hot path. Consistency + defense-in-depth win.

**Owner auth:** Supabase Auth (email + password) for the one owner account.
Function runs `verify_jwt=true` **+** checks `auth.uid()` against a small
allowlist (`KARMEN_MENU_ADMINS` env, comma-separated UUIDs — or a `menu_admins`
table if it grows). Neither the anon key alone nor a signed-in-but-not-allowlisted
user can write. Mirrors La Bodega's "sign in → role check → gate," minus the
admin/manager tiers.

---

## The ≤3 new backend things (WE apply via CLI `--project-ref` + `$SUPABASE_ACCESS_TOKEN`; MCP can't reach this org)

1. **`menu_catalog` table** — the pick-from-catalog source, so the owner never
   retypes a dish or fat-fingers a price.
   ```sql
   create table if not exists public.menu_catalog (
     id            bigint generated always as identity primary key,
     category      text not null check (category in ('comida','bebida','extra')),
     item_name     text not null,
     default_price numeric(10,2) not null check (default_price >= 0),
     default_sides text,
     is_active     boolean not null default true,
     sort_hint     integer,
     constraint menu_catalog_cat_item_key unique (category, item_name)
   );
   alter table public.menu_catalog enable row level security; -- deny-all; admin fn uses service role
   ```
   **Seed** from the distinct `(category, item_name, price, sides)` already in
   `daily_menu` (the 2026-07-04 day gives 38 real starter rows). Idempotent upsert
   on `(category, item_name)`.

2. **`karmen-menu-admin` edge function** — fail-closed, service-role writes,
   actions (Spanish error messages, clean JSON, `voice_events` audit):
   - `list_day { service_date? }` → **all** rows for the day **including
     `is_available=false`** (unlike the gateway, which hides them) so the owner
     can un-sell-out an item. Defaults to today in `America/Mazatlan`.
   - `list_catalog {}` → active `menu_catalog` rows for the picker.
   - `upsert_item { service_date?, category, item_name, price, sides?, sort_order? }`
     → validate enum + price ≥ 0; upsert on the `(service_date, category, item_name)`
     unique key. Reject `service_date` in the past (never edit a served day).
   - `set_available { id, is_available }` → the sold-out toggle (soft hide;
     matches the gateway's 15s cache — a flip reflects within one TTL).
   - `delete_item { id }` → hard-remove a single row (today/future only).
   - `copy_day { from_date?, to_date? }` → `insert … select` most-recent-prior
     day → target; **`on conflict (service_date,category,item_name) do nothing`**
     so it never clobbers edits the owner already made today. Returns inserted count.
   - **Idempotency:** accept an optional `request_id` on mutating actions; a repeat
     is a no-op (mirrors La Bodega's `admin_upsert_product` key — matters most for
     `copy_day`).

3. **(Phase 3 only, GATED) standing-breakfast** — see §"Standing breakfast".

No RLS policy is added to `daily_menu`: it stays deny-all; the admin function's
service role writes it. That is the point of the architecture choice.

---

## Bolt frontend brief (the app) — MANDATORY discipline (from La Bodega CLAUDE.md)

**Phase 1 — INSPECT FIRST, report, STOP.** Before writing code, confirm: the
`karmen-menu-admin` action names + exact JSON shapes, the **locked** `daily_menu`
column names (`service_date, category, item_name, price, sides, is_available,
sort_order`), the `menu_catalog` columns, and the anon key + function URL. **Bolt
invents field names — grep the output for invented names before accepting.** Do
not touch any Stage-2 file (`karmen-gateway`, the ElevenLabs tool/prompt).

**Phase 2 — implement only after Lopz confirms.** One screen:

- **Stack:** Vite + React 18 + TS + Tailwind + `@supabase/supabase-js`, Spanish
  UI, phone/tablet-first. Same shape as `la-bodega-admin-panel`.
- **Auth:** Supabase Auth login (email/password) → gate the whole app
  (clone `AuthContext` + `ProtectedRoute`, one role). No role RPC needed;
  the admin function is the real wall.
- **Header:** today's date resolved in **`America/Mazatlan`** (never UTC — a
  single `todayInTz` helper, byte-identical logic to the gateway), title "Menú de
  hoy — {fecha}".
- **Two big primary actions:**
  - **"Copiar el menú de ayer"** → `copy_day`. This is the *default daily move*
    (most days repeat). Then the owner tweaks.
  - **"Agregar platillo"** → opens the **catalog picker** (searchable combobox,
    cloned from La Bodega's brand combobox: type → filtered list → pick prefills
    price+sides → `upsert_item`; "escribe uno nuevo" path allowed and it also
    lands in `menu_catalog`).
- **Body:** three sections **Comida / Bebida / Extra**, each a list of the day's
  rows: `item_name`, inline-editable `price` ($ prefix), `sides`, an
  **available toggle** (sold-out), and delete. Reuse La Bodega's `PriceSection`
  input styling and slide-over/inline-edit feel.
- **Empty state (mirrors the gateway's `menu_not_set`):** when today has zero
  rows, show "El menú de hoy aún no está cargado" + the two big actions front and
  center — so the owner immediately sees Karmen has nothing to read.
- **Feedback + guards (ported verbatim in spirit):** green "Guardado" banner that
  auto-clears (~2s); **confirm modal on delete**; **confirm modal on a $0 price
  for comida/bebida** (but $0 is *valid* for extras like "Cuchara extra" — don't
  block those). Trust the write, show the write; re-fetch `list_day` after each
  mutation.
- **Files (surgical scope — lock these, protect everything else):**
  `src/lib/supabase.ts`, `src/lib/menuAdmin.ts` (function client), `src/lib/time.ts`
  (`todayInTz`), `src/context/AuthContext.tsx`, `src/components/ProtectedRoute.tsx`,
  `src/pages/LoginPage.tsx`, `src/pages/MenuDelDiaPage.tsx`,
  `src/components/CatalogPicker.tsx`, `src/components/MenuRow.tsx`,
  `src/components/ConfirmModal.tsx`. **Do NOT create any `daily_menu` migration or
  write SQL — the backend is applied separately by Lopz.**

**Known-good test values:** date `2026-07-04` (38 seeded rows: 21 comida @120,
11 bebida @25, 6 extra 0–15); a comida = `Cazuela` / `120` / `arroz`; a $0 extra =
`Cuchara extra`.

---

## Standing breakfast (Phase 3 — GATED on the owner decision above)
Recommended shape **if** the owner confirms a fixed daily breakfast:
- New `standing_items` table (always-available; **no `service_date`**):
  `category, item_name, price, sides, is_available, sort_order`.
- The admin app gets a small read-only-ish "Desayuno permanente" section editing
  `standing_items` (rare changes).
- **Read-path change (coordinated, NOT app-only):** `karmen-gateway`'s
  `get_daily_menu` **unions** active `standing_items` into today's response so
  Karmen serves breakfast every day without the owner re-adding it — and the
  ElevenLabs prompt's "no breakfast" refusal is lifted in lockstep.
- This is why Phase 3 waits: it touches Stage 2, so it ships as its own
  audit → build → prove-with-one-live-call cycle, never bolted onto the app quietly.

---

## Gotchas (call these out in the Bolt prompt)
- **"Today" = `America/Mazatlan` (UTC-7, no DST), never UTC** — editor and gateway
  must resolve the same date string or the owner edits a day Karmen isn't reading.
- **Separate Supabase org; MCP can't reach it** — backend applied via CLI/Mgmt API
  with `$SUPABASE_ACCESS_TOKEN`; Bolt only builds the frontend against the function.
- **`daily_menu` is RLS deny-all** — the app must go through `karmen-menu-admin`;
  a direct `from('daily_menu')` write from the browser will (correctly) fail.
- **Bolt invents field names** — lock the column/action names; grep before accepting.
- **`copy_day` must `do nothing` on conflict** — never clobber an edit already made.
- **Never leave Karmen broken** — the app is additive; the current gateway/prompt
  keep working whether or not today's rows exist. The `menu_not_set` contract is
  the safety net.

## AS-BUILT — Phases 1–2 backend (applied + proven 2026-07-06)

Everything below is live on project `edcjcehfedwxxucktxoj` and proven by real HTTP
calls (17/17 checks). This is the contract the Bolt frontend builds against.

**Shipped**
- `public.menu_catalog` table (RLS deny-all) — seeded **38** rows from real
  `daily_menu` history (11 bebida / 21 comida / 6 extra), idempotent.
- `karmen-menu-admin` edge function, `verify_jwt=true` (pinned in `config.toml`),
  service-role writes, fail-closed on `x-karmen-admin-secret`.
- Migrations: `20260706150000_create_menu_catalog.sql`,
  `20260706150001_seed_menu_catalog.sql`.

**Auth — as built (differs from the plan above, on purpose).** The plan floated a
Supabase-Auth uid-allowlist; the delivered build uses the **two-var shared-secret**
posture the build brief asked for, mirroring `karmen-gateway` exactly: caller sends
`Authorization: Bearer <anon JWT>` (platform `verify_jwt`) **+** `x-karmen-admin-secret`
matched against `KARMEN_ADMIN_SECRET` / `KARMEN_ADMIN_SECRET_NEW` (rotation; NEW
unset today). Neither set OR no match → 401. *Known posture note:* a browser app
holding the write secret is acceptable for one owner + low blast radius (menu only,
past days immutable); the documented hardening path if this ever widens is a user-JWT
+ uid allowlist, layered on top without changing the action contract.

**Function URL:** `https://edcjcehfedwxxucktxoj.supabase.co/functions/v1/karmen-menu-admin`
(POST only; every body needs `"action"`).

**Actions + request shapes** (all responses `{ok:true,...}` or `{ok:false,error}`):
| action | request body | notes |
|---|---|---|
| `list_day` | `{action, service_date?}` | all rows incl. `is_available=false`; default today (America/Mazatlan). Returns `items[]` with `id,category,item_name,price,sides,is_available,sort_order`. |
| `list_catalog` | `{action}` | active catalog for the picker: `catalog[]` `{id,category,item_name,default_price,default_sides,sort_hint}`. |
| `upsert_item` | `{action, service_date?, category, item_name, price, sides?, sort_order?, is_available?}` | add/edit one dish; natural idempotency on `(service_date,category,item_name)`. Past date → 400. |
| `set_available` | `{action, id, is_available}` | sold-out toggle. Past date → 400. |
| `delete_item` | `{action, id}` | remove one dish. Past date → 400. |
| `copy_day` | `{action, to_date?, from_date?}` | clone latest prior day → target; **ON CONFLICT DO NOTHING** (never clobbers edits). Returns `{from_date,to_date,source_count,skipped_existing,inserted}`. |

**Validation/guardrails enforced in code:** `category ∈ {desayuno,comida,bebida,extra}`;
`price ≥ 0` finite; `item_name` required; **service_date in the past is never
writable** (a served day is history); "today" resolved in **America/Mazatlan**
(byte-identical to the gateway). Errors are clean Spanish JSON; raw DB text never
leaks. Best-effort audit to `voice_events` (`menu_admin_*` events).

**2026-07-12 — `desayuno` added to the admin app's category whitelist.**
`daily_menu` and `menu_catalog` already carried `category='desayuno'` rows
(added out-of-band, ahead of this repo's migration history — see
`20260712120000_allow_desayuno_category.sql`, which catches the CHECK
constraints up to what was already live). `karmen-menu-admin`'s `CATEGORIES`
whitelist now includes it, so the owner's app can manage breakfast rows
end-to-end (`list_day`/`list_catalog`/`upsert_item`/`set_available`/
`delete_item`/`copy_day` all treat it like any other category — `copy_day` in
particular never filtered on `CATEGORIES`, so it already carried desayuno rows
across once they were writable). **This is admin-only.** `karmen-gateway`
(the voice-agent read path) still deliberately excludes `desayuno` from
`get_daily_menu`, and Karmen's system prompt still refuses breakfast requests
— see the Standing-breakfast section above. Lifting that is its own
coordinated backend+prompt cycle, not part of this change.

**Proven live (throwaway date 2026-09-09, cleaned up):** fail-closed 401 (no/wrong
secret) · list_catalog=38 · copy_day=38 from 2026-07-05 · upsert Cazuela→999 ·
set_available→false · delete→37 · re-copy inserted=1/skipped=37 with the 999 edit
**preserved** · past-date upsert+copy both rejected · **`daily_menu` fingerprint
identical before/after (76 rows untouched)** · gateway still reads 2026-07-04 as
38 items @ $120 and returns `menu_not_set` for today (no rows) — unaffected.

**Rollback point:** `main` @ `af17452ad18b364e1c4075e3ed30f919ba5e45c2` (pre-Stage-3).
To fully revert: `drop table public.menu_catalog;` · delete the `karmen-menu-admin`
function (`supabase functions delete karmen-menu-admin --project-ref edcjcehfedwxxucktxoj`) ·
`git revert`/reset the Stage-3 commit. `daily_menu`, `karmen-gateway`, Karmen's
prompt, and the ordenes/n8n flow are untouched by all of the above.

## DONE WHEN
- [ ] Owner logs in; a non-allowlisted account cannot write (verified live).
- [ ] Empty day shows the `menu_not_set`-style state + both big actions.
- [ ] "Copiar ayer" populates today from the prior day; re-running is a safe no-op.
- [ ] Catalog picker adds an item with prefilled price/sides; a brand-new dish
      also lands in `menu_catalog`.
- [ ] Inline price edit + sold-out toggle + delete each round-trip and re-fetch;
      confirm modals fire on delete and on $0 comida/bebida.
- [ ] `karmen-gateway get_daily_menu` reflects the app's edits within one cache TTL
      (~15s) — proven by editing in the app, then hitting the gateway.
- [ ] Guardrail: only `menu_catalog` (+ Phase 3 `standing_items`) and the admin
      function are added; gateway/`ordenes*`/n8n untouched.
- [ ] Standing breakfast: **NOT built** until the owner answers the two questions
      and the read-path change is planned as its own cycle.
