-- Edge Functions use the service role key. It bypasses RLS but still needs table privileges,
-- which this project does not grant by default.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.calls, public.call_messages, public.call_state, public.appointments to service_role;
grant usage, select on all sequences in schema public to service_role;
