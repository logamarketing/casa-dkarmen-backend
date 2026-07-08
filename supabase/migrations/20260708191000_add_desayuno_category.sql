-- Casa D'Karmen — widen menu category checks to include desayuno.
--
-- Purpose: allow breakfast items to live as a first-class category in both the
-- daily menu and reusable catalog, without changing the behavior of existing
-- comida, bebida, or extra rows.
--
-- Safe to re-run: we replace the category CHECK constraints with the widened
-- allowlist on each run.

alter table if exists public.daily_menu
  drop constraint if exists daily_menu_category_check;

alter table if exists public.daily_menu
  add constraint daily_menu_category_check
  check (category in ('desayuno', 'comida', 'bebida', 'extra'));

alter table if exists public.menu_catalog
  drop constraint if exists menu_catalog_category_check;

alter table if exists public.menu_catalog
  add constraint menu_catalog_category_check
  check (category in ('desayuno', 'comida', 'bebida', 'extra'));
