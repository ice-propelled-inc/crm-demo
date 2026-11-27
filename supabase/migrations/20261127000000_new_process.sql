-- New demo process (docs/demo-process.md): operation modes, administrator availability, tasks,
-- notifications, web chat, three insurance fields, and clinic data kept in the database.
-- Edge Functions write with the service role; the page reads with the anon key and writes through the admin function.

-- Calls and chats share the calls table; channel tells them apart.
alter table public.calls add column channel text not null default 'phone' check (channel in ('phone', 'chat'));

-- Insurance: type (none / private / cdcp), company and member ID. insurance_number stays for old rows.
alter table public.appointments add column insurance_type text check (insurance_type in ('none', 'private', 'cdcp'));
alter table public.appointments add column insurance_company text;
alter table public.appointments add column insurance_member_id text;

-- Observer suggestions for the live page (next question, knowledge-base answer, handoff warning).
alter table public.call_state add column suggestions jsonb not null default '{}'::jsonb;

-- One row per business set. A missing row means the defaults from agent-config.json "settings".
create table public.business_settings (
  business           text primary key,
  operation_mode     text not null default 'overflow' check (operation_mode in ('copilot', 'overflow', 'autonomous')),
  admin_availability text not null default 'available' check (admin_availability in ('available', 'busy', 'offline')),
  notifications      jsonb not null default '{}'::jsonb,
  updated_at         timestamptz not null default now()
);

-- Clinic data edited on the page: the whole agent-config.json and schedule.json of a business set.
-- A missing row means the seed files published with the page.
create table public.business_data (
  business   text primary key,
  config     jsonb not null,
  schedule   jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.tasks (
  id             uuid primary key default gen_random_uuid(),
  business       text not null default 'dental',
  type           text not null check (type in ('callback', 'urgent_callback', 'coverage_check')),
  status         text not null default 'pending' check (status in ('pending', 'acknowledged', 'resolved', 'declined')),
  name           text,
  phone          text,
  reason         text,
  call_id        uuid references public.calls (id) on delete set null,
  appointment_id uuid references public.appointments (id) on delete set null,
  due_at         timestamptz not null default now() + interval '2 hours',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index tasks_business_created_idx on public.tasks (business, created_at desc);
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

-- Every notification the system sent or would send (status 'simulated' when no provider is configured).
create table public.notifications (
  id             bigint generated always as identity primary key,
  business       text not null default 'dental',
  appointment_id uuid references public.appointments (id) on delete cascade,
  event          text not null check (event in ('booked', 'rescheduled', 'cancelled', 'reminder')),
  channel        text not null check (channel in ('sms', 'email')),
  recipient      text,
  text           text not null,
  status         text not null check (status in ('sent', 'simulated', 'failed')),
  error          text,
  created_at     timestamptz not null default now()
);
create index notifications_business_created_idx on public.notifications (business, created_at desc);
create unique index notifications_reminder_once on public.notifications (appointment_id, event) where event = 'reminder';

-- Row level security: the page reads everything. Demo only: use test data, never real patients.
alter table public.business_settings enable row level security;
alter table public.business_data enable row level security;
alter table public.tasks enable row level security;
alter table public.notifications enable row level security;

create policy "page reads settings" on public.business_settings for select to anon, authenticated using (true);
create policy "page reads business data" on public.business_data for select to anon, authenticated using (true);
create policy "page reads tasks" on public.tasks for select to anon, authenticated using (true);
create policy "page reads notifications" on public.notifications for select to anon, authenticated using (true);

revoke insert, update, delete on public.business_settings, public.business_data, public.tasks, public.notifications from anon, authenticated;
grant select on public.business_settings, public.business_data, public.tasks, public.notifications to anon, authenticated;

grant select, insert, update, delete on public.business_settings, public.business_data, public.tasks, public.notifications to service_role;
grant usage, select on all sequences in schema public to service_role;

alter publication supabase_realtime add table public.business_settings, public.business_data, public.tasks, public.notifications;
