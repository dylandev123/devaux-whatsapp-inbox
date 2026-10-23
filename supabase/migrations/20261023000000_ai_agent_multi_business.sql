-- Assisted AI WhatsApp Agent: multi-business support.
-- Run this in the Supabase SQL editor (the app has no DB credentials beyond the
-- signed-in user's session, so it cannot be applied automatically).
--
-- DEPENDS ON: 20261022000000_ai_agent.sql
--
-- Minimal and additive. The ONLY change is removing the Dog Food-only check
-- on ai_agent_settings. Existing rows (including Dog Food's enabled flag,
-- mode, contact scope, staff group and every other table) are untouched.
--
-- NO business is enabled by this migration. Settings rows for other
-- businesses are created by the app on first visit, or by the optional block
-- below, with the column defaults: enabled = false, mode = 'observe',
-- contact_scope = 'none'.

alter table public.ai_agent_settings
  drop constraint if exists ai_agent_settings_pilot_only;

-- Optional: pre-create OFF / observe / none rows for every active business that
-- doesn't have one yet. Never updates an existing row (on conflict do nothing).
insert into public.ai_agent_settings (business_slug)
select b.business_slug
from public.whatsapp_businesses b
where b.is_active
on conflict (business_slug) do nothing;

-- Verification (optional):
--   select conname from pg_constraint
--    where conrelid = 'public.ai_agent_settings'::regclass and conname = 'ai_agent_settings_pilot_only';
--   -- Expected: 0 rows
--   select business_slug, enabled, mode, contact_scope from public.ai_agent_settings order by 1;
--   -- Expected: dog_food unchanged; every other business false / observe / none
