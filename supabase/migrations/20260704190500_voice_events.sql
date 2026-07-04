-- Casa D'Karmen — voice_events (Stage 2: gateway telemetry)
--
-- Best-effort observability for karmen-gateway: get_daily_menu calls (with
-- item_count / menu_not_set / latency), errors, and unauthorized attempts.
-- The menu_not_set events are the operational signal for "Edgar hasn't loaded
-- today's menu yet." Writes are service-role only (from the edge function).
--
-- Additive-only. Touches nothing on ordenes*, chat_context,
-- n8n_chat_histories, ordenes_unificadas, or the n8n order webhook. Safe to
-- re-run.

create table if not exists public.voice_events (
  id          bigint generated always as identity primary key,
  call_sid    text,
  event_type  text        not null,
  payload     jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists voice_events_created_at_idx
  on public.voice_events (created_at desc);

create index if not exists voice_events_type_created_idx
  on public.voice_events (event_type, created_at desc);

comment on table public.voice_events is
  'Karmen voice-gateway telemetry (best-effort, written by the edge function via the service role). Additive; unrelated to the ordenes/n8n order flow.';

-- Defensive default: not world-readable via the Data API. The edge function
-- writes with the service role (bypasses RLS). Add a read policy only if an
-- admin dashboard on a non-service-role key ever needs it.
alter table public.voice_events enable row level security;
