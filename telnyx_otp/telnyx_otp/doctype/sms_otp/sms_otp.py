import re

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime, time_diff_in_seconds

# Order matters: more specific / higher-confidence patterns first.
OTP_PATTERNS = [
	r"\b[A-Z]{1,3}-\d{4,8}\b",       # G-723660
	r"\b\d{3}[-\s]\d{3}\b",          # 723-660 / 723 660
	r"\b\d{4,8}\b",                  # 723660 (fallback: any 4-8 digit run)
]


def extract_otp(text: str) -> str:
	"""Best-effort extraction of an OTP/verification code from an SMS body."""
	if not text:
		return ""

	for pattern in OTP_PATTERNS:
		match = re.search(pattern, text)
		if match:
			return match.group(0)

	return ""


def get_settings():
	return frappe.get_cached_doc("Telnyx OTP Settings")


class SMSOTP(Document):
	def validate(self):
		if not self.otp_code and self.message:
			self.otp_code = extract_otp(self.message)

		if not self.status:
			self.status = "New"


def notify_new_otp(doc, method=None):
	"""Push the new OTP to any open desk pages via websocket."""
	frappe.publish_realtime(
		event="sms_otp_new",
		message={
			"name": doc.name,
			"otp_code": doc.otp_code,
			"from_number": doc.from_number,
			"to_number": doc.to_number,
			"phone_number": doc.phone_number,
			"message": doc.message,
			"received_at": str(doc.received_at) if doc.received_at else None,
			"status": doc.status,
		},
	)


@frappe.whitelist()
def mark_copied(name: str):
	"""
	Called from the inbox UI the moment the user clicks 'Copy'.
	Records copied_at now; the scheduled job flips status -> Used after the
	configured grace period so the code still reads as active for a moment
	after copying (e.g. while it's being pasted into the target site).
	"""
	doc = frappe.get_doc("SMS OTP", name)
	if not doc.copied_at:
		doc.copied_at = now_datetime()
		if doc.status == "New":
			doc.status = "Copied"
		doc.save(ignore_permissions=True)
		frappe.db.commit()
	return {"copied_at": str(doc.copied_at), "status": doc.status}


def update_otp_statuses():
	"""
	Scheduled every minute (see hooks.py). Keeps status accurate even when
	nobody has the inbox page open:
	  - Copied -> Used, `copied_grace_seconds` after copied_at
	  - anything not yet Used -> Expired, `expiry_minutes` after received_at
	"""
	settings = get_settings()
	expiry_minutes = settings.expiry_minutes or 10
	grace_seconds = settings.copied_grace_seconds or 60
	now = now_datetime()

	open_rows = frappe.get_all(
		"SMS OTP",
		filters={"status": ["not in", ["Used", "Expired"]]},
		fields=["name", "status", "received_at", "copied_at"],
	)

	for row in open_rows:
		new_status = row.status

		if row.copied_at and time_diff_in_seconds(now, row.copied_at) >= grace_seconds:
			new_status = "Used"
		elif row.received_at and time_diff_in_seconds(now, row.received_at) >= expiry_minutes * 60:
			new_status = "Expired"

		if new_status != row.status:
			frappe.db.set_value(
				"SMS OTP",
				row.name,
				{
					"status": new_status,
					"is_used": 1 if new_status == "Used" else 0,
					"is_expired": 1 if new_status == "Expired" else 0,
				},
				update_modified=False,
			)
			frappe.publish_realtime(
				event="sms_otp_status",
				message={"name": row.name, "status": new_status},
			)

	frappe.db.commit()
