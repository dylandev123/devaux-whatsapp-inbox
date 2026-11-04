# Google Docs order sync

Adds each new actionable WhatsApp order, as one line, at the **very top** of a Google Doc your staff already maintain (the document
can be hundreds of pages). Supabase stays the authoritative order record; the document is a mirror that only ever grows at the top.
Managed from **AI Agent → Google Docs**. **Off by default** for every business.

```
Location — Customer name — Phone — Product/Quantity — Notes — Delivery date — Order ref ⟨E-7K2QX⟩
```

The field order, which fields are on, and the separator stay configurable in the dashboard. The default is the line above (location
first, then name, phone, products, notes, delivery date, order reference). A configuration saved before this layout that still has the
old default *order* (name, phone, location, …) moves to the new order automatically; the fields you switched on or off and your
separator are kept, and a configuration you re-ordered yourself is never rearranged. Lines already in the document are never rewritten.

A **South Delivery** starts with `SOUTH DELIVERY` (plus the destination when the address does not name it), whatever the field order:

```
SOUTH DELIVERY — St Remy, Soufrière — Tara — +1 (758) 719-0614 — 2 × Birbo Chicken (large), 1 × Birbo Chicken (small) — Signed by Louise (WhatsApp name: Tara) — Date to be confirmed — #O-EKM84 ⟨O-EKM84⟩
```

An order placed for someone else shows the person it is for, with the sender in the notes
(`… — Tamara Amos — +1 (758) 484-7702 — 1 × Bandit (damaged, 25kg) — $155 Paid in store · Placed by Gary Devaux (+17587162997) — …`).

## What it does (and never does)

- **Append-only at the top.** A new order becomes one new paragraph at the start of the document's **first tab**, pushing everything
  already there down. The app never replaces, rewrites, reorders or deletes anything. A later change to an order (correction,
  completed, cancelled) is **not** reflected in the document, and a line staff edit or delete stays as they left it: edit lines by
  hand in Google Docs. (The orders themselves are untouched; Supabase has the up-to-date version.)
- **No document reads on the normal path.** The access test uses Drive metadata (title, type, edit permission) plus a Docs API
  availability check that asks for a document id that cannot exist (Google answers "not found" when the API is on, "disabled" or
  "insufficient scope" otherwise). Inserting sends a single `insertText` at index 1 and nothing else. The only time the document's
  text is downloaded is to settle an insert whose outcome is unknown (below).
- **Index rules handled.** Index 0 is the document's section break, so the first character is index 1. No `tabId` is sent, which
  Google defines as "the first tab", so no tab lookup (and no read) is needed. The new paragraph is reset to plain body text so a
  document that opens with a Title, a heading, a bullet or bold/coloured text does not turn the order line into one; only the new
  paragraph is styled, never the one that was first. If Google refuses the styling requests the bare line is inserted instead. A
  document that opens with a **table** cannot take text above it: the dashboard reports "Document start cannot take text" with the
  fix (put an empty paragraph at the top) and retries after you press **Sync now**.
- Each line ends with a small grey order id (`⟨E-7K2QX⟩`). It is what lets the app recognise its own line after an interruption.
- Missing details are shown as `(no phone)`, `(no location)`, `(no name)`, `(no items)` — never guessed. Because lines are not updated
  afterwards, you can switch off "Also add orders that still miss details" to wait until an order is complete. Orders flagged as
  "might not be an order", or without products, are not listed.
- Only orders created **after sync was turned on** are added automatically — including after switching sync off and on again.
  Older outstanding orders come in only through the explicit one-time **import** (preview first, then confirmation).
- Never sends a WhatsApp message (the integration does not touch the outbox), and never modifies an order.

## Duplicates, retries and the crash window

**This is at-least-once delivery with detection, not exactly-once.** Google has no idempotency key for `batchUpdate`, so a write
whose answer is lost cannot be proven applied or not from our side alone. What is guaranteed:

1. **One attempt per order.** Before writing, the order's row in `ai_agent_gdoc_lines` is claimed by one atomic database statement
   (`claim_gdoc_line`, backed by a unique index). Overlapping triggers, cron ticks and button presses cannot both write an order, with
   or without the per-business lease.
2. **A refusal is safe to retry.** If Google answers with a 4xx (permission, bad request, rate limit, …) the document is known to be
   unchanged: the row becomes `failed` and the next run adds the order.
3. **An unknown outcome is never retried blindly.** A timeout, network error, 5xx, or a crash after the write leaves the row
   `inserting` / `unconfirmed`. The order is not written again. After a 2-minute settle period the background sync downloads the
   first tab's **text only** (one bounded read, shared by all unknown lines) and looks for the order's tag: **found** → marked
   done; **absent** → `failed` and retried; **read impossible** (e.g. the document is too large for the time left) → stays
   `unconfirmed`, retried at most every 10 minutes up to 6 times, then left to you.
