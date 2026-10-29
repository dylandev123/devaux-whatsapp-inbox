// Conversational order teaching — pure (no I/O), unit-tested in tests/aiAgentTeachSessions.test.ts.
//
// "!order #REF teach …" used to be one shot: any doubt (a spelling, a missing quantity, an unclear product) rejected the whole
// instruction. It is now a short conversation about ONE order. The first message and every reply are kept as a transcript; the
// model re-reads the whole transcript each turn and this file decides, deterministically, what may happen:
//
//   * the order reference establishes the customer, so a spelling difference in the name never rejects anything;
//   * a product must come from the staff member's words or from verified records (the order itself, the customer's reliable
//     earlier orders, approved product knowledge, the customer's staff-saved usual product) — never from the model alone;
//   * a quantity must be in the staff member's words: when it is not, that becomes a QUESTION, not a rejection;
//   * a fact about the CUSTOMER (usual product, default location, display name) is separate from a fact about THIS ORDER, is only
//     proposed when staff said so explicitly (or answered "yes" to our question), and is applied only after its own !confirm P-CODE.
//
// When nothing is left to ask, the result is the existing correction preview (C-CODE) plus, if any, a separate preference
// preview (P-CODE). Nothing here applies anything.

import { normalizeText } from "./escalationUpdates.ts";
import { sameProductLoose } from "./orderConversation.ts";
import {
  CORRECTION_TTL_MS,
  type CorrectionPlan,
  type CorrectionProposal,
  GENERAL_CUE,
  overlap,
  parseCorrectionProposal,
  planCorrection,
  quantityStated,
  safe,
  words,
} from "./orderTeach.ts";
import { displayRef, isReliableName, type OrderLine, type OrderNames, orderDisplayName, orderProductText, type TrackedOrder } from "./orders.ts";

export const SESSION_TTL_MS = 30 * 60_000;
export const MAX_SESSION_TURNS = 8;
export const PREFERENCE_TTL_MS = CORRECTION_TTL_MS;

export interface TeachTurn {
  by: "staff" | "assistant";
  text: string;
  at: string;
  messageId?: string | null;
}

/** What the session remembers between turns besides the transcript. */
export interface TeachState {
  /** How many times each question was asked (a question is not repeated forever). */
  asked: Record<string, number>;
  /** Yes/no answers already settled ("save_usual", "apply_usual", "save_location"). */
  decided: Record<string, boolean>;
  /** The questions currently outstanding. */
  questions: TeachQuestion[];
}

export const emptyState = (): TeachState => ({ asked: {}, decided: {}, questions: [] });

export interface TeachQuestion {
  key: string;
  text: string;
}

// ── Facts about the customer (not the order) ─────────────────────────────────

export type PreferenceFact =
  | { type: "usual_product"; line: OrderLine; label: string }
  | { type: "delivery_location"; value: string; label: string }
  | { type: "display_name"; value: string; label: string };

export const FACT_LABEL: Record<PreferenceFact["type"], string> = {
  usual_product: "Usual product",
  delivery_location: "Usual delivery location",
  display_name: "Display name",
};

// ── What the model returns (beyond the order correction) ─────────────────────

export interface TeachUnderstanding {
  proposal: CorrectionProposal;
  /** false: the reply is not about this teaching session (ordinary chatter). */
  related: boolean;
  usual_product: { line: OrderLine; save: boolean | null; for_order: boolean | null } | null;
  saved_location: { value: string; save: boolean | null } | null;
  display_name: string | null;
  questions: string[];
}

const text = (v: unknown, max: number): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};
const flag = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);

export function parseTeachUnderstanding(raw: string | null | undefined): TeachUnderstanding | null {
  const proposal = parseCorrectionProposal(raw);
  if (!proposal) return null;
  const src = (raw ?? "").trim();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const u = json.usual_product && typeof json.usual_product === "object" ? (json.usual_product as Record<string, unknown>) : null;
  const product = u ? text(u.product, 200) : null;
  const l = json.saved_location && typeof json.saved_location === "object" ? (json.saved_location as Record<string, unknown>) : null;
  const location = l ? text(l.value, 300) : null;
  return {
    proposal,
    related: json.related !== false,
    usual_product: u && product ? { line: { product, quantity: null, variant: text(u.variant, 100), size: text(u.size, 50) }, save: flag(u.save), for_order: flag(u.for_order) } : null,
    saved_location: l && location ? { value: location, save: flag(l.save) } : null,
    display_name: text(json.display_name, 120),
    questions: (Array.isArray(json.questions) ? json.questions : []).map((q) => text(q, 200)).filter((q): q is string => Boolean(q)).slice(0, 3),
  };
}

