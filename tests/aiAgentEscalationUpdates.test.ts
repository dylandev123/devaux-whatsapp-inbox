// Smart escalation updates (lib/aiAgent/escalationUpdates.ts): what counts as a trivial message, how the
// structured picture of the request advances, what is a material change, how the model's order draft is
// kept honest, and how the staff-group update reads. Pure functions only; the database-backed behaviour
// (posting, races, restarts) is in tests/aiAgentUpdatesSql.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStaffUpdate,
  type Change,
  contextFromSnapshot,
  diffSnapshots,
  EMPTY_SNAPSHOT,
  extractQuestions,
  groundOrderDraft,
  isCancellation,
  isTrivialMessage,
  isTrivialTurn,
  isUrgentChange,
  nextSnapshot,
  parseSnapshot,
  type RequestSnapshot,
  snapshotFromContext,
  type TurnFacts,
} from "../lib/aiAgent/escalationUpdates.ts";
import { AGENT_MESSAGE_MARKERS, matchStaffReply } from "../lib/aiAgent/engine.ts";

const facts = (over: Partial<TurnFacts> & { segments: string[] }): TurnFacts => ({
  orderRequest: null,
  cancellation: false,
  modelIntent: null,
  ...over,
});
const order = (items: [string, string | null][], address: string | null = null, pref: string | null = null) => ({
  items: items.map(([product, quantity]) => ({ product, quantity })),
  delivery_address: address,
  delivery_preference: pref,
  notes: null,
});

// ── Trivial messages ────────────────────────────────────────────────────────

test("thank-yous, acknowledgements and greetings are trivial; anything with content is not", () => {
  for (const t of ["Thanks", "thank you!", "Thank you so much", "ok", "Okay thanks", "hello", "Hi", "good morning", "👍", "Noted", "Cheers", "no problem", "Ok will do"]) {
    assert.equal(isTrivialMessage(t), true, t);
  }
  for (const t of ["Test", "What products do you have?", "Thanks, but the bag was torn", "ok cancel it", "yes", "no", "yes please deliver", "2 bags", "hello do you have chicken"]) {
    assert.equal(isTrivialMessage(t), false, t);
  }
  assert.equal(isTrivialMessage(""), false);
});

test("a turn is trivial only when EVERY message in it is", () => {
  assert.equal(isTrivialTurn(["Thanks", "ok"]), true);
  assert.equal(isTrivialTurn(["Thanks", "also, do you deliver?"]), false);
  assert.equal(isTrivialTurn([]), false);
});

test("cancellation wording is recognised, ordinary wording is not", () => {
  for (const t of ["Please cancel my order", "I want to cancel", "never mind", "forget the order", "I don't want it anymore", "call it off"]) {
    assert.equal(isCancellation(t), true, t);
  }
  for (const t of ["what time do you close", "2 bags of chicken", "thanks"]) assert.equal(isCancellation(t), false, t);
});

test("questions are the customer's own sentences, verbatim, and chit-chat is not one", () => {
  assert.deepEqual(extractQuestions(["What products do you have?"]), ["What products do you have?"]);
  assert.deepEqual(extractQuestions(["Hi. Do you deliver to Gros Islet? Also how much is the 15kg bag"]), ["Do you deliver to Gros Islet?"]);
  assert.deepEqual(extractQuestions(["Test", "thanks", "2 bags please"]), []);
  // Repeats collapse.
  assert.deepEqual(extractQuestions(["Do you deliver?", "do you deliver"]), ["Do you deliver?"]);
});

// ── Snapshot + diff: the headline scenarios ─────────────────────────────────

test('"Test" then "What products do you have?" — the second message is a material update', () => {
  const first = nextSnapshot(EMPTY_SNAPSHOT, facts({ segments: ["Test"] }));
  assert.deepEqual(first.other, ["Test"]);
  const second = nextSnapshot(first, facts({ segments: ["What products do you have?"] }));
  assert.deepEqual(diffSnapshots(first, second), [{ kind: "question_added", text: "New question: “What products do you have?”" }]);
  // The picture stays complete: the first message is still there.
  assert.deepEqual(second.other, ["Test"]);
  assert.deepEqual(second.questions, ["What products do you have?"]);
});

test("customer adds a product", () => {
  const a = nextSnapshot(EMPTY_SNAPSHOT, facts({ segments: ["2 bags of chicken please"], orderRequest: order([["Chicken", "2"]]) }));
  const b = nextSnapshot(a, facts({ segments: ["also 1 bag of beef"], orderRequest: order([["Chicken", "2"], ["Beef", "1"]]) }));
  assert.deepEqual(diffSnapshots(a, b).map((c) => c.text), ["Added: 1 × Beef"]);
});

