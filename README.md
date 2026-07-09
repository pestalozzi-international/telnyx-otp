# OTP Inbox (Telnyx SMS + Mailgun Email, via n8n)

A Frappe app that watches inbound SMS (Telnyx) and inbound email (Mailgun),
both relayed through n8n, and shows verification codes and security alerts
in a single live inbox — useful when you're juggling verification/recovery
flows for several accounts at once.

> The app's Python package is still named `telnyx_otp` to match this repo,
> even though it now also handles email. Renaming the package is a bigger,
> more disruptive change (it touches every module path and any installed
> site's migration history) — happy to do it in a follow-up if you'd
> rather the package name match the new scope too.

## What it gives you

- **OTP Message** doctype — every inbound SMS or email is stored here.
  - `channel` — `SMS` or `Email`.
  - `otp_code` — auto-extracted from the message where possible.
  - `status` — `New → Copied → Used`, or `Expired` if it timed out, or
    `Info` for messages where no code was found (e.g. a plain security
    alert like "new backup codes generated" — still useful to see, but
    nothing to copy or expire).
  - For email: `subject`, `body_text`, `body_html` (the full formatted
    email, viewable from the inbox).
- **Monitored Endpoint** doctype — register each phone number or email
  address you're watching, with a friendly label (e.g. "Google – Account
  1", "Recovery inbox – client X"). Used to filter the inbox by account.
- **Telnyx OTP Settings** — one place to set:
  - `expiry_minutes` (default **10**) — after this long since receipt, a
    code is marked **Expired**.
  - `copied_grace_seconds` (default **60**) — after clicking Copy, the code
    stays visible for this long before flipping to **Used**.
- **Two webhook endpoints**:
  - `POST /api/method/telnyx_otp.api.webhook.receive` — SMS (Telnyx, direct
    or relayed through n8n/Zoho Flow).
  - `POST /api/method/telnyx_otp.api.webhook.receive_email` — Email
    (Mailgun inbound route, relayed through n8n).
- **OTP Inbox page** (desk — search "OTP Inbox" in the awesomebar):
  - Filter by account (endpoint) and by channel (SMS / Email).
  - SMS messages show the code big and monospace with a Copy button.
  - Email messages show the subject + snippet, with a "View email" button
    that opens the original formatted HTML in a sandboxed preview (no
    script execution — safe against anything embedded in the email).
  - Status badges, live push updates over websockets as new messages
    arrive, and a status sweep every minute in the background.
- **Duplicate protection** — SMS uses the Telnyx message `id`; email uses
  the `Message-Id` header. Retried webhook deliveries are ignored.

## About the payload shapes

Both SMS and email arrive wrapped by n8n, but not identically:

**SMS (Telnyx)** — nested two levels under `webhookTrigger.payload.data.payload`
in the Zoho-Flow-style relay, or flatter if n8n forwards Telnyx's raw
`data.payload` shape directly. `webhook.py`'s `_unwrap_sms()` tries, in
order: an n8n `body` wrapper, the `webhookTrigger.payload.data.payload`
nesting, the raw Telnyx `data.payload` shape, then falls back to already-flat.

**Email (Mailgun)** — arrives flatter, as `webhookTrigger.payload` directly
holding the Mailgun form fields (`sender`, `recipient`, `From`, `To`,
`Subject`, `stripped-text`, `body-plain`, `Message-Id`, etc). Mailgun's
field names use hyphens; n8n commonly sanitizes those into double
underscores when building JSON keys (`body-plain` → `body__plain`,
`Message-Id` → `Message__Id`). `_unwrap_email()`/`_first()` check both
spellings for every field, so it works either way.

In both cases, the safest setup on the n8n side is still to forward the
original JSON body untouched — fewer moving parts to keep in sync if
Telnyx, Mailgun, or n8n itself changes field naming.

## OTP extraction

`telnyx_otp/telnyx_otp/doctype/otp_message/otp_message.py` → `extract_otp()`:

1. A code near a keyword ("code", "otp", "passcode", "verification code",
   "pin", …) — trusted for both channels.
2. An explicit `LETTERS-DIGITS` format (e.g. `G-723660`).
3. A `DDD-DDD` / `DDD DDD` format (e.g. `723-660`).
4. **SMS only** — any standalone 4-8 digit run, as a fallback. This is
   *not* applied to email, because email prose is full of things that look
   like a code but aren't (zip codes, tracking numbers, years) — the
   Google "backup codes generated" alert in our test payload, for example,
   has no code at all, and would have false-matched on "94043" (the zip
   code in Google's footer) if we applied the SMS fallback there. Email
   messages with no confidently-extracted code just land as `status =
   Info`, no code shown, nothing to copy.

## Install

```bash
bench get-app https://github.com/pestalozzi-international/telnyx-otp.git
bench --site your-site.local install-app telnyx_otp
bench --site your-site.local migrate
bench restart
```

Then, in the desk:
1. Open **Telnyx OTP Settings** and confirm/adjust `expiry_minutes` and
   `copied_grace_seconds`.
2. Add your numbers and monitored inboxes in **Monitored Endpoint** (this
   also happens automatically on first inbound message, but pre-naming
   them is nicer).
3. Point your n8n workflows' outbound HTTP nodes at:
   - SMS: `https://your-site.example.com/api/method/telnyx_otp.api.webhook.receive`
   - Email: `https://your-site.example.com/api/method/telnyx_otp.api.webhook.receive_email`

No API key is required on either endpoint (`allow_guest=True`), since
webhooks can't complete Frappe's session-based CSRF flow. Lock it down
further if you want — a shared-secret query param check at the top of each
function, or a reverse-proxy IP allowlist for n8n's egress IPs, or verifying
Mailgun's HMAC signature (`token` + `timestamp` + `signature` fields are
already coming through in the payload if you want to add that check).

## Permissions

Only `System Manager` can read/write by default. Add roles in the doctype
JSON permissions and the `otp-inbox` page's `roles` list if others need
access.
