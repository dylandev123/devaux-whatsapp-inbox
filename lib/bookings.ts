import { supabase } from "@/lib/supabaseClient";
import { logAndDescribeError } from "@/lib/errors";

// Mirrors customer_bookings from
// supabase/migrations/20260623000600_customer_bookings.sql.
export interface CustomerBooking {
  id: string;
  customer_id: string;
  business_slug: string;
  booking_reference: string | null;
  booking_status: string | null;
  service_type: string | null;
  hotel_name: string | null;
  arrival_date: string | null;
  departure_date: string | null;
  guest_count: number | null;
  deposit_paid: boolean;
  deposit_amount: number | null;
  balance_due: number | null;
  booking_value: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export const BOOKING_STATUSES = [
  "Lead",
  "Quoting",
  "Awaiting Deposit",
  "Deposit Paid",
  "Confirmed",
  "In Progress",
  "Completed",
  "Cancelled",
] as const;

const BOOKING_STATUS_BADGE_CLASSES: Record<string, string> = {
  Lead: "bg-zinc-100 text-zinc-600",
  Quoting: "bg-blue-50 text-blue-700",
  "Awaiting Deposit": "bg-amber-50 text-amber-700",
  "Deposit Paid": "bg-teal-50 text-teal-700",
  Confirmed: "bg-emerald-50 text-emerald-700",
  "In Progress": "bg-indigo-50 text-indigo-700",
  Completed: "bg-green-50 text-green-700",
  Cancelled: "bg-red-50 text-red-700",
};

export function bookingStatusBadgeClass(status: string | null): string {
  return BOOKING_STATUS_BADGE_CLASSES[status ?? ""] ?? "bg-zinc-100 text-zinc-600";
}

const BOOKING_COLUMNS =
  "id, customer_id, business_slug, booking_reference, booking_status, service_type, hotel_name, arrival_date, departure_date, guest_count, deposit_paid, deposit_amount, balance_due, booking_value, notes, created_at, updated_at";

export async function fetchBookingsForCustomer(customerId: string): Promise<CustomerBooking[]> {
  const { data, error } = await supabase
    .from("customer_bookings")
    .select(BOOKING_COLUMNS)
    .eq("customer_id", customerId)
    .order("arrival_date", { ascending: false, nullsFirst: false });
  if (error) {
    throw new Error(logAndDescribeError("fetchBookingsForCustomer", error));
  }
  return data ?? [];
}

export interface NewBookingInput {
  customer_id: string;
  business_slug: string;
  service_type?: string | null;
  hotel_name?: string | null;
  arrival_date?: string | null;
  departure_date?: string | null;
  guest_count?: number | null;
  booking_value?: number | null;
}

export async function createBooking(input: NewBookingInput): Promise<CustomerBooking> {
  const { data, error } = await supabase
    .from("customer_bookings")
    .insert(input)
    .select(BOOKING_COLUMNS)
    .single();
  if (error) {
    throw new Error(logAndDescribeError("createBooking", error));
  }
  return data;
}

// Distinct customer ids whose booking_reference or hotel_name matches —
// used to widen customer search (see lib/customers.ts searchCustomers).
export async function searchBookingCustomerIds(query: string): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  const like = `"%${q.replace(/"/g, '\\"')}%"`;
  const { data, error } = await supabase
    .from("customer_bookings")
    .select("customer_id")
    .or(`booking_reference.ilike.${like},hotel_name.ilike.${like}`)
    .limit(25);
  if (error) {
    throw new Error(logAndDescribeError("searchBookingCustomerIds", error));
  }
  return Array.from(
    new Set((data ?? []).map((row) => row.customer_id).filter((id): id is string => Boolean(id)))
  );
}

export interface BookingSummary {
  totalBookings: number;
  lifetimeRevenue: number;
  upcomingCount: number;
  lastBookingLabel: string | null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function summarizeBookings(bookings: CustomerBooking[]): BookingSummary {
  const today = todayIso();
  const lifetimeRevenue = bookings
    .filter((b) => b.booking_status !== "Cancelled")
    .reduce((sum, b) => sum + (b.booking_value ?? 0), 0);
  const upcomingCount = bookings.filter(
    (b) =>
      b.arrival_date &&
      b.arrival_date >= today &&
      b.booking_status !== "Cancelled" &&
      b.booking_status !== "Completed"
  ).length;

  const withArrival = bookings.filter((b): b is CustomerBooking & { arrival_date: string } =>
    Boolean(b.arrival_date)
  );
  const last = withArrival.reduce<CustomerBooking | null>((latest, b) => {
    if (!latest || !latest.arrival_date) return b;
    return b.arrival_date! > latest.arrival_date ? b : latest;
  }, null);
  const lastBookingLabel = last?.arrival_date
    ? new Date(last.arrival_date).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : null;

  return {
    totalBookings: bookings.length,
    lifetimeRevenue,
    upcomingCount,
    lastBookingLabel,
  };
}

export function splitUpcomingPastBookings(bookings: CustomerBooking[]): {
  upcoming: CustomerBooking[];
  past: CustomerBooking[];
} {
  const today = todayIso();
  const upcoming = bookings
    .filter((b) => b.arrival_date && b.arrival_date >= today)
    .sort((a, b) => (a.arrival_date! < b.arrival_date! ? -1 : 1));
  const past = bookings
    .filter((b) => !b.arrival_date || b.arrival_date < today)
    .sort((a, b) => {
      const aKey = a.arrival_date ?? a.created_at;
      const bKey = b.arrival_date ?? b.created_at;
      return aKey < bKey ? 1 : -1;
    });
  return { upcoming, past };
}

export function formatCurrency(value: number | null): string {
  if (value == null) return "—";
  return `US$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
