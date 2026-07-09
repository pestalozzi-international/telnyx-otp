app_name = "telnyx_otp"
app_title = "OTP Inbox"
app_publisher = "Pestalozzi International"
app_description = (
	"Receives inbound SMS (Telnyx) and email (Mailgun) webhooks - both relayed "
	"through n8n - and shows verification codes and security alerts in a live, "
	"per-account inbox, with used/expired tracking. Built for verifying "
	"multiple accounts at once."
)
app_email = "you@example.com"
app_license = "mit"

# Push new messages to any open desk pages the instant they're inserted
doc_events = {
	"OTP Message": {
		"after_insert": "telnyx_otp.telnyx_otp.doctype.otp_message.otp_message.notify_new_otp"
	}
}

# Runs every minute: flips is_used (60s after copy) and is_expired (after the
# configured expiry window) so the state is correct even if nobody has the
# inbox page open. 'Info' rows (alerts with no code) are left untouched.
scheduler_events = {
	"cron": {
		"* * * * *": [
			"telnyx_otp.telnyx_otp.doctype.otp_message.otp_message.update_otp_statuses"
		]
	}
}
