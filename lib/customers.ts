import { supabase } from "@/lib/supabaseClient";

// Mirrors the `customers` table created in
// supabase/migrations/20260622000000_customers.sql. Rows are created/refreshed
// automatically by a DB trigger when a customer messages any business; the
// app only ever reads, and edits the profile fields listed in EditableFields.
export interface Customer {
  id: string;
  phone_number: string;
  whatsapp_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  notes: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  source_business: string | null;
}

export type EditableCustomerFields = Pick<
  Customer,
  "first_name" | "last_name" | "email" | "notes" | "tags"
>;

export interface CustomerBusinessStat {
  businessSlug: string;
  firstContactAt: string;
  messageCount: number;
}

const CUSTOMER_COLUMNS =
  "id, phone_number, whatsapp_name, first_name, last_name, email, notes, tags, created_at, updated_at, last_message_at, source_business";

export async function fetchCustomerByPhone(phoneNumber: string): Promise<Customer | null> {
  const { data, error } = await supabase
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("phone_number", phoneNumber)
    .maybeSingle();
  if (error) throw error;
  return data;
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
  if (error) throw error;
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
  if (error) throw error;

  const stats = new Map<string, CustomerBusinessStat>();
  for (const row of data ?? []) {
    const existing = stats.get(row.business_slug);
    if (existing) {
      existing.messageCount += 1;
      if (new Date(row.timestamp).getTime() < new Date(existing.firstContactAt).getTime()) {
        existing.firstContactAt = row.timestamp;
      }
    } else {
      stats.set(row.business_slug, {
        businessSlug: row.business_slug,
        firstContactAt: row.timestamp,
        messageCount: 1,
      });
    }
  }
  return Array.from(stats.values()).sort(
    (a, b) => new Date(a.firstContactAt).getTime() - new Date(b.firstContactAt).getTime()
  );
}

export interface CustomerSearchResult extends Customer {
  latestBusinessSlug: string | null;
  latestChatId: string | null;
}

// Searches the customers table across all businesses by name/phone/email,
// plus a separate exact-tag pass (PostgREST can't ILIKE inside an array).
export async function searchCustomers(query: string): Promise<CustomerSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  // Quoted so commas/parentheses in the search text don't break PostgREST's
  // or-filter grammar (e.g. searching "Smith, John").
  const like = `"%${q.replace(/"/g, '\\"')}%"`;

  const [byFields, byTag] = await Promise.all([
    supabase
      .from("customers")
      .select(CUSTOMER_COLUMNS)
      .or(
        `whatsapp_name.ilike.${like},first_name.ilike.${like},last_name.ilike.${like},phone_number.ilike.${like},email.ilike.${like}`
      )
      .limit(25),
    supabase.from("customers").select(CUSTOMER_COLUMNS).contains("tags", [q]).limit(25),
  ]);

  if (byFields.error) throw byFields.error;
  if (byTag.error) throw byTag.error;

  const merged = new Map<string, Customer>();
  for (const row of [...(byFields.data ?? []), ...(byTag.data ?? [])]) {
    merged.set(row.id, row);
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
  if (latestError) throw latestError;

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
