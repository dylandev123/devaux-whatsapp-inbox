// Server-only: the stored proposals behind !confirm / !discard (ai_agent_order_proposals): a correction (C-CODE), a bulk completion
// (B-CODE) or a customer preference (P-CODE). Shared by lib/server/aiAgent/orderCorrections.ts and teachSessions.ts.
// Status moves are conditional updates, so a repeated or racing confirm is a no-op.

import { randomBytes } from "node:crypto";
import { generateRefCode } from "@/lib/aiAgent/engine";
import type { ProposalKind } from "@/lib/aiAgent/orderTeach";
import { agentDb } from "@/lib/server/aiAgent/db";

export type Status = "pending" | "applying" | "applied" | "partial" | "discarded" | "expired" | "superseded" | "stale" | "failed";

export interface ProposalRow {
  id: string;
  business_slug: string;
  kind: ProposalKind;
  code: string;
  status: Status;
  group_jid: string;
  created_by: string | null;
  source_message_id: string;
  order_id: string | null;
  order_version: number | null;
  instruction: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  expires_at: string;
  claimed_at: string | null;
}

export const PROPOSAL_COLUMNS = "id, business_slug, kind, code, status, group_jid, created_by, source_message_id, order_id, order_version, instruction, payload, result, expires_at, claimed_at";

export async function proposalBySource(slug: string, messageId: string, kind: ProposalKind): Promise<ProposalRow | null> {
  const { data, error } = await agentDb().from("ai_agent_order_proposals").select(PROPOSAL_COLUMNS).eq("business_slug", slug).eq("source_message_id", messageId).eq("kind", kind).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ProposalRow | null) ?? null;
}

/** Always filtered by business: another business's code is "unknown", never "somebody else's". */
export async function proposalByCode(slug: string, code: string): Promise<ProposalRow | null> {
  const { data, error } = await agentDb().from("ai_agent_order_proposals").select(PROPOSAL_COLUMNS).eq("business_slug", slug).eq("code", code).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ProposalRow | null) ?? null;
}

/** Conditional status change: true only when this call made it (the row was in one of `from`). */
export async function move(row: ProposalRow, from: Status[], to: Status, patch: Record<string, unknown> = {}): Promise<boolean> {
  const { data, error } = await agentDb()
    .from("ai_agent_order_proposals")
    .update({ status: to, ...patch })
    .eq("business_slug", row.business_slug)
    .eq("id", row.id)
    .in("status", from)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** A new proposal replaces any still-pending one it makes obsolete, so only the newest code can be confirmed. */
export async function supersedePending(slug: string, kind: ProposalKind, orderId: string | null): Promise<void> {
  let q = agentDb().from("ai_agent_order_proposals").update({ status: "superseded", resolved_at: new Date().toISOString() }).eq("business_slug", slug).eq("kind", kind).eq("status", "pending");
  if (orderId) q = q.eq("order_id", orderId);
  const { error } = await q;
  if (error) throw new Error(error.message);
}

export const newCode = (kind: ProposalKind) => generateRefCode(randomBytes(8)).replace(/^E-/, kind === "correction" ? "C-" : kind === "customer_preference" ? "P-" : "B-");

export async function createProposal(args: {
  slug: string;
  kind: ProposalKind;
  groupJid: string;
  createdBy: string | null;
  messageId: string;
  orderId: string | null;
  orderVersion: number | null;
  instruction: string | null;
  payload: (code: string) => Record<string, unknown>;
  ttlMs: number;
  now: Date;
}): Promise<{ row: ProposalRow; existing: boolean }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newCode(args.kind);
    const { data, error } = await agentDb()
      .from("ai_agent_order_proposals")
      .insert({
        business_slug: args.slug,
        kind: args.kind,
        code,
        group_jid: args.groupJid,
        created_by: args.createdBy,
        source_message_id: args.messageId,
        order_id: args.orderId,
        order_version: args.orderVersion,
        instruction: args.instruction,
        payload: args.payload(code),
        expires_at: new Date(args.now.getTime() + args.ttlMs).toISOString(),
      })
      .select(PROPOSAL_COLUMNS)
      .single();
    if (!error && data) return { row: data as ProposalRow, existing: false };
    if (error?.code !== "23505") throw new Error(error?.message ?? "insert failed");
    // A unique violation is the same WhatsApp message arriving twice at once, or (rarely) a code collision.
    const same = await proposalBySource(args.slug, args.messageId, args.kind);
    if (same) return { row: same, existing: true };
  }
  throw new Error("Could not allocate a proposal code");
}

