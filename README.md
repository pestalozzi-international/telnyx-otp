# Telnyx OTP

Receives inbound SMS webhooks (Telnyx, relayed through n8n or Zoho Flow) and
shows OTP codes in a live, per-number inbox inside Frappe desk — with
copied/used/expired tracking, for verifying multiple accounts side by side.

## What it gives you

- **SMS OTP** doctype — every inbound message is stored, OTP code
  auto-extracted from the text, linked to the receiving number.
- **OTP Phone Number** doctype — register each of your Telnyx numbers with a
  friendly label (e.g. "Google – Account 1"). Used to filter the inbox.
- **Telnyx OTP Settings** — one place to set:
  - `expiry_minutes` (default **10**) — after this long since receipt, a
    code is marked **Expired**.
  - `copied_grace_seconds` (default **60**) — after clicking Copy, the code
    stays visible for this long before flipping to **Used**.
- **Webhook endpoint** — `POST /api/method/telnyx_otp.api.webhook.receive`.
  Handles three payload shapes automatically (see "About the n8n payload"
  below).
- **OTP Inbox page** (search "OTP Inbox" in the awesomebar) — big monospace
  codes, a dropdown to pick which number/account you're watching, a status
  badge (New / Copied / Used / Expired), and live push updates over
  websockets — no refresh needed.
- **Duplicate protection** — the Telnyx message `id` is stored as `event_id`
  (unique), so retried/duplicate webhook deliveries are ignored.

## About the n8n payload

Whether the shape n8n sends is *identical* to the Zoho Flow one depends on
how you built the n8n workflow:

- If your n8n workflow just relays the exact body it received (e.g. a
  Webhook trigger piped straight into an HTTP Request node with the raw
  JSON as the body), the shape will match Telnyx's original payload, and
  everything works as-is.
- If n8n's own Webhook trigger node received the request, n8n itself wraps
  the incoming payload as `{"body": {...}, "headers": {...}, ...}`. If your
  workflow forwards `$json` (the whole n8n item) instead of `$json.body`,
  we'll get that extra `body` wrapper.
- If you added a Set/Edit Fields node that renames or restructures fields,
  the shape changes further.

To stay robust either way, `telnyx_otp/api/webhook.py` now unwraps, in
order: an n8n `body` wrapper, the Zoho Flow `webhookTrigger` wrapper, the
raw Telnyx `data.payload` wrapper, and finally falls back to the payload
already being flat. The safest setup on the n8n side is still to forward
the original JSON untouched — fewer moving parts to keep in sync.

## Install

```bash
bench get-app /path/to/telnyx_otp        # or a git URL once pushed
bench --site your-site.local install-app telnyx_otp
bench --site your-site.local migrate
bench restart
```

Then, in the desk:
1. Open **Telnyx OTP Settings** and confirm/adjust `expiry_minutes` and
   `copied_grace_seconds`.
2. Add each number you're using in **OTP Phone Number** with a label (this
   also happens automatically on first inbound message, but pre-naming
   them is nicer).
3. Point Telnyx / your n8n workflow's outbound HTTP node at:
   ```
   https://your-site.example.com/api/method/telnyx_otp.api.webhook.receive
   ```

No API key is required (`allow_guest=True`), since webhooks can't complete
Frappe's session-based CSRF flow. Lock it down further if you want, e.g. a
shared-secret query param check at the top of `receive()`, or a
reverse-proxy IP allowlist for Telnyx's/n8n's egress IPs.

## Why 10 minutes for expiry?

Codes like Google's ("G-723660" in your sample) are commonly valid for
around 10 minutes; a lot of banking/2FA codes use 5. Since you're juggling
multiple providers/accounts, we made it a **setting** rather than a
hardcoded value — change `expiry_minutes` in Telnyx OTP Settings any time,
no code changes needed.

## Tuning OTP extraction

`telnyx_otp/telnyx_otp/doctype/sms_otp/sms_otp.py` → `OTP_PATTERNS`, tried in
order:

1. `LETTERS-DIGITS` (e.g. `G-723660`)
2. `DDD-DDD` / `DDD DDD` (e.g. `723-660`)
3. Any standalone run of 4–8 digits

## Permissions

Only `System Manager` can read/write by default. Add roles in the doctype
JSON permissions and the `otp-inbox` page's `roles` list if others need
access.