// ── Words ────────────────────────────────────────────────────────────────────

const SAVE_CUE = /\b(save|remember|keep|store|record|note it|set (?:it )?as|make (?:it|that)|add (?:it )?to (?:his|her|their) (?:profile|record|file))\b/i;
const NO_SAVE_CUE = /\b(don'?t save|do not save|no need to save|not to save|without saving|just (?:for )?(?:this|today'?s?)(?: one| order)?|only (?:for )?(?:this|today'?s?)(?: one| order)?|one[- ]?off|not (?:permanent|his usual|the usual))\b/i;
const YES = /^\W*(yes|yep|yeah|yup|y|ok|okay|sure|please|do it|correct|right|that'?s right|go ahead|affirmative)\b/i;
const NO = /^\W*(no|nope|nah|don'?t|do not|not)\b/i;
const NAME_CUE = /\b(name is|named|call (?:him|her|them)|spelt|spelled|spelling|rename|should be (?:called|named|saved as)|save (?:him|her|them|it) as|display name|goes by|is called)\b/i;
const CANCEL = /^\W*(cancel|stop|abort|never ?mind|forget (?:it|that)|ignore (?:that|it)|scrap (?:that|it)|leave it)\b/i;

export const isCancelReply = (t: string) => CANCEL.test(t.trim());

const compact = (s: string) => normalizeText(s).replace(/ /g, "");

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** "Jonathon" and "Jonathan", "Wei Xin Lin" and "Weixin Lin": the same person written differently. */
export function similarNames(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ca = compact(a);
  const cb = compact(b);
  if (!ca || !cb) return false;
  if (ca === cb || ca.includes(cb) || cb.includes(ca)) return true;
  if (distance(ca, cb) <= Math.max(1, Math.floor(Math.min(ca.length, cb.length) / 5))) return true;
  const ta = normalizeText(a).split(" ");
  const tb = normalizeText(b).split(" ");
  return ta.some((x) => x.length >= 4 && tb.some((y) => y.length >= 4 && distance(x, y) <= 2 && x[0] === y[0]));
}

// ── Planning ─────────────────────────────────────────────────────────────────

export interface KnownProducts {
  /** Product names from verified sources only, each with where it came from (shown to staff). */
  products: { text: string; source: "order" | "history" | "knowledge" | "saved" }[];
}

export interface TeachPlanInput {
  order: TrackedOrder;
  understanding: TeachUnderstanding;
  /** Every staff message of the session, oldest first (the last is the newest). */
  turns: string[];
  state: TeachState;
  known: KnownProducts;
  /** The best known name of the customer (staff-entered, then saved, then profile). */
  customerName: string | null;
  at: Date;
  timezone: string;
}

export interface TeachPlan {
  kind: "ask" | "propose" | "nothing";
  questions: TeachQuestion[];
  correction: CorrectionPlan | null;
  facts: PreferenceFact[];
  /** Plain remarks for the preview ("kept the name Jonathan Calderon"). */
  notes: string[];
  state: TeachState;
}

const productText = (l: Pick<OrderLine, "product" | "variant" | "size">) => orderProductText({ ...l, quantity: null });
const bagsOf = (l: OrderLine) => `bags of ${productText(l)}`;

export function planTeaching(input: TeachPlanInput): TeachPlan {
  const { order, understanding, turns, known, at, timezone } = input;
  const said = turns.join(" . ");
  const latest = turns[turns.length - 1] ?? "";
  const state: TeachState = { asked: { ...input.state.asked }, decided: { ...input.state.decided }, questions: [] };
  const questions: TeachQuestion[] = [];
  const notes: string[] = [];
  const who = safe(input.customerName ?? order.customer_name, 40) || "the customer";
  const heard = new Set(words(said));
  const ask = (key: string, q: string) => {
    if (!questions.some((x) => x.key === key)) questions.push({ key, text: q });
  };

  const proposal: CorrectionProposal = { ...understanding.proposal, ambiguities: [], reusable: [] };

  // The order reference already says whose order this is. A name that only differs in spelling is the same person.
  if (proposal.customer_name) {
    const current = order.customer_name;
    const explicit = NAME_CUE.test(said);
    if (similarNames(proposal.customer_name, current) || similarNames(proposal.customer_name, input.customerName)) {
      if (!explicit) {
        notes.push(`Kept the name ${safe(current ?? input.customerName, 40)} (“${safe(proposal.customer_name, 30)}” is the same person).`);
        proposal.customer_name = null;
      }
    } else if (!explicit && isReliableName(current)) {
      notes.push(`Kept the name ${safe(current, 40)} — this order is theirs, whatever name was mentioned. Say “the name is …” to change it.`);
      proposal.customer_name = null;
    }
  }

  // Products: grounded in the words or in a verified record, and every NEW quantity stated.
  const verified = (l: OrderLine) => known.products.find((k) => normalizeText(k.text) === normalizeText(productText(l)) || sameProductLoose({ ...l, quantity: null }, { product: k.text, quantity: null, variant: null, size: null }));
  const groundedLine = (l: OrderLine) => overlap(heard, `${l.product} ${l.variant ?? ""} ${l.size ?? ""}`) >= 0.5;
  const onOrder = (l: OrderLine) => order.items.find((o) => sameProductLoose(o, l));

  const usual = understanding.usual_product;
  // The usual product only goes on THIS order when staff (or their answer) say so.
  const wantsOnOrder = (l: OrderLine) => !usual || !sameProductLoose(usual.line, l) || state.decided.apply_usual === true || usual.for_order === true;
  if (usual && usual.for_order !== null && state.decided.apply_usual === undefined) state.decided.apply_usual = usual.for_order;

  let items = proposal.items;
  const itemQuestions: string[] = [];
  // Products accepted from verified records (not from the words): the order check must be allowed to see them as grounded.
  const fromRecords: string[] = [];
  if (items) {
    const kept: OrderLine[] = [];
    for (const line of items) {
      const existing = onOrder(line);
      if (!existing && !wantsOnOrder(line)) continue;
      const ok = existing || groundedLine(line) || verified(line);
      if (!ok) {
        const options = known.products.slice(0, 4).map((k) => k.text);
        ask(`product:${normalizeText(line.product)}`, `Which product is it? I could not match “${safe(line.product, 40)}” to what you wrote or to ${who}'s verified orders.${options.length > 0 ? ` I know: ${options.join(", ")}.` : ""}`);
        itemQuestions.push(line.product);
        continue;
      }
      if (!existing && !groundedLine(line)) {
        const from = verified(line)!;
        fromRecords.push(productText(line));
        notes.push(`“${productText(line)}” comes from ${from.source === "history" ? `${who}'s verified earlier orders` : from.source === "saved" ? `${who}'s saved usual product` : from.source === "knowledge" ? "approved product knowledge" : "this order"}, not from your words.`);
      }
      const changedQuantity = !existing || (line.quantity ?? null) !== (existing.quantity ?? null);
      if (changedQuantity && (!line.quantity || !quantityStated(said, line.quantity))) {
        ask(`quantity:${normalizeText(line.product)}`, `How many ${bagsOf(line)} ${existing ? "should the order have" : `does ${who} want`}?`);
        itemQuestions.push(line.product);
        continue;
      }
      kept.push(line);
    }
    // The complete list is only trustworthy if every line in it survived: otherwise ask first, change nothing.
    items = itemQuestions.length > 0 ? null : kept.length > 0 || proposal.items!.length === 0 ? kept : null;
    proposal.items = items;
  }
  // "Yes, use it for this order" with no quantity yet: the product is known, the quantity is not.
  if (usual && state.decided.apply_usual === true && !onOrder(usual.line) && !(proposal.items ?? []).some((l) => sameProductLoose(l, usual.line)) && itemQuestions.length === 0) {
    ask(`quantity:${normalizeText(usual.line.product)}`, `How many ${bagsOf(usual.line)} does ${who} want on this order?`);
  }

  // Facts about the customer. Each needs an explicit "save" from staff — their words, or "yes" to our question.
  const facts: PreferenceFact[] = [];
  const decideSave = (key: string, modelSave: boolean | null, generalised: boolean): boolean | null => {
    if (state.decided[key] !== undefined) return state.decided[key];
    const asked = state.asked[key] ?? 0;
    let answer: boolean | null = null;
    if (NO_SAVE_CUE.test(latest) || (asked > 0 && NO.test(latest))) answer = false;
    else if ((SAVE_CUE.test(latest) && !NO_SAVE_CUE.test(latest)) || (asked > 0 && YES.test(latest))) answer = modelSave === false ? false : true;
    else if (SAVE_CUE.test(said) && !NO_SAVE_CUE.test(said) && modelSave === true) answer = true;
    if (answer === null && !generalised) return false;
    if (answer !== null) state.decided[key] = answer;
    return answer;
  };

  if (usual) {
    const grounded = groundedLine(usual.line) || verified(usual.line);
    if (!grounded) {
      ask("usual_product", `Which product should I save as ${who}'s usual? I could not match “${safe(usual.line.product, 40)}”.`);
    } else {
      const decision = decideSave("save_usual", usual.save, GENERAL_CUE.test(said) || SAVE_CUE.test(said) || usual.save !== null);
      const hasApplyAnswer = state.decided.apply_usual !== undefined || Boolean(onOrder(usual.line)) || (proposal.items ?? []).some((l) => sameProductLoose(l, usual.line));
      if (decision === null && (state.asked.save_usual ?? 0) < 2) ask("save_usual", `Should I save ${productText(usual.line)} as ${who}'s usual product (for future orders)?`);
      if (!hasApplyAnswer && (state.asked.apply_usual ?? 0) < 2) ask("apply_usual", `Is it also the product for ${who}'s current order (${displayRef(order.ref_code)})?`);
      if (decision === true) facts.push({ type: "usual_product", line: { ...usual.line, quantity: null }, label: productText(usual.line) });
    }
  }

  const place = understanding.saved_location;
  if (place) {
    if (overlap(heard, place.value) < 0.5) {
      notes.push(`Did not save “${safe(place.value, 40)}” as a usual location: it is not in what you wrote.`);
    } else if (GENERAL_CUE.test(said) || SAVE_CUE.test(said) || place.save !== null) {
      const decision = decideSave("save_location", place.save, true);
      if (decision === null && (state.asked.save_location ?? 0) < 2) ask("save_location", `Should I save ${safe(place.value, 60)} as ${who}'s usual delivery location (for future orders), or is it only for this order?`);
      if (decision === true) facts.push({ type: "delivery_location", value: safe(place.value, 120), label: safe(place.value, 120) });
    }
  }

  if (understanding.display_name) {
    const name = understanding.display_name;
    const current = input.customerName;
    if (!NAME_CUE.test(said) || !isReliableName(name) || overlap(heard, name) < 1) {
      notes.push(`Did not change the display name: say “call him ${safe(name, 30)}” or “the name is ${safe(name, 30)}” to set it.`);
    } else if (normalizeText(name) !== normalizeText(current ?? "")) {
      facts.push({ type: "display_name", value: safe(name, 60), label: safe(name, 60) });
    }
  }

  // The model's own doubts become questions too (at most three in all), never a rejection.
  for (const a of understanding.proposal.ambiguities) ask(`amb:${compact(a).slice(0, 24)}`, safe(a, 160));
  for (const q of understanding.questions) ask(`model:${compact(q).slice(0, 24)}`, safe(q, 160));

  // What the order checks make of the rest. Its doubts are questions as well.
  // A usual product or place has its own, confirmed path (P-CODE); the old "offer a !remember command" hint is for anything else general.
  const hints = understanding.usual_product || understanding.saved_location ? [] : understanding.proposal.reusable;
  const correction = planCorrection(order, { ...proposal, reusable: hints }, { instruction: [said, ...fromRecords].join(" . "), at, timezone });
  for (const a of correction.ambiguities) ask(`amb:${compact(a).slice(0, 24)}`, a);

  const asked = questions.slice(0, 3);
  for (const q of asked) state.asked[q.key] = (state.asked[q.key] ?? 0) + 1;
  state.questions = asked;
  if (asked.length > 0) return { kind: "ask", questions: asked, correction: null, facts: [], notes, state };
  if (correction.changes.length === 0 && facts.length === 0) return { kind: "nothing", questions: [], correction, facts, notes, state };
  return { kind: "propose", questions: [], correction: correction.changes.length > 0 ? correction : null, facts, notes, state };
}

// ── Reply text ───────────────────────────────────────────────────────────────

const labelOf = (o: TrackedOrder, names?: OrderNames) => `${displayRef(o.ref_code)} (${safe(orderDisplayName(o, names) ?? "customer", 30)})`;
const minutes = (ms: number) => Math.round(ms / 60_000);

export const TEACH_REPLY = {
  ask: (o: TrackedOrder, names: OrderNames | undefined, questions: TeachQuestion[], notes: string[]) =>
    [
      `❓ *${labelOf(o, names)}* — I need a little more before I change anything:`,
      ...questions.map((q, i) => `${questions.length > 1 ? `${i + 1}. ` : ""}${q.text}`),
      ...notes.map((n) => `ℹ️ ${n}`),
      "Reply to this message in your own words. Say “cancel” to stop.",
      `Nothing has changed. This conversation closes after ${minutes(SESSION_TTL_MS)} minutes of silence.`,
    ].join("\n"),
  cancelled: (o: TrackedOrder) => `🛑 Stopped teaching ${displayRef(o.ref_code)}. Nothing was changed or saved. Start again with !order ${displayRef(o.ref_code)} teach …`,
  restarted: (o: TrackedOrder) => `🔄 Started over on ${displayRef(o.ref_code)}; the earlier conversation about it is closed.`,
  expired: (ref: string) => `⌛ The teaching conversation about ${displayRef(ref)} timed out, so nothing was changed. Start again with !order ${displayRef(ref)} teach …`,
  notYours: (ref: string) => `⚠️ The question about ${displayRef(ref)} was asked of another staff member. They can answer it, or send !order ${displayRef(ref)} teach … to start your own. Nothing changed.`,
  unrelated: (o: TrackedOrder) => `ℹ️ I could not tell how that answers my question about ${displayRef(o.ref_code)}. Reply again, say “cancel”, or send !order ${displayRef(o.ref_code)} teach … Nothing changed.`,
  tooLong: (o: TrackedOrder) => `⚠️ That conversation about ${displayRef(o.ref_code)} has gone on too long, so I stopped. Nothing changed. Send one complete !order ${displayRef(o.ref_code)} teach … instead.`,
  orderChanged: (o: TrackedOrder) => `⚠️ ${displayRef(o.ref_code)} changed while we were talking, so I stopped. Nothing changed. Check !order ${displayRef(o.ref_code)} and teach it again.`,
  nothing: (o: TrackedOrder, names: OrderNames | undefined, notes: string[]) => [`ℹ️ ${labelOf(o, names)} already matches that — nothing to change or save.`, ...notes.map((n) => `ℹ️ ${n}`)].join("\n"),
  pickOne: (refs: string[]) => `ℹ️ I am waiting on answers about ${refs.map(displayRef).join(" and ")}. Reply directly to the question you are answering so I know which one you mean. Nothing changed.`,
  noSessions: () => "ℹ️ There is no open teaching conversation to answer.",
  preferencePreview: (o: TrackedOrder, names: OrderNames | undefined, facts: PreferenceFact[], code: string, evidence: string, orderCode: string | null) =>
    [
      `💾 *Proposed customer memory — ${labelOf(o, names)}* (separate from the order)`,
      `You said: “${safe(evidence, 160)}”`,
      ...facts.map((f) => `• ${FACT_LABEL[f.type]}: *${safe(f.label, 80)}*`),
      "This is the CUSTOMER's permanent preference, used for their future orders until you replace it. It does not change this order.",
      `Nothing is saved yet. Save: !confirm ${code} · Cancel: !discard ${code}`,
      ...(orderCode ? [`(The order change above is separate: !confirm ${orderCode}.)`] : []),
      `Valid for ${minutes(PREFERENCE_TTL_MS)} minutes.`,
    ].join("\n"),
  preferenceApplied: (o: TrackedOrder, names: OrderNames | undefined, lines: string[]) => [`✅ Saved for ${labelOf(o, names)}:`, ...lines.map((l) => `• ${l}`), "Future order extraction can use this. Correct it any time by teaching a new value; the old one stays in the history."].join("\n"),
  preferenceFailed: (code: string, lines: string[]) => [`⚠️ ${code}: not everything was saved.`, ...lines.map((l) => `• ${l}`), `Nothing else changed. !confirm ${code} again retries.`].join("\n"),
  preferencePending: () => "⚠️ Saving customer preferences needs a one-time setup step that has not been run yet (migration 20261111000000), so nothing was saved. The order correction, if any, is unaffected.",
  sessionsPending: () => "⚠️ I cannot hold a back-and-forth conversation yet (a one-time setup step, migration 20261111000000, has not been run). Please send ONE complete message with the product, quantity and day: !order #REF teach …",
};
