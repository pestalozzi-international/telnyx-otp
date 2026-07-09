import json
import re

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime, time_diff_in_seconds

# Keyword-anchored match first (works for both channels, and is the only
# thing we trust for Email, where prose is full of stray 4-8 digit numbers
# like zip codes, years, and tracking IDs).
CODE_KEYWORD_PATTERN = re.compile(
	r"(?:verification code|passcode|one-time code|security code|otp|code|pin)"
	r"[^0-9A-Za-z]{0,15}([A-Z]{0,3}-?\d{4,8})",
	re.IGNORECASE,
)
LETTER_DASH_PATTERN = re.compile(r"\b[A-Z]{1,3}-\d{4,8}\b")
DASH_DIGIT_PATTERN = re.compile(r"\b\d{3}[-\s]\d{3}\b")
BARE_DIGIT_PATTERN = re.compile(r"\b\d{4,8}\b")

# Many auth emails send a link instead of (or alongside) a code - "click to
# verify", "confirm your email", "reset your password", "sign in with this
# link". These keywords are checked against the link's anchor text and the
# URL itself.
LINK_KEYWORD_PATTERN = re.compile(
	r"(verify|confirm|activat|reset|unlock|recover|sign[- ]?in|log[- ]?in|"
	r"authenticat|validate|secure your account|check activity|magic link)",
	re.IGNORECASE,
)
ANCHOR_PATTERN = re.compile(r'<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
TAG_PATTERN = re.compile(r"<[^>]+>")
URL_PATTERN = re.compile(r"https?://\S+")


def extract_otp(text: str, channel: str = "SMS") -> str:
	"""
	Best-effort extraction of an OTP/verification code from a message body.

	SMS bodies are short and almost always *just* the code plus a sentence,
	so a bare 4-8 digit run is a safe fallback there. Email bodies are full
	of prose (zip codes, years, tracking numbers), so for Email we only
	trust a match that's anchored to a code-ish keyword or an explicit
	letter-dash format - never a bare digit run.
	"""
	if not text:
		return ""

	match = CODE_KEYWORD_PATTERN.search(text)
	if match:
		return match.group(1)

	match = LETTER_DASH_PATTERN.search(text)
	if match:
		return match.group(0)

	match = DASH_DIGIT_PATTERN.search(text)
	if match:
		return match.group(0)

	if channel == "SMS":
		match = BARE_DIGIT_PATTERN.search(text)
		if match:
			return match.group(0)

	return ""


def extract_action_links(body_html: str, body_text: str) -> list:
	"""
	Pull out likely verification/confirmation/sign-in/reset links from an
	email. A lot of account-security emails send a link rather than a code -
	this is what surfaces those prominently in the inbox instead of leaving
	the user to dig through the full rendered body.
	"""
	links = []

	if body_html:
		for href, inner in ANCHOR_PATTERN.findall(body_html):
			anchor_text = " ".join(TAG_PATTERN.sub(" ", inner).split())
			haystack = f"{anchor_text} {href}"
			if LINK_KEYWORD_PATTERN.search(haystack):
				links.append({"text": anchor_text or href, "url": href})

	if not links and body_text:
		for url in URL_PATTERN.findall(body_text):
			idx = body_text.find(url)
			context = body_text[max(0, idx - 60):idx]
			if LINK_KEYWORD_PATTERN.search(context) or LINK_KEYWORD_PATTERN.search(url):
				links.append({"text": url, "url": url.rstrip(">).,")})

	seen = set()
	deduped = []
	for link in links:
		if link["url"] not in seen:
			seen.add(link["url"])
			deduped.append(link)
	return deduped[:5]


def get_settings():
	return frappe.get_cached_doc("Telnyx OTP Settings")


class OTPMessage(Document):
	def validate(self):
		if not self.channel:
			self.channel = "SMS"

		if not self.otp_code:
			source_text = self.message or self.body_text or ""
			self.otp_code = extract_otp(source_text, self.channel)

		if self.channel == "Email" and not self.action_links:
			links = extract_action_links(self.body_html, self.body_text)
			self.action_links = json.dumps(links) if links else ""

		if not self.status:
			# No code extracted (e.g. a security-alert email with no OTP in
			# it, or one that only carries a verification link) -> it's
			# informational, not something to track through a used/expired
			# lifecycle. The link itself doesn't expire in our system either
			# way - the provider's own link expiry still applies.
			self.status = "New" if self.otp_code else "Info"


def notify_new_otp(doc, method=None):
	"""Push the new message to any open desk pages via websocket."""
	frappe.publish_realtime(
		event="sms_otp_new",
		message={
			"name": doc.name,
			"otp_code": doc.otp_code,
			"channel": doc.channel,
			"from_display": doc.from_display,
			"to_display": doc.to_display,
			"subject": doc.subject,
			"endpoint": doc.endpoint,
			"message": doc.message,
			"received_at": str(doc.received_at) if doc.received_at else None,
			"status": doc.status,
			"has_links": bool(doc.action_links),
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
	doc = frappe.get_doc("OTP Message", name)
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
	  - New -> Expired, `expiry_minutes` after received_at
	'Info' rows (no code was ever found, e.g. a plain security-alert email
	or a link-only email) are left alone - there's nothing to expire or use
	on our side.
	"""
	settings = get_settings()
	expiry_minutes = settings.expiry_minutes or 10
	grace_seconds = settings.copied_grace_seconds or 60
	now = now_datetime()

	open_rows = frappe.get_all(
		"OTP Message",
		filters={"status": ["not in", ["Used", "Expired", "Info"]]},
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
				"OTP Message",
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
