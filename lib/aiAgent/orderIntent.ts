// Is this conversation really an ORDER? — pure rules, no I/O, no model call.
//
// The extraction model reads a product mention and an "intent". That is not enough to put something on the delivery list:
// an invoice being discussed ("can you send the invoice for the 3" tablets?"), a quotation, a price enquiry, a question
// about sizes, or a customer answering a product clarification ("it is the 3" tablets") all name products and quantities
// without anybody asking for a delivery. This module decides, from the customer's own words, the staff replies around them
// and what the order already holds, which of three things a NEW order candidate is:
//
//   confirmed   the customer asked for goods to be supplied, or staff offered delivery and the customer accepted, or the
//               message is a plain order (products with quantities and where/when). It becomes an order as before.
//   possible    something that might be an order but nothing in the conversation says so. It is kept, flagged for staff
//               review, and kept OUT of the delivery lists until a person confirms it.
//   non_order   a conversation about an invoice, quotation, price, availability or a product question with no request in it.
//               No order is created.
//
// It only ever decides about creating a NEW order. An order that already exists is never cancelled, deleted or demoted
// by a later classification.

import { normalizeText } from "./escalationUpdates.ts";
import { pointsAtPicture } from "./orderImages.ts";
import { staffOffersDelivery, type ConversationLine } from "./staffDelivery.ts";

export type OrderIntentKind = "confirmed" | "possible" | "non_order";

export type OrderIntentReason =
  | "explicit_request"
  | "staff_agreement"
  | "stated_order"
  | "document_talk"
  | "price_enquiry"
  | "product_question"
  | "clarification"
  | "document_context"
  | "unclear";

export interface OrderIntent {
  kind: OrderIntentKind;
  reason: OrderIntentReason;
}

export { ORDER_REVIEW_ATTENTION } from "./orders.ts";

