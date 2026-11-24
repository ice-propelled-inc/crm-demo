-- Demo call desk: calls, live transcript, call state and appointments.
-- Edge Functions write with the service role; the static page reads with the anon key.

create table public.calls (
  id              uuid primary key default gen_random_uuid(),
  phone           text,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  status          text not null default 'ringing' check (status in ('ringing', 'active', 'ended')),
  mode            text not null default 'ringing' check (mode in ('ringing', 'ai', 'admin', 'transferring')),
  outcome         text,
  handoff_reason  text,
  recording_url   text,
  twilio_call_sid text,
  vapi_call_id    text unique
);
create index calls_started_at_idx on public.calls (started_at desc);

create table public.call_messages (
  id         bigint generated always as identity primary key,
  call_id    uuid not null references public.calls (id) on delete cascade,
  speaker    text not null check (speaker in ('ai', 'caller', 'admin', 'system')),
  text       text not null,
  created_at timestamptz not null default now()
);
create index call_messages_call_idx on public.call_messages (call_id, created_at);

create table public.call_state (
  call_id        uuid primary key references public.calls (id) on delete cascade,
  stage          text,
  script_step    text,
  fields         jsonb not null default '{}'::jsonb,
  handoff_reason text,
  updated_at     timestamptz not null default now()
);

-- start / end are clinic local time (schedule.json time zone), without a time zone offset.
create table public.appointments (
  id               uuid primary key default gen_random_uuid(),
  call_id          uuid references public.calls (id) on delete set null,
  doctor_id        text,
  service_id       text,
  start            timestamp,
  "end"            timestamp,
  name             text,
  phone            text,
  patient_type     text check (patient_type in ('new', 'returning')),
  complaint        text,
  insurance_number text,
  status           text not null default 'draft'
                   check (status in ('draft', 'filled', 'completed', 'cancelled', 'missed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index appointments_doctor_start_idx on public.appointments (doctor_id, start);
create index appointments_call_idx on public.appointments (call_id);

create function public.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger appointments_touch before update on public.appointments
  for each row execute function public.touch_updated_at();

-- Row level security: the page may read everything and change only the appointment status.
-- Demo only: anyone with the page URL and the anon key can read this data. Use test data, never real patients.
alter table public.calls enable row level security;
alter table public.call_messages enable row level security;
alter table public.call_state enable row level security;
alter table public.appointments enable row level security;

create policy "page reads calls" on public.calls for select to anon, authenticated using (true);
create policy "page reads messages" on public.call_messages for select to anon, authenticated using (true);
create policy "page reads call state" on public.call_state for select to anon, authenticated using (true);
create policy "page reads appointments" on public.appointments for select to anon, authenticated using (true);
create policy "page updates appointment status" on public.appointments for update to anon, authenticated
  using (true) with check (true);

revoke insert, update, delete on public.calls, public.call_messages, public.call_state, public.appointments from anon, authenticated;
grant select on public.calls, public.call_messages, public.call_state, public.appointments to anon, authenticated;
grant update (status) on public.appointments to anon, authenticated;

-- Realtime pushes changes of these tables to the page.
alter publication supabase_realtime add table public.calls, public.call_messages, public.call_state, public.appointments;
