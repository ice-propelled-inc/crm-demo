-- Several demo businesses share the tables: every call and appointment belongs to one business set
-- (docs/crm-demo-local/businesses). Fields without their own column (address, order items, vehicle...) go to details.
alter table public.calls add column business text not null default 'dental';
alter table public.appointments add column business text not null default 'dental';
alter table public.appointments add column details jsonb not null default '{}'::jsonb;

create index calls_business_started_idx on public.calls (business, started_at desc);
create index appointments_business_start_idx on public.appointments (business, start);
