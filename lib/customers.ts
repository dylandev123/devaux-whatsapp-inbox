import { supabase } from "@/lib/supabaseClient";
import { logAndDescribeError } from "@/lib/errors";
import { searchBookingCustomerIds } from "@/lib/bookings";
import { ContactNameInfo } from "@/lib/contactName";

// Mirrors the `customers` table created in
// supabase/migrations/20260622000000_customers.sql plus the `stage` column
// added in supabase/migrations/20260623000500_customer_stage_tags.sql. Rows
// are created/refreshed automatically by a DB trigger when a customer
// messages any business; the app only ever reads, and edits the profile
// fields listed in EditableCustomerFields.
export interface Customer {
  id: string;
  phone_number: string;
  whatsapp_name: string | null;
  business_contact_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  notes: string | null;
  tags: string[];
  stage: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  source_business: string | null;
}

// Defined for By Sea Tours specifically (no other business has specified its
// own pipeline yet) but used as the single shared option list for now to
// keep the stage picker simple.
export const STAGE_OPTIONS = [
  "New Lead",
  "Quoting",
  "Waiting on Guest",
  "Deposit Pending",
  "Booked",
  "Completed",
  "Follow Up",
  "Not Interested",
] as const;

export type EditableCustomerFields = Pick<
  Customer,
  "first_name" | "last_name" | "email" | "notes" | "tags" | "stage"
>;

// Quick-add suggestions shown in the tag editor — custom tags typed in
// directly are still allowed, this is just a shortcut list.
export const SUGGESTED_TAGS = [
  "VIP",
  "Repeat Guest",
  "Royalton",
  "Wedding",
  "Family",
  "Airport Transfer",
  "Snorkeling",
  "High Value",
  "Needs Follow Up",
] as const;

export interface CustomerBusinessStat {
  businessSlug: string;
  firstContactAt: string;
  lastContactAt: string;
  messageCount: number;
}

export interface CustomerTimelineMessage {
  businessSlug: string;
  chatId: string;
  timestamp: string;
  messageBody: string | null;
  messageType: string | null;
  mediaUrl: string | null;
  direction: string | null;
}

const CUSTOMER_COLUMNS =
  "id, phone_number, whatsapp_name, business_contact_name, first_name, last_name, email, notes, tags, stage, created_at, updated_at, last_message_at, source_business";

export async function fetchCustomerByPhone(phoneNumber: string): Promise<Customer | null> {
  const { data, error } = await supabase
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("phone_number", phoneNumber)
    .maybeSingle();
  if (error) {
    throw new Error(logAndDescribeError("fetchCustomerByPhone", error));
  }
  return data;
}

// Lightweight name-only lookup, polled into the inbox so the conversation
// list and message header can apply the same first/last → whatsapp_name →
// phone_number → "Unknown Contact" fallback chain as the customer profile
// (see lib/contactName.ts), instead of only ever showing the raw WhatsApp
// push name captured on the message itself.
export async function fetchContactDirectory(): Promise<Map<string, ContactNameInfo>> {
  const { data, error } = await supabase
    .from("customers")
    .select("phone_number, first_name, last_name, whatsapp_name, business_contact_name");
  if (error) {
    throw new Error(logAndDescribeError("fetchContactDirectory", error));
  }
  const directory = new Map<string, ContactNameInfo>();
  for (const row of data ?? []) {
    directory.set(row.phone_number, {
      businessContactName: row.business_contact_name,
      firstName: row.first_name,
      lastName: row.last_name,
      whatsappName: row.whatsapp_name,
      phoneNumber: row.phone_number,
    });
  }
  return directory;
}

// For the /contacts page. Client-side aggregation, same tradeoff noted on
// fetchCustomerBusinessStats below — fine at current scale, swap for a view
// or RPC if the customer list grows large enough to matter.
export async function fetchAllCustomers(): Promise<Customer[]> {
  const { data, error } = await supabase
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .order("last_message_at", { ascending: false, nullsFirst: false });
  if (error) {
    throw new Error(logAndDescribeError("fetchAllCustomers", error));
  }
  return data ?? [];
}

// Businesses each phone number has messaged, for every customer at once —
// used by the /contacts page instead of calling fetchCustomerBusinessStats
// once per row.
export async function fetchBusinessesContactedByPhone(): Promise<Map<string, string[]>> {
  const { data, error } = await supabase.from("whatsapp_messages").select("business_slug, contact_number");
  if (error) {
    throw new Error(logAndDescribeError("fetchBusinessesContactedByPhone", error));
  }
  const sets = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    if (!row.contact_number) continue;
    if (!sets.has(row.contact_number)) sets.set(row.contact_number, new Set());
    sets.get(row.contact_number)!.add(row.business_slug);
  }
  const result = new Map<string, string[]>();
  for (const [phone, set] of sets) {
    result.set(phone, Array.from(set));
  }
  return result;
}

export async function updateCustomer(
  id: string,
  patch: Partial<EditableCustomerFields>
): Promise<Customer> {
  const { data, error } = await supabase
    .from("customers")
    .update(patch)
    .eq("id", id)
    .select(CUSTOMER_COLUMNS)
    .single();
  if (error) {
    throw new Error(logAndDescribeError("updateCustomer", error));
  }
  return data;
}

