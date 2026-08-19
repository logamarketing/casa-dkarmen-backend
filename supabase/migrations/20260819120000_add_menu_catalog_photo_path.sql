-- Casa D'Karmen — menu_catalog.photo_path (dish photos for the ordering site).
--
-- The photo lives with the DISH (catalog), not the day: daily_menu rows join to
-- their catalog row by (category, item_name) at read time in karmen-gateway, so
-- a dish photographed once shows its photo every day it is served.
--
-- Stores the STORAGE PATH inside the public "platos" bucket (e.g.
-- "Cazuela.webp"), never a URL — the gateway builds the public URL so the
-- bucket/host can move without a data migration. Nullable: no photo, no path.
--
-- Additive only. Touches nothing on daily_menu rows, ordenes*, chat_context,
-- n8n_chat_histories, ordenes_unificadas, or n8n. Safe to re-run.

alter table public.menu_catalog
  add column if not exists photo_path text;

comment on column public.menu_catalog.photo_path is
  'Storage path of the dish photo inside the PUBLIC "platos" bucket (path only, never a URL). Read by karmen-gateway get_daily_menu (include_photos) for the ordering site. Nullable = no photo.';
