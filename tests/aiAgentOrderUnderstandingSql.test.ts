// Order understanding end to end: the app's REAL server code (processBridgeMessage → monitor → trackOrders → report) against
// the REAL migrations in a throwaway Postgres (tests/helpers/pgHarness.ts). Only the language models and the picture
// fetch are replaced by scripted stand-ins. Covers the #KBNYW and #JXBDS shapes: a customer photo with "this one", a staff
// delivery day offered and accepted, invoice-only talk held out of the order book, orders held for review, staff-committed days,
// locked days, timezone boundaries, inaccessible pictures and another business's media. Skips itself without Postgres.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const GROUP = "120363000000000001@g.us";
const MEDIA = "http://203.0.113.9:3030";
const MAddie = { chat: "42924070961342@lid", phone: "17585200082" };
const SOCO = { chat: "72181774049339@lid", phone: "17587305408" };
type Customer = typeof MAddie;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let orders: typeof import("../lib/server/aiAgent/orders.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
let pictures: typeof import("../lib/server/aiAgent/orderImages.ts");
type OrderOnly = import("../lib/aiAgent/engine.ts").OrderOnlyProposal;
type Draft = import("../lib/aiAgent/engine.ts").OrderRequestDraft;
type MonitorInput = Parameters<Parameters<typeof import("../lib/server/aiAgent/model.ts").setOrderUpdateProposerForTests>[0] & {}>[0];

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));

const monitorCalls: MonitorInput[] = [];
let monitorScript: (input: MonitorInput) => OrderOnly | null = () => ({ intent: "other", order_request: null, staff_action: null });
const draft = (over: Partial<Draft> = {}): Draft => ({ items: [{ product: "Monello Chicken", quantity: "2", variant: null, size: "15kg" }], delivery_address: null, delivery_preference: null, notes: null, requested_for: null, ...over });

async function configure(over: Record<string, string | number | boolean | null | string[]> = {}) {
  const settings = {
    enabled: true, mode: "observe", contact_scope: "none", staff_group_jid: GROUP, staff_notices_enabled: false, customer_memory_enabled: false,
    batching_enabled: false, auto_takeover_minutes: 0, default_customer_mode: "staff_first", staff_authorized_senders: ["17585550001"],
    orders_tracking_enabled: true, orders_summary_enabled: true, orders_group_jid: null, orders_timezone: "America/St_Lucia", orders_summary_hour: 8,
    orders_customer_confirms: false, orders_tracking_since: null, ...over,
  };
  const set = Object.entries(settings)
    .map(([k, v]) => `${k} = ${v === null ? "null" : Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`)
    .join(", ");
  await pg.run(`update public.ai_agent_settings set ${set} where business_slug = 'dog_food';`);
}

