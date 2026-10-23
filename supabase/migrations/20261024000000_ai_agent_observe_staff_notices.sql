-- Assisted AI WhatsApp Agent: staff notices in Observe mode.
-- Run this in the Supabase SQL editor BEFORE deploying the matching app code
-- (the app now selects the new column). Not applied automatically.
--
-- DEPENDS ON: 20261022000000_ai_agent.sql
--
-- 1. ai_agent_settings.staff_notices_enabled (default false). When true, a
--    business in Observe mode may post escalation notices (kind staff_notice,
--    and nothing else) to its staff group. Existing rows get false, so no
--    business changes behaviour until an admin turns it on.
-- 2. claim_ai_agent_outbox now only hands out items the business's current
--    mode permits: customer-bound kinds need Assisted mode; a business that is
--    disabled (or Observe) has its pending items left untouched.

alter table public.ai_agent_settings
  add column if not exists staff_notices_enabled boolean not null default false;

create or replace function public.claim_ai_agent_outbox(
  p_business_slug text default null,
  p_limit integer default 20
)
returns setof public.ai_agent_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.ai_agent_outbox o
     set status = 'dispatched', dispatched_at = now()
   where o.id in (
     select p.id from public.ai_agent_outbox p
      join public.ai_agent_settings s on s.business_slug = p.business_slug
      where p.status = 'pending'
        and s.enabled
        and (
          s.mode = 'assisted'
          or (s.mode = 'observe' and s.staff_notices_enabled
              and p.kind = 'staff_notice' and p.to_jid = s.staff_group_jid)
        )
        and (p_business_slug is null or p.business_slug = p_business_slug)
      order by p.created_at
      limit greatest(least(p_limit, 100), 1)
      for update of p skip locked
   )
  returning o.*;
end;
$$;

revoke all on function public.claim_ai_agent_outbox(text, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_agent_outbox(text, integer) to service_role;

-- Verification (optional):
--   select business_slug, mode, staff_notices_enabled from public.ai_agent_settings order by 1;
--   -- Expected: staff_notices_enabled = false everywhere
