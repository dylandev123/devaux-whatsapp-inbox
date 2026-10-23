// Batching against the REAL SQL (supabase/migrations/20261025000000_*): quiet
// period resets, the maximum-wait ceiling, duplicate deliveries, concurrent
// enqueues and workers, worker restarts (expired leases), messages arriving
// mid-processing, business isolation and customer deletion. Runs on a
// throwaway local Postgres (tests/helpers/pgHarness.ts) and skips when no
// Postgres binaries are installed.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { pgAvailable, TestPg } from "./helpers/pgHarness.ts";

const BIZ = "dog_food";
const OTHER = "by_sea";
const CHAT = "17585551234@s.whatsapp.net";

let pg: TestPg;
let n = 0;

const lit = (v: string | null) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`);

function enqueue(opts: { biz?: string; chat?: string; id?: string; text?: string; media?: boolean; at?: string | null } = {}): string {
  const id = opts.id ?? `MSG${++n}`;
  return `select batch_id, due_at, max_due_at, message_count, duplicate from public.enqueue_ai_agent_batch_message(
    ${lit(opts.biz ?? BIZ)}, ${lit(opts.chat ?? CHAT)}, '17585551234', ${lit(id)}, null, ${lit(opts.text ?? "hello")},
    ${opts.media ?? false}, ${opts.at === undefined ? "null" : lit(opts.at)});`;
}

async function settings(biz: string, quiet: number, max: number): Promise<void> {
  await pg.run(
    `update public.ai_agent_settings set batching_enabled = true, batch_quiet_seconds = ${quiet}, batch_max_wait_seconds = ${max} where business_slug = ${lit(biz)};`
  );
}

/** Seconds from now() until a timestamptz, rounded. */
const secs = (col: string) => `round(extract(epoch from (${col} - now())))`;

async function reset(): Promise<void> {
  await pg.run("truncate public.ai_agent_batches cascade; truncate public.ai_agent_events;");
  await settings(BIZ, 45, 180);
  await settings(OTHER, 45, 180);
}

describe("batching SQL", { skip: !pgAvailable && "PostgreSQL binaries not installed" }, () => {
  before(async () => {
    pg = await TestPg.start();
  });
  after(() => pg?.stop());

  test("settings default: batching OFF, 45s quiet, 180s max, memory capture OFF", async () => {
    const row = await pg.run(
      "select batching_enabled, batch_quiet_seconds, batch_max_wait_seconds, customer_memory_enabled from public.ai_agent_settings where business_slug = 'dog_food';"
    );
    assert.equal(row, "f|45|180|f");
  });

  test("settings reject out-of-range windows", async () => {
    await assert.rejects(pg.run("update public.ai_agent_settings set batch_quiet_seconds = 121 where business_slug = 'dog_food';"));
    await assert.rejects(pg.run("update public.ai_agent_settings set batch_quiet_seconds = -1 where business_slug = 'dog_food';"));
    await assert.rejects(
      pg.run("update public.ai_agent_settings set batch_quiet_seconds = 100, batch_max_wait_seconds = 60 where business_slug = 'dog_food';")
    );
    await assert.doesNotReject(
      pg.run("update public.ai_agent_settings set batch_quiet_seconds = 0, batch_max_wait_seconds = 10 where business_slug = 'dog_food';")
    );
    await settings(BIZ, 45, 180);
  });

  test("first message opens a batch due after the quiet period", async () => {
    await reset();
    const [, due, , count, dup] = (await pg.run(enqueue())).split("|");
    assert.equal(count, "1");
    assert.equal(dup, "f");
    const left = await pg.run(`select ${secs("due_at")} from public.ai_agent_batches;`);
    assert.ok(Number(left) >= 44 && Number(left) <= 45, `due in ${left}s (${due})`);
  });

  test("each new message resets the quiet-period deadline", async () => {
    await reset();
    await pg.run(enqueue());
    // Pretend 40 s have passed: the deadline is only 5 s away.
    await pg.run("update public.ai_agent_batches set due_at = now() + interval '5 seconds';");
    const out = await pg.run(enqueue());
    assert.equal(out.split("|")[3], "2");
    const left = Number(await pg.run(`select ${secs("due_at")} from public.ai_agent_batches;`));
    assert.ok(left >= 44 && left <= 45, `deadline reset to ${left}s`);
  });

  test("the deadline never extends past the maximum wait", async () => {
    await reset();
    await pg.run(enqueue());
    // 175 s into a 180 s maximum: only 5 s of ceiling remain.
    await pg.run("update public.ai_agent_batches set max_due_at = now() + interval '5 seconds', due_at = now() + interval '2 seconds';");
    await pg.run(enqueue());
    const left = Number(await pg.run(`select ${secs("due_at")} from public.ai_agent_batches;`));
    assert.ok(left <= 5, `capped at the ceiling, got ${left}s`);
    // And the ceiling itself is first message + max wait, set once.
    const maxLeft = Number(await pg.run(`select ${secs("max_due_at")} from public.ai_agent_batches;`));
    assert.ok(maxLeft <= 5);
  });

  test("a quiet period of 0 makes the batch due immediately", async () => {
    await reset();
    await settings(BIZ, 0, 180);
    await pg.run(enqueue());
    const claimed = await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w1');");
    assert.equal(claimed, "1");
  });

  test("a duplicate webhook delivery changes nothing", async () => {
    await reset();
    await pg.run(enqueue({ id: "DUP1" }));
    await pg.run("update public.ai_agent_batches set due_at = now() + interval '5 seconds';");
    const out = (await pg.run(enqueue({ id: "DUP1" }))).split("|");
    assert.equal(out[4], "t");
    assert.equal(out[3], "1");
    assert.equal(await pg.run("select count(*) from public.ai_agent_batch_messages;"), "1");
    // The duplicate must not push the deadline back either.
    const left = Number(await pg.run(`select ${secs("due_at")} from public.ai_agent_batches;`));
    assert.ok(left <= 5, `duplicate reset the timer to ${left}s`);
  });

  test("the same message delivered concurrently is stored once", async () => {
    await reset();
    const results = await pg.parallel(Array.from({ length: 10 }, () => enqueue({ id: "SIMULTANEOUS" })));
    const fresh = results.filter((r) => r.split("|")[4] === "f");
    assert.equal(fresh.length, 1, `exactly one delivery is the original: ${results.join(" / ")}`);
    assert.equal(await pg.run("select count(*) from public.ai_agent_batch_messages;"), "1");
    assert.equal(await pg.run("select message_count from public.ai_agent_batches;"), "1");
  });

  test("concurrent enqueues for one chat end up in exactly one batch", async () => {
    await reset();
    const results = await pg.parallel(Array.from({ length: 24 }, (_, i) => enqueue({ id: `C${i}` })));
    assert.equal(results.length, 24);
    assert.equal(await pg.run("select count(*) from public.ai_agent_batches where status = 'collecting';"), "1");
    assert.equal(await pg.run("select message_count from public.ai_agent_batches;"), "24");
    assert.equal(await pg.run("select count(*) from public.ai_agent_batch_messages;"), "24");
  });

  test("not-yet-due batches are not claimed; due ones are claimed once", async () => {
    await reset();
    await pg.run(enqueue());
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w1');"), "0");
    await pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second';");
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w1');"), "1");
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w2');"), "0");
    assert.equal(await pg.run("select status, attempts, worker_id from public.ai_agent_batches;"), "processing|1|w1");
  });

  test("concurrent workers: a due batch is claimed by exactly one", async () => {
    for (let round = 0; round < 5; round += 1) {
      await reset();
      await pg.run(enqueue());
      await pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second';");
      const claims = await pg.parallel(Array.from({ length: 8 }, (_, i) => `select count(*) from public.claim_ai_agent_batches(5, 'w${i}');`));
      assert.equal(claims.filter((c) => c === "1").length, 1, `round ${round}: ${claims.join(",")}`);
    }
  });

  test("concurrent workers split many due batches without overlap", async () => {
    await reset();
    for (let i = 0; i < 12; i += 1) await pg.run(enqueue({ chat: `1758555${1000 + i}@s.whatsapp.net` }));
    await pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second';");
    const claims = await pg.parallel(Array.from({ length: 6 }, (_, i) => `select id from public.claim_ai_agent_batches(3, 'w${i}');`));
    const ids = claims.flatMap((c) => c.split("\n").filter(Boolean));
    assert.equal(new Set(ids).size, ids.length, "a batch was handed to two workers");
    assert.equal(ids.length, 12);
  });

  test("worker restart: an expired lease is re-claimed; a live lease is not", async () => {
    await reset();
    await pg.run(enqueue());
    await pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second';");
    await pg.run("select * from public.claim_ai_agent_batches(5, 'crashed');");
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w2');"), "0", "live lease must not be stolen");
    await pg.run("update public.ai_agent_batches set lease_until = now() - interval '1 second';");
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w2');"), "1");
    assert.equal(await pg.run("select attempts, worker_id from public.ai_agent_batches;"), "2|w2");
    // The crashed worker can no longer finish it.
    const stale = await pg.run(`select public.complete_ai_agent_batch((select id from public.ai_agent_batches), 'crashed', 'done', 'REPLY', null);`);
    assert.equal(stale, "f");
    const ok = await pg.run(`select public.complete_ai_agent_batch((select id from public.ai_agent_batches), 'w2', 'done', 'REPLY', null);`);
    assert.equal(ok, "t");
  });

  test("a batch that keeps failing stops after the attempt cap", async () => {
    await reset();
    await pg.run(enqueue());
    await pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second';");
    for (let i = 0; i < 4; i += 1) {
      await pg.run("select * from public.claim_ai_agent_batches(5, 'w', 150, 4);");
      await pg.run("update public.ai_agent_batches set lease_until = now() - interval '1 second';");
    }
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w', 150, 4);"), "0");
    assert.equal(await pg.run("select status, error from public.ai_agent_batches;"), "failed|max_attempts_exceeded");
  });

  test("release keeps the batch for a later retry, not an immediate one", async () => {
    await reset();
    await pg.run(enqueue());
    await pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second';");
    await pg.run("select * from public.claim_ai_agent_batches(5, 'w1');");
    await pg.run(`select public.release_ai_agent_batch((select id from public.ai_agent_batches), 'w1', 'model timeout', 30);`);
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w2');"), "0");
    await pg.run("update public.ai_agent_batches set lease_until = now() - interval '1 second';");
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w2');"), "1");
  });

  test("a message arriving mid-processing opens a NEW batch and is not merged", async () => {
    await reset();
    await pg.run(enqueue({ id: "A1" }));
    await pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second';");
    await pg.run("select * from public.claim_ai_agent_batches(5, 'w1');");
    const out = (await pg.run(enqueue({ id: "A2" }))).split("|");
    assert.equal(out[3], "1", "new batch starts at one message");
    assert.equal(await pg.run("select status, message_count from public.ai_agent_batches order by created_at;"), "processing|1\ncollecting|1");
    // The first batch's messages are untouched.
    assert.equal(await pg.run("select whatsapp_message_id from public.ai_agent_batch_messages m join public.ai_agent_batches b on b.id = m.batch_id where b.status = 'processing';"), "A1");
  });

  test("a chat's next batch waits for the earlier one to finish (strict order)", async () => {
    await reset();
    await pg.run(enqueue({ id: "B1" }));
    await pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second';");
    await pg.run("select * from public.claim_ai_agent_batches(5, 'w1');");
    await pg.run(enqueue({ id: "B2" }));
    await pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second' where status = 'collecting';");
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w2');"), "0", "second batch must wait");
    // Even once the first batch's lease has expired, it is reclaimed BEFORE the second.
    await pg.run("update public.ai_agent_batches set lease_until = now() - interval '1 second' where status = 'processing';");
    const first = await pg.run("select b.id = (select id from public.ai_agent_batches order by created_at limit 1) from public.claim_ai_agent_batches(5, 'w2') b;");
    assert.equal(first, "t");
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w3');"), "0");
    await pg.run(`select public.complete_ai_agent_batch((select id from public.ai_agent_batches where status = 'processing'), 'w2', 'done', 'NO_REPLY', null);`);
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w3');"), "1");
  });

  test("other chats are not blocked by a processing batch", async () => {
    await reset();
    await pg.run(enqueue({ id: "D1" }));
    await pg.run(enqueue({ id: "D2", chat: "17585559999@s.whatsapp.net" }));
    await pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second';");
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_batches(5, 'w1');"), "2");
  });

  test("businesses are isolated: same chat id, same message id, separate batches", async () => {
    await reset();
    await pg.run(enqueue({ biz: BIZ, id: "SAME" }));
    await pg.run(enqueue({ biz: OTHER, id: "SAME" }));
    assert.equal(await pg.run("select count(*) from public.ai_agent_batches;"), "2");
    assert.equal(await pg.run("select count(distinct business_slug) from public.ai_agent_batch_messages;"), "2");
  });

  test("a quiet window is per business", async () => {
    await reset();
    await settings(OTHER, 10, 20);
    await pg.run(enqueue({ biz: BIZ }));
    await pg.run(enqueue({ biz: OTHER }));
    const rows = await pg.run(`select business_slug, ${secs("due_at")} from public.ai_agent_batches order by business_slug;`);
    const [bySea, dogFood] = rows.split("\n").map((r) => Number(r.split("|")[1]));
    assert.ok(bySea >= 9 && bySea <= 10, `by_sea ${bySea}`);
    assert.ok(dogFood >= 44 && dogFood <= 45, `dog_food ${dogFood}`);
  });

  test("message order and original timestamps are preserved", async () => {
    await reset();
    await pg.run(enqueue({ id: "O1", text: "second", at: "2026-10-22T14:03:20Z" }));
    await pg.run(enqueue({ id: "O2", text: "first", at: "2026-10-22T14:03:05Z" }));
    await pg.run(enqueue({ id: "O3", text: "no timestamp", at: null }));
    const rows = await pg.run(
      "select text, to_char(message_at at time zone 'utc', 'HH24:MI:SS') from public.ai_agent_batch_messages order by position;"
    );
    assert.equal(rows, "second|14:03:20\nfirst|14:03:05\nno timestamp|");
  });

  test("enqueue refuses a business with no settings row", async () => {
    await assert.rejects(pg.run(enqueue({ biz: "nobody" })), /no ai_agent_settings/);
  });

  test("purge removes only finished batches past retention (messages cascade)", async () => {
    await reset();
    await pg.run(enqueue({ id: "P1" }));
    await pg.run(enqueue({ id: "P2", chat: "17585550000@s.whatsapp.net" }));
    await pg.run("update public.ai_agent_batches set due_at = now() - interval '1 second';");
    await pg.run("select * from public.claim_ai_agent_batches(5, 'w1');");
    await pg.run(`select public.complete_ai_agent_batch(id, 'w1', 'done', 'REPLY', null) from public.ai_agent_batches where chat_id = '${CHAT}';`);
    await pg.run("update public.ai_agent_batches set finished_at = now() - interval '8 days' where status = 'done';");
    assert.equal(await pg.run("select public.purge_ai_agent_batches();"), "1");
    assert.equal(await pg.run("select count(*) from public.ai_agent_batches;"), "1");
    assert.equal(await pg.run("select count(*) from public.ai_agent_batch_messages;"), "1");
  });

  test("Observe-mode outbox claim is untouched: only the permitted staff notice is handed out", async () => {
    await reset();
    const group = "120363000000000001@g.us";
    await pg.run(
      `update public.ai_agent_settings set enabled = true, mode = 'observe', staff_notices_enabled = true, staff_group_jid = '${group}' where business_slug = 'dog_food';
       insert into public.ai_agent_outbox (business_slug, chat_id, kind, to_jid, body, dedupe_key) values
        ('dog_food', '${CHAT}', 'customer_reply', '${CHAT}', 'hi', 'k1'),
        ('dog_food', '${CHAT}', 'holding_reply', '${CHAT}', 'hi', 'k2'),
        ('dog_food', '${CHAT}', 'staff_notice', '${CHAT}', 'wrong target', 'k3'),
        ('dog_food', '${CHAT}', 'staff_notice', '${group}', 'ok', 'k4');`
    );
    assert.equal(await pg.run("select kind || ':' || body from public.claim_ai_agent_outbox('dog_food', 20);"), "staff_notice:ok");
    await pg.run("update public.ai_agent_settings set enabled = false where business_slug = 'dog_food'; update public.ai_agent_outbox set status = 'pending';");
    assert.equal(await pg.run("select count(*) from public.claim_ai_agent_outbox('dog_food', 20);"), "0");
    await pg.run("delete from public.ai_agent_outbox; update public.ai_agent_settings set enabled = false where business_slug = 'dog_food';");
  });

  test("customer deletion is scoped to one business and one customer", async () => {
    await reset();
    const phone = "17585551234";
    await pg.run(
      `insert into public.ai_agent_customer_memory (business_slug, customer_key, kind, source, content, fingerprint) values
        ('dog_food', '${phone}', 'preference', 'customer_stated', 'prefers afternoon delivery', 'a'),
        ('dog_food', 'chat:${CHAT}', 'preference', 'customer_stated', 'lid-scoped fact', 'b'),
        ('dog_food', '17585550000', 'preference', 'customer_stated', 'someone else', 'c'),
        ('by_sea', '${phone}', 'preference', 'customer_stated', 'same phone, other business', 'd');
       insert into public.customer_ai_profile (business_slug, contact_number, preferences) values
        ('dog_food', '${phone}', 'x'), ('by_sea', '${phone}', 'y');
       insert into public.customer_orders (business_slug, chat_id, contact_number, order_seq, summary, order_status) values
        ('dog_food', '${CHAT}', '${phone}', 1, '2 bags', 'Completed');`
    );
    await pg.run(enqueue({ id: "F1" }));
    const res = await pg.run(`select public.forget_ai_agent_customer('dog_food', array['${CHAT}'], '${phone}', false, false);`);
    assert.deepEqual(JSON.parse(res), { memory: 2, profile: 1, batches: 1, orders: 0, logs: 0 });
    assert.equal(await pg.run("select count(*) from public.ai_agent_customer_memory;"), "2");
    assert.equal(await pg.run("select business_slug from public.customer_ai_profile;"), "by_sea");
    assert.equal(await pg.run("select count(*) from public.customer_orders;"), "1", "orders are kept unless explicitly included");
    const again = await pg.run(`select public.forget_ai_agent_customer('dog_food', array['${CHAT}'], '${phone}', true, true);`);
    assert.equal(JSON.parse(again).orders, 1);
    assert.equal(await pg.run("select count(*) from public.customer_orders;"), "0");
    await assert.rejects(pg.run("select public.forget_ai_agent_customer('dog_food', '{}', null, false, false);"), /nothing identifies/);
  });

  test("the migration can be re-run without error or data loss", async () => {
    await reset();
    await pg.run(enqueue({ id: "R1" }));
    const { readFileSync } = await import("node:fs");
    await pg.run(readFileSync("supabase/migrations/20261025000000_ai_agent_batching_memory.sql", "utf8"));
    assert.equal(await pg.run("select count(*) from public.ai_agent_batches;"), "1");
  });
});