test("customer changes a quantity", () => {
  const a = nextSnapshot(EMPTY_SNAPSHOT, facts({ segments: ["2 chicken"], orderRequest: order([["Chicken", "2"]]) }));
  const b = nextSnapshot(a, facts({ segments: ["actually make it 3"], orderRequest: order([["Chicken", "3"]]) }));
  assert.deepEqual(diffSnapshots(a, b), [{ kind: "quantity_changed", text: "Quantity changed: Chicken 2 → 3" }]);
  // Matching ignores case and plurals.
  const c = nextSnapshot(b, facts({ segments: ["3 chickens"], orderRequest: order([["chickens", "3"]]) }));
  assert.deepEqual(diffSnapshots(b, c), []);
});

test("address and delivery changes, removals, and cancellation are all material", () => {
  const a = nextSnapshot(EMPTY_SNAPSHOT, facts({ segments: ["1 beef"], orderRequest: order([["Beef", "1"], ["Fish", "2"]], "12 Main St", "Friday") }));
  const b = nextSnapshot(a, facts({ segments: ["no fish. deliver to 5 Hill Rd on Saturday"], orderRequest: order([["Beef", "1"]], "5 Hill Rd", "Saturday") }));
  const kinds = diffSnapshots(a, b).map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["address_changed", "delivery_changed", "item_removed"]);
  const c = nextSnapshot(b, facts({ segments: ["please cancel"], cancellation: true }));
  const change = diffSnapshots(b, c);
  assert.deepEqual(change.map((x) => x.kind), ["cancelled"]);
  assert.equal(isUrgentChange(change), true);
  assert.equal(isUrgentChange(diffSnapshots(a, b)), false);
});

test('"Thank you", repeats and a duplicate delivery change nothing', () => {
  const a = nextSnapshot(EMPTY_SNAPSHOT, facts({ segments: ["Do you deliver?"] }));
  for (const again of [["Thank you"], ["ok"], ["Do you deliver?"], ["do you deliver"], ["hello"]]) {
    assert.deepEqual(diffSnapshots(a, nextSnapshot(a, facts({ segments: again }))), [], again.join());
  }
});

test("a message the model could not structure still reaches staff verbatim — unless it was small talk", () => {
  const a = nextSnapshot(EMPTY_SNAPSHOT, facts({ segments: ["2 chicken"], orderRequest: order([["Chicken", "2"]]) }));
  const b = nextSnapshot(a, facts({ segments: ["can you make it before noon"], modelIntent: "other" }));
  assert.deepEqual(diffSnapshots(a, b).map((c) => c.kind), ["question_added"]);
  const c = nextSnapshot(a, facts({ segments: ["my dog is a big eater"], modelIntent: "other" }));
  assert.deepEqual(diffSnapshots(a, c), [{ kind: "message_added", text: "New message: “my dog is a big eater”" }]);
  const d = nextSnapshot(a, facts({ segments: ["lovely weather"], modelIntent: "smalltalk" }));
  assert.deepEqual(diffSnapshots(a, d), []);
});

test("the snapshot survives a round trip through escalation.context", () => {
  const s = nextSnapshot(EMPTY_SNAPSHOT, facts({ segments: ["2 chicken", "Do you deliver?"], orderRequest: order([["Chicken", "2"]], "12 Main St") }));
  assert.deepEqual(snapshotFromContext(contextFromSnapshot(s)), s);
  assert.equal(parseSnapshot(null), null);
  assert.deepEqual(parseSnapshot({ items: "nope", cancelled: "yes" })?.items, []);
});

// ── Not fabricating ─────────────────────────────────────────────────────────

test("grounding drops products, quantities and addresses the customer never wrote", () => {
  const said = ["I want 2 bags of chicken dog food delivered to 12 Main Street"];
  const grounded = groundOrderDraft(
    order([["Chicken dog food", "2"], ["Beef treats", "5"]], "12 Main Street", "Friday 3pm"),
    null,
    said
  );
  assert.deepEqual(grounded?.items, [{ product: "Chicken dog food", quantity: "2" }]);
  assert.equal(grounded?.delivery_address, "12 Main Street");
  assert.equal(grounded?.delivery_preference, null);
});

test("grounding keeps the prior value when the model invents a change", () => {
  const prior = order([["Chicken", "2"]], "12 Main Street", "Friday");
  const g = groundOrderDraft(order([["Chicken", "9"]], "99 Fake Avenue", "Monday"), prior, ["thanks, see you soon"]);
  assert.deepEqual(g?.items, [{ product: "Chicken", quantity: "2" }]);
  assert.equal(g?.delivery_address, "12 Main Street");
  assert.equal(g?.delivery_preference, "Friday");
  // The same words, stated by the customer, ARE accepted — including number words.
  const ok = groundOrderDraft(order([["Chicken", "three"]], null, null), prior, ["make the chicken three please"]);
  assert.deepEqual(ok?.items, [{ product: "Chicken", quantity: "three" }]);
  const digit = groundOrderDraft(order([["Chicken", "3"]], null, null), prior, ["make the chicken three please"]);
  assert.deepEqual(digit?.items, [{ product: "Chicken", quantity: "3" }]);
});

// ── The staff-group message ─────────────────────────────────────────────────