/** A stored message exactly as the bridge saves it, then the same message forwarded to the Inbox (what the bridge does). */
async function deliver(c: Customer, who: "customer" | "staff", text: string, at: string, opts: { id?: string; media?: { type: string; file: string; biz?: string }; quotes?: string } = {}) {
  const id = opts.id ?? `M-${++seq}`;
  const mediaUrl = opts.media ? `${MEDIA}/media/${opts.media.biz ?? "dog_food"}/${opts.media.file}` : null;
  const raw = opts.quotes ? JSON.stringify({ message: { extendedTextMessage: { contextInfo: { stanzaId: opts.quotes } } } }) : JSON.stringify({});
  await pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, contact_number, direction, message_type, message_body, media_url, whatsapp_message_id, timestamp, raw)
                values ('dog_food', ${lit(c.chat)}, ${lit(c.phone)}, ${lit(who === "customer" ? "inbound" : "outbound")}, ${lit(opts.media?.type ?? "text")}, ${lit(text)}, ${mediaUrl ? lit(mediaUrl) : "null"}, ${lit(id)}, ${lit(at)}, ${lit(raw)}::jsonb);`);
  return decide.processBridgeMessage({
    businessSlug: "dog_food", whatsappMessageId: id, chatId: c.chat, contactNumber: c.phone, fromMe: who === "staff", text, hasMedia: Boolean(opts.media),
    quotedMessageId: opts.quotes ?? null, senderJid: null, timestamp: at,
  });
}
const allOrders = () => rows<Record<string, any>>(`select * from public.ai_agent_orders order by created_at, id`);
const orderEvents = () => rows<Record<string, any>>(`select * from public.ai_agent_order_events order by created_at, id`);
const lastReasons = async (chat: string) => (await rows<{ reason_codes: string[] }>(`select reason_codes from public.ai_agent_events where chat_id = ${lit(chat)} order by created_at, id`)).at(-1)?.reason_codes ?? [];
const anyOutbox = () => count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay','staff_draft')`);
const reportText = async (view: "all" | "today" | "tomorrow" | "review" = "all", now = new Date("2026-10-27T16:00:00Z")) => {
  const settings = (await dbmod.loadSettings("dog_food"))!;
  const all = await orders.loadOutstandingOrders("dog_food");
  const { buildOrdersView } = await import("../lib/aiAgent/orderViews.ts");
  return buildOrdersView({ view: { type: view }, orders: all, now, timezone: settings.orders_timezone || "America/St_Lucia" }).parts.join("\n");
};

