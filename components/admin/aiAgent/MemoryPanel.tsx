"use client";

import { useCallback, useEffect, useState } from "react";
import { aiAgentApi, CustomerMemoryView, MemoryCustomerListItem, MemoryFactView } from "@/lib/aiAgent/client";
import { KnownChat } from "@/lib/knownChats";
import { Card, dangerButton, formatWhen, inputClass, Notice, primaryButton, secondaryButton } from "@/components/admin/aiAgent/ui";

const FACT_LABEL: Record<MemoryFactView["kind"], string> = {
  preference: "Preference",
  delivery_preference: "Delivery preference",
  resolved_issue: "Resolved issue",
  note: "Note",
};
const SOURCE_LABEL: Record<MemoryFactView["source"], string> = {
  customer_stated: "customer said",
  staff_confirmed: "staff confirmed",
  admin: "entered by admin",
};

function Tag({ tone, children }: { tone: "ok" | "warn" | "muted"; children: React.ReactNode }) {
  const style = { ok: "bg-emerald-50 text-emerald-700", warn: "bg-amber-100 text-amber-800", muted: "bg-zinc-100 text-zinc-600" }[tone];
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${style}`}>{children}</span>;
}

function FactRow({ fact, onSave, onDelete, busy }: { fact: MemoryFactView; onSave: (content: string) => void; onDelete: () => void; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.content);
  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={fact.source === "customer_stated" ? "muted" : "ok"}>{SOURCE_LABEL[fact.source]}</Tag>
        <span className="text-xs text-zinc-500">{FACT_LABEL[fact.kind]}</span>
        <span className="text-xs text-zinc-400">
          updated {formatWhen(fact.updated_at)}
          {fact.expires_at ? ` · expires ${formatWhen(fact.expires_at)}` : ""}
        </span>
      </div>
      {editing ? (
        <div className="mt-1 flex gap-2">
          <input value={draft} maxLength={300} onChange={(e) => setDraft(e.target.value)} className={inputClass} />
          <button type="button" disabled={busy || !draft.trim()} className={primaryButton} onClick={() => { onSave(draft); setEditing(false); }}>
            Save
          </button>
          <button type="button" className={secondaryButton} onClick={() => { setDraft(fact.content); setEditing(false); }}>
            Cancel
          </button>
        </div>
      ) : (
        <p className="mt-1 text-zinc-900">{fact.content}</p>
      )}
      {fact.evidence && <p className="mt-0.5 text-xs italic text-zinc-400">Customer&apos;s words: &ldquo;{fact.evidence}&rdquo;</p>}
      {!editing && (
        <div className="mt-1 flex gap-3 text-xs">
          <button type="button" className="cursor-pointer text-zinc-500 hover:text-zinc-900" onClick={() => setEditing(true)}>
            Correct
          </button>
          <button type="button" disabled={busy} className="cursor-pointer text-red-600 hover:text-red-800" onClick={onDelete}>
            Delete
          </button>
        </div>
      )}
    </li>
  );
}

export function MemoryPanel({ businessSlug, chats }: { businessSlug: string; chats: KnownChat[] }) {
  const [customers, setCustomers] = useState<MemoryCustomerListItem[]>([]);
  const [chatId, setChatId] = useState("");
  const [typed, setTyped] = useState("");
  const [memory, setMemory] = useState<CustomerMemoryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<"preference" | "delivery_preference" | "note">("preference");
  const [newContent, setNewContent] = useState("");
  const [includeOrders, setIncludeOrders] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    aiAgentApi
      .listMemoryCustomers(businessSlug)
      .then((r) => setCustomers(r.customers))
      .catch(() => setCustomers([]));
  }, [businessSlug]);

  const open = useCallback(
    async (target: string) => {
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        const res = await aiAgentApi.getMemory(businessSlug, target);
        setMemory(res.memory);
        setChatId(target);
      } catch (err) {
        setMemory(null);
        setError(err instanceof Error ? err.message : "Failed to load memory");
      } finally {
        setBusy(false);
      }
    },
    [businessSlug]
  );

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await action();
      setInfo(done);
      await open(chatId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const verified = memory?.orders.filter((o) => o.verified) ?? [];
  const unconfirmed = memory?.orders.filter((o) => !o.verified) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Card
        title="Customer memory"
        subtitle="What the agent remembers about one customer of this business. Confirmed purchases come from orders staff have processed; preferences are only what the customer said; AI inferences are never treated as fact."
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <select value={chatId} onChange={(e) => e.target.value && open(e.target.value)} className={`${inputClass} sm:max-w-xs`}>
              <option value="">Choose a customer…</option>
              {customers.length > 0 && (
                <optgroup label="With remembered facts">
                  {customers.map((c) => (
                    <option key={c.customerKey} value={c.chatId}>
                      {c.customerKey.startsWith("chat:") ? c.customerKey.slice(5) : c.customerKey} ({c.facts})
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Known chats">
                {chats
                  .filter((c) => !c.isGroup)
                  .map((c) => (
                    <option key={c.chatId} value={c.chatId}>
                      {c.contactName || c.contactNumber || c.chatId}
                    </option>
                  ))}
              </optgroup>
            </select>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="…or a phone number, digits only" className={`${inputClass} sm:max-w-xs`} />
            <button type="button" disabled={busy || !typed.trim()} className={secondaryButton} onClick={() => open(typed.trim())}>
              Look up
            </button>
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          {info && <Notice tone="ok">{info}</Notice>}
        </div>
      </Card>

      {memory && (
        <>
          <Card title="Identity" subtitle="Memory is matched only by a verified phone number or this customer's own chats — never by name.">
            <p className="text-sm text-zinc-700">
              {memory.identity.phone ? <>Verified phone: <span className="font-mono">{memory.identity.phone}</span></> : "No verified phone number."}
            </p>
            {memory.identity.unresolvedLid && (
              <div className="mt-2">
                <Notice tone="warn">
                  This chat uses a privacy ID (@lid) and WhatsApp reported no phone number. Memory is limited to this one chat and is not merged with any other.
                </Notice>
              </div>
            )}
            <p className="mt-1 text-xs text-zinc-400">Chats: {memory.identity.chatIds.join(", ")}</p>
          </Card>

          <Card title="Confirmed purchases" subtitle="Orders staff processed (Added / Completed). These are the only completed purchases the agent will refer to.">
            {verified.length === 0 ? (
              <Notice tone="info">No confirmed orders on record.</Notice>
            ) : (
              <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
                {verified.map((o) => (
                  <li key={o.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                    <div className={o.excluded ? "opacity-50" : ""}>
                      <p className="text-zinc-900">
                        {o.products.length ? o.products.join(", ") : o.summary}
                        {o.quantity ? ` × ${o.quantity}` : ""} <Tag tone="ok">{o.status}</Tag> {o.excluded && <Tag tone="warn">hidden from agent</Tag>}
                      </p>
                      <p className="text-xs text-zinc-400">{formatWhen(o.at)}{o.address ? ` · ${o.address}` : ""}</p>
                    </div>
                    <button type="button" disabled={busy} className={secondaryButton} onClick={() => run(() => aiAgentApi.setOrderExcluded(businessSlug, chatId, o.id, !o.excluded), o.excluded ? "Order shown to the agent again." : "Order hidden from the agent.")}>
                      {o.excluded ? "Include" : "Exclude"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {unconfirmed.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-amber-800">Earlier requests not confirmed by staff (never treated as purchases)</p>
                <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
                  {unconfirmed.map((o) => (
                    <li key={o.id} className="px-3 py-2 text-sm text-zinc-700">
                      {o.products.length ? o.products.join(", ") : o.summary} <Tag tone="warn">{o.status ?? "Needs adding"}</Tag>
                      <span className="ml-2 text-xs text-zinc-400">{formatWhen(o.at)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <Card title="Remembered facts" subtitle="Preferences the customer stated in their own words, issues staff resolved, and notes you add. Correct or delete anything that is wrong.">
            {memory.facts.length === 0 ? (
              <Notice tone="info">Nothing remembered yet.</Notice>
            ) : (
              <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
                {memory.facts.map((f) => (
                  <FactRow
                    key={f.id}
                    fact={f}
                    busy={busy}
                    onSave={(content) => run(() => aiAgentApi.updateMemoryFact(businessSlug, chatId, f.id, content), "Fact corrected.")}
                    onDelete={() => window.confirm("Delete this remembered fact?") && run(() => aiAgentApi.deleteMemoryFact(businessSlug, chatId, f.id), "Fact deleted.")}
                  />
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <select value={newKind} onChange={(e) => setNewKind(e.target.value as typeof newKind)} className={`${inputClass} sm:w-48`}>
                <option value="preference">Preference</option>
                <option value="delivery_preference">Delivery preference</option>
                <option value="note">Note</option>
              </select>
              <input value={newContent} maxLength={300} onChange={(e) => setNewContent(e.target.value)} placeholder="e.g. Prefers morning delivery" className={`${inputClass} sm:flex-1`} />
              <button
                type="button"
                disabled={busy || !newContent.trim()}
                className={primaryButton}
                onClick={() => run(async () => { await aiAgentApi.addMemoryFact(businessSlug, chatId, newKind, newContent.trim()); setNewContent(""); }, "Fact added.")}
              >
                Add
              </button>
            </div>
          </Card>

          <Card title="AI inferences (unverified)" subtitle="Guesses from the analysis engine. They may be stale or wrong and are always labelled that way to the agent.">
            {Object.keys(memory.inferences).length === 0 ? (
              <Notice tone="info">{memory.identity.phone ? "No inferences stored." : "Inferences are only used for customers with a verified phone number."}</Notice>
            ) : (
              <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
                {Object.entries(memory.inferences).map(([field, value]) => (
                  <li key={field} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                    <p>
                      <span className="text-xs text-zinc-500">{field.replace(/_/g, " ")}: </span>
                      {value}
                    </p>
                    <button type="button" disabled={busy} className={secondaryButton} onClick={() => run(() => aiAgentApi.clearInference(businessSlug, chatId, [field]), "Inference cleared.")}>
                      Clear
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Delete this customer's data" subtitle="Removes remembered facts, the AI profile and any batched message text for this customer in this business only.">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input type="checkbox" checked={includeOrders} onChange={(e) => setIncludeOrders(e.target.checked)} />
                Also delete recorded orders (business records — usually keep)
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input type="checkbox" checked={includeLogs} onChange={(e) => setIncludeLogs(e.target.checked)} />
                Also erase message text kept in agent activity, escalations and order requests
              </label>
              <div className="flex gap-2">
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type DELETE to confirm" className={`${inputClass} sm:max-w-xs`} />
                <button
                  type="button"
                  disabled={busy || confirm !== "DELETE"}
                  className={dangerButton}
                  onClick={() =>
                    run(async () => {
                      await aiAgentApi.forgetCustomer(businessSlug, chatId, { includeOrders, includeLogs });
                      setConfirm("");
                    }, "Customer data deleted.")
                  }
                >
                  Delete customer data
                </button>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
