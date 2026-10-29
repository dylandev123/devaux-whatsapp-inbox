// Deploying the app before migration 20261110000000 is run must not take the agent down: settings are read in their older shape
// (routing and missed calls simply off), and the new columns are never required for existing behaviour.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });

describe("settings before the routing / missed-call migration", () => {
  after(async () => {
    (await import("../lib/server/aiAgent/db.ts")).setAgentDbForTests(null);
  });

  test("a missing-column error falls back to the older column list, once", async () => {
    const db = await import("../lib/server/aiAgent/db.ts");
    const asked: string[] = [];
    db.setAgentDbForTests({
      from: () => ({
        select: (columns: string) => {
          asked.push(columns);
          const result = columns.includes("routing_rules")
            ? { data: null, error: { code: "42703", message: 'column "routing_rules" does not exist' } }
            : { data: { business_slug: "dog_food", enabled: true, mode: "approval_pilot" }, error: null };
          return { eq: () => ({ maybeSingle: async () => result }) };
        },
      }),
    } as never);
    const settings = await db.loadSettings("dog_food");
    assert.equal(settings?.business_slug, "dog_food");
    assert.equal(settings?.routing_rules, undefined, "routing is off");
    assert.equal(settings?.missed_call_enabled, undefined, "missed calls are off");
    assert.equal(asked.length, 2);
    assert.ok(asked[0].includes("routing_rules") && !asked[1].includes("routing_rules") && !asked[1].includes("missed_call"));
    assert.ok(asked[1].includes("orders_group_jid") && asked[1].includes("staff_group_jid"), "everything else is still read");
  });

  test("any other error is still an error", async () => {
    const db = await import("../lib/server/aiAgent/db.ts");
    db.setAgentDbForTests({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "57P01", message: "terminating connection" } }) }) }) }) } as never);
    await assert.rejects(() => db.loadSettings("dog_food"), /terminating connection/);
  });
});