describe("Order understanding (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
  before(async () => {
    pg = await TestPg.start();
    await pg.run(`
      create table public.whatsapp_messages (
        id bigserial primary key, business_slug text, chat_id text, contact_number text, direction text, message_type text,
        message_body text, media_url text, whatsapp_message_id text, timestamp timestamptz default now(), raw jsonb
      );`);
    process.env.WHATSAPP_MEDIA_ORIGIN = MEDIA;
    dbmod = await import("../lib/server/aiAgent/db.ts");
    dbmod.setAgentDbForTests(pgSupabase(pg) as never);
    decide = await import("../lib/server/aiAgent/decide.ts");
    orders = await import("../lib/server/aiAgent/orders.ts");
    model = await import("../lib/server/aiAgent/model.ts");
    pictures = await import("../lib/server/aiAgent/orderImages.ts");
    model.setOrderUpdateProposerForTests(async (input) => {
      monitorCalls.push(input);
      const proposal = monitorScript(input);
      return proposal ? { proposal, model: "scripted-small", error: null } : { proposal: null, model: "scripted-small", error: "model unavailable" };
    });
  });
  after(() => {
    model?.setOrderUpdateProposerForTests(null);
    pictures?.setPictureReaderForTests(null);
    dbmod?.setAgentDbForTests(null);
    delete process.env.WHATSAPP_MEDIA_ORIGIN;
    pg?.stop();
  });

  beforeEach(async () => {
    await pg.run(`
      truncate public.ai_agent_orders, public.ai_agent_order_summary_runs, public.ai_agent_order_update_posts, public.ai_agent_escalations,
        public.ai_agent_outbox, public.ai_agent_events, public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules,
        public.ai_agent_order_requests, public.whatsapp_messages cascade;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none', staff_group_jid = null, orders_tracking_enabled = false;`);
    await configure();
    monitorCalls.length = 0;
    monitorScript = () => ({ intent: "other", order_request: null, staff_action: null });
    pictures.setPictureReaderForTests(null);
  });

  // ── #JXBDS: invoice and clarification talk is not an order ──────────────────

  test("invoice talk never becomes an order, even when the model reads products and quantities in it", async () => {
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: '3" tablets', quantity: "1" }, { product: "chlorine powder", quantity: "1" }] }), order_target: "new", staff_action: null });
    await deliver(SOCO, "customer", 'Can you send the invoice for the 3" tablets and chlorine powder - one pail each', "2026-10-27T13:13:41Z");
    assert.equal((await allOrders()).length, 0, "no order");
    assert.ok((await lastReasons(SOCO.chat)).includes("order_not_created_non_order"));
    assert.equal(await anyOutbox(), 0);
  });

  test("#JXBDS: 'It is 3\" tablets and chlorine powder - one pail each' is held for review: kept, but on no delivery list", async () => {
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: '3" tablets', quantity: "1" }, { product: "chlorine powder", quantity: "1" }] }), order_target: "new", staff_action: null });
    await deliver(SOCO, "customer", "Morning", "2026-10-27T13:11:00Z");
    await deliver(SOCO, "customer", 'It is 3" tablests  and chlorine powder- one pail each', "2026-10-27T13:13:41Z");
    const [o] = await allOrders();
    assert.ok(o, "the message is kept for staff to look at");
    assert.equal(o.attention, "review_order_intent");
    assert.ok((await lastReasons(SOCO.chat)).includes("order_held_for_review"));
    for (const view of ["today", "tomorrow", "all"] as const) {
      const text = await reportText(view);
      assert.ok(!/3" tablets/.test(text.split("MIGHT NOT BE AN ORDER")[0]), `${view}: not on a delivery list`);
    }
    assert.match(await reportText("review"), /POSSIBLE ORDERS TO REVIEW[\s\S]*chlorine powder/);
  });

  test("a real order after invoice talk is still an order, and staff confirming a held order releases it", async () => {
    monitorScript = () => ({ intent: "order", order_request: draft({ delivery_address: "Cap Estate" }), order_target: "new", staff_action: null });
    await deliver(SOCO, "staff", "I will email the invoice now", "2026-10-27T13:00:00Z");
    await deliver(SOCO, "customer", "Please bring 2 bags of Monello 15kg to Cap Estate", "2026-10-27T13:02:00Z");
    const [o] = await allOrders();
    assert.equal(o.attention, null, "an explicit request is an order whatever was said before");
  });

  // ── #KBNYW: a photo, a staff offer, a yes ──────────────────────────────────

  const IMG = "1793113229713-AC39EF485DC922CF4E49486250ADA921.jpg";
  const readsBandit = async (url: string) => {
    readerCalls.push(url);
    return { text: JSON.stringify({ kind: "product", visible_text: ["Bandit", "OMEGA 6", "25kg"], product: "Bandit", size: "25kg" }) };
  };
  const readerCalls: string[] = [];

  test("#KBNYW: the photo under 'This one 55lbs' is read once and grounds the product; a staff offer is not a date, the customer's yes to it is", async () => {
    readerCalls.length = 0;
    pictures.setPictureReaderForTests(readsBandit);
    // The order reader sees the label, and answers from it only because the customer's words point at the picture.
    monitorScript = (input) =>
      /label reads/.test(input.newMessages)
        ? { intent: "order", order_request: draft({ items: [{ product: "Bandit", quantity: null, variant: null, size: "55lbs" }], requested_for: null }), order_target: "new", staff_action: null }
        : { intent: "order", order_request: draft({ items: [{ product: "This one", quantity: null, variant: null, size: "55lbs" }] }), order_target: "new", staff_action: null };
    await deliver(MAddie, "customer", "This one 55lbs", "2026-10-27T15:00:10Z", { id: "AC39", media: { type: "image", file: IMG } });
    assert.equal(readerCalls.length, 1, "one picture, one read");
    assert.match(monitorCalls[0].newMessages, /photo — label reads: “Bandit”, “OMEGA 6”, “25kg”/);
    let [o] = await allOrders();
    assert.equal(o.items[0].product, "Bandit", "the product comes from the label, not from 'This one'");
    assert.equal(o.items[0].quantity, null, "a quantity is never read from a picture");
    assert.equal(o.attention, null, "the model read an order and nothing says otherwise");
    assert.equal(o.requested_for, "Wed 28 Oct (default)", "no day was given: the existing 9 AM default, written 10:59 local → tomorrow");

    // Staff offer delivery and a day. Offers change nothing.
    await deliver(MAddie, "staff", "Yes we can deliver the dog food", "2026-10-27T15:01:05Z", { id: "S1" });
    await deliver(MAddie, "staff", "It’ll have to be tomorrow as our driver leaves at 9am every morning for deliveries", "2026-10-27T15:01:10Z", { id: "S2" });
    await deliver(MAddie, "staff", "Would you like us to put you down for tomorrow", "2026-10-27T15:01:20Z", { id: "2A24C915" });
    [o] = await allOrders();
    assert.equal(o.requested_for, "Wed 28 Oct (default)", "an offer is not an agreement");
    assert.equal((await orderEvents()).filter((e) => e.kind === "delivery_day_agreed").length, 0);

    // The customer accepts, quoting the offer.
    await deliver(MAddie, "customer", "Yes sure", "2026-10-27T15:05:00Z", { id: "ACDA", quotes: "2A24C915" });
    [o] = await allOrders();
    assert.equal(o.requested_for, "Wed 28 Oct", "tomorrow counted from the STAFF message, in Saint Lucia time: now a stated day, not a default");
    const agreed = (await orderEvents()).find((e) => e.kind === "delivery_day_agreed");
    assert.ok(agreed, "recorded in the order's history");
    assert.equal(agreed.changes.date_source.after.source, "staff_offer_accepted");
    assert.equal(agreed.changes.date_source.after.staff_message_id, "2A24C915");
    // The report shows the date only: nothing about where it came from.
    const tomorrow = await reportText("tomorrow");
    assert.match(tomorrow, /Bandit/);
    assert.doesNotMatch(tomorrow, /default|agreed|staff said|offer/i);
    assert.equal(await anyOutbox(), 0, "nothing was sent to anyone");
    // A redelivered "Yes sure" changes nothing.
    const versionBefore = (await allOrders())[0].version;
    await decide.processBridgeMessage({ businessSlug: "dog_food", whatsappMessageId: "ACDA", chatId: MAddie.chat, contactNumber: MAddie.phone, fromMe: false, text: "Yes sure", hasMedia: false, quotedMessageId: "2A24C915", senderJid: null, timestamp: "2026-10-27T15:05:00Z" });
    assert.equal((await allOrders())[0].version, versionBefore);
  });

  test("an order held for review is released when staff offer delivery and the customer accepts", async () => {
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: '3" tablets', quantity: "1" }, { product: "chlorine powder", quantity: "1" }] }), order_target: "new", staff_action: null });
    await deliver(SOCO, "staff", "Which product is it you need?", "2026-10-27T13:12:00Z");
    await deliver(SOCO, "customer", 'It is 3" tablets and chlorine powder - one pail each', "2026-10-27T13:13:41Z");
    assert.equal((await allOrders())[0].attention, "review_order_intent");
    monitorScript = () => ({ intent: "other", order_request: null, staff_action: null });
    await deliver(SOCO, "staff", "We can deliver those, shall we put you down for tomorrow?", "2026-10-27T13:20:00Z", { id: "OFFER" });
    await deliver(SOCO, "customer", "Yes please", "2026-10-27T13:22:00Z", { id: "YES" });
    const [o] = await allOrders();
    assert.equal(o.attention, null, "released");
    assert.equal(o.requested_for, "Wed 28 Oct");
    assert.match(await reportText("tomorrow"), /chlorine powder/);
  });

  test("a picture that cannot be read gives no product, and is not retried forever", async () => {
    readerCalls.length = 0;
    pictures.setPictureReaderForTests(async (url) => {
      readerCalls.push(url);
      return { error: "media_404" };
    });
    monitorScript = (input) => ({ intent: "order", order_request: draft({ items: [{ product: "This one", quantity: null, variant: null, size: null }] }), order_target: "new", staff_action: null });
    await deliver(MAddie, "customer", "This one please 55lbs", "2026-10-27T15:00:10Z", { id: "IMG1", media: { type: "image", file: IMG } });
    assert.match(monitorCalls[0].newMessages, /photo — not read/, "the order reader is told it saw nothing");
    assert.doesNotMatch(monitorCalls[0].newMessages, /label reads/);
    const [o] = await allOrders();
    assert.equal(o.items[0].product, "This one", "nothing is invented from an unreadable picture");
    assert.equal(o.attention, "review_order_intent");
  });

  test("a read picture is cached: later turns and replays never pay for it again", async () => {
    readerCalls.length = 0;
    pictures.setPictureReaderForTests(readsBandit);
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: "Bandit", quantity: "2", variant: null, size: null }] }), order_target: "new", staff_action: null });
    await deliver(MAddie, "customer", "this one", "2026-10-27T15:00:10Z", { id: "IMG2", media: { type: "image", file: IMG } });
    await deliver(MAddie, "customer", "2 of this one please", "2026-10-27T15:01:00Z");
    await deliver(MAddie, "customer", "the same as the picture", "2026-10-27T15:02:00Z");
    assert.equal(readerCalls.length, 1, "read once");
    assert.equal(await count(`select 1 from public.ai_agent_audit_log where action = 'orders.picture_read'`), 1);
  });

  test("another business's media folder, a wrong host or a picture nobody points at is never fetched", async () => {
    readerCalls.length = 0;
    pictures.setPictureReaderForTests(readsBandit);
    monitorScript = () => ({ intent: "order", order_request: draft(), order_target: "new", staff_action: null });
    await deliver(MAddie, "customer", "this one", "2026-10-27T15:00:10Z", { id: "OTHER", media: { type: "image", file: IMG, biz: "by_sea" } });
    await deliver(MAddie, "customer", "2 bags of Monello 15kg to Cap Estate Friday", "2026-10-27T15:00:50Z", { id: "NOPOINT", media: { type: "image", file: "other.jpg" } });
    // The reader stand-in is called only after the address passes the same check as production (allowedPictureUrl).
    assert.ok(!readerCalls.some((u) => u.includes("/by_sea/")), "never another business's folder");
    assert.ok(!readerCalls.some((u) => u.includes("other.jpg")), "a picture the words do not point at is left alone");
  });

  // ── Staff-committed days ────────────────────────────────────────────────────

  async function openOrder(at = "2026-10-27T14:00:00Z", over: Partial<Draft> = {}) {
    monitorScript = () => ({ intent: "order", order_request: draft({ delivery_address: "Cap Estate", ...over }), order_target: "new", staff_action: null });
    await deliver(MAddie, "customer", "I need 2 bags of Monello 15kg delivered to Cap Estate", at);
    monitorScript = () => ({ intent: "other", order_request: null, staff_action: null });
    return (await allOrders())[0];
  }

  test("a staff commitment sets the order's day from the staff message's own time; the order shows the date only", async () => {
    const before = await openOrder();
    const res = await deliver(MAddie, "staff", "We will deliver on Friday", "2026-10-27T14:05:00Z", { id: "S-FRI" });
    assert.deepEqual(res.outbox, []);
    const [o] = await allOrders();
    assert.equal(o.requested_for, "Fri 30 Oct");
    assert.equal(o.last_message_at, before.last_message_at, "a staff message is not customer activity");
    assert.equal(monitorCalls.length, 1, "decided by rules: no extra model call for the staff message");
    const ev = (await orderEvents()).find((e) => e.kind === "delivery_day_agreed");
    assert.ok(ev);
    assert.equal(ev.actor_kind, "staff");
    assert.equal(ev.changes.date_source.after.source, "staff_commitment");
    assert.match(await reportText("all", new Date("2026-10-28T15:00:00Z")), /Fri 30 Oct/);
  });

  test("a staff commitment to deliver releases an order held for review; talk about an invoice does not move a day", async () => {
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: '3" tablets', quantity: "1" }] }), order_target: "new", staff_action: null });
    await deliver(SOCO, "customer", 'It is 3" tablets - one pail', "2026-10-27T13:13:41Z");
    assert.equal((await allOrders())[0].attention, "review_order_intent");
    monitorScript = () => ({ intent: "other", order_request: null, staff_action: null });
    const day = (await allOrders())[0].requested_for;
    await deliver(SOCO, "staff", "We will send the invoice tomorrow", "2026-10-27T13:20:00Z");
    assert.equal((await allOrders())[0].requested_for, day);
    await deliver(SOCO, "staff", "We will deliver on Friday", "2026-10-27T13:25:00Z");
    const [o] = await allOrders();
    assert.equal(o.requested_for, "Fri 30 Oct");
    assert.equal(o.attention, null);
  });

  test("tentative offers, questions and refusals never move the day", async () => {
    await openOrder();
    const dayBefore = (await allOrders())[0].requested_for;
    for (const text of ["Can we deliver on Friday?", "We might be able to deliver tomorrow", "Hopefully we can deliver Saturday", "We can't deliver tomorrow", "We deliver every Friday"]) {
      await deliver(MAddie, "staff", text, "2026-10-27T14:05:00Z");
    }
    assert.equal((await allOrders())[0].requested_for, dayBefore);
  });

  test("a day staff edited is never overwritten, and a day set after the staff message is not either", async () => {
    await openOrder();
    await pg.run(`update public.ai_agent_orders set manual_locked_fields = array['requested_for'], requested_for = 'Mon 02 Nov' where true;`);
    await deliver(MAddie, "staff", "We will deliver tomorrow", "2026-10-27T14:05:00Z");
    assert.equal((await allOrders())[0].requested_for, "Mon 02 Nov", "staff-locked");
    assert.equal((await orderEvents()).filter((e) => e.kind === "delivery_day_agreed").length, 0);
  });

  test("timezone boundary: 'tomorrow' at 22:30 in Saint Lucia (02:30 UTC) is the next LOCAL day", async () => {
    await openOrder("2026-10-27T13:00:00Z");
    await deliver(MAddie, "staff", "We will deliver tomorrow", "2026-10-28T02:30:00Z");
    assert.equal((await allOrders())[0].requested_for, "Wed 28 Oct", "Tuesday 22:30 local → tomorrow is Wednesday, not Thursday");
  });

  test("with several open orders a staff commitment is not guessed onto one of them", async () => {
    await openOrder("2026-10-27T14:00:00Z");
    monitorScript = () => ({ intent: "order", order_request: draft({ items: [{ product: "Pedigree", quantity: "1" }], delivery_address: "Gros Islet" }), order_target: "new", staff_action: null });
    await deliver(MAddie, "customer", "Also a separate order: 1 Pedigree to Gros Islet please", "2026-10-27T14:02:00Z");
    assert.equal((await allOrders()).length, 2);
    monitorScript = () => ({ intent: "other", order_request: null, staff_action: null });
    const days = (await allOrders()).map((o) => o.requested_for);
    await deliver(MAddie, "staff", "We will deliver on Friday", "2026-10-27T14:05:00Z");
    assert.deepEqual((await allOrders()).map((o) => o.requested_for), days);
  });

  test("a redelivered staff message changes nothing the second time", async () => {
    await openOrder();
    await deliver(MAddie, "staff", "We will deliver on Friday", "2026-10-27T14:05:00Z", { id: "DUP" });
    const v = (await allOrders())[0].version;
    await decide.processBridgeMessage({ businessSlug: "dog_food", whatsappMessageId: "DUP", chatId: MAddie.chat, contactNumber: MAddie.phone, fromMe: true, text: "We will deliver on Friday", hasMedia: false, quotedMessageId: null, senderJid: null, timestamp: "2026-10-27T14:05:00Z" });
    assert.equal((await allOrders())[0].version, v);
  });
});
