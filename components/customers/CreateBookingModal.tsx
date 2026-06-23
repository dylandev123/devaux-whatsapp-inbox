"use client";

import { useState } from "react";
import { createBooking, CustomerBooking } from "@/lib/bookings";

interface CreateBookingModalProps {
  customerId: string;
  businessSlug: string;
  onClose: () => void;
  onCreated: (booking: CustomerBooking) => void;
}

export function CreateBookingModal({
  customerId,
  businessSlug,
  onClose,
  onCreated,
}: CreateBookingModalProps) {
  const [serviceType, setServiceType] = useState("");
  const [hotelName, setHotelName] = useState("");
  const [arrivalDate, setArrivalDate] = useState("");
  const [departureDate, setDepartureDate] = useState("");
  const [guestCount, setGuestCount] = useState("");
  const [bookingValue, setBookingValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await createBooking({
        customer_id: customerId,
        business_slug: businessSlug,
        service_type: serviceType.trim() || null,
        hotel_name: hotelName.trim() || null,
        arrival_date: arrivalDate || null,
        departure_date: departureDate || null,
        guest_count: guestCount ? Number(guestCount) : null,
        booking_value: bookingValue ? Number(bookingValue) : null,
      });
      onCreated(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create booking");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900">Create booking</h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 cursor-pointer rounded-md px-2 py-2 text-sm text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900"
          >
            Close
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Service type</label>
            <input
              value={serviceType}
              onChange={(e) => setServiceType(e.target.value)}
              placeholder="e.g. Snorkeling tour"
              className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-500">Hotel / Villa</label>
            <input
              value={hotelName}
              onChange={(e) => setHotelName(e.target.value)}
              placeholder="e.g. Royalton Saint Lucia"
              className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Arrival date</label>
              <input
                type="date"
                value={arrivalDate}
                onChange={(e) => setArrivalDate(e.target.value)}
                className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Departure date</label>
              <input
                type="date"
                value={departureDate}
                onChange={(e) => setDepartureDate(e.target.value)}
                className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Guests</label>
              <input
                type="number"
                min="0"
                value={guestCount}
                onChange={(e) => setGuestCount(e.target.value)}
                className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-500">Booking value (US$)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={bookingValue}
                onChange={(e) => setBookingValue(e.target.value)}
                className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="mt-1 cursor-pointer rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Creating…" : "Create booking"}
          </button>
        </div>
      </form>
    </div>
  );
}