const snapshot = (over: Partial<RequestSnapshot> = {}): RequestSnapshot => ({ ...EMPTY_SNAPSHOT, ...over });

test("an update shows the reference, who, what changed, the COMPLETE current request and what to do", () => {
  const current = snapshot({
    items: [{ product: "Chicken", quantity: "3" }, { product: "Beef", quantity: "1" }],
    delivery_address: "12 Main St",
    questions: ["Do you deliver on Sunday?"],
  });
  const changes: Change[] = [
    { kind: "quantity_changed", text: "Quantity changed: Chicken 2 → 3" },
    { kind: "question_added", text: "New question: “Do you deliver on Sunday?”" },
  ];
  const text = buildStaffUpdate({ refCode: "E-ABCDE", priority: "normal", customerLabel: "Jane · 17585550101", current, changes, afterStaffReply: false });
  assert.match(text, /Update on #E-ABCDE · NORMAL/);
  assert.match(text, /Jane · 17585550101/);
  assert.match(text, /What changed\*\n• Quantity changed: Chicken 2 → 3\n• New question/);
  assert.match(text, /Current request\* \(NOT confirmed\)\n• Chicken — qty 3\n• Beef — qty 1\n• Address: 12 Main St\n• Asks: “Do you deliver on Sunday\?”/);
  assert.match(text, /Action needed\*\n• Check availability and price for the updated order/);
  assert.match(text, /Answer the customer's new question/);
  assert.doesNotMatch(text, /AFTER staff replied/);
});

test("a change after staff replied is flagged, and a cancellation says what to stop", () => {
  const text = buildStaffUpdate({
    refCode: "E-ABCDE",
    priority: "high",
    customerLabel: "Jane",
    current: snapshot({ items: [{ product: "Chicken", quantity: "2" }], cancelled: true }),
    changes: [{ kind: "cancelled", text: "Customer wants to CANCEL" }],
    afterStaffReply: true,
  });
  assert.match(text, /Customer changed this AFTER staff replied/);
  assert.match(text, /Confirm the cancellation with the customer and stop any preparation or delivery/);
  assert.match(text, /Review your earlier reply/);
});

test("updates stay concise: capped lines, no reason codes, no raw chat history", () => {
  const many = Array.from({ length: 20 }, (_, i) => `question number ${i}?`);
  const current = snapshot({ questions: many.slice(-6), other: ["a", "b", "c", "d"] });
  const changes: Change[] = many.map((q) => ({ kind: "question_added", text: `New question: “${q}”` }));
  const text = buildStaffUpdate({ refCode: "E-ABCDE", priority: "normal", customerLabel: "Jane", current, changes, afterStaffReply: false });
  assert.ok(text.split("\n").length < 40, `too long: ${text.split("\n").length} lines`);
  assert.match(text, /\+14 more in the dashboard/);
  assert.doesNotMatch(text, /model_uncertain|open_escalation|staff_first|reason/i);
  assert.ok(text.length < 1800);
});

test("Observe-mode updates say nothing reaches the customer", () => {
  const text = buildStaffUpdate({
    refCode: "E-ABCDE", priority: "normal", customerLabel: "Jane", current: snapshot({ questions: ["Hi?"] }),
    changes: [{ kind: "question_added", text: "New question: “Hi?”" }], afterStaffReply: false, observeOnly: true,
  });
  assert.match(text, /Observe mode: nothing is sent to the customer/);
});

// ── Quote routing and echo protection ───────────────────────────────────────

test("our own update message is never read as a staff instruction when echoed back", () => {
  const text = buildStaffUpdate({
    refCode: "E-ABCDE", priority: "normal", customerLabel: "Jane", current: snapshot({ questions: ["Hi?"] }),
    changes: [{ kind: "question_added", text: "New question: “Hi?”" }], afterStaffReply: false,
  });
  assert.ok(AGENT_MESSAGE_MARKERS.some((m) => text.includes(m)));
  assert.equal(matchStaffReply({ text, quotedMessageId: "WA-UPDATE" }, [{ id: "e1", ref_code: "E-ABCDE", notice_message_id: "WA-UPDATE", status: "notified" }]).kind, "unmatched");
});

test("a quoted reply to the initial notice or to an update resolves to the same escalation", () => {
  // matchCandidates() (staffGroup.ts) stamps the QUOTED message id onto the candidate whichever notice it was.
  const esc = (quoted: string) => [{ id: "e1", ref_code: "E-ABCDE", notice_message_id: quoted, status: "notified" }];
  for (const quoted of ["WA-INITIAL", "WA-UPDATE-1", "WA-UPDATE-2"]) {
    const m = matchStaffReply({ text: "Yes, Tuesday works", quotedMessageId: quoted }, esc(quoted));
    assert.equal(m.kind, "matched");
    assert.equal(m.kind === "matched" && m.escalationId, "e1");
    assert.equal(m.kind === "matched" && m.refCode, "E-ABCDE");
  }
});
