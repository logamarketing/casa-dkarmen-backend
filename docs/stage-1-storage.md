# Stage 1 — Storage (daily_menu)

**Date:** 2026-07-04 · **Project:** Casa D Karmen Project (`edcjcehfedwxxucktxoj`) · **Additive only.**

## Goal
Make the "menú del día" **data**, not prompt text. Karmen reads whatever rows
exist for a `service_date` — **count-agnostic** (12, 21, 30; never hardcoded).
The DB becomes the single source of truth for price.

## What shipped
- `supabase/migrations/20260704185136_create_daily_menu.sql` — the table.
- `supabase/migrations/20260704185137_seed_daily_menu_2026_07_04.sql` — one real
  day (from Edgar's Google Doc, updated 2026-07-03), idempotent upsert.

### Schema (`public.daily_menu`)
`id` (identity pk) · `service_date date` · `category text ∈ {comida,bebida,extra}` ·
`item_name text` · `price numeric(10,2) ≥ 0` · `sides text null` ·
`is_available boolean default true` · `sort_order int null` · `created_at timestamptz`.
Unique `(service_date, category, item_name)` → a re-seed updates the day in place.

## Decisions (engineering calls)
- **Count-agnostic by construction.** No count column, no per-day cap. Reads are
  `where service_date = <today> and is_available` — the row set defines the menu.
- **`price numeric(10,2)`**, not integer — extras and future half-portions.
- **RLS enabled, no policies.** Defensive default so the table isn't world-readable
  via the Data API. The Stage 2 read path uses the **service role** (bypasses RLS),
  matching the Lisa gateway. Add read policies only if a non-service-role reader is
  ever introduced.
- **Item names verbatim** from the source doc (e.g. `Aguacate extra`), not tidied —
  the doc is the source of truth.
- **`sides` NULL** where the doc lists none (e.g. `Nachos con Carne con Cochinita Pibil`).

## How it was applied (no DB password; loga-agent-core link untouched)
Applied byte-exact from the committed files via the **Management API**
(`POST /v1/projects/edcjcehfedwxxucktxoj/database/query`, `Bearer $SUPABASE_ACCESS_TOKEN`).
The Supabase **MCP** tools are scoped to the logamarketing org and **cannot reach
this project**, so they were not used. `supabase link` / `db push` were **not** run
(they'd need the DB password and would risk repointing another repo's CLI link).

**Migration-history note:** because these were applied via the API, no rows were
written to `supabase_migrations.schema_migrations`. Both migrations are idempotent
(`create table if not exists`, `on conflict do update`), so a future
`supabase db push` (once the DB password is available) will apply-and-record them
safely with no divergence.

## Verified (Definition of Done — live)
- **Counts by category (2026-07-04):** comida **21** @ 120 · bebida **11** @ 25 ·
  extra **6** (0–15). **Total 38.**
- **$120 correction:** all 21 comidas at 120; **0 rows at 110** (the old prompt's
  undercharge is gone from the source of truth).
- **Idempotency:** re-ran the seed migration → still **38** rows, no duplicates,
  unique constraint held.
- **RLS:** enabled on `daily_menu`.
- **Guardrail:** the only object added is `daily_menu`; `ordenes`,
  `ordenes_agente_voz`, `ordenes_unificadas`, `chat_context`, `n8n_chat_histories`
  are present and untouched. The n8n order webhook was not involved.
- **Karmen:** unchanged (rewire is Stage 2).

## Carry-forward → Stage 2 (read path)
- Resolve "today" in **America/Mazatlan** (Sinaloa, UTC-7, no DST) — never UTC.
- If no rows exist for today → explicit `menu_not_set`; never serve a stale day.
- Order items by `category`, then `sort_order`.
- Read via the service role (RLS bypass).
