// The staff-group command registry — pure (no I/O), unit-tested in tests/aiAgentCustomerCommands.test.ts.
//
// "!rules" / "!help" are generated from THIS list, so the help can never advertise a command that is not implemented:
// a command is added here in the same change that implements it, and a test checks every entry against the real
// parsers (and every real parser against this list). Nothing here changes data.

export type CommandSection = "Message Approval" | "Customer Memory" | "Orders" | "AI Learning" | "General";

export const COMMAND_SECTIONS: readonly CommandSection[] = ["Message Approval", "Customer Memory", "Orders", "AI Learning", "General"];

export interface CommandDoc {
  /** The word after "!" that the parser recognises. */
  name: string;
  section: CommandSection;
  /** The shape to type, including required arguments. */
  usage: string;
  summary: string;
  example?: string;
  /** What the command needs besides its own words (a quoted message, an ID…), in plain language. */
  needs?: string;
  /** Who may use it. */
  who: "anyone" | "authorized";
  /** True when the command only reads. */
  readOnly: boolean;
}

export const STAFF_COMMANDS: readonly CommandDoc[] = [
  // ── Message Approval ──
  { name: "approve", section: "Message Approval", usage: "!approve [v2] [confirm]", summary: "Send the AI's draft to the customer, exactly as written.", example: "!approve", needs: "Quote the draft or notice, or add its code (#E-ABCDE). Add “confirm” when the draft says to check facts first.", who: "authorized", readOnly: false },
  { name: "edit", section: "Message Approval", usage: "!edit [v2] <your wording>", summary: "Replace the draft with your wording. Sends nothing until you !approve.", example: "!edit Hi Jane, we can deliver Friday.", needs: "Quote the draft or notice, or add its code.", who: "authorized", readOnly: false },
  { name: "reject", section: "Message Approval", usage: "!reject [wrong|missing] [why]", summary: "Drop the draft. Nothing is sent.", example: "!reject wrong price", needs: "Quote the draft or notice, or add its code.", who: "authorized", readOnly: false },
  { name: "send", section: "Message Approval", usage: "!send <exact text>", summary: "Send exactly your text to the customer.", example: "!send Hi Jane, your order is ready.", needs: "Quote the notice, or add its code.", who: "authorized", readOnly: false },
  { name: "moreinfo", section: "Message Approval", usage: "!moreinfo", summary: "Full details of one request: customer, order, risks, draft status.", needs: "Quote the notice, or add its code.", who: "authorized", readOnly: true },
  { name: "note", section: "Message Approval", usage: "!note <text>", summary: "Save an internal note on a request. Not sent to the customer.", needs: "Quote the notice, or add its code.", who: "anyone", readOnly: false },
  { name: "close", section: "Message Approval", usage: "!close", summary: "Close a request.", needs: "Quote the notice, or add its code.", who: "anyone", readOnly: false },
  { name: "takeover", section: "Message Approval", usage: "!takeover", summary: "Pause the AI for this customer until you !resume.", needs: "Quote the notice, or add its code.", who: "anyone", readOnly: false },
  { name: "resume", section: "Message Approval", usage: "!resume", summary: "Let the AI handle this customer again.", needs: "Quote the notice, or add its code.", who: "anyone", readOnly: false },
  { name: "status", section: "Message Approval", usage: "!status", summary: "List open requests. With a quote or code: that request's draft status.", who: "anyone", readOnly: true },

  // ── Customer Memory ──
  { name: "customer", section: "Customer Memory", usage: "!customer <customer>", summary: "Show a customer's saved location, preferences, notes and recent orders.", example: "!customer 17585550123  (or reply to their notice with !customer)", needs: "A customer: reply to their notice, or give a phone number, a request code (#E-ABCDE) or an order code (#QU6U9).", who: "authorized", readOnly: true },
  { name: "location", section: "Customer Memory", usage: "!location <customer> [place|clear]", summary: "Without a place: show the saved default delivery location. With one: save or replace it. “clear”: remove it.", example: "!location 17585550123 Cap Estate  (or reply to their notice with !location Cap Estate, or !location clear)", needs: "A customer, as for !customer.", who: "authorized", readOnly: false },
  { name: "remember", section: "Customer Memory", usage: "!remember <customer> <fact>", summary: "Propose a lasting note about one customer. It is only saved after you confirm, and an unconfirmed proposal expires after 7 days.", example: "!remember 17585550123 Dog is nervous, call before arriving", needs: "A customer, as for !customer. Then reply: !remember confirm M-ABCDE (save), !remember discard M-ABCDE, or !remember remove M-ABCDE (delete a saved note).", who: "authorized", readOnly: false },

  // ── Orders ──
  { name: "orders", section: "Orders", usage: "!orders [today|tomorrow|<date>|all|overdue|missing|undated|review]  |  !orders complete all", summary: "Outstanding orders by the day they are for, split into delivery and collection. Alone: today and tomorrow. “all”: every outstanding order. “overdue”: older orders still open. “missing”: orders lacking products, quantity, delivery/collection, address or day. “undated”: no day given. “review”: possible orders that might not be orders (an invoice or price talk) and are on no delivery list until confirmed. Deliveries to the south are grouped under South Deliveries on each day. The views only read. “complete all”: marks TODAY's outstanding orders completed (fulfilled — delivered or collected, not just hidden; history is kept). It shows the orders and a B- code first and changes nothing until you !confirm B-ABCDE (or !discard B-ABCDE). Tomorrow's, overdue, later and undated orders are never included. Customers are not messaged.", example: "!orders tomorrow  (or !orders 30 Oct, or !orders complete all)", needs: "Used in the Orders group (the staff group unless a separate Orders group is set). Completing needs the B- code from the preview.", who: "authorized", readOnly: false },
  { name: "update", section: "Orders", usage: "!update [#REF confirmed|cancelled|2 bags|delivery tomorrow]", summary: "Alone: a short list of orders that are new or changed since the last update delivered to the group (nothing is marked reviewed). With an order code: confirm, cancel or change that order.", example: "!update #QU6U9 delivery 30 Oct", needs: "Used in the Orders group. The “since” point is shared by the whole group.", who: "authorized", readOnly: false },
  { name: "order", section: "Orders", usage: "!order <name, phone or #REF> | #REF completed | #REF reopen | #REF teach <instruction>", summary: "Find active orders, show one in full (also !moreinfo #REF), mark it completed (leaves !orders; history kept; customer not messaged) or reopen it. “teach”: correct one order in your own words — product, quantity, address, day, time, delivery or collection, name, other contact, notes — in one message. It shows a before/after and a C- code first; nothing changes until you !confirm C-ABCDE (or !discard C-ABCDE). The customer is never messaged, and nothing is saved as a lasting customer preference or business fact unless you run !remember or !teach yourself.", example: "!order #ZWL67 teach The address is Cap Estate and the food is 1 Bandit 25kg", needs: "Used in the Orders group. Completing and teaching need the order code (#REF).", who: "authorized", readOnly: false },

  // ── AI Learning ──
  { name: "teach", section: "AI Learning", usage: "!teach [for 6h|until YYYY-MM-DD] <fact>", summary: "Propose a business fact for the AI to learn.", example: "!teach We deliver to Gros Islet on Fridays", needs: "Optional: quote a request to tie the fact to it.", who: "authorized", readOnly: false },
  { name: "confirm", section: "AI Learning", usage: "!confirm K-ABCD [replace|keep]", summary: "Approve a suggested fact into the AI's knowledge (K- code: knowledge only, not orders). The same command applies an order proposal: the C- code from !order #REF teach, or the B- code from !orders complete all.", example: "!confirm K-7QX2  (or !confirm C-ABCDE, !confirm B-ABCDE)", needs: "The code from the suggestion or preview. K- codes only when WhatsApp confirmation is switched on. C-/B- codes expire (30 and 10 minutes) and apply once.", who: "authorized", readOnly: false },
  { name: "discard", section: "AI Learning", usage: "!discard K-ABCD", summary: "Reject a suggested fact (K- code), or drop an order proposal (C- or B- code) without changing anything.", example: "!discard K-7QX2  (or !discard C-ABCDE)", needs: "The code from the suggestion or preview.", who: "authorized", readOnly: false },
  { name: "memory", section: "AI Learning", usage: "!memory [K-ABCD]", summary: "List what the AI learned recently, or show where one fact came from.", who: "anyone", readOnly: true },
  { name: "forget", section: "AI Learning", usage: "!forget K-ABCD", summary: "Switch off a learned fact. It stays in the history.", example: "!forget K-7QX2", needs: "The K- code (see !memory).", who: "authorized", readOnly: false },

  // ── General ──
  { name: "rules", section: "General", usage: "!rules  (or !help)", summary: "Show this list. Changes nothing.", who: "authorized", readOnly: true },
];

