-- Casa D'Karmen — menu_catalog (Stage 3: edit path, Phase 1 of 2)
--
-- Purpose: the reusable dish catalog behind "pick-from-catalog" in the daily-menu
-- admin app. The owner picks a known dish instead of retyping name/price/sides and
-- risking a typo. It is a CONVENIENCE source only: the single source of truth for
-- what Karmen serves on a given day remains public.daily_menu. Adding/removing a
-- catalog row never changes any daily_menu row.
--
-- Additive-only to the existing Casa D Karmen Project (ref edcjcehfedwxxucktxoj).
-- Touches nothing on daily_menu's rows, karmen-gateway, ordenes*, chat_context,
-- n8n_chat_histories, ordenes_unificadas, or the n8n order webhook. Safe to re-run.

create table if not exists public.menu_catalog (
  id            bigint generated always as identity primary key,
  category      text          not null check (category in ('comida','bebida','extra')),
  item_name     text          not null,
  default_price numeric(10,2) not null check (default_price >= 0),
  default_sides text,
  is_active     boolean       not null default true,
  sort_hint     integer,
  created_at    timestamptz   not null default now(),
  constraint menu_catalog_cat_item_key unique (category, item_name)
);

comment on table public.menu_catalog is
  'Casa D''Karmen reusable dish catalog for the daily-menu admin picker. NOT a source of truth for service — public.daily_menu is. One row per (category, item_name); default_price/default_sides prefill the daily row when the owner picks an item. Additive; unrelated to the ordenes/n8n order flow.';

-- Same defensive posture as daily_menu: RLS enabled with NO policies = deny-all to
-- anon/authenticated. All access goes through the karmen-menu-admin edge function,
-- which uses the service role (bypasses RLS). Nothing here is world-readable.
alter table public.menu_catalog enable row level security;
