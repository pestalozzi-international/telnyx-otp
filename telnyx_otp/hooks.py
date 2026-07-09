app_name = "telnyx_otp"
app_title = "Telnyx OTP"
app_publisher = "Pestalozzi International"
app_description = "Receives inbound SMS webhooks (Telnyx, via n8n/Zoho Flow) and displays OTP codes in a live, per-number inbox with used/expired tracking"
app_email = "you@example.com"
app_license = "mit"

# Push new OTPs to any open desk pages the instant they're inserted
doc_events = {
	"SMS OTP": {
		"after_insert": "telnyx_otp.telnyx_otp.doctype.sms_otp.sms_otp.notify_new_otp"
	}
}

# Runs every minute: flips is_used (60s after copy) and is_expired (after the
# configured expiry window) so the state is correct even if nobody has the
# inbox page open.
scheduler_events = {
	"cron": {
		"* * * * *": [
			"telnyx_otp.telnyx_otp.doctype.sms_otp.sms_otp.update_otp_statuses"
		]
	}
}
