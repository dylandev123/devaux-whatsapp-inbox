// Server-only: reads the customer photos an order conversation points at ("this one 55lbs" under a picture of a bag).
//
// One small vision call per picture, ever: the reading is stored in the audit log (keyed by the WhatsApp message id) and reused
// by every later turn, retry or replay. A picture is read only when the customer's words point at it (picturesToRead), only
// from this business's own media folder (allowedPictureUrl), only when it is small enough, and within an hourly budget.
// An expired, missing or unreadable picture is not an error: it simply gives no product, and the order reader is told so.
// Nothing here writes an order, sends a message or stores the picture itself.

import OpenAI from "openai";
import {
  allowedPictureUrl,
  MAX_PICTURE_BYTES,
  type MediaLine,
  parsePictureReading,
  PICTURE_MAX_ATTEMPTS,
  PICTURE_READS_PER_BUSINESS_PER_HOUR,
  type PictureReading,
  picturesToRead,
} from "@/lib/aiAgent/orderImages";
import { agentDb, audit } from "@/lib/server/aiAgent/db";
import { getAiSettings } from "@/lib/server/aiSettings";

const ATTEMPT = "orders.picture_attempt";
const READ = "orders.picture_read";
const FETCH_TIMEOUT_MS = 8_000;

const PICTURE_PROMPT = `You look at ONE photo a customer sent to a small business while ordering, to help staff understand a message such as "this one". You only describe what is plainly visible; you never decide anything about an order.

Return ONLY JSON: { "kind": "product" | "other" | "unreadable", "visible_text": ["<text you can actually read on the packaging, label or screenshot>"], "product": "<the product name exactly as printed>" or null, "size": "<a size or weight printed on the pack, e.g. 25kg>" or null }

Rules:
- "visible_text" is a transcription of readable text only: brand, product name, flavour, size/weight. Copy it; do not translate or complete it.
- "product" and "size" must be words that appear in "visible_text". Never guess a variant, flavour, size or quantity that is not printed. Never count items.
- A photo of something that is not a product label or package (a person, a pet, a room, a document) is "other". A blurry, cropped or dark photo is "unreadable".
- A product list is given only to help you spell names that are printed on the label. Do not name a listed product unless its name is printed on the photo.`;

async function cachedReading(businessSlug: string, messageId: string): Promise<PictureReading | null> {
  const { data, error } = await agentDb().from("ai_agent_audit_log").select("details").eq("business_slug", businessSlug).eq("action", READ).eq("target_id", messageId).order("created_at", { ascending: false }).limit(1);
  if (error || !data?.[0]) return null;
  const reading = (data[0].details as { reading?: PictureReading } | null)?.reading;
  return reading && typeof reading.kind === "string" ? reading : null;
}

async function count(businessSlug: string, action: string, messageId?: string, sinceMs?: number): Promise<number> {
  let query = agentDb().from("ai_agent_audit_log").select("id", { count: "exact", head: true }).eq("business_slug", businessSlug).eq("action", action);
  if (messageId) query = query.eq("target_id", messageId);
  if (sinceMs) query = query.gte("created_at", new Date(Date.now() - sinceMs).toISOString());
  const { count: n, error } = await query;
  if (error) throw new Error(error.message);
  return n ?? 0;
}

async function fetchPicture(url: URL): Promise<{ dataUrl: string } | { error: string }> {
  try {
    // No redirects (the address was checked), a hard time limit (no in-memory timers: the platform enforces it), a size limit.
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
    if (!res.ok) return { error: `media_${res.status}` };
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!/^image\/(?:jpeg|png|webp)$/.test(type)) return { error: "media_not_image" };
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_PICTURE_BYTES) return { error: "media_too_large" };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_PICTURE_BYTES) return { error: bytes.length === 0 ? "media_empty" : "media_too_large" };
    return { dataUrl: `data:${type};base64,${bytes.toString("base64")}` };
  } catch {
    return { error: "media_unreachable" };
  }
}

