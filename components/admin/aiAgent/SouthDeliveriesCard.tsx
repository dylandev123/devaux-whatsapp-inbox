"use client";

import { useState } from "react";
import { aiAgentApi, SettingsResponse } from "@/lib/aiAgent/client";
import { regionConfigFrom, southLocationsToText } from "@/lib/aiAgent/deliveryRegions";
import { Card, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

interface Props {
  businessSlug: string;
  data: SettingsResponse;
  onSaved: (next: SettingsResponse["settings"]) => void;
}

/** The places that count as a South Delivery. Orders to them are marked SOUTH DELIVERY, listed together, and get no automatic delivery day. */
export function SouthDeliveriesCard({ businessSlug, data, onSaved }: Props) {
  const saved = data.settings.south_locations;
  const builtIn = southLocationsToText(regionConfigFrom(null).south);
  const [text, setText] = useState(southLocationsToText(regionConfigFrom(saved).south));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function save(next: string | null) {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await aiAgentApi.saveSettings(businessSlug, { southLocationsText: next });
      onSaved(res.settings);
      setText(southLocationsToText(regionConfigFrom(res.settings.south_locations).south));
      setMessage(next === null ? "Back to the built-in list." : "Saved. New and updated orders use this list; nothing already in the Google Doc is changed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="South Deliveries" subtitle="Orders to these places are marked SOUTH DELIVERY, listed together in the order reports, and never get an automatic next-day delivery date: the day is confirmed by a person. One destination per line: the heading, then other names for it after a colon.">
      <div className="flex flex-col gap-3">
        <textarea className={`${inputClass} h-48 font-mono text-xs`} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <p className="text-xs text-zinc-500">
          Example: <span className="font-mono">Soufrière: Anse Chastanet, Jalousie, St Remy</span>. A place that also exists in the north (Belle Vue, Union, Beausejour…) is never classified automatically.
        </p>
        {error && <Notice tone="error">{error}</Notice>}
        {message && <Notice tone="ok">{message}</Notice>}
        <div className="flex gap-2">
          <button type="button" className={primaryButton} disabled={saving} onClick={() => save(text)}>
            Save list
          </button>
          <button type="button" className={secondaryButton} disabled={saving || text === builtIn} onClick={() => save(null)}>
            Restore built-in list
          </button>
        </div>
      </div>
    </Card>
  );
}
