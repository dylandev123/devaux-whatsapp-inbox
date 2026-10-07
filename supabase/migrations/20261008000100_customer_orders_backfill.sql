-- ONE-TIME, OPTIONAL backfill of customer_orders from existing
-- conversation_analysis rows. Run AFTER 20261008000000_customer_orders.sql.
--
-- Only rows the AI currently classifies as a successful "Order placed" are
-- copied, and only if they carry concrete extracted order data (products,
-- address or payment). Nothing is inferred from customer_ai_profile text or
-- from older analyses that have already been overwritten — those orders are
-- not recoverable. Each conversation gets at most order_seq 1; it is skipped
-- if that conversation already has any customer_orders row, so it is safe to
-- re-run and safe to run after live syncing has started.
--
-- STEP 1 — preview what would be inserted (read-only):
--   select business_slug, customer_name, last_message_at, order_status,
--          extracted->'products_services' as products, summary
--   from conversation_analysis a
--   where <same where clause as below>
--   order by last_message_at desc;
--
-- STEP 2 — run the insert below.

insert into public.customer_orders (
  business_slug, chat_id, contact_number, order_seq, customer_name, summary,
  details, delivery_address, payment_info, order_status, confidence,
  source_analysis_id, source_message_at, source_last_message_at, detected_at
)
select
  a.business_slug,
  a.chat_id,
  coalesce(nullif(a.contact_number, ''), regexp_replace(a.chat_id, '@s\.whatsapp\.net$', '', 'i')),
  1,
  a.customer_name,
  a.summary,
  a.extracted,
  nullif(trim(a.extracted ->> 'address'), ''),
  nullif(trim(a.extracted ->> 'payment_info'), ''),
  a.order_status,
  a.confidence,
  a.id,
  a.last_message_at,
  a.last_message_at,
  a.analyzed_at
from public.conversation_analysis a
where a.category = 'Order placed'
  and a.status = 'ok'
  and (
    jsonb_array_length(case when jsonb_typeof(a.extracted -> 'products_services') = 'array'
                            then a.extracted -> 'products_services' else '[]'::jsonb end) > 0
    or nullif(trim(a.extracted ->> 'address'), '') is not null
    or nullif(trim(a.extracted ->> 'payment_info'), '') is not null
  )
  and not exists (
    select 1 from public.customer_orders o
    where o.business_slug = a.business_slug and o.chat_id = a.chat_id
  )
on conflict (business_slug, chat_id, order_seq) do nothing;