4. **Staff decide what the app cannot.** An unresolved line appears under **Needs your attention** with three buttons: *It is in
   the document*, *It is not there — add it*, *Leave it out*. Nothing is ever guessed.
5. If the write succeeded but recording it in the database fails, the recording is retried immediately three times; if it still
   fails the row stays `inserting` and step 3 settles it.

Residual risk, stated plainly: a duplicate is possible only if Google applies an abandoned request after the 2-minute settle period,
or if you choose *add it again* for a line that is in fact there. A line that staff delete before it is verified is reported as
absent and re-added once.

## Time budget and the order flow

Google is **not** in the WhatsApp order-processing path. After an order is created or changed the app starts the sync without
waiting for it (`after()` keeps the serverless function alive until it finishes) and the order flow continues. A failed or
interrupted run is retried by the existing cron tick (`/api/cron/ai-agent/batches`), which gives the sync whatever is left of its
60 s. After a failed run, automatic triggers wait 5 minutes before trying again (the dashboard's **Retry now** / **Sync now** do not
wait). Up to 15 lines are written per run, oldest first so the newest ends on top.

## One-time setup

### 1. Run the SQL migrations
Supabase SQL editor → run, in order, `supabase/migrations/20261112000000_ai_agent_google_docs_sync.sql` and
`supabase/migrations/20261113000000_ai_agent_gdocs_append_only.sql` (both additive and idempotent; the first is already applied in
production). Until the second is run the app cannot insert lines (the sync reports an error); nothing else changes.

### 2. Google Cloud OAuth client
1. [Google Cloud console](https://console.cloud.google.com/) → create or choose a project.
2. **APIs & Services → Library**: enable **Google Docs API** and **Google Drive API**.
3. **OAuth consent screen**: user type **Internal** if your account is Google Workspace, otherwise **External**. Add the scopes
   `…/auth/documents`, `…/auth/drive.metadata.readonly`, `openid`, `email`.
   - Set publishing status to **In production** (an app left in *Testing* has refresh tokens that expire after 7 days). For personal
     use Google shows an "unverified app" screen once: *Advanced → Go to … (unsafe)* is expected for your own app.
4. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URI (exactly):
   `https://<your-production-domain>/api/ai-agent/google-docs/callback`
   (add `http://localhost:3000/api/ai-agent/google-docs/callback` for local testing).
5. Copy the client id and secret.

Why those scopes: `documents` lets the app insert text into the document; `drive.metadata.readonly` is used only to read the document's title and
whether the connected account may edit it (so edit access is verified *before* sync can be enabled — no file content is read
through Drive); `openid email` shows which account is connected.

### 3. Environment variables (Vercel → Settings → Environment Variables, then redeploy)

| Variable | Value |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | from step 2 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | from step 2 |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | 32 random bytes: `openssl rand -base64 32`. Encrypts the stored refresh token (AES-256-GCM, bound to the business). Keep it; if it changes, reconnect Google. |
| `GOOGLE_OAUTH_REDIRECT_URI` | optional; only if the app is reached under a different host than the one registered |

Staff never see or paste any of these.

### 4. Connect and test (dashboard)
1. **Google Docs** tab → **Connect Google Account** → sign in with an account that can **edit** the orders document.
2. Paste the document link (or id) → **Save & test access**. This never opens the document: it asks Drive for the title, type and
   whether the account can edit, and checks that the Google Docs API answers for this account. It takes about a second, whatever
   the document's size.
3. Choose the line format (live preview) → **Save format**.
4. **Turn sync on**. Nothing is written until the next actionable order arrives (or you press **Sync now**).
5. Optional: **Preview outstanding orders** → select → **Add selected** to import existing ones.

## Operations
- **Needs your attention** lists failed writes (retried automatically; *Add now* / *Retry now* for impatience) and lines whose result
  is unknown (see above).
- Revoked or expired Google access → health "Google needs to be reconnected", nothing is written; **Reconnect** restores it.
  Reconnecting a *different* account switches sync off until access is tested again.
- Changing the document switches sync off; the new document only receives orders from the moment it is turned on.
- **Disconnect** revokes the token at Google, deletes the stored credential and switches sync off. Lines already in the document stay.
- Legacy: earlier versions managed a marked "AI ORDERS" section with in-place updates. That behaviour is gone; the settings columns for
  it remain in the database but are unused, and the app no longer reads or edits any such section.
