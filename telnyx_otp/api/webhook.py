import json
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

import frappe
from frappe.utils import now_datetime, get_datetime


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _get_or_create_endpoint(endpoint_type: str, value: str):
	if not value:
		return None
	if not frappe.db.exists("Monitored Endpoint", value):
		frappe.get_doc(
			{
				"doctype": "Monitored Endpoint",
				"endpoint_type": endpoint_type,
				"value": value,
				"label": value,
				"is_active": 1,
			}
		).insert(ignore_permissions=True)
	return value


def _parse_body() -> dict:
	try:
		raw = frappe.request.get_data(as_text=True)
		return json.loads(raw) if raw else {}
	except Exception:
		frappe.throw("Invalid JSON body")


def _to_naive_system_time(dt):
	"""
	MySQL's DATETIME column is timezone-naive and Frappe always stores
	datetimes as naive values in the site's system timezone. External
	payloads, though, often carry an explicit UTC offset (Telnyx:
	"+00:00", Mailgun/email Date headers: "+05:30") and/or microseconds -
	MySQL rejects a string like '2026-07-09 19:12:21+05:30' outright
	(error 1292), which is what caused the two webhook 500s. This
	converts any timezone-aware datetime to the site's system timezone
	and strips the tzinfo before it ever reaches the database.
	"""
	if dt is None or dt.tzinfo is None:
		return dt
	try:
		tz_name = frappe.utils.get_system_timezone()
		tz = ZoneInfo(tz_name)
	except Exception:
		tz = ZoneInfo("UTC")
	return dt.astimezone(tz).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# SMS (Telnyx, relayed via n8n or Zoho Flow)
# ---------------------------------------------------------------------------

def _unwrap_sms(body: dict) -> dict:
	"""
	Different relays wrap the actual Telnyx SMS event differently.

	1) n8n, when a workflow forwards the whole item it received from a prior
	   Webhook node instead of just its `body`, nests everything one level
	   deeper under "body".
	2) Zoho-Flow-relayed shape:
	   {"webhookTrigger": {"payload": {"data": {"payload": {...}}}}}
	3) Raw Telnyx webhook shape:
	   {"data": {"event_type": ..., "payload": {...}}}
	4) Already-unwrapped payload:
	   {"from": {...}, "to": [...], "text": "...", ...}

	If your n8n workflow flattens/renames fields with a Set/Edit Fields node
	before forwarding, adjust this to match - the safest setup is to have
	n8n forward the original JSON body untouched.
	"""
	if isinstance(body.get("body"), dict):
		body = body["body"]

	if "webhookTrigger" in body:
		try:
			return body["webhookTrigger"]["payload"]["data"]["payload"]
		except (KeyError, TypeError):
			pass

	if isinstance(body.get("data"), dict) and "payload" in body["data"]:
		return body["data"]["payload"]

	if isinstance(body.get("payload"), dict):
		return body["payload"]

	return body


@frappe.whitelist(allow_guest=True)
def receive():
	"""
	SMS webhook target (Telnyx, direct or relayed via n8n/Zoho Flow). Point
	your provider/relay at:

		https://<your-site>/api/method/telnyx_otp.api.webhook.receive
	"""
	body = _parse_body()
	payload = _unwrap_sms(body)

	event_id = payload.get("id")
	text = payload.get("text") or ""

	from_number = (payload.get("from") or {}).get("phone_number")

	to_list = payload.get("to") or []
	to_number = to_list[0].get("phone_number") if to_list else None

	received_at = payload.get("received_at")
	received_at = get_datetime(received_at) if received_at else now_datetime()
	received_at = _to_naive_system_time(received_at)

	if event_id and frappe.db.exists("OTP Message", {"event_id": event_id}):
		return {"status": "duplicate", "event_id": event_id}

	endpoint = _get_or_create_endpoint("SMS", to_number)

	doc = frappe.get_doc(
		{
			"doctype": "OTP Message",
			"channel": "SMS",
			"event_id": event_id,
			"from_display": from_number,
			"to_display": to_number,
			"endpoint": endpoint,
			"message": text,
			"received_at": received_at,
			"provider": "Telnyx",
			"raw_payload": json.dumps(body, indent=2),
		}
	)
	doc.insert(ignore_permissions=True)
	frappe.db.commit()

	return {"status": "ok", "name": doc.name, "otp_code": doc.otp_code}


