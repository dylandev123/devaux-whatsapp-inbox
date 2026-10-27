// Server-only: what STAFF decided about one customer — the default delivery location and confirmed notes — in
// ai_agent_customer_staff_memory (migration 20261106000000). Every query is scoped to one business_slug and to the
// customer keys the identity resolver proved (lib/aiAgent/identity.ts, memoryKeysFor), exactly like the rest of customer
// memory. Written ONLY by the staff-group commands (customerCommands.ts); read by the staff card and the AI's memory brief.

import { randomBytes } from "node:crypto";
import type { ChatIdentity } from "@/lib/aiAgent/identity";
import { isProposalExpired, locationFingerprint, noteFingerprint, proposalCutoff } from "@/lib/aiAgent/customerCommands";
import { memoryKeysFor, primaryMemoryKey } from "@/lib/aiAgent/memory";
import { generateRefCode } from "@/lib/aiAgent/engine";
import { agentDb } from "@/lib/server/aiAgent/db";

export interface StaffLocation {
  id: string;
  content: string;
  set_by: string | null;
  source: string;
  created_at: string;
}

export interface StaffNote {
  id: string;
  content: string;
  short_code: string | null;
  status: "proposed" | "active";
  created_at: string;
  customer_label: string | null;
}

const COLUMNS = "id, customer_key, kind, status, content, short_code, set_by, source, created_at, customer_label";

export interface CustomerKeys {
  /** Where new data is stored. */
  primary: string;
  /** Every key that provably belongs to the same customer; reads and replacements cover all of them. */
  all: string[];
}

export function customerKeys(chatId: string, identity: Pick<ChatIdentity, "phone" | "chatIds">): CustomerKeys {
  const primary = primaryMemoryKey(chatId, identity);
  return { primary, all: [...new Set([primary, ...memoryKeysFor(identity)])] };
}

/** The customer's current default delivery location (the newest active one if, impossibly, two keys each held one). */
export async function loadStaffLocation(businessSlug: string, keys: string[]): Promise<StaffLocation | null> {
  if (keys.length === 0) return null;
  const { data, error } = await agentDb()
    .from("ai_agent_customer_staff_memory")
    .select(COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("kind", "delivery_location")
    .eq("status", "active")
    .in("customer_key", keys)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? []) as StaffLocation[])[0] ?? null;
}

