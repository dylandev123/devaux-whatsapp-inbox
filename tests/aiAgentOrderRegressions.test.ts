// Regression tests for the real production messages of 2–3 Nov 2026 (orders O-MF9T2, O-G5LE3, O-EKM84, O-CR4PG) and the 8 AM report,
// through the app's REAL server code (processBridgeMessage → order tracking → report → outbox) against the REAL migrations in a throwaway
// Postgres (tests/helpers/pgHarness.ts). Only the language model is replaced by a scripted stand-in that returns what the real model
// returned in production (the faulty drafts), so these tests prove the SERVER now corrects them. Skips itself without Postgres binaries.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";
import { pgSupabase } from "./helpers/pgSupabase.ts";
import { formatOrderLine, defaultFormat } from "../lib/aiAgent/gdocFormat.ts";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

const GROUP = "120363000000000001@g.us";
const SEA_GROUP = "120363000000000002@g.us";
const ORDERS_GROUP = "120363000000000003@g.us";
const OTHER_GROUP = "120363000000000009@g.us";
const STAFF = "17585550001@s.whatsapp.net";
const STRANGER = "17585550999@s.whatsapp.net";

const GARY = { chat: "17587162997@s.whatsapp.net", phone: "17587162997", name: "Gary Devaux" };
const TARA = { chat: "17587190614@s.whatsapp.net", phone: "17587190614", name: "Tara" };
const SHOTMUN = { chat: "17587183149@s.whatsapp.net", phone: "17587183149", name: "Shotmun" };
type Customer = typeof GARY;

let pg: TestPg;
let decide: typeof import("../lib/server/aiAgent/decide.ts");
let orders: typeof import("../lib/server/aiAgent/orders.ts");
let outbox: typeof import("../lib/server/aiAgent/outbox.ts");
let model: typeof import("../lib/server/aiAgent/model.ts");
let dbmod: typeof import("../lib/server/aiAgent/db.ts");
type Proposal = import("../lib/aiAgent/engine.ts").ModelProposal;
type ProposeInput = Parameters<Parameters<typeof import("../lib/server/aiAgent/model.ts").setReplyProposerForTests>[0] & {}>[0];