// Aggregates whatsapp_messages client-side rather than relying on a Postgres
// view/RPC, so this works as soon as the customers migration ships — no extra
// DB object required. Swap the body for an RPC call later if this gets slow.
export async function fetchCustomerBusinessStats(
  phoneNumber: string
): Promise<CustomerBusinessStat[]> {
  const { data, error } = await supabase
    .from("whatsapp_messages")
    .select("business_slug, timestamp")
    .eq("contact_number", phoneNumber);
  if (error) {
    throw new Error(logAndDescribeError("fetchCustomerBusinessStats", error));
  }

  const stats = new Map<string, CustomerBusinessStat>();
  for (const row of data ?? []) {
    const existing = stats.get(row.business_slug);
    if (existing) {
      existing.messageCount += 1;
      if (new Date(row.timestamp).getTime() < new Date(existing.firstContactAt).getTime()) {
        existing.firstContactAt = row.timestamp;
      }
      if (new Date(row.timestamp).getTime() > new Date(existing.lastContactAt).getTime()) {
        existing.lastContactAt = row.timestamp;
      }
    } else {
      stats.set(row.business_slug, {
        businessSlug: row.business_slug,
        firstContactAt: row.timestamp,
        lastContactAt: row.timestamp,
        messageCount: 1,
      });
    }
  }
  return Array.from(stats.values()).sort(
    (a, b) => new Date(b.lastContactAt).getTime() - new Date(a.lastContactAt).getTime()
  );
}

// Latest N messages for this customer across every business, for the
// profile panel's timeline section.
export async function fetchCustomerTimeline(
  phoneNumber: string,
  limit = 10
): Promise<CustomerTimelineMessage[]> {
  const { data, error } = await supabase
    .from("whatsapp_messages")
    .select("business_slug, chat_id, timestamp, message_body, message_type, media_url, direction")
    .eq("contact_number", phoneNumber)
    .order("timestamp", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(logAndDescribeError("fetchCustomerTimeline", error));
  }
  return (data ?? []).map((row) => ({
    businessSlug: row.business_slug,
    chatId: row.chat_id,
    timestamp: row.timestamp,
    messageBody: row.message_body,
    messageType: row.message_type,
    mediaUrl: row.media_url,
    direction: row.direction,
  }));
}

export interface CustomerSearchResult extends Customer {
  latestBusinessSlug: string | null;
  latestChatId: string | null;
}

// Searches the customers table across all businesses by name/phone/email,
// plus a separate exact-tag pass (PostgREST can't ILIKE inside an array),
// plus any customer whose booking reference or hotel name matches (see
// supabase/migrations/20260623000600_customer_bookings.sql).
export async function searchCustomers(query: string): Promise<CustomerSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  // Quoted so commas/parentheses in the search text don't break PostgREST's
  // or-filter grammar (e.g. searching "Smith, John").
  const like = `"%${q.replace(/"/g, '\\"')}%"`;

  const [byFields, byTag, bookingCustomerIds] = await Promise.all([
    supabase
      .from("customers")
      .select(CUSTOMER_COLUMNS)
      .or(
        `whatsapp_name.ilike.${like},first_name.ilike.${like},last_name.ilike.${like},phone_number.ilike.${like},email.ilike.${like},notes.ilike.${like}`
      )
      .limit(25),
    supabase.from("customers").select(CUSTOMER_COLUMNS).contains("tags", [q]).limit(25),
    searchBookingCustomerIds(q),
  ]);

  if (byFields.error) {
    throw new Error(logAndDescribeError("searchCustomers(byFields)", byFields.error));
  }
  if (byTag.error) {
    throw new Error(logAndDescribeError("searchCustomers(byTag)", byTag.error));
  }

  const merged = new Map<string, Customer>();
  for (const row of [...(byFields.data ?? []), ...(byTag.data ?? [])]) {
    merged.set(row.id, row);
  }

  const missingBookingCustomerIds = bookingCustomerIds.filter((id) => !merged.has(id));
  if (missingBookingCustomerIds.length > 0) {
    const { data: bookingCustomers, error: bookingCustomersError } = await supabase
      .from("customers")
      .select(CUSTOMER_COLUMNS)
      .in("id", missingBookingCustomerIds);
    if (bookingCustomersError) {
      throw new Error(logAndDescribeError("searchCustomers(bookingCustomers)", bookingCustomersError));
    }
    for (const row of bookingCustomers ?? []) {
      merged.set(row.id, row);
    }
  }

  const customers = Array.from(merged.values());
  if (customers.length === 0) return [];

  const { data: latestMessages, error: latestError } = await supabase
    .from("whatsapp_messages")
    .select("business_slug, chat_id, contact_number, timestamp")
    .in(
      "contact_number",
      customers.map((c) => c.phone_number)
    )
    .order("timestamp", { ascending: false });
  if (latestError) {
    throw new Error(logAndDescribeError("searchCustomers(latestMessages)", latestError));
  }

  const latestByPhone = new Map<string, { business_slug: string; chat_id: string }>();
  for (const row of latestMessages ?? []) {
    if (!row.contact_number || latestByPhone.has(row.contact_number)) continue;
    latestByPhone.set(row.contact_number, { business_slug: row.business_slug, chat_id: row.chat_id });
  }

  return customers.map((customer) => {
    const latest = latestByPhone.get(customer.phone_number);
    return {
      ...customer,
      latestBusinessSlug: latest?.business_slug ?? null,
      latestChatId: latest?.chat_id ?? null,
    };
  });
}
