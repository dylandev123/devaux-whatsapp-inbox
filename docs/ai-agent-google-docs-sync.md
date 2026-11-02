# Google Docs order sync

Adds new WhatsApp orders, as one paragraph each, to a Google Doc your staff already maintain. Supabase stays the authoritative
order record; the document is a mirror. Managed entirely from **AI Agent → Google Docs**. **Off by default** for every business.

## What it does (and never does)

- Adds its own clearly marked section (`▼ AI ORDERS [business] … ▼` … `▲ END OF AI ORDERS [business] ▲`) the first time an order
  syncs, at the top, the end, or directly after a heading you name. Everything else in the document — text, headings, lists, styles —
  is left alone. New orders go directly under the section's first line, so **newest is first**.
- Each line ends with a small grey order id (`⟨E-7K2QX⟩`). The app finds its own line by that id, so a retry, a reconnect or a crash can
  never add the same order twice.
- **Manual edits are protected.** The app remembers the exact text it wrote. A line is rewritten or removed only if the paragraph still
  holds exactly that text. If a person changed it (or removed it, or the id is duplicated) the change is *held* in the dashboard with
  both versions and you choose; the document is not touched. Writes are also guarded by Google's document revision id, so a write
  based on a stale read is rejected whole and retried against the fresh text.
- Missing details are shown as `(no phone)`, `(no location)`, `(no name)`, `(no items)` — never guessed. Orders that might not be
  orders (flagged for review), or that have no products yet, are not listed.
- Only orders created **after sync was turned on** sync automatically. Older outstanding orders come in only through the one-time
  **import** (preview first, then explicit confirmation).
- Settings for completed, cancelled (keep + label + strike through / leave / remove) and corrected orders (update in place / hold for
  approval).
- Never sends a WhatsApp message (the integration does not touch the outbox).

## One-time setup

### 1. Run the SQL migration
Supabase SQL editor → run `supabase/migrations/20261112000000_ai_agent_google_docs_sync.sql` (additive, idempotent). Until then the
tab shows "setup pending" and nothing else changes.

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

Why those scopes: `documents` reads and edits the document; `drive.metadata.readonly` is used only to read the document's title and
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
2. Paste the document link (or id) → **Save & test access**. This only reads. It reports the title, whether the account can edit,
   and where the section would go.
3. Choose the line format (live preview), insertion position and the completed / cancelled / corrected rules → **Save**.
4. **Turn sync on**. Nothing is written until the next actionable order arrives (or you press **Sync now**).
5. Optional: **Preview outstanding orders** → select → **Add selected** to import existing ones.

## Operations
- The sync runs right after an order is created or changed, and on every tick of `/api/cron/ai-agent/batches` (so changes made by
  staff commands are picked up too). Overlapping runs are serialised by a database lease.
- **Needs your attention** lists held conflicts, held corrections, removed lines and failed writes, with *Retry* / *Add again* /
  *Keep the document's version* / *Use the app's version*.
- Revoked or expired Google access → health "Google needs to be reconnected", nothing is written; **Reconnect** restores it.
  Reconnecting a *different* account switches sync off until access is tested again.
- Changing the document switches sync off and starts the new one empty (older orders via import).
- **Disconnect** revokes the token at Google, deletes the stored credential and switches sync off. Lines already in the document stay.
- Do not rename the two marker lines. If one is damaged the dashboard says so and writes stop until it is restored.