let seq = 0;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
async function rows<T = Record<string, any>>(sql: string): Promise<T[]> {
  return JSON.parse((await pg.run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`)) || "[]");
}
const count = async (sql: string) => Number(await pg.run(`select count(*) from (${sql}) t;`));

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  decision: "ESCALATE",
  intent: "other",
  reply: null,
  confidence: 0.2,
  knowledge_ids: [],
  escalation_reason: "needs staff",
  priority: null,
  summary: null,
  order_request: null,
  memory_facts: [],
  ...over,
});
let script: (input: ProposeInput) => Proposal = () => proposal();
const modelCalls: ProposeInput[] = [];

type SettingValue = string | number | boolean | null | string[];
async function configure(over: Record<string, SettingValue> = {}, biz = "dog_food", group: string | null = GROUP) {
  const settings = {
    enabled: true,
    mode: "approval_pilot",
    contact_scope: "all",
    staff_group_jid: group,
    staff_notices_enabled: true,
    customer_memory_enabled: false,
    batching_enabled: false,
    auto_takeover_minutes: 0,
    default_customer_mode: "staff_first",
    staff_authorized_senders: ["17585550001"],
    orders_tracking_enabled: true,
    orders_summary_enabled: true,
    orders_group_jid: null,
    orders_timezone: "America/St_Lucia",
    orders_summary_hour: 8,
    orders_customer_confirms: false,
    orders_tracking_since: null,
    ...over,
  };
  const set = Object.entries(settings)
    .map(([k, v]) => `${k} = ${v === null ? "null" : Array.isArray(v) ? `array[${v.map(lit).join(",")}]::text[]` : typeof v === "string" ? lit(v) : v}`)
    .join(", ");
  await pg.run(`update public.ai_agent_settings set ${set} where business_slug = ${lit(biz)};`);
}
const settingsOf = async (biz = "dog_food") => (await dbmod.loadSettings(biz))!;

async function ackAll(items: { id: string; send: boolean }[]) {
  for (const item of items) if (item.send) await outbox.ackOutbox({ outboxId: item.id, status: "sent", whatsappMessageId: `WA-OUT-${++seq}`, error: null });
}

async function customerSays(c: Customer, text: string, opts: { biz?: string; id?: string } = {}) {
  const result = await decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food",
    whatsappMessageId: opts.id ?? `CUST-${++seq}`,
    chatId: c.chat,
    contactNumber: c.phone,
    fromMe: false,
    text,
    hasMedia: false,
    quotedMessageId: null,
    senderJid: null,
    timestamp: new Date().toISOString(),
  });
  await ackAll(result.outbox);
  return result;
}

async function groupSays(text: string, opts: { group?: string; sender?: string | null; biz?: string; id?: string } = {}) {
  const result = await decide.processBridgeMessage({
    businessSlug: opts.biz ?? "dog_food",
    whatsappMessageId: opts.id ?? `GRP-${++seq}`,
    chatId: opts.group ?? GROUP,
    contactNumber: null,
    fromMe: false,
    text,
    hasMedia: false,
    quotedMessageId: null,
    senderJid: opts.sender === undefined ? STAFF : opts.sender,
    senderPhone: null,
    timestamp: new Date().toISOString(),
  });
  return result;
}

type Draft = import("../lib/aiAgent/engine.ts").OrderRequestDraft;
const draft = (over: Partial<Draft> = {}): Draft => ({
  items: [{ product: "Monello Chicken", quantity: "2", size: "15kg" }],
  delivery_address: "12 Main St Gros Islet",
  delivery_preference: "delivery",
  notes: null,
  requested_for: "Friday morning",
  ...over,
});
/** The model proposes this order draft (and names the open order it belongs to, if any). */
const modelOrders = (d: Draft | null, extra: Partial<Proposal> = {}) => {
  script = () => proposal({ decision: "ESCALATE", intent: "order", order_request: d, summary: "order", ...extra });
};

const allOrders = (biz = "dog_food") => rows<Record<string, any>>(`select * from public.ai_agent_orders where business_slug = ${lit(biz)} order by created_at, id`);
const orderEvents = (orderId?: string) =>
  rows<Record<string, any>>(`select * from public.ai_agent_order_events${orderId ? ` where order_id = ${lit(orderId)}` : ""} order by created_at, id`);
const summaryOutbox = (biz = "dog_food") =>
  rows<Record<string, any>>(`select * from public.ai_agent_outbox where business_slug = ${lit(biz)} and dedupe_key like 'ordersummary:%' order by created_at, id`);
const runs = (biz = "dog_food") => rows<Record<string, any>>(`select * from public.ai_agent_order_summary_runs where business_slug = ${lit(biz)} order by created_at, id`);
const customerBound = () => count(`select 1 from public.ai_agent_outbox where kind in ('customer_reply','holding_reply','staff_relay')`);
/** A person (staff phone) writes to the customer: the proof that there was something to confirm. */
const staffWritesTo = (c: Customer, text: string) =>
  pg.run(`insert into public.whatsapp_messages (business_slug, chat_id, contact_number, direction, message_body, whatsapp_message_id, timestamp)
          values ('dog_food', ${lit(c.chat)}, ${lit(c.phone)}, 'outbound', ${lit(text)}, ${lit(`STAFFMSG-${++seq}`)}, now() + interval '1 second');`);


const GARY_MESSAGE = "Please put on this morning‘s delivery list. \n\nTamara Amos\n+1 (758) 484-7702\n1 Bandit 25kg (damaged)\n$155 Paid in store\nDeliver to Rodney Heights, building behind Dog Food St. Lucia.";
const LOUISE_MESSAGE = "Hi Richard\nWhen are you next in Soufriere \nNeed\n2 large bags Birbo Chicken for St Remy\n\n1 small Birbo Chicken for Narural at St Remy\n\nThanks\n\nLouise";
const ACID_MESSAGE = "Need 2 case acid 10 lbs cal hypo bill to anthony macnamara";

const BIZ = "dog_food";
const EIGHT_AM = new Date("2026-11-04T12:00:40Z"); // 08:00 in St Lucia
const lastModelInput = () => modelCalls[modelCalls.length - 1];
void lastModelInput;

describe("Order extraction and the 8 AM report: production regressions (real server code, real SQL)", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
  before(async () => {
    pg = await TestPg.start();
    await pg.run(`
      create table public.whatsapp_messages (
        id bigserial primary key, business_slug text, chat_id text, contact_number text, direction text,
        message_body text, whatsapp_message_id text, timestamp timestamptz default now()
      );
      create table public.customers (phone_number text primary key, first_name text, last_name text, whatsapp_name text, business_contact_name text);`);
    dbmod = await import("../lib/server/aiAgent/db.ts");
    dbmod.setAgentDbForTests(pgSupabase(pg) as never);
    decide = await import("../lib/server/aiAgent/decide.ts");
    orders = await import("../lib/server/aiAgent/orders.ts");
    outbox = await import("../lib/server/aiAgent/outbox.ts");
    model = await import("../lib/server/aiAgent/model.ts");
    model.setReplyProposerForTests(async (input) => {
      modelCalls.push(input);
      return { proposal: script(input), model: "scripted", error: null };
    });
  });
  after(() => {
    model?.setReplyProposerForTests(null);
    dbmod?.setAgentDbForTests(null);
    pg?.stop();
  });

  beforeEach(async () => {
    await pg.run(`
      truncate public.ai_agent_orders, public.ai_agent_order_summary_runs, public.ai_agent_order_update_posts, public.ai_agent_escalations, public.ai_agent_outbox,
        public.ai_agent_staff_answers, public.ai_agent_events, public.ai_agent_learning_candidates, public.ai_agent_knowledge,
        public.ai_agent_customer_memory, public.ai_agent_audit_log, public.ai_agent_conversations, public.ai_agent_contact_rules,
        public.ai_agent_order_requests, public.ai_agent_batches, public.ai_agent_batch_messages, public.ai_agent_pilot_drafts,
        public.ai_agent_shadow_results, public.whatsapp_messages, public.customers cascade;
      update public.ai_agent_settings set enabled = false, mode = 'observe', contact_scope = 'none', staff_group_jid = null,
        staff_notices_enabled = false, staff_authorized_senders = '{}', batching_enabled = false,
        orders_tracking_enabled = false, orders_summary_enabled = false, orders_group_jid = null,
        orders_timezone = 'America/St_Lucia', orders_summary_hour = 8, orders_customer_confirms = false, orders_tracking_since = null,
        south_locations = null;
      insert into public.customers (phone_number, whatsapp_name) values
        (${lit(GARY.phone)}, 'Gary Devaux'), (${lit(TARA.phone)}, 'Tara'), (${lit(SHOTMUN.phone)}, 'Shotmun');`);
    await configure({}, BIZ, GROUP);
    modelCalls.length = 0;
    script = () => proposal();
  });

  // ── 1. O-MF9T2: Gary Devaux orders for Tamara Amos ─────────────────────────

  describe("third-party order (Gary Devaux orders for Tamara Amos)", () => {
    // What the model returned in production (a profile-name-led draft), plus the recipient fields it was given.
    const garyDraft = (over: Partial<Draft> = {}): Draft => ({
      items: [{ product: "Bandit", quantity: "1", size: "25kg" }],
      delivery_address: "Rodney Heights, building behind Dog Food St. Lucia",
      delivery_preference: "delivery",
      notes: "damaged",
      requested_for: "this morning",
      customer_name: "Tamara Amos",
      contact_phone: "+1 (758) 484-7702",
      placed_for_other: true,
      ...over,
    });

    test("the delivery customer is the recipient; the sender is kept in the notes and their profile is untouched", async () => {
      modelOrders(garyDraft());
      await customerSays(GARY, GARY_MESSAGE, { biz: BIZ });
      const [o] = await allOrders(BIZ);
      assert.equal((await allOrders(BIZ)).length, 1);
      assert.equal(o.customer_name, "Tamara Amos");
      assert.equal(o.contact_number, "17584847702");
      assert.equal(o.delivery_address, "Rodney Heights, building behind Dog Food St. Lucia");
      assert.match(o.notes, /\$155 Paid in store/);
      assert.match(o.notes, /Placed by Gary Devaux \(\+17587162997\)/);
      assert.deepEqual(o.items, [{ product: "Bandit", quantity: "1", size: "25kg", variant: "damaged" }]);
      assert.doesNotMatch(o.notes, /^damaged/, "'damaged' describes the product, it is not a stray note");
      // The sender's own saved profile is exactly as it was, and no profile was invented for the recipient.
      assert.deepEqual(await rows(`select phone_number, whatsapp_name, first_name from public.customers order by phone_number`), [
        { phone_number: GARY.phone, whatsapp_name: "Gary Devaux", first_name: null },
        { phone_number: SHOTMUN.phone, whatsapp_name: "Shotmun", first_name: null },
        { phone_number: TARA.phone, whatsapp_name: "Tara", first_name: null },
      ]);
      // Staff read it under the recipient's name, not the sender's.
      const names = await orders.loadOrderNames(BIZ, [(await orders.loadOutstandingOrders(BIZ))[0]]);
      assert.equal(Object.values(names)[0]?.name, "Tamara Amos");
      // …and the Google Docs line leads with the location.
      const line = formatOrderLine(o as never, defaultFormat()).text;
      assert.match(line, /^Rodney Heights, building behind Dog Food St\. Lucia — Tamara Amos — \+1 \(758\) 484-7702 — 1 × Bandit \(damaged, 25kg\) — \$155 Paid in store · Placed by Gary Devaux \(\+17587162997\) — .*— #O-/);
    });

    test("even if the model returns nothing about the recipient, the name-and-number lines are read from the message", async () => {
      modelOrders(garyDraft({ customer_name: undefined, contact_phone: undefined, placed_for_other: undefined, notes: "$155 paid in store" }));
      await customerSays(GARY, GARY_MESSAGE, { biz: BIZ });
      const [o] = await allOrders(BIZ);
      assert.equal(o.customer_name, "Tamara Amos");
      assert.equal(o.contact_number, "17584847702");
      assert.match(o.notes, /Placed by Gary Devaux/);
    });

    test("a later message from the sender never replaces the recipient's name or number", async () => {
      modelOrders(garyDraft());
      await customerSays(GARY, GARY_MESSAGE, { biz: BIZ });
      modelOrders(garyDraft({ customer_name: undefined, contact_phone: undefined, placed_for_other: undefined, items: [{ product: "Bandit", quantity: "2", size: "25kg" }], notes: "damaged" }), { order_target: undefined });
      await customerSays(GARY, "Make it 2 please", { biz: BIZ });
      const all = await allOrders(BIZ);
      for (const o of all) {
        assert.equal(o.customer_name, "Tamara Amos");
        assert.equal(o.contact_number, "17584847702");
      }
    });

    test("the sender ordering for themselves is unchanged: their own name, their own number, nothing in the notes", async () => {
      modelOrders(garyDraft({ customer_name: undefined, contact_phone: undefined, placed_for_other: undefined, notes: null }));
      await customerSays(GARY, "1 Bandit 25kg please, deliver to Rodney Heights", { biz: BIZ });
      const [o] = await allOrders(BIZ);
      assert.equal(o.contact_number, GARY.phone);
      assert.doesNotMatch(o.notes ?? "", /Placed by/);
    });
  });

  // ── 2. O-G5LE3 + O-EKM84: Louise's South order ─────────────────────────────

  describe("South delivery with two product lines (Louise, signed; WhatsApp name Tara)", () => {
    // The production draft: two separate orders, each with the same place, and the model's guess at a day.
    const twoOrders = () => {
      const base = { delivery_address: "St Remy", delivery_preference: "delivery", notes: null, customer_name: "Louise" } satisfies Partial<Draft>;
      script = () =>
        proposal({
          decision: "ESCALATE",
          intent: "order",
          summary: "order",
          order_target: "new",
          order_request: { ...base, items: [{ product: "Birbo Chicken", quantity: "2", size: "large" }] },
          other_orders: [{ target: "new", order: { ...base, items: [{ product: "Birbo Chicken", quantity: "1", size: "small" }] } }],
        });
    };

    test("ONE order with both lines, marked South (Soufrière, St Remy), day pending, signed name kept apart from the WhatsApp name", async () => {
      twoOrders();
      await customerSays(TARA, LOUISE_MESSAGE, { biz: BIZ });
      const all = await allOrders(BIZ);
      assert.equal(all.length, 1, "one customer message is one order");
      const [o] = all;
      assert.deepEqual(o.items, [
        { product: "Birbo Chicken", quantity: "2", size: "large", variant: null },
        { product: "Birbo Chicken", quantity: "1", size: "small", variant: null },
      ]);
      assert.equal(o.delivery_address, "St Remy, Soufrière");
      assert.equal(o.requested_for, "Date to be confirmed (south)", "no Wednesday default for a south delivery");
      assert.equal(o.customer_name, "Tara", "the verified WhatsApp contact is not silently renamed");
      assert.match(o.notes, /Signed by Louise \(WhatsApp name: Tara\)/);
      assert.match(o.notes, /small Birbo Chicken for Narural/);
      assert.equal(o.contact_number, TARA.phone);
      // No profile was changed either.
      assert.deepEqual(await rows(`select first_name, last_name, whatsapp_name from public.customers where phone_number = ${lit(TARA.phone)}`), [{ first_name: null, last_name: null, whatsapp_name: "Tara" }]);
    });

    test("it is reported under South Deliveries (date to be confirmed), not under today or tomorrow, and the Docs line starts with SOUTH DELIVERY", async () => {
      twoOrders();
      await customerSays(TARA, LOUISE_MESSAGE, { biz: BIZ });
      const settings = await settingsOf(BIZ);
      for (const now of [new Date(), new Date(Date.now() + 30 * 3_600_000)]) {
        const report = (await orders.buildSummaryNow(settings, "manual", now)).text;
        assert.match(report, /South Deliveries\* — date to be confirmed \(1\)\n\n📍 \*Soufrière\* \(1\)/);
        assert.match(report, /2 × Birbo Chicken large; 1 × Birbo Chicken small/);
        assert.doesNotMatch(report, /overdue/i);
      }
      const [o] = await allOrders(BIZ);
      const line = formatOrderLine(o as never, defaultFormat()).text;
      assert.match(line, /^SOUTH DELIVERY — St Remy, Soufrière — Tara — \+1 \(758\) 719-0614 — 2 × Birbo Chicken \(large\), 1 × Birbo Chicken \(small\) — .*Signed by Louise \(WhatsApp name: Tara\).* — Date to be confirmed — #O-/);
    });

    test("a model that already returned one good order gets the same result (no double handling)", async () => {
      modelOrders({ items: [{ product: "Birbo Chicken", quantity: "2", size: "large" }, { product: "Birbo Chicken", quantity: "1", size: "small" }], delivery_address: "St Remy", delivery_preference: "delivery", notes: null, requested_for: "when next in Soufriere" });
      await customerSays(TARA, LOUISE_MESSAGE, { biz: BIZ });
      const all = await allOrders(BIZ);
      assert.equal(all.length, 1);
      assert.equal(all[0].items.length, 2);
      assert.match(all[0].requested_for, /^Date to be confirmed \(south/, "a question about when you are next in Soufrière is not a delivery date");
    });

    test("staff can still set the real day, and then it is an ordinary dated south order", async () => {
      twoOrders();
      await customerSays(TARA, LOUISE_MESSAGE, { biz: BIZ });
      const [o] = await allOrders(BIZ);
      const res = await orders.updateOrderManually({ businessSlug: BIZ, orderId: o.id, adminId: "u", action: "edit", patch: { requested_for: "Thu 5 Nov" } });
      assert.ok(res.ok, JSON.stringify(res));
      const text = (await orders.buildSummaryNow(await settingsOf(BIZ), "manual", new Date("2026-11-04T17:00:00Z"))).text;
      assert.match(text, /TOMORROW — Thu 5 Nov\* \(1\)[\s\S]*South Deliveries/);
      assert.doesNotMatch(text, /date to be confirmed/);
    });

    test("two different places in one message stay two deliveries", async () => {
      script = () =>
        proposal({
          decision: "ESCALATE",
          intent: "order",
          summary: "order",
          order_target: "new",
          order_request: { items: [{ product: "Birbo Chicken", quantity: "2" }], delivery_address: "Vieux Fort", delivery_preference: "delivery", notes: null },
          other_orders: [{ target: "new", order: { items: [{ product: "Monello", quantity: "1" }], delivery_address: "Gros Islet", delivery_preference: "delivery", notes: null } }],
        });
      await customerSays(TARA, "2 bags Birbo Chicken for Vieux Fort and 1 Monello for Gros Islet", { biz: BIZ });
      assert.equal((await allOrders(BIZ)).length, 2);
    });
  });

  // ── 3. O-CR4PG: quantity vs package size, billing ──────────────────────────

  describe("quantities, package sizes and billing (Shotmun)", () => {
    const acidScript = () =>
      modelOrders({
        items: [{ product: "acid", quantity: "2", size: "case" }, { product: "cal hypo", quantity: "2", size: "10 lbs" }],
        delivery_address: null,
        delivery_preference: null,
        notes: null,
      });

    test("2 cases acid, ONE 10 lb cal hypo, billing instruction kept, not a quantity", async () => {
      acidScript();
      await customerSays(SHOTMUN, ACID_MESSAGE, { biz: BIZ });
      const [o] = await allOrders(BIZ);
      assert.deepEqual(o.items, [
        { product: "acid", quantity: "2", size: "case", variant: null },
        { product: "cal hypo", quantity: "1", size: "10 lbs", variant: null },
      ]);
      assert.match(o.notes, /Bill to Anthony Macnamara/);
      assert.equal(o.customer_name, "Shotmun", "the bill-to name is not the customer");
    });

    test("a later 'have them call me' keeps the billing instruction", async () => {
      acidScript();
      await customerSays(SHOTMUN, ACID_MESSAGE, { biz: BIZ });
      script = () => proposal({ decision: "ESCALATE", intent: "order", summary: "order", order_request: { items: [{ product: "acid", quantity: "2", size: "case" }, { product: "cal hypo", quantity: "1", size: "10 lbs" }], delivery_address: null, delivery_preference: null, notes: "have them call me" } });
      await customerSays(SHOTMUN, "Have them call me", { biz: BIZ });
      const [o] = await allOrders(BIZ);
      assert.match(o.notes, /have them call me/);
      assert.match(o.notes, /Bill to Anthony Macnamara/);
      assert.equal(o.items[1].quantity, "1");
    });
  });

  // ── 4. The 8 AM report ─────────────────────────────────────────────────────

  describe("8 AM report: fresh data, Saint Lucia date, no duplicates, no stale post", () => {
    const seed = (ref: string, over: { created: string; requested_for: string; status?: string; address?: string; name?: string }) =>
      pg.run(`insert into public.ai_agent_orders (business_slug, ref_code, chat_id, contact_number, customer_name, status, items, fulfilment_method, delivery_address, requested_for, first_message_at, last_message_at, created_at, updated_at)
              values (${lit(BIZ)}, ${lit(ref)}, ${lit(`${ref}@s.whatsapp.net`)}, '17585550123', ${lit(over.name ?? ref)}, ${lit(over.status ?? "awaiting_confirmation")}, '[{"product":"Monello","quantity":"1","variant":null,"size":null}]'::jsonb,
                      'delivery', ${lit(over.address ?? "Gros Islet")}, ${lit(over.requested_for)}, ${lit(over.created)}, ${lit(over.created)}, ${lit(over.created)}, ${lit(over.created)});`);

    test("the scheduled report and a later !orders use the same fresh query; an order that arrived after 8:00 is not an omission", async () => {
      await seed("O-BEFOR", { created: "2026-11-03T20:00:00Z", requested_for: "Wed 4 Nov (today)", name: "Before" });
      await seed("O-DONE1", { created: "2026-11-03T20:00:00Z", requested_for: "Wed 4 Nov (today)", status: "fulfilled", name: "Finished" });
      await seed("O-CANC1", { created: "2026-11-03T20:00:00Z", requested_for: "Wed 4 Nov (today)", status: "cancelled", name: "Cancelled" });
      const settings = await settingsOf(BIZ);
      assert.equal(await orders.runScheduledSummary(settings, EIGHT_AM), "sent");
      const [morning] = await summaryOutbox(BIZ);
      assert.match(morning.body, /ORDERS — Wed 4 Nov\*\n🕗 Generated Wed 4 Nov, 8:00 AM/);
      assert.match(morning.body, /Before · #BEFOR/);
      assert.doesNotMatch(morning.body, /#DONE1|#CANC1|Finished|Cancelled/, "completed and cancelled orders are not outstanding");
      // These arrive AFTER the report was generated (8:14 and 8:46 local): they cannot be in it, and are in the next one.
      await seed("O-LATE1", { created: "2026-11-04T12:14:06Z", requested_for: "Wed 4 Nov (today)", name: "Late" });
      await seed("O-VFORT", { created: "2026-11-04T12:46:17Z", requested_for: "Wed 4 Nov (today)", address: "Hewanorra House", name: "Gilles" });
      assert.doesNotMatch(morning.body, /LATE1|VFORT/);
      const later = (await orders.buildSummaryNow(settings, "manual", new Date("2026-11-04T17:22:31Z"))).text;
      assert.match(later, /Generated Wed 4 Nov, 1:22 PM/);
      assert.match(later, /Late · #LATE1/);
      assert.match(later, /South Deliveries\*[\s\S]*Vieux Fort[\s\S]*Gilles · #VFORT/);
      // The report body stored for the morning is a snapshot of that moment, not of the database at claim time.
      assert.equal((await summaryOutbox(BIZ)).length, 1);
    });

    test("the day is the Saint Lucia day, not the UTC day (9 PM Tuesday there is already Wednesday in UTC)", async () => {
      await seed("O-TUESD", { created: "2026-11-03T20:00:00Z", requested_for: "Tue 3 Nov (today)", name: "Tuesday" });
      const settings = await settingsOf(BIZ);
      const text = (await orders.buildSummaryNow(settings, "manual", new Date("2026-11-04T01:00:00Z"))).text; // 9 PM Tue 3 Nov, St Lucia
      assert.match(text, /ORDERS — Tue 3 Nov\*\n🕗 Generated Tue 3 Nov, 9:00 PM/);
      assert.match(text, /TODAY — Tue 3 Nov\* \(1\)/);
    });

    test("repeated, overlapping and restarted scheduler runs still post once", async () => {
      await seed("O-BEFOR", { created: "2026-11-03T20:00:00Z", requested_for: "Wed 4 Nov (today)" });
      const settings = await settingsOf(BIZ);
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => orders.runScheduledSummary(settings, EIGHT_AM)));
      assert.equal(outcomes.filter((o) => o === "sent").length, 1);
      await orders.runScheduledSummary(settings, new Date("2026-11-04T12:09:00Z"));
      assert.equal((await summaryOutbox(BIZ)).length, 1);
    });

    test("a report the bridge never collected is closed as not sent, never delivered hours late", async () => {
      await seed("O-BEFOR", { created: "2026-11-03T20:00:00Z", requested_for: "Wed 4 Nov (today)", name: "Before" });
      const settings = await settingsOf(BIZ);
      assert.equal(await orders.runScheduledSummary(settings, EIGHT_AM), "sent");
      // The bridge was offline: 25 minutes later nobody has collected it.
      await pg.run(`update public.ai_agent_outbox set created_at = now() - interval '25 minutes' where dedupe_key like 'ordersummary:%'`);
      const handedOut = await outbox.claimOutbox(BIZ, 20);
      assert.equal(handedOut.filter((i) => /ORDERS/.test(i.body)).length, 0, "the old list is not handed to the bridge");
      const [row] = await summaryOutbox(BIZ);
      assert.equal(row.status, "failed");
      assert.match(row.error, /^stale_reply:/);
      // Orders arrived meanwhile; the scheduler rebuilds a FRESH report from the database (same morning, inside the catch-up window).
      await seed("O-LATE1", { created: "2026-11-04T12:20:00Z", requested_for: "Wed 4 Nov (today)", name: "Late" });
      assert.equal(await orders.runScheduledSummary(settings, new Date("2026-11-04T12:30:00Z")), "retried");
      const fresh = (await summaryOutbox(BIZ)).filter((r) => r.status === "pending");
      assert.equal(fresh.length, 1);
      assert.match(fresh[0].body, /Generated Wed 4 Nov, 8:30 AM/);
      assert.match(fresh[0].body, /Late · #LATE1/);
      // Only the fresh one reaches the bridge.
      const items = await outbox.claimOutbox(BIZ, 20);
      assert.equal(items.filter((i) => /Late · #LATE1/.test(i.body)).length, 1);
    });

    test("outside the morning catch-up window a stale report is not re-posted; the day stays missed", async () => {
      await seed("O-BEFOR", { created: "2026-11-03T20:00:00Z", requested_for: "Wed 4 Nov (today)" });
      const settings = await settingsOf(BIZ);
      await orders.runScheduledSummary(settings, EIGHT_AM);
      await pg.run(`update public.ai_agent_outbox set created_at = now() - interval '25 minutes' where dedupe_key like 'ordersummary:%'`);
      await outbox.claimOutbox(BIZ, 20);
      assert.equal(await orders.runScheduledSummary(settings, new Date("2026-11-04T19:00:00Z")), "already_done"); // 3 PM
      assert.equal((await summaryOutbox(BIZ)).filter((r) => r.status === "pending").length, 0);
    });

    test("an old !orders answer waiting in the outbox is closed too, but ordinary messages are never touched", async () => {
      const group = GROUP;
      await pg.run(`insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, status, dedupe_key, created_at)
        values (${lit(BIZ)}, ${lit(group)}, 'staff_notice', ${lit(group)}, 'old list', 'pending', 'ordersview:dog_food:X:p1', now() - interval '40 minutes'),
               (${lit(BIZ)}, ${lit(group)}, 'staff_notice', ${lit(group)}, 'plain notice', 'pending', 'some-notice', now() - interval '40 minutes');`);
      const items = await outbox.claimOutbox(BIZ, 20);
      assert.deepEqual(items.map((i) => i.body), ["plain notice"]);
    });

    test("no customer is ever messaged by any of this", async () => {
      modelOrders({ items: [{ product: "acid", quantity: "2", size: "case" }], delivery_address: null, delivery_preference: null, notes: null });
      await customerSays(SHOTMUN, ACID_MESSAGE, { biz: BIZ });
      assert.equal(await customerBound(), 0);
    });
  });
});
