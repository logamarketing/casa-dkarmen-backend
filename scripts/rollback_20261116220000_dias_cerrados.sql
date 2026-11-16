-- ROLLBACK for supabase/migrations/20261116220000_dias_cerrados.sql
--
-- Order: roll the GATEWAY back first, then run this.
--   1. Gateway -> the pre-change version (v33, commit 8305471):
--        git -C casa-dkarmen-backend show 8305471:supabase/functions/karmen-gateway/index.ts \
--          > supabase/functions/karmen-gateway/index.ts
--        supabase functions deploy karmen-gateway --project-ref edcjcehfedwxxucktxoj
--   2. supabase db query --linked -f scripts/rollback_20261116220000_dias_cerrados.sql
--
-- Either order is safe: a gateway that cannot reach these functions falls back
-- to the Sunday-only rule and logs `closed_check_error`.
-- WARNING: dropping the table discards every one-off closed date entered.

begin;
drop function if exists public.karmen_proxima_apertura(date);
drop function if exists public.karmen_dia_cerrado(date);
drop table if exists public.dias_cerrados;
commit;