# ---------------------------------------------------------------------------
# Email (Mailgun inbound routes, relayed via n8n)
# ---------------------------------------------------------------------------

def _unwrap_email(body: dict) -> dict:
	"""
	n8n's default HTTP Request/Webhook combo tends to arrive as:
	{"webhookTrigger": {"payload": {<mailgun fields, flat>}}}

	Mailgun's own field names use hyphens ('body-plain', 'Message-Id',
	'X-Notifications'); n8n commonly sanitizes those to double underscores
	when it turns them into JSON keys ('body__plain', 'Message__Id',
	'X__Notifications'). We check both spellings for every field.
	"""
	if isinstance(body.get("body"), dict):
		body = body["body"]

	if "webhookTrigger" in body:
		try:
			body = body["webhookTrigger"]["payload"]
		except (KeyError, TypeError):
			pass
	elif isinstance(body.get("payload"), dict):
		body = body["payload"]

	return body


def _first(payload: dict, *keys):
	for key in keys:
		value = payload.get(key)
		if value:
			return value
	return None


@frappe.whitelist(allow_guest=True)
def receive_email():
	"""
	Email webhook target (Mailgun inbound route, relayed via n8n). Point your
	n8n workflow's outbound HTTP node at:

		https://<your-site>/api/method/telnyx_otp.api.webhook.receive_email
	"""
	body = _parse_body()
	payload = _unwrap_email(body)

	message_id = _first(payload, "Message__Id", "Message-Id", "message_id")
	event_id = (message_id or "").strip("<>") or frappe.generate_hash(length=16)

	from_display = _first(payload, "From", "from", "sender")
	to_display = _first(payload, "recipient", "To", "to")
	subject = _first(payload, "Subject", "subject") or ""

	# Prefer Mailgun's full body-plain/body-html over its stripped-text/
	# stripped-html variants. "stripped" is Mailgun's own heuristic to
	# drop quoted/forwarded content, treating it as noise - but for this
	# app that's often exactly where the useful content is (a forwarded
	# security alert, a quoted verification link, etc). Only fall back to
	# the stripped fields if the full ones aren't present at all.
	body_text = _first(payload, "body__plain", "body-plain", "stripped__text", "stripped-text") or ""
	body_html = _first(payload, "body__html", "body-html", "stripped__html", "stripped-html") or ""

	date_str = _first(payload, "Date", "date")
	received_at = None
	if date_str:
		try:
			received_at = parsedate_to_datetime(date_str)
		except (TypeError, ValueError):
			received_at = None
	received_at = received_at or now_datetime()
	received_at = _to_naive_system_time(received_at)

	if frappe.db.exists("OTP Message", {"event_id": event_id}):
		return {"status": "duplicate", "event_id": event_id}

	endpoint = _get_or_create_endpoint("Email", to_display)

	# Snippet for list views / the inbox card: first ~200 chars of the
	# plain-text body, collapsed to one line.
	snippet = " ".join(body_text.split())[:200]

	doc = frappe.get_doc(
		{
			"doctype": "OTP Message",
			"channel": "Email",
			"event_id": event_id,
			"from_display": from_display,
			"to_display": to_display,
			"endpoint": endpoint,
			"subject": subject,
			"message": snippet,
			"body_text": body_text,
			"body_html": body_html,
			"received_at": received_at,
			"provider": "Mailgun",
			"raw_payload": json.dumps(body, indent=2),
		}
	)
	doc.insert(ignore_permissions=True)
	frappe.db.commit()

	return {"status": "ok", "name": doc.name, "otp_code": doc.otp_code}