/** "!help" is another name for "!rules". */
export const COMMAND_ALIASES: Readonly<Record<string, string>> = { help: "rules" };

/** WhatsApp truncates very long messages and is hard to read on a phone: each part stays well under this. */
export const RULES_MESSAGE_MAX = 1400;

const lineFor = (c: CommandDoc): string[] => {
  const out = [`*${c.usage}*`, c.summary];
  if (c.needs) out.push(`↳ ${c.needs}`);
  if (c.example) out.push(`e.g. ${c.example}`);
  if (c.who === "authorized") out.push("🔒 authorized staff only");
  return out;
};

/** One block of text per section, in display order (empty sections are skipped). */
export function rulesSections(registry: readonly CommandDoc[] = STAFF_COMMANDS): { section: CommandSection; text: string }[] {
  return COMMAND_SECTIONS.map((section) => {
    const commands = registry.filter((c) => c.section === section);
    if (commands.length === 0) return null;
    return { section, text: [`*${section.toUpperCase()}*`, ...commands.map((c) => lineFor(c).join("\n"))].join("\n\n") };
  }).filter((s): s is { section: CommandSection; text: string } => s !== null);
}

/**
 * The !rules reply as WhatsApp messages: sections packed into parts that each fit RULES_MESSAGE_MAX; a section longer
 * than that is split between its commands, never in the middle of one.
 */
export function buildRulesMessages(registry: readonly CommandDoc[] = STAFF_COMMANDS, max = RULES_MESSAGE_MAX): string[] {
  const blocks: string[] = [];
  for (const { text } of rulesSections(registry)) {
    if (text.length <= max) {
      blocks.push(text);
      continue;
    }
    const [title, ...commands] = text.split("\n\n");
    let current = title;
    for (const command of commands) {
      if (current.length + 2 + command.length > max && current !== title) {
        blocks.push(current);
        current = `${title} (cont.)`;
      }
      current += `\n\n${command}`;
    }
    blocks.push(current);
  }
  const parts: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (current && current.length + 2 + block.length > max) {
      parts.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) parts.push(current);
  const header = "📖 *Staff commands*\nA command must be the first word of your message.";
  const footer = "Nothing above is sent to a customer unless it says so.";
  return parts.map((p, i) => [i === 0 ? `${header}\n\n${p}` : p, parts.length > 1 ? `(${i + 1}/${parts.length})` : "", i === parts.length - 1 ? footer : ""].filter(Boolean).join("\n\n"));
}
