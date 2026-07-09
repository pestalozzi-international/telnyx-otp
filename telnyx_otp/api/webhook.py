import json

import frappe
from frappe.utils import now_datetime, get_datetime


def _unwrap(body: dict) -> dict:
	"""
	Different relays wrap the actual Telnyx SMS event differently. Handle all
	of these and return the inner dict that contains from/to/text/id/etc.

	1) n8n, when the flow re-sends the exact body it received from a
	   previous webhook node, often nests it one level under "body":
	   {"body": {...same as case 2 or 3...}}

	2) Zoho-Flow-relayed shape:
	   {"webhookTrigger": {"payload": {"data": {"payload": {...}}}}}

	3) Raw Telnyx webhook shape:
	   {"data": {"event_type": ..., "payload": {...}}}

	4) Already-unwrapped payload:
	   {"from": {...}, "to": [...], "text": "...", ...}

	If your n8n workflow instead flattens/renames fields with a Set/Edit
	Fields node before forwarding, adjust this function to match whatever
	shape actually arrives - the safest option is to configure n8n's HTTP
	Request node to forward the original JSON body untouched.
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


def _get_or_create_phone_number(number: str):
	if not number:
		return None
	if not frappe.db.exists("OTP Phone Number", number):
		frappe.get_doc(
			{
				"doctype": "OTP Phone Number",
				"phone_number": number,
				"label": number,
				"is_active": 1,
			}
		).insert(ignore_permissions=True)
	return number


@frappe.whitelist(allow_guest=True)
def receive():
	"""
	Webhook target. Point Telnyx (or an n8n / Zoho Flow relay in front of it)
	at:

		https://<your-site>/api/method/telnyx_otp.api.webhook.receive

	Accepts the raw JSON body of the request.
	"""
	try:
		raw = frappe.request.get_data(as_text=True)
		body = json.loads(raw) if raw else {}
	except Exception:
		frappe.throw("Invalid JSON body")

	payload = _unwrap(body)

	event_id = payload.get("id")
	text = payload.get("text") or ""

	from_number = (payload.get("from") or {}).get("phone_number")

	to_list = payload.get("to") or []
	to_number = to_list[0].get("phone_number") if to_list else None

	received_at = payload.get("received_at")
	received_at = get_datetime(received_at) if received_at else now_datetime()

	# Idempotency: if we've already stored this event, don't duplicate it.
	if event_id and frappe.db.exists("SMS OTP", {"event_id": event_id}):
		return {"status": "duplicate", "event_id": event_id}

	phone_number = _get_or_create_phone_number(to_number)

	doc = frappe.get_doc(
		{
			"doctype": "SMS OTP",
			"event_id": event_id,
			"from_number": from_number,
			"to_number": to_number,
			"phone_number": phone_number,
			"message": text,
			"received_at": received_at,
			"provider": "Telnyx",
			"raw_payload": json.dumps(body, indent=2),
		}
	)
	doc.insert(ignore_permissions=True)
	frappe.db.commit()

	return {"status": "ok", "name": doc.name, "otp_code": doc.otp_code}