/** Same, for the AI's read path: a missing table (migration not yet run) is "nothing saved", never a failure. */
export async function loadStaffLocationSafe(businessSlug: string, keys: string[]): Promise<StaffLocation | null> {
  try {
    return await loadStaffLocation(businessSlug, keys);
  } catch (err) {
    console.error("[aiAgent] loadStaffLocation", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function loadStaffNotes(businessSlug: string, keys: string[], statuses: ("active" | "proposed")[] = ["active"]): Promise<StaffNote[]> {
  if (keys.length === 0) return [];
  const { data, error } = await agentDb()
    .from("ai_agent_customer_staff_memory")
    .select(COLUMNS)
    .eq("business_slug", businessSlug)
    .eq("kind", "note")
    .in("status", statuses)
    .in("customer_key", keys)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message);
  // A proposal older than the TTL is expired even before the sweep has marked it: never shown, never counted.
  return ((data ?? []) as StaffNote[]).filter((n) => n.status !== "proposed" || !isProposalExpired(n.created_at));
}

export async function loadStaffNotesSafe(businessSlug: string, keys: string[]): Promise<StaffNote[]> {
  try {
    return await loadStaffNotes(businessSlug, keys);
  } catch (err) {
    console.error("[aiAgent] loadStaffNotes", err instanceof Error ? err.message : err);
    return [];
  }
}

export interface LocationChange {
  result: "created" | "updated" | "unchanged" | "replayed";
  id: string;
  previous: string | null;
}

/** Saves or replaces the default location in one transaction (set_ai_agent_customer_location). */
export async function saveStaffLocation(args: {
  businessSlug: string;
  keys: CustomerKeys;
  location: string;
  setBy: string | null;
  messageId: string | null;
  eventId: string | null;
  chatId: string;
  label: string;
}): Promise<LocationChange> {
  const { data, error } = await agentDb().rpc("set_ai_agent_customer_location", {
    p_business_slug: args.businessSlug,
    p_customer_key: args.keys.primary,
    p_keys: args.keys.all,
    p_location: args.location,
    p_fingerprint: locationFingerprint(args.location),
    p_set_by: args.setBy,
    p_source_message_id: args.messageId,
    p_source_event_id: args.eventId,
    p_source_chat_id: args.chatId,
    p_customer_label: args.label,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { result: LocationChange["result"]; id: string; previous_location: string | null } | undefined;
  if (!row) throw new Error("set_ai_agent_customer_location returned nothing");
  return { result: row.result, id: row.id, previous: row.previous_location };
}

export interface LocationClear {
  result: "cleared" | "none" | "replayed";
  id: string | null;
  previous: string | null;
}

/** Removes the default location in one transaction (clear_ai_agent_customer_location); the row stays as history. */
export async function clearStaffLocation(args: { businessSlug: string; keys: CustomerKeys; clearedBy: string | null; messageId: string | null }): Promise<LocationClear> {
  const { data, error } = await agentDb().rpc("clear_ai_agent_customer_location", {
    p_business_slug: args.businessSlug,
    p_customer_key: args.keys.primary,
    p_keys: args.keys.all,
    p_cleared_by: args.clearedBy,
    p_source_message_id: args.messageId,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { result: LocationClear["result"]; id: string | null; previous_location: string | null } | undefined;
  if (!row) throw new Error("clear_ai_agent_customer_location returned nothing");
  return { result: row.result, id: row.id, previous: row.previous_location };
}

export interface ExpiredProposal {
  id: string;
  customer_key: string;
  short_code: string | null;
}

/**
 * Marks every unconfirmed proposal older than the TTL as expired (a conditional update: only from 'proposed'). Run before
 * anything that lists, counts, proposes or reviews notes, so an expired proposal frees its slot and its duplicate check.
 */
export async function expireStaleProposals(businessSlug: string, now: number = Date.now()): Promise<ExpiredProposal[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_customer_staff_memory")
    .update({ status: "expired", ended_at: new Date(now).toISOString(), ended_by: null })
    .eq("business_slug", businessSlug)
    .eq("kind", "note")
    .eq("status", "proposed")
    .lt("created_at", proposalCutoff(now))
    .select("id, customer_key, short_code");
  if (error) throw new Error(error.message);
  return (data ?? []) as ExpiredProposal[];
}

export type ProposeResult =
  | { result: "proposed"; code: string; id: string }
  | { result: "duplicate"; code: string | null; status: "proposed" | "active" }
  | { result: "replayed"; code: string | null }
  | { result: "limit" };

/** Stores a note as PROPOSED. The same note (any spelling) already active or waiting is reported, not duplicated. */
export async function proposeStaffNote(args: {
  businessSlug: string;
  keys: CustomerKeys;
  content: string;
  setBy: string | null;
  messageId: string | null;
  eventId: string | null;
  chatId: string;
  label: string;
  limit: number;
}): Promise<ProposeResult> {
  const db = agentDb();
  const fingerprint = noteFingerprint(args.content);
  const existing = await loadStaffNotes(args.businessSlug, args.keys.all, ["active", "proposed"]);
  const same = existing.find((n) => noteFingerprint(n.content) === fingerprint);
  if (same) return { result: "duplicate", code: same.short_code, status: same.status };
  if (existing.length >= args.limit) return { result: "limit" };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateRefCode(randomBytes(8)).replace(/^E-/, "M-");
    const { data, error } = await db
      .from("ai_agent_customer_staff_memory")
      .insert({
        business_slug: args.businessSlug,
        customer_key: args.keys.primary,
        kind: "note",
        status: "proposed",
        content: args.content,
        fingerprint,
        short_code: code,
        source: "staff_whatsapp",
        set_by: args.setBy,
        source_message_id: args.messageId,
        source_event_id: args.eventId,
        source_chat_id: args.chatId,
        customer_label: args.label.slice(0, 120),
      })
      .select("id")
      .single();
    if (!error && data) return { result: "proposed", code, id: data.id as string };
    if (error?.code !== "23505") throw new Error(error?.message ?? "insert failed");
    // A unique violation is a repeat of this very message, the same note raced in, or a code collision.
    if (args.messageId) {
      const { data: again } = await db
        .from("ai_agent_customer_staff_memory")
        .select("short_code")
        .eq("business_slug", args.businessSlug)
        .eq("kind", "note")
        .eq("source_message_id", args.messageId)
        .limit(1);
      const hit = ((again ?? []) as { short_code: string | null }[])[0];
      if (hit) return { result: "replayed", code: hit.short_code };
    }
    const raced = (await loadStaffNotes(args.businessSlug, args.keys.all, ["active", "proposed"])).find((n) => noteFingerprint(n.content) === fingerprint);
    if (raced) return { result: "duplicate", code: raced.short_code, status: raced.status };
  }
  throw new Error("Could not allocate a note code");
}

export interface NoteRow {
  id: string;
  customer_key: string;
  content: string;
  status: string;
  customer_label: string | null;
  created_at: string;
  source_chat_id?: string | null;
}

export async function findNoteByCode(businessSlug: string, code: string): Promise<NoteRow | null> {
  const { data, error } = await agentDb()
    .from("ai_agent_customer_staff_memory")
    .select("id, customer_key, content, status, customer_label, created_at")
    .eq("business_slug", businessSlug)
    .eq("kind", "note")
    .eq("short_code", code)
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? []) as NoteRow[])[0] ?? null;
}

/**
 * Moves a note along its lifecycle with a conditional update (only from the expected state), so a repeat or a race is a
 * no-op: proposed → active (confirm, only while unexpired) | discarded; active → removed. (Expiry itself is expireStaleProposals.)
 */
export async function transitionNote(args: { businessSlug: string; id: string; from: "proposed" | "active"; to: "active" | "discarded" | "removed"; by: string | null }): Promise<boolean> {
  const now = new Date().toISOString();
  const patch = args.to === "active" ? { status: "active", confirmed_at: now, confirmed_by: args.by } : { status: args.to, ended_at: now, ended_by: args.by };
  let query = agentDb().from("ai_agent_customer_staff_memory").update(patch).eq("business_slug", args.businessSlug).eq("id", args.id).eq("status", args.from);
  // An expired proposal can never be confirmed, even if it expires between the caller's check and this update.
  if (args.to === "active") query = query.gte("created_at", proposalCutoff());
  const { data, error } = await query.select("id");
  if (error) {
    // Confirming a note that an identical active one now exists violates the duplicate index: report "no change".
    if (error.code === "23505") return false;
    throw new Error(error.message);
  }
  return (data ?? []).length > 0;
}
