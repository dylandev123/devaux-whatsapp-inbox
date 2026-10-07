"use client";

import { useState } from "react";
import { describeError } from "@/lib/errors";
import { businessLabel } from "@/lib/whatsapp";
import {
  deleteRecipientGroup,
  Recipient,
  RecipientGroup,
  saveRecipientGroup,
} from "@/lib/scheduledMessages";
import { RecipientPicker } from "./RecipientPicker";

interface Props {
  groups: RecipientGroup[];
  businessSlugs: string[];
  defaultBusinessSlug: string;
  onChanged: () => void;
}

interface Draft {
  id?: string;
  business_slug: string;
  name: string;
  members: Recipient[];
}

export function RecipientGroupsPanel({ groups, businessSlugs, defaultBusinessSlug, onChanged }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) {
      setError("Give the group a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveRecipientGroup({ ...draft, name: draft.name.trim() });
      setDraft(null);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(group: RecipientGroup) {
    if (!window.confirm(`Delete group "${group.name}"? Schedules using it will no longer send to its members.`)) {
      return;
    }
    try {
      await deleteRecipientGroup(group.id);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          Reusable lists (e.g. &quot;Drivers&quot;). A schedule sends one message to everyone in the groups it uses.
        </p>
        <button
          type="button"
          onClick={() => setDraft({ business_slug: defaultBusinessSlug, name: "", members: [] })}
          className="cursor-pointer rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          New group
        </button>
      </div>

      {error && !draft && <p className="text-sm text-red-600">{error}</p>}

      {draft && (
        <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-zinc-600">Group name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Cool & Pool Staff"
                className="w-full rounded-md border border-zinc-200 px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-zinc-600">Business</span>
              <select
                value={draft.business_slug}
                disabled={Boolean(draft.id)}
                onChange={(e) => setDraft({ ...draft, business_slug: e.target.value, members: [] })}
                className="w-full rounded-md border border-zinc-200 px-3 py-2 disabled:bg-zinc-50"
              >
                {businessSlugs.map((slug) => (
                  <option key={slug} value={slug}>
                    {businessLabel(slug)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <span className="mb-1 block text-sm text-zinc-600">Members ({draft.members.length})</span>
            <RecipientPicker
              businessSlug={draft.business_slug}
              value={draft.members}
              onChange={(members) => setDraft({ ...draft, members })}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
              className="cursor-pointer rounded-md px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="cursor-pointer rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save group"}
            </button>
          </div>
        </div>
      )}

      {groups.length === 0 && !draft ? (
        <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500">
          No recipient groups yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {groups.map((group) => (
            <li key={group.id} className="rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-zinc-900">{group.name}</p>
                  <p className="text-xs text-zinc-500">
                    {businessLabel(group.business_slug)} · {group.members.length} member
                    {group.members.length === 1 ? "" : "s"}
                  </p>
                  {group.members.length > 0 && (
                    <p className="mt-1 text-xs text-zinc-500">
                      {group.members
                        .slice(0, 8)
                        .map((m) => m.name || m.jid.replace(/@.*$/, ""))
                        .join(", ")}
                      {group.members.length > 8 ? `, +${group.members.length - 8} more` : ""}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        id: group.id,
                        business_slug: group.business_slug,
                        name: group.name,
                        members: group.members,
                      })
                    }
                    className="cursor-pointer rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(group)}
                    className="cursor-pointer rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
