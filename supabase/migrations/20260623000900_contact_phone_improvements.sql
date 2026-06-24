-- Customer/contact phone improvements.
-- Run this in the Supabase SQL editor — the app has no DB credentials beyond
-- the authenticated user's own session, so this can't be applied automatically.
-- Depends on supabase/migrations/20260622000000_customers.sql and
-- 20260623000600_customer_bookings.sql already having been run.

-- New column for a name distinct from the contact's own WhatsApp profile
-- name: the name as saved in the connected WhatsApp Business account's own
-- phonebook, when the bridge reports it. IMPORTANT: the bridge does not
-- currently send this field (I have no access to that backend to confirm or
-- add it), so this column will stay null for every row until/unless the
-- bridge is updated to populate it. Adding it now means the priority order
-- below is ready the moment it does, without another migration.
alter table whatsapp_messages add column if not exists business_contact_name text;
alter table customers add column if not exists business_contact_name text;

-- Canonical phone format used as the customers.phone_number dedupe key:
-- digits only, no "+", no spaces/dashes. WhatsApp JIDs are already digits-
-- only, but defending against stray formatting (e.g. a "+", spaces, a
-- leading "00") keeps the same real contact from ever creating a second row.
create or replace function normalize_phone_number(input text)
returns text
language sql
immutable
as $$
  select regexp_replace(trim(coalesce(input, '')), '[^0-9]', '', 'g');
$$;

-- Merge any customer rows that already exist and normalize to the same
-- number (e.g. one row stored with a "+" and another without) before
-- normalizing in place, so the update below never hits the unique
-- constraint. Keeps the oldest row per normalized number; reassigns its
-- bookings from the duplicate(s) before deleting them.
do $$
declare
  dup record;
  keeper uuid;
  loser_id uuid;
begin
  for dup in (
    select normalize_phone_number(phone_number) as norm
    from customers
    group by normalize_phone_number(phone_number)
    having count(*) > 1
  ) loop
    select id into keeper
    from customers
    where normalize_phone_number(phone_number) = dup.norm
    order by created_at asc
    limit 1;

    for loser_id in (
      select id from customers
      where normalize_phone_number(phone_number) = dup.norm
        and id <> keeper
    ) loop
      update customer_bookings set customer_id = keeper where customer_id = loser_id;
      delete from customers where id = loser_id;
    end loop;
  end loop;
end $$;

update customers
set phone_number = normalize_phone_number(phone_number)
where phone_number <> normalize_phone_number(phone_number);

-- Replaces the version from 20260622000000_customers.sql. Two changes:
--   1. Normalizes the phone number before using it as the upsert key, so
--      future inserts can't create a near-duplicate of an existing customer.
--   2. No longer skips outbound messages — staff-initiated conversations
--      (the business messaging a new number first) now create/update a
--      customer record too, not just inbound ones. This is safe because
--      contact_number already represents "the customer in this
--      conversation" regardless of which direction a given row is — every
--      other place in the app (e.g. resolveRecipientNumber when sending)
--      already relies on that being true.
create or replace function upsert_customer_from_message()
returns trigger as $$
declare
  normalized_number text;
begin
  if new.contact_number is null then
    return new;
  end if;

  normalized_number := normalize_phone_number(new.contact_number);
  if normalized_number = '' then
    return new;
  end if;

  insert into customers (phone_number, whatsapp_name, business_contact_name, last_message_at, source_business)
  values (normalized_number, new.contact_name, new.business_contact_name, new.timestamp, new.business_slug)
  on conflict (phone_number) do update
    set whatsapp_name = coalesce(excluded.whatsapp_name, customers.whatsapp_name),
        business_contact_name = coalesce(excluded.business_contact_name, customers.business_contact_name),
        last_message_at = greatest(customers.last_message_at, excluded.last_message_at),
        updated_at = now();

  return new;
end;
$$ language plpgsql security definer;

-- No RLS changes needed — these are new columns on tables that already have
-- RLS policies covering every column (customers, whatsapp_messages).
