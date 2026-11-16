-- Días cerrados — one-off closed dates, and the ONE rule for "is Casa D'Karmen
-- closed on this date?" that every channel asks: karmen-gateway (site menu and
-- voice agent), the WhatsApp bot (n8n, direct Postgres), the hub.
-- Applied 2026-11-16 via `supabase db query --linked` (this file is the schema
-- of record; the project does not use `db push`). Rollback:
-- scripts/rollback_20261116220000_dias_cerrados.sql.
--
-- Why: on Monday 2026-11-16 the restaurant was closed, but the breakfast menu
-- auto-seeded at 05:00 and every channel took the day as open. The only closed
-- day the system knew was Sunday, hard-coded in the gateway.
--
-- Access model — same as public.promociones: RLS enabled with NO policies, so
-- only the table owner and the service role (edge functions) can read or
-- write rows; admin writes will go through a hub-session-gated edge function.
-- anon/authenticated table privileges are revoked as well, so no future
-- policy can open a public write path by accident.
--
-- The two functions are SECURITY DEFINER on purpose: under RLS-with-no-policies
-- a plain role (e.g. n8n's Postgres login) would read ZERO rows, and every
-- one-off closed date would silently look open. As definer they always see the
-- real table. They expose only "closed or not" and a date — never creado_por.

create table public.dias_cerrados (
  fecha date primary key,
  creado_en timestamptz not null default now(),
  creado_por text
);

comment on table public.dias_cerrados is
  'One-off closed dates (Mazatlan calendar dates). Sundays are closed by rule and need no row. Read through karmen_dia_cerrado / karmen_proxima_apertura.';

alter table public.dias_cerrados enable row level security;
revoke all on table public.dias_cerrados from anon, authenticated;

-- True on a Sunday (always) or on a date listed in dias_cerrados.
create function public.karmen_dia_cerrado(p_fecha date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select extract(isodow from p_fecha) = 7
      or exists (select 1 from public.dias_cerrados d where d.fecha = p_fecha);
$$;

comment on function public.karmen_dia_cerrado(date) is
  'Closed on this date? Sunday or listed in dias_cerrados. The single source of truth for every channel.';

-- The first date strictly after p_desde that is open (not a Sunday, not in
-- dias_cerrados). NULL when there is none within 60 days.
create function public.karmen_proxima_apertura(p_desde date)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select p_desde + g.i
  from generate_series(1, 60) as g(i)
  where not public.karmen_dia_cerrado(p_desde + g.i)
  order by g.i
  limit 1;
$$;

comment on function public.karmen_proxima_apertura(date) is
  'First open date strictly after p_desde (not Sunday, not in dias_cerrados); NULL if none within 60 days.';
