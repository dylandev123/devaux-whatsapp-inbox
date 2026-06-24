"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Customer,
  CustomerBusinessStat,
  CustomerTimelineMessage,
  EditableCustomerFields,
  fetchCustomerBusinessStats,
  fetchCustomerByPhone,
  fetchCustomerTimeline,
  STAGE_OPTIONS,
  SUGGESTED_TAGS,
  updateCustomer,
} from "@/lib/customers";
import {
  bookingStatusBadgeClass,
  CustomerBooking,
  fetchBookingsForCustomer,
  formatCurrency,
  splitUpcomingPastBookings,
  summarizeBookings,
} from "@/lib/bookings";
import { businessColor, businessLabel, isOutbound } from "@/lib/whatsapp";
import { classifyMedia, mediaPreviewLabel } from "@/lib/media";
import { resolveContactName } from "@/lib/contactName";
import { telHref } from "@/lib/phone";
import { CreateBookingModal } from "./CreateBookingModal";

interface CustomerPanelProps {
  phoneNumber: string;
  businessSlug: string | null;
  onClose: () => void;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function isMissingBookingsTable(err: unknown): boolean {
  return err instanceof Error && /PGRST205|Could not find the table/i.test(err.message);
}

function previewText(message: Pick<CustomerTimelineMessage, "messageBody" | "messageType" | "mediaUrl">): string {
  if (message.messageBody?.trim()) return message.messageBody.trim();
  const kind = classifyMedia({ media_url: message.mediaUrl, message_type: message.messageType });
  if (kind) return mediaPreviewLabel({ message_type: message.messageType }, kind);
  return "—";
}

function BookingCard({ booking }: { booking: CustomerBooking }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-zinc-900">
          {booking.booking_reference || `Booking #${booking.id.slice(0, 8)}`}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${bookingStatusBadgeClass(
            booking.booking_status
          )}`}
        >
          {booking.booking_status || "Lead"}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-y-1.5 text-xs text-zinc-500">
        <dt>Arrival</dt>
        <dd className="text-right text-zinc-700">{formatDate(booking.arrival_date)}</dd>
        <dt>Departure</dt>
        <dd className="text-right text-zinc-700">{formatDate(booking.departure_date)}</dd>
        <dt>Hotel / Villa</dt>
        <dd className="truncate text-right text-zinc-700">{booking.hotel_name || "—"}</dd>
        <dt>Guests</dt>
        <dd className="text-right text-zinc-700">{booking.guest_count ?? "—"}</dd>
        <dt>Service type</dt>
        <dd className="truncate text-right text-zinc-700">{booking.service_type || "—"}</dd>
        <dt>Deposit status</dt>
        <dd className="text-right text-zinc-700">{booking.deposit_paid ? "Paid" : "Unpaid"}</dd>
        <dt>Deposit amount</dt>
        <dd className="text-right text-zinc-700">{formatCurrency(booking.deposit_amount)}</dd>
        <dt>Balance due</dt>
        <dd className="text-right text-zinc-700">{formatCurrency(booking.balance_due)}</dd>
        <dt>Total booking value</dt>
        <dd className="text-right font-medium text-zinc-900">{formatCurrency(booking.booking_value)}</dd>
      </dl>
      {booking.notes && (
        <p className="mt-2 border-t border-zinc-100 pt-2 text-xs text-zinc-500">{booking.notes}</p>
      )}
    </div>
  );
}

export function CustomerPanel({ phoneNumber, businessSlug, onClose }: CustomerPanelProps) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [stats, setStats] = useState<CustomerBusinessStat[]>([]);
  const [timeline, setTimeline] = useState<CustomerTimelineMessage[]>([]);
  const [bookings, setBookings] = useState<CustomerBooking[]>([]);
  const [bookingsMigrationMissing, setBookingsMigrationMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showCreateBooking, setShowCreateBooking] = useState(false);

  const [form, setForm] = useState<EditableCustomerFields>({
    first_name: "",
    last_name: "",
    email: "",
    notes: "",
    tags: [],
    stage: null,
  });
  const [newTag, setNewTag] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setBookings([]);

    fetchCustomerByPhone(phoneNumber)
      .then(async (fetchedCustomer) => {
        if (!active) return;
        setCustomer(fetchedCustomer);
        setForm({
          first_name: fetchedCustomer?.first_name ?? "",
          last_name: fetchedCustomer?.last_name ?? "",
          email: fetchedCustomer?.email ?? "",
          notes: fetchedCustomer?.notes ?? "",
          tags: fetchedCustomer?.tags ?? [],
          stage: fetchedCustomer?.stage ?? null,
        });

        if (!fetchedCustomer) {
          setStats([]);
          setTimeline([]);
          setBookings([]);
          return;
        }

        const [fetchedStats, fetchedTimeline] = await Promise.all([
          fetchCustomerBusinessStats(phoneNumber),
          fetchCustomerTimeline(phoneNumber, 10),
        ]);
        if (!active) return;
        setStats(fetchedStats);
        setTimeline(fetchedTimeline);

        // Fetched separately from stats/timeline above: if
        // customer_bookings hasn't been created yet (migration not run),
        // this fails on its own without taking down the rest of the
        // profile, which already worked before bookings existed.
        try {
          const fetchedBookings = await fetchBookingsForCustomer(fetchedCustomer.id);
          if (active) {
            setBookings(fetchedBookings);
            setBookingsMigrationMissing(false);
          }
        } catch (bookingsErr) {
          if (!active) return;
          if (isMissingBookingsTable(bookingsErr)) {
            setBookingsMigrationMissing(true);
            setBookings([]);
          } else {
            setError(
              bookingsErr instanceof Error ? bookingsErr.message : "Failed to load bookings"
            );
          }
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load customer");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [phoneNumber]);

  function addTag(tag: string) {
    const trimmed = tag.trim();
    if (!trimmed) return;
    setForm((f) => {
      if (f.tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) return f;
      return { ...f, tags: [...f.tags, trimmed] };
    });
    setNewTag("");
  }

  function removeTag(tag: string) {
    setForm((f) => ({ ...f, tags: f.tags.filter((t) => t !== tag) }));
  }

  async function refreshBookings() {
    if (!customer) return;
    try {
      setBookings(await fetchBookingsForCustomer(customer.id));
      setBookingsMigrationMissing(false);
    } catch (err) {
      if (isMissingBookingsTable(err)) {
        setBookingsMigrationMissing(true);
      } else {
        setError(err instanceof Error ? err.message : "Failed to refresh bookings");
      }
    }
  }

  async function handleSave() {
    if (!customer) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateCustomer(customer.id, form);
      setCustomer(updated);
      setForm({
        first_name: updated.first_name ?? "",
        last_name: updated.last_name ?? "",
        email: updated.email ?? "",
        notes: updated.notes ?? "",
        tags: updated.tags,
        stage: updated.stage ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save customer");
    } finally {
      setSaving(false);
    }
  }

  const displayName = resolveContactName({
    businessContactName: customer?.business_contact_name,
    firstName: form.first_name,
    lastName: form.last_name,
    whatsappName: customer?.whatsapp_name,
    phoneNumber: customer?.phone_number,
  });
  const totalMessages = useMemo(
    () => stats.reduce((sum, s) => sum + s.messageCount, 0),
    [stats]
  );
  const lastMessagePreview = timeline[0] ? previewText(timeline[0]) : "—";
  const suggestedToShow = SUGGESTED_TAGS.filter(
    (t) => !form.tags.some((existing) => existing.toLowerCase() === t.toLowerCase())
  );
  const bookingSummary = useMemo(() => summarizeBookings(bookings), [bookings]);
  const { upcoming: upcomingBookings, past: pastBookings } = useMemo(
    () => splitUpcomingPastBookings(bookings),
    [bookings]
  );

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-white md:static md:inset-auto md:z-auto md:w-96 md:flex-shrink-0 md:border-l md:border-zinc-200">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-5 py-4">
        <h2 className="text-sm font-semibold text-zinc-900">Customer profile</h2>
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 cursor-pointer rounded-md px-2 py-2 text-sm text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900"
        >
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading && <p className="text-sm text-zinc-500">Loading…</p>}
        {error && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

        {!loading && !customer && (
          <p className="text-sm text-zinc-500">
            No customer profile yet for this number. One is created automatically the next time
            they message.
          </p>
        )}

        {!loading && customer && (
          <div className="flex flex-col gap-6">
            {/* Customer summary */}
            <section className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
              <p className="text-base font-semibold text-zinc-900">{displayName}</p>
              <dl className="mt-2 grid grid-cols-2 gap-y-1.5 text-xs text-zinc-600">
                <dt>Stage</dt>
                <dd className="text-right font-medium text-zinc-800">{form.stage || "No stage"}</dd>
                <dt>Bookings</dt>
                <dd className="text-right font-medium text-zinc-800">{bookingSummary.totalBookings}</dd>
                <dt>Lifetime revenue</dt>
                <dd className="text-right font-medium text-zinc-800">
                  {formatCurrency(bookingSummary.lifetimeRevenue)}
                </dd>
                <dt>Upcoming bookings</dt>
                <dd className="text-right font-medium text-zinc-800">{bookingSummary.upcomingCount}</dd>
                <dt>Last booking</dt>
                <dd className="text-right font-medium text-zinc-800">
                  {bookingSummary.lastBookingLabel || "—"}
                </dd>
              </dl>
            </section>

            {/* Profile card */}
            <section className="rounded-lg border border-zinc-200 p-4">
              {customer.whatsapp_name && (
                <p className="text-sm text-zinc-500">WhatsApp name: {customer.whatsapp_name}</p>
              )}
              <p className="text-sm text-zinc-500">
                Phone:{" "}
                <a href={telHref(customer.phone_number)} className="text-zinc-700 hover:text-emerald-600 hover:underline">
                  {customer.phone_number}
                </a>
              </p>

              <dl className="mt-3 grid grid-cols-2 gap-y-2 text-xs text-zinc-500">
                <dt>Customer since</dt>
                <dd className="text-right text-zinc-700">{formatDate(customer.created_at)}</dd>
                <dt>Last message</dt>
                <dd className="text-right text-zinc-700">{formatDate(customer.last_message_at)}</dd>
                <dt>Source business</dt>
                <dd className="text-right text-zinc-700">
                  {customer.source_business ? businessLabel(customer.source_business) : "—"}
                </dd>
                <dt>Total messages</dt>
                <dd className="text-right text-zinc-700">{totalMessages}</dd>
              </dl>
              <div className="mt-3 border-t border-zinc-100 pt-3">
                <p className="text-xs font-medium text-zinc-400">Last message preview</p>
                <p className="mt-0.5 truncate text-sm text-zinc-700">{lastMessagePreview}</p>
              </div>
            </section>

            {/* Editable fields */}
            <section className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Profile
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={form.first_name ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
                  placeholder="First name"
                  className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
                />
                <input
                  value={form.last_name ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
                  placeholder="Last name"
                  className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
                />
              </div>
              <input
                type="email"
                value={form.email ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="Email"
                className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
              />

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">Stage</label>
                <select
                  value={form.stage ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value || null }))}
                  className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
                >
                  <option value="">No stage</option>
                  {STAGE_OPTIONS.map((stage) => (
                    <option key={stage} value={stage}>
                      {stage}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">Tags</label>
                {form.tags.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {form.tags.map((tag) => (
                      <span
                        key={tag}
                        className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                      >
                        {tag}
                        <button
                          type="button"
                          onClick={() => removeTag(tag)}
                          aria-label={`Remove tag ${tag}`}
                          className="cursor-pointer text-emerald-500 hover:text-emerald-900"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <input
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTag(newTag);
                    }
                  }}
                  placeholder="Add a tag and press Enter"
                  className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
                />
                {suggestedToShow.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {suggestedToShow.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => addTag(tag)}
                        className="cursor-pointer rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-500 hover:border-emerald-300 hover:text-emerald-700"
                      >
                        + {tag}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <textarea
                value={form.notes ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Notes"
                rows={3}
                className="resize-none rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="cursor-pointer rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </section>

            {/* Bookings */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  Bookings
                </h3>
                {businessSlug && !bookingsMigrationMissing && (
                  <button
                    type="button"
                    onClick={() => setShowCreateBooking(true)}
                    className="cursor-pointer rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                  >
                    + Create booking
                  </button>
                )}
              </div>

              {bookingsMigrationMissing ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Bookings aren&apos;t set up yet — run{" "}
                  <code className="rounded bg-amber-100 px-1 py-0.5">
                    supabase/migrations/20260623000600_customer_bookings.sql
                  </code>{" "}
                  in the Supabase SQL editor to enable this section.
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                      Upcoming bookings
                    </p>
                    {upcomingBookings.length === 0 && (
                      <p className="text-sm text-zinc-500">No upcoming bookings.</p>
                    )}
                    {upcomingBookings.map((booking) => (
                      <BookingCard key={booking.id} booking={booking} />
                    ))}
                  </div>

                  <div className="mt-2 flex flex-col gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                      Past bookings
                    </p>
                    {pastBookings.length === 0 && (
                      <p className="text-sm text-zinc-500">No past bookings.</p>
                    )}
                    {pastBookings.map((booking) => (
                      <BookingCard key={booking.id} booking={booking} />
                    ))}
                  </div>
                </>
              )}
            </section>

            {/* Businesses contacted */}
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Businesses contacted
              </h3>
              {stats.length === 0 && <p className="text-sm text-zinc-500">No history yet.</p>}
              {stats.map((stat) => {
                const color = businessColor(stat.businessSlug);
                return (
                  <div
                    key={stat.businessSlug}
                    className="rounded-md border border-zinc-100 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${color.dot}`} aria-hidden />
                        <span className="text-sm font-medium text-zinc-800">
                          {businessLabel(stat.businessSlug)}
                        </span>
                      </div>
                      <span className="text-xs font-medium text-zinc-500">
                        {stat.messageCount} message{stat.messageCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-zinc-400">
                      <span>First contact {formatDate(stat.firstContactAt)}</span>
                      <span>Last contact {formatDate(stat.lastContactAt)}</span>
                    </div>
                  </div>
                );
              })}
            </section>

            {/* Timeline */}
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Timeline
              </h3>
              {timeline.length === 0 && <p className="text-sm text-zinc-500">No messages yet.</p>}
              <div className="flex flex-col gap-2">
                {timeline.map((message, index) => {
                  const color = businessColor(message.businessSlug);
                  const outbound = isOutbound(message.direction);
                  return (
                    <div
                      key={`${message.businessSlug}-${message.chatId}-${index}`}
                      className="flex items-start gap-2 rounded-md border border-zinc-100 px-3 py-2"
                    >
                      <span className={`mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${color.dot}`} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium text-zinc-700">
                            {businessLabel(message.businessSlug)}
                          </span>
                          <span className="flex-shrink-0 text-[11px] text-zinc-400">
                            {formatDateTime(message.timestamp)}
                          </span>
                        </div>
                        <p className="truncate text-sm text-zinc-600">
                          <span
                            className={`mr-1 text-[11px] font-medium ${outbound ? "text-zinc-400" : color.text}`}
                          >
                            {outbound ? "Staff" : "Customer"}
                          </span>
                          {previewText(message)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="flex flex-col gap-2 opacity-50">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Coming soon
              </h3>
              <p className="text-sm text-zinc-500">Assigned to — unassigned</p>
              <p className="text-sm text-zinc-500">Follow-up reminder — none</p>
            </section>
          </div>
        )}
      </div>

      {showCreateBooking && customer && businessSlug && (
        <CreateBookingModal
          customerId={customer.id}
          businessSlug={businessSlug}
          onClose={() => setShowCreateBooking(false)}
          onCreated={() => refreshBookings()}
        />
      )}
    </div>
  );
}
