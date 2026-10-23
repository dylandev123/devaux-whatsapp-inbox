// Server-only: data access for message batches. The scheduling itself (quiet
// period, maximum wait, claiming, leases, strict per-chat ordering) is done by
// the SQL functions in supabase/migrations/20261025000000_ai_agent_batching_memory.sql;
// nothing here keeps state in memory, so a restart loses nothing. The code that
// actually decides a batch lives in decide.ts (processDueBatches).

import { randomBytes } from "crypto";
import type { StoredBatchMessage } from "@/lib/aiAgent/batching";
import { agentDb } from "@/lib/server/aiAgent/db";

export interface BatchRow {
  id: string;
  business_slug: string;
  chat_id: string;
  contact_number: string | null;
  status: "collecting" | "processing" | "done" | "failed" | "cancelled";
  first_message_at: string;
  last_message_at: string;
  due_at: string;
  max_due_at: string;
  message_count: number;
  attempts: number;
  worker_id: string | null;
  lease_until: string | null;
}

export const MAX_BATCH_ATTEMPTS = 4;
const LEASE_SECONDS = 150;

/** Unique per worker invocation; only the claimant may complete or release a batch. */
export function newWorkerId(): string {
  return `w-${randomBytes(6).toString("hex")}`;
}

export async function enqueueBatchMessage(input: {
  businessSlug: string;
  chatId: string;
  contactNumber: string | null;
  whatsappMessageId: string;
  eventId: string | null;
  text: string;
  hasMedia: boolean;
  messageAt: string | null;
}): Promise<{ batchId: string; dueAt: string; maxDueAt: string; messageCount: number; duplicate: boolean }> {
  const messageAt = input.messageAt && !Number.isNaN(Date.parse(input.messageAt)) ? new Date(input.messageAt).toISOString() : null;
  const { data, error } = await agentDb().rpc("enqueue_ai_agent_batch_message", {
    p_business_slug: input.businessSlug,
    p_chat_id: input.chatId,
    p_contact_number: input.contactNumber,
    p_whatsapp_message_id: input.whatsappMessageId,
    p_event_id: input.eventId,
    p_text: input.text.slice(0, 8000),
    p_has_media: input.hasMedia,
    p_message_at: messageAt,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { batch_id: string; due_at: string; max_due_at: string; message_count: number; duplicate: boolean }
    | undefined;
  if (!row) throw new Error("enqueue_ai_agent_batch_message returned nothing");
  return { batchId: row.batch_id, dueAt: row.due_at, maxDueAt: row.max_due_at, messageCount: row.message_count, duplicate: row.duplicate };
}

export async function claimBatches(limit: number, worker: string): Promise<BatchRow[]> {
  const { data, error } = await agentDb().rpc("claim_ai_agent_batches", {
    p_limit: limit,
    p_worker: worker,
    p_lease_seconds: LEASE_SECONDS,
    p_max_attempts: MAX_BATCH_ATTEMPTS,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as BatchRow[];
}

export async function loadBatchMessages(batchId: string): Promise<StoredBatchMessage[]> {
  const { data, error } = await agentDb()
    .from("ai_agent_batch_messages")
    .select("id, whatsapp_message_id, event_id, text, has_media, message_at, received_at, position")
    .eq("batch_id", batchId)
    .order("position");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    whatsappMessageId: r.whatsapp_message_id,
    eventId: r.event_id,
    text: r.text ?? "",
    hasMedia: r.has_media === true,
    messageAt: r.message_at,
    receivedAt: r.received_at,
    position: Number(r.position),
  }));
}

/** True when this worker still held the lease and the batch is now finished. */
export async function completeBatch(
  batchId: string,
  worker: string,
  status: "done" | "failed" | "cancelled",
  decision: string | null,
  errorText: string | null = null
): Promise<boolean> {
  const { data, error } = await agentDb().rpc("complete_ai_agent_batch", {
    p_batch_id: batchId,
    p_worker: worker,
    p_status: status,
    p_decision: decision,
    p_error: errorText,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

export async function releaseBatch(batchId: string, worker: string, errorText: string, retrySeconds: number): Promise<void> {
  const { error } = await agentDb().rpc("release_ai_agent_batch", {
    p_batch_id: batchId,
    p_worker: worker,
    p_error: errorText,
    p_retry_seconds: retrySeconds,
  });
  if (error) throw new Error(error.message);
}

export async function purgeFinishedBatches(): Promise<void> {
  const { error } = await agentDb().rpc("purge_ai_agent_batches");
  if (error) console.error("[aiAgent] purge batches", error.message);
}
