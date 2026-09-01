-- AI Settings: server-side-only configuration for the OpenAI-powered
-- conversation analysis engine (replaces the previously hardcoded
-- ANTHROPIC_API_KEY env var — see lib/server/analysisEngine.ts).
-- Run this in the Supabase SQL editor — the app has no DB credentials beyond
-- the authenticated user's own session, so this can't be applied
-- automatically.
--
-- Singleton table: exactly one row, id fixed at 1. There is nothing
-- per-business here — one OpenAI key/model configures analysis for every
-- business, matching how it worked before (one ANTHROPIC_API_KEY for the
-- whole app).
--
-- SECURITY: unlike every other table in this app, this table has RLS
-- enabled with NO policies granted to `authenticated` or `anon` at all —
-- that is deliberate, not an oversight. It means no client-side Supabase
-- call (select/insert/update) can ever reach this table, from any logged-in
-- user, admin or not. The only thing that can read/write it is the
-- service-role key, which is never sent to the browser and is only ever
-- used from this app's own server-side API routes
-- (app/api/ai-settings/route.ts, app/api/ai-settings/test/route.ts) and the
-- analysis engine (lib/server/analysisEngine.ts) — all of which enforce the
-- admin-only check via middleware.ts before this table is ever touched, and
-- none of which ever return the raw api_key value back to the browser (the
-- API routes mask it to "last 4 characters" before responding). This is the
-- one table in this schema where "authenticated users share full access" is
-- deliberately NOT the model, because it holds a secret credential rather
-- than shared business data.

create table if not exists ai_settings (
  id integer primary key default 1 check (id = 1),
  model text not null default 'gpt-5.6-luna' check (model in ('gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol')),
  api_key text,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_error text,
  updated_at timestamptz not null default now()
);

create or replace function touch_ai_settings_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_ai_settings_updated_at on ai_settings;
create trigger trg_touch_ai_settings_updated_at
  before update on ai_settings
  for each row execute function touch_ai_settings_updated_at();

-- Seed the single row so the app can always assume it exists and just
-- upsert id=1, rather than branching on get-or-create.
insert into ai_settings (id, model) values (1, 'gpt-5.6-luna')
on conflict (id) do nothing;

alter table ai_settings enable row level security;

-- No policies. RLS with zero policies denies all access to `authenticated`
-- and `anon` by default — that is the intended state for this table (see
-- the comment at the top of this file). The service-role key bypasses RLS
-- entirely, which is how the app's own server code reaches this table.