export interface PictureReadArgs {
  businessSlug: string;
  /** The chat's recent lines, with their media. */
  lines: MediaLine[];
  /** The customer's words in the turn being read. */
  turnTexts: string[];
  turnAt: string;
  /** What the business sells (knowledge lines), only to help the model spell what is printed. Asked for only when a picture is really read. */
  knownProducts?: () => Promise<string[]>;
}

/** Test seam: replaces fetching and the model. Returns the raw model text for a picture address. */
type PictureReader = (url: string, knownProducts: string[]) => Promise<{ text: string } | { error: string }>;
let readerForTests: PictureReader | null = null;
export function setPictureReaderForTests(fn: PictureReader | null): void {
  readerForTests = fn;
}

async function askModel(dataUrl: string, knownProducts: string[]): Promise<{ text: string; model: string } | { error: string }> {
  const settings = await getAiSettings().catch(() => null);
  if (!settings?.api_key) return { error: "model_not_configured" };
  const model = process.env.AI_AGENT_IMAGE_MODEL?.trim() || settings.model;
  try {
    const client = new OpenAI({ apiKey: settings.api_key });
    const response = await client.responses.create({
      model,
      instructions: PICTURE_PROMPT,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `Known products (spelling help only):\n${knownProducts.slice(0, 40).join("\n") || "none"}` },
            { type: "input_image", image_url: dataUrl, detail: "low" },
          ],
        },
      ],
      max_output_tokens: 300,
    });
    if (response.error) return { error: "model_error" };
    return response.output_text?.trim() ? { text: response.output_text, model } : { error: "model_empty" };
  } catch {
    return { error: "model_error" };
  }
}

/**
 * The readings for the pictures this turn points at, by WhatsApp message id. A picture that cannot be read (expired,
 * missing, too big, another business's folder, no model, over budget) is simply absent from the result.
 */
export async function readPicturesForTurn(args: PictureReadArgs): Promise<Map<string, PictureReading>> {
  const out = new Map<string, PictureReading>();
  const { businessSlug } = args;
  const origin = process.env.WHATSAPP_MEDIA_ORIGIN;
  for (const line of picturesToRead(args.lines, args.turnTexts, args.turnAt)) {
    const id = line.id;
    if (!id) continue;
    try {
      const cached = await cachedReading(businessSlug, id);
      if (cached) {
        out.set(id, cached);
        continue;
      }
      const url = allowedPictureUrl(line.mediaUrl, businessSlug, origin);
      // Only an address on the media origin, in THIS business's folder, is ever requested (also in tests).
      if (!url) continue;
      if ((await count(businessSlug, ATTEMPT, id)) >= PICTURE_MAX_ATTEMPTS) continue;
      if ((await count(businessSlug, ATTEMPT, undefined, 3_600_000)) >= PICTURE_READS_PER_BUSINESS_PER_HOUR) {
        await audit(businessSlug, "system", null, "orders.picture_rate_limited", { type: "message", id }, {});
        continue;
      }
      // Counted before the work, so a failing fetch or model still uses its budget.
      await audit(businessSlug, "system", null, ATTEMPT, { type: "message", id }, {});
      const known = await (args.knownProducts?.() ?? Promise.resolve([])).catch(() => [] as string[]);
      let text: string;
      let model = "test";
      if (readerForTests) {
        const res = await readerForTests(url.toString(), known);
        if ("error" in res) continue;
        text = res.text;
      } else {
        const fetched = await fetchPicture(url);
        if ("error" in fetched) {
          await audit(businessSlug, "system", null, "orders.picture_unavailable", { type: "message", id }, { why: fetched.error });
          continue;
        }
        const asked = await askModel(fetched.dataUrl, known);
        if ("error" in asked) {
          await audit(businessSlug, "system", null, "orders.picture_unavailable", { type: "message", id }, { why: asked.error });
          continue;
        }
        text = asked.text;
        model = asked.model;
      }
      const reading = parsePictureReading(text);
      // The reading (labels and a product name, never the picture) is kept so no later turn pays for it again.
      await audit(businessSlug, "system", null, READ, { type: "message", id }, { reading, model });
      out.set(id, reading);
    } catch (err) {
      console.error("[aiAgent] picture read failed", err instanceof Error ? err.message : "unknown");
    }
  }
  return out;
}
