-- One-off repair script — NOT part of the routine migration chain, and not
-- applied automatically. Run this in the Supabase SQL editor only after
-- checking which slug(s), if any, actually need it (see the "before" query
-- below).
--
-- Confirmed against the live schema for this project:
--   * whatsapp_businesses does not exist here — there is no separate
--     business registry table, so this does NOT touch or create one.
--   * business_slug exists on exactly two tables: whatsapp_messages and
--     whatsapp_sessions (both created by the bridge, not by any migration in
--     this repo). No other business-related table was found, so nothing
--     else is referenced.
--
-- What this does: normalizes any business_slug value across both tables to
-- trim → lowercase → spaces/hyphens-to-underscore form (e.g. "By Sea" or
-- "By-Sea" -> "by_sea"), matching lib/businessSlug.ts's
-- normalizeBusinessSlug() on the app side. Idempotent: rows already in
-- canonical form are left untouched, so re-running this after it has already
-- succeeded does nothing.
--
-- Conflict safety: before changing anything, this checks whether two
-- *different* business_slug values already in use (across either table)
-- would normalize to the same canonical value (e.g. both "By_Sea" and
-- "by_sea" already appear somewhere). If so, it aborts with an exception
-- instead of silently merging them — that's a human decision (which spelling
-- is the real one), not something safe to guess in a script. Nothing is
-- committed unless the whole block completes without conflict.

do $$
declare
  conflict_row record;
  bad record;
  canonical text;
begin
  -- Conflict check first, over the combined set of distinct raw values from
  -- both tables.
  for conflict_row in (
    with slugs as (
      select distinct business_slug from whatsapp_messages where business_slug is not null
      union
      select distinct business_slug from whatsapp_sessions where business_slug is not null
    )
    select
      regexp_replace(lower(trim(business_slug)), '[\s-]+', '_', 'g') as canonical,
      array_agg(distinct business_slug order by business_slug) as raw_variants
    from slugs
    group by 1
    having count(distinct business_slug) > 1
  ) loop
    raise exception
      'Cannot normalize to "%": multiple distinct business_slug values already map to it (%). Resolve manually before re-running.',
      conflict_row.canonical, conflict_row.raw_variants;
  end loop;

  -- No conflicts — safe to normalize. Only rows that aren't already
  -- canonical are touched.
  for bad in (
    select distinct business_slug
    from (
      select business_slug from whatsapp_messages where business_slug is not null
      union
      select business_slug from whatsapp_sessions where business_slug is not null
    ) s
    where business_slug <> regexp_replace(lower(trim(business_slug)), '[\s-]+', '_', 'g')
  ) loop
    canonical := regexp_replace(lower(trim(bad.business_slug)), '[\s-]+', '_', 'g');

    update whatsapp_messages set business_slug = canonical where business_slug = bad.business_slug;
    update whatsapp_sessions set business_slug = canonical where business_slug = bad.business_slug;

    raise notice 'Normalized business_slug "%" -> "%"', bad.business_slug, canonical;
  end loop;
end $$;

-- Validation query (run before AND after): should return zero rows once
-- this script has succeeded.
--   with slugs as (
--     select distinct business_slug from whatsapp_messages where business_slug is not null
--     union
--     select distinct business_slug from whatsapp_sessions where business_slug is not null
--   )
--   select business_slug
--   from slugs
--   where business_slug <> regexp_replace(lower(trim(business_slug)), '[\s-]+', '_', 'g');
