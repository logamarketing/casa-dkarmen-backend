-- Casa D'Karmen — daily_menu (Stage 1: storage)
--
-- Purpose: hold the "menú del día" as DATA so the Karmen voice agent reads
-- whatever rows exist for a given service_date. Count-agnostic by design:
-- 12, 21, 30 items — the number is NEVER hardcoded anywhere. The DB is the
-- single source of truth for price (ends the hand-edited prompt).
--
-- Additive-only to the existing Casa D Karmen Project (ref edcjcehfedwxxucktxoj).
-- Touches nothing on ordenes*, chat_context, n8n_chat_histories,
-- ordenes_unificadas, or the n8n order webhook. Safe to re-run.

create table if not exists public.daily_menu (
  id            bigint generated always as identity primary key,
  service_date  date          not null,
  category      text          not null check (category in ('comida','bebida','extra')),
  item_name     text          not null,
  price         numeric(10,2) not null check (price >= 0),
  sides         text,
  is_available  boolean       not null default true,
  sort_order    integer,
  created_at    timestamptz   not null default now(),
  constraint daily_menu_day_category_item_key unique (service_date, category, item_name)
);

comment on table public.daily_menu is
  'Casa D''Karmen menú del día. One row per item per service_date; the voice agent reads whatever rows exist for the requested day (count-agnostic). Single source of truth for price. Additive; unrelated to the ordenes/n8n order flow.';

-- Defensive default: a new table in a project that exposes the Data API must
-- not be world-readable. The Stage 2 read path uses the service role (which
-- bypasses RLS), matching the Lisa gateway pattern. No policies are added in
-- Stage 1 by design — RLS-enabled + no policy = deny to anon/authenticated.
alter table public.daily_menu enable row level security;
