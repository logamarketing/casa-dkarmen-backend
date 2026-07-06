-- Seed — Casa D'Karmen menu_catalog from the real daily_menu history.
--
-- Source of truth for the seed is whatever days already exist in public.daily_menu
-- (the 2026-07-04 seed day gives ~38 real dishes at their corrected prices). We take
-- ONE row per (category, item_name) — the most recent day's price/sides for that
-- dish — so the catalog reflects the latest known price. This is READ-ONLY against
-- daily_menu; it does not modify a single daily_menu row.
--
-- Idempotent: ON CONFLICT (category, item_name) DO NOTHING. Re-running never
-- duplicates and never overwrites a catalog price the owner may have since edited.

insert into public.menu_catalog (category, item_name, default_price, default_sides, sort_hint)
select distinct on (dm.category, dm.item_name)
  dm.category,
  dm.item_name,
  dm.price,
  dm.sides,
  dm.sort_order
from public.daily_menu dm
order by dm.category, dm.item_name, dm.service_date desc, dm.id desc
on conflict (category, item_name) do nothing;
