-- Backfill the missing `profiles` row for dylandevaux3@gmail.com.
-- Run this in the Supabase SQL editor — the app has no DB credentials
-- beyond the authenticated user's own session, so this can't be applied
-- automatically.
--
-- Root cause of "/admin doesn't work": this auth.users account has no
-- corresponding row in `profiles` at all. middleware.ts's admin gate does
-- `select("role").eq("id", user.id).single()` — with zero rows that query
-- errors, `profile` ends up undefined, `profile?.role !== "admin"` is true,
-- and the request is silently redirected to "/". Login and the main inbox
-- still work fine because "/" never queries `profiles`.
--
-- Note: the live `profiles` table does NOT have the `email` column that
-- 20260623000800_admin_roles.sql defines (its `create table if not exists`
-- was a no-op against an existing narrower table), so that migration's
-- `update ... where email = ...` could never have matched this schema. This
-- statement is written against the schema that's actually deployed
-- (id, role only).
insert into public.profiles (id, role)
select id, 'admin'
from auth.users
where email = 'dylandevaux3@gmail.com'
on conflict (id) do update set role = 'admin';
