-- Casa D'Karmen — allow 'desayuno' (breakfast) as a 4th category.
--
-- Catches up this repo's migration history to what is already live on
-- edcjcehfedwxxucktxoj: daily_menu and menu_catalog both already carry rows
-- with category='desayuno' (added out-of-band), so the CHECK constraints
-- created in 20260704185136_create_daily_menu.sql and
-- 20260706150000_create_menu_catalog.sql (comida|bebida|extra only) no longer
-- match production. This migration is a no-op against the live DB (the
-- constraint already permits desayuno there) but keeps a fresh
-- `supabase db reset` / new environment in sync with reality.
--
-- Additive only. Does not touch karmen-gateway, ordenes*, chat_context,
-- n8n_chat_histories, ordenes_unificadas, or the n8n order webhook — Karmen's
-- voice agent still deliberately excludes desayuno (see
-- supabase/functions/karmen-gateway/index.ts CATEGORIES + the system prompt);
-- that is a separate, coordinated read-path decision, not part of this change.

alter table public.daily_menu
  drop constraint if exists daily_menu_category_check;
alter table public.daily_menu
  add constraint daily_menu_category_check
  check (category in ('desayuno', 'comida', 'bebida', 'extra'));

alter table public.menu_catalog
  drop constraint if exists menu_catalog_category_check;
alter table public.menu_catalog
  add constraint menu_catalog_category_check
  check (category in ('desayuno', 'comida', 'bebida', 'extra'));
