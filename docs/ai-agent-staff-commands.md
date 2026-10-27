# Staff commands: `!rules` and customer memory

Staff manage customer memory from the authorized WhatsApp staff group. No bridge change: the bridge already forwards staff-group
messages with the quoted message id and the sender's phone.

Files: `lib/aiAgent/commandRegistry.ts` (the list `!rules` is generated from), `lib/aiAgent/customerCommands.ts` (pure parsing,
validation, reply text), `lib/server/aiAgent/customerCommands.ts` (who the customer is, authorization, storage),
`lib/server/aiAgent/customerStaffMemory.ts` (the table), migrations `20261106000000_ai_agent_customer_staff_memory.sql` and `20261107000000_ai_agent_staff_memory_clear_expiry.sql`,
tests `tests/aiAgentCustomerCommands.test.ts`.

## Commands

| Command | Who | Does |
|---|---|---|
| `!rules`, `!help` | authorized | Lists every working command, by section, in numbered WhatsApp-sized parts. Read-only; no quote needed. Anyone else in the group gets a refusal (audited) and no list. |
| `!customer <customer>` | authorized | Name, phone, saved location, staff notes, notes waiting for confirmation, what the customer said, resolved issues, recent confirmed orders and their addresses, AI guesses (labelled unverified). |
| `!location <customer>` | authorized | Shows the saved default delivery location. |
| `!location <customer> Cap Estate` | authorized | Saves or replaces it. Same place again (any spelling) = no change. |
| `!location <customer> clear` | authorized | Removes the saved default (also `!location clear` as a reply to the customer's notice). The row stays as history (`removed`, who, when, which message) and the change is audited as `customer_location.cleared`. Nothing saved = "nothing changed", no audit entry. `!location clear Cap Estate` is refused, never saved. |
| `!remember <customer> <fact>` | authorized | Proposes a note (code `M-ABCDE`). Nothing is saved yet. An unconfirmed proposal **expires after 7 days**. |
| `!remember confirm\|discard\|remove M-ABCDE` | authorized | Saves a proposed note / drops it / retires a saved one. Confirming an expired proposal is refused ("expired… propose it again"). |

`<customer>` is one of: a **phone number** (`17585550123`), a **request code** (`#E-ABCDE`), an **order code** (`#QU6U9`), or — omitted —
**the notice you reply to**. Display names are never used. `X-0123` is not a format this system has; it is answered with "can't find a
customer" and nothing changes. If the reply and a typed customer disagree, or a reply is about several customers, nothing changes.

Every command is read from the START of a message and is handled before escalation matching, so replying to a customer's notice with
`!location Cap Estate` sets a location; it is never an "answer" to that request and never reaches the customer.

## Orders (unchanged; documented in `!rules`)

`!update` (today's report), `!update #REF confirmed|cancelled|2 bags|delivery tomorrow`, `!order <name|phone|#REF>`, `!moreinfo #REF` —
in the Orders group (the staff group unless a separate Orders group is set). There is no `!orders`, `!done` or order `!confirm`:
`!confirm K-ABCD` still means *approve a suggested knowledge fact* and nothing else.

## Memory behaviour

* Stored in `ai_agent_customer_staff_memory`, per business and customer key (verified phone, or `chat:<id>` for an @lid with no phone).
  Separate from business knowledge (`ai_agent_knowledge`) and from customer-stated facts (`ai_agent_customer_memory`).
* One active default location per customer (unique index). A change supersedes the old row, which is kept with who (verified sender id),
  when, from which WhatsApp message, and the previous value. All in one SQL function, so concurrent or repeated commands cannot leave two.
* "Same place" / "usual location": the order flow (`resolveFromHistory`) uses the saved location first, then falls back to an earlier
  order's address as before. With none saved, the AI is told to ask. A different address in a message is that order's address only; no
  customer-facing path writes the default.
* The AI's prompt gets the location as "set by staff, verified" and notes as internal. Staff memory is read even when
  `customer_memory_enabled` is off (that switch gates what the AI captures by itself).
* Clearing a location: the AI then has none saved and, for "same place", falls back to an earlier order's address exactly as before
  a location was ever saved (and asks when there is none).
* Expiry: a proposal is `expired` once it is more than 7 days old (from when it was proposed). A sweep marks them (audited as
  `customer_note.expired`, actor `system`) before any `!remember`/`!customer`, so an expired proposal is never listed, never counts toward
  the 12-note cap and never blocks proposing the same note again. The confirming UPDATE is also guarded by age, so there is no window
  between the check and the write. Active notes never expire.
* Customer deletion (`forget_ai_agent_customer`) now erases this table too.

## Deployment order

1. Run `20261106000000_ai_agent_customer_staff_memory.sql` in Supabase (additive; also re-creates `forget_ai_agent_customer` with one extra delete),
   unless it has already been run.
2. Run `20261107000000_ai_agent_staff_memory_clear_expiry.sql` (additive and idempotent: one column, `removed`/`expired` statuses, one function).
3. Deploy the app. Until steps 1–2 are done, `!location`/`!remember`/`!customer` fail (the AI path degrades to "nothing saved"; `!rules` works).
   Without step 2, `!location clear` fails and an expired proposal cannot be marked.

## Limits

* No semantic contradiction check for free-text notes (staff see existing notes in the proposal); no name search; a phone number is
  accepted only if the business has dealt with it. Expiry has no reminder: an unconfirmed proposal simply lapses.