// Money and paperwork: what the conversation is about when nobody asks for goods.
const DOCUMENT = /\b(?:invoices?|quot(?:e|es|ed|ation|ations)|estimates?|pro ?forma|receipts?|statements?|bills?|billing|payments?|paid|pay|balance|account|credit|owing|owe|outstanding)\b/i;
const PRICE = /\b(?:how much|prices?|pricing|costs?|what(?:'s| is) the (?:price|cost|rate)|rates?|discount|cheaper|total)\b/i;
const QUESTION_ABOUT_PRODUCT = /\b(?:do you (?:have|sell|carry|stock)|have you got|is there|are there|in stock|available|availability|which (?:one|size|kind|type)|what (?:size|kind|type|flavou?r|brand)|difference between|ingredients|what is (?:in|the)|does (?:it|that)|is (?:it|that|this)|are (?:they|these|those))\b/i;

// The customer asks for goods to be supplied.
const REQUEST: RegExp[] = [
  /\b(?:i|we)(?:'d| would|'ll| will|'m| am| are)?\s*(?:like|want|need|require|take|have|get|order|ordering|looking for)\b/i,
  /\b(?:i|we)'?ll (?:take|have|get|need)\b/i,
  /\b(?:please|pls|plz|kindly)\s+(?:send|bring|deliver|drop|put|give|add|get)\b/i,
  /\b(?:can|could|would|may) (?:you|i|we)\s+(?:please |pls |kindly )?(?:send|bring|deliver|get|have|order|drop|give|put)\b/i,
  /\b(?:send|bring|deliver|drop off|give)\s+(?:me|us|it|them|one|two|three|a|an|some|\d)\b/i,
  /\bput (?:me|us) down\b/i,
  /\b(?:place|make|do|want to place|like to place)\s+(?:an?|my|the|another)\s+order\b/i,
  /\border\s+(?:for|of|me|us|some|\d)\b/i,
  /\bneed\s+(?:a|an|some|\d|two|three|four|five)\b/i,
  /\bwant\s+(?:a|an|some|\d|two|three|four|five)\b/i,
];

// A reply that answers a question rather than makes a request: "it is the 3" tablets", "that's the one", "those are the 25kg".
const CLARIFICATION = /^(?:it is|it's|its|that is|that's|thats|those are|these are|they are|they're|this is|this one is|the one is|it was|it should be|i meant|i mean)\b/i;

const DELIVERY_WORD = /\b(?:deliver\w*|bring|drop off|send(?:\s+(?:to|it)\b)|to my (?:house|home|place|office|yard)|collect\w*|pick ?up)\b/i;

const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?\n])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** A sentence that asks for goods and is not about paperwork or prices ("send the invoice" is not an order). */
function isRequestSentence(s: string): boolean {
  // "Please send 3 pails of chlorine and the invoice": goods named BEFORE the paperwork are an order; "send the invoice for 3 pails" is not.
  const document = s.search(DOCUMENT);
  const quantity = s.search(/\d|\b(?:one|two|three|four|five|six|a couple|a few|some|a bag|a pail)\b/i);
  if (document >= 0 && !(quantity >= 0 && quantity < document && REQUEST.some((p) => p.test(s)))) return false;
  if (document < 0 && (PRICE.test(s) && !/\b(?:i|we)(?:'d| would|'ll| will)?\s*(?:like|want|need)\b/i.test(s))) return false;
  if (document >= 0) return true;
  return REQUEST.some((p) => p.test(s));
}

export interface IntentInput {
  /** The customer's new messages in this turn, verbatim. */
  segments: string[];
  /** Earlier lines of the chat, oldest first (customer and staff), excluding this turn. */
  recent: ConversationLine[];
  /** The model's own label for the turn ("order", "question"…), when it gave one. */
  modelIntent: string | null;
  /** The products of the draft: whether each has a quantity. */
  items: { quantity: string | null; product?: string }[];
  hasAddress: boolean;
  hasDay: boolean;
  /** True when staff offered delivery in the last few lines and this turn accepts it. */
  staffAgreement?: boolean;
}

/** How far back "the conversation is about an invoice" reaches. */
const DOCUMENT_LOOKBACK = 6;

/**
 * Classifies ONE new-order candidate. Order of the checks matters and is the policy: an explicit request or an accepted
 * staff offer wins over everything; paperwork or a question with no request is not an order; then a plain order stated
 * with quantities and where or when; everything else is "possible" and goes to review.
 */
export function classifyOrderIntent(input: IntentInput): OrderIntent {
  const turn = input.segments.map((s) => s.replace(/[\u2018\u2019]/g, "'")).flatMap(sentences);
  if (input.staffAgreement) return { kind: "confirmed", reason: "staff_agreement" };
  if (turn.some(isRequestSentence)) return { kind: "confirmed", reason: "explicit_request" };

  const joined = turn.join(" ");
  const aboutDocument = DOCUMENT.test(joined);
  const aboutPrice = PRICE.test(joined);
  const aboutProduct = QUESTION_ABOUT_PRODUCT.test(joined) || turn.some((s) => /\?\s*$/.test(s));
  const quantified = input.items.length > 0 && input.items.some((i) => Boolean(i.quantity));

  // Nothing asks for goods. A turn that is only paperwork, a price or a question is not an order.
  if (aboutDocument) return { kind: "non_order", reason: "document_talk" };
  if (aboutPrice && !quantified) return { kind: "non_order", reason: "price_enquiry" };
  if (aboutProduct && !quantified) return { kind: "non_order", reason: "product_question" };

  // The conversation around it is about an invoice or a quote, and this message does not start a request of its own.
  const lookback = input.recent.slice(-DOCUMENT_LOOKBACK);
  if (lookback.some((m) => DOCUMENT.test(m.text))) return { kind: "possible", reason: "document_context" };
  // An answer to a question ("it is the 3" tablets and chlorine powder - one pail each") is not itself a request.
  if (turn.length > 0 && CLARIFICATION.test(turn[0])) return { kind: "possible", reason: "clarification" };
  if (aboutPrice || aboutProduct) return { kind: "possible", reason: "product_question" };

  // A product that is only "this one": nothing says which product it is (no readable photo, no earlier line). Not an order yet.
  if (input.items.length > 0 && input.items.every((i) => i.product !== undefined && pointsAtPicture(i.product) && i.product.trim().split(/\s+/).length <= 3 && !/\d/.test(i.product))) {
    return { kind: "possible", reason: "unclear" };
  }

  // A plain order as customers write them: products with quantities, and where or when, or a delivery word.
  const where = input.hasAddress || input.hasDay || DELIVERY_WORD.test(joined);
  if (quantified && where && input.modelIntent !== "question") return { kind: "confirmed", reason: "stated_order" };
  // "2 bags Monello 15kg", "some Monello please": how many customers order. Nothing above says it is anything else (no paperwork,
  // price, question, answer to a question, or invoice talk around it) and the model read it as an order.
  if (input.modelIntent === "order") return { kind: "confirmed", reason: "stated_order" };
  return { kind: "possible", reason: "unclear" };
}

/** True when the last staff line before `recent` ends offers or promises delivery (used to read the customer's "yes"). */
export function staffRecentlyOfferedDelivery(recent: ConversationLine[], withinHours = 12, at?: string): boolean {
  const last = [...recent].reverse().find((m) => m.who === "Staff" && m.text.trim());
  if (!last) return false;
  if (at && Date.parse(at) - Date.parse(last.at) > withinHours * 3_600_000) return false;
  return recent.filter((m) => m.who === "Staff").slice(-3).some((m) => staffOffersDelivery(m.text)) || normalizeText(last.text).includes("put you down");
}

export const INTENT_REASON_CODE: Record<OrderIntentReason, string> = {
  explicit_request: "order_intent_explicit_request",
  staff_agreement: "order_intent_staff_agreement",
  stated_order: "order_intent_stated_order",
  document_talk: "order_intent_document_talk",
  price_enquiry: "order_intent_price_enquiry",
  product_question: "order_intent_product_question",
  clarification: "order_intent_clarification",
  document_context: "order_intent_document_context",
  unclear: "order_intent_unclear",
};
