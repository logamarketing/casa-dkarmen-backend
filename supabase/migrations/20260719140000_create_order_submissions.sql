-- Stage A order integrity: idempotency guard for the new submit_order gateway
-- action. Additive only — does not touch ordenes/ordenes_agente_voz/ordenes_unificadas
-- or any existing table. See docs/stage-A-order-integrity-design.md.
--
-- Keyed on the ElevenLabs system__conversation_id dynamic variable (wired into
-- the new submit_order tool, not the existing get_daily_menu/compute_total
-- tools). A row here means "this exact tool call already produced a verified
-- ordenes_agente_voz insert" — a retry/duplicate call with the same
-- conversation_id is answered idempotently instead of writing a second order.
--
-- conversation_id is nullable: if the dynamic variable does not arrive on a
-- given call (open question at build time — being empirically tested), that
-- call simply cannot be deduped, and the gap is visible in voice_events
-- telemetry rather than silently assumed away. A NULL never collides with
-- another NULL under a plain UNIQUE constraint, so no partial/filtered index
-- is needed for that case.

create table if not exists public.order_submissions (
  conversation_id text primary key,
  order_row_id bigint not null,
  created_at timestamptz not null default now()
);

comment on table public.order_submissions is
  'Idempotency guard for karmen-gateway submit_order (Stage A). One row per verified ordenes_agente_voz insert, keyed by ElevenLabs conversation_id.';

alter table public.order_submissions enable row level security;
-- No policies: service-role key only (same posture as daily_menu/voice_events).
-- RLS-enabled-no-policy is the deliberate fail-closed default for a table with
-- no anon/authenticated access path (K-series prevention rule, Stage 1 recap).
