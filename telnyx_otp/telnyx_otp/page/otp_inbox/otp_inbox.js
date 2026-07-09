frappe.pages["otp-inbox"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "OTP Inbox",
		single_column: true,
	});

	new OTPInbox(page);
};

const STATUS_COLORS = {
	New: "blue",
	Copied: "orange",
	Used: "grey",
	Expired: "red",
};

class OTPInbox {
	constructor(page) {
		this.page = page;
		this.selected_number = ""; // "" = all numbers
		this.cards = {}; // name -> {data, $el}

		this.render_styles();
		this.render_filter();

		this.$container = $('<div class="otp-inbox"></div>').appendTo(page.body);

		this.page.set_secondary_action("Refresh", () => this.load());

		this.load_numbers().then(() => this.load());

		// New OTP inserted anywhere
		frappe.realtime.on("sms_otp_new", (data) => {
			if (this.selected_number && data.phone_number !== this.selected_number) return;
			this.upsert_card(data, true);
			frappe.show_alert({
				message: __("New OTP received: {0}", [data.otp_code || "?"]),
				indicator: "green",
			});
		});

		// Status flips pushed by the once-a-minute scheduler job
		frappe.realtime.on("sms_otp_status", (data) => {
			this.update_status_badge(data.name, data.status);
		});

		// Client-side ticker so "Copied" cards visibly count down to Used
		// even before the server-side job runs.
		this.ticker = setInterval(() => this.tick(), 1000);
	}

	render_styles() {
		if ($("#otp-inbox-style").length) return;
		$(`<style id="otp-inbox-style">
			.otp-inbox { padding: 15px; }
			.otp-filter-bar { padding: 0 15px 10px; }
			.otp-card {
				display: flex;
				align-items: center;
				justify-content: space-between;
				background: var(--card-bg, #fff);
				border: 1px solid var(--border-color);
				border-radius: 8px;
				padding: 14px 18px;
				margin-bottom: 10px;
			}
			.otp-card.is-used, .otp-card.is-expired { opacity: 0.55; }
			.otp-card .otp-left { flex: 1; }
			.otp-card .otp-top-row { display: flex; align-items: center; gap: 10px; }
			.otp-card .otp-code {
				font-size: 26px;
				font-weight: 700;
				letter-spacing: 1px;
				font-family: monospace;
			}
			.otp-card .otp-meta {
				font-size: 12px;
				color: var(--text-muted);
				margin-top: 4px;
			}
			.otp-card .otp-message {
				font-size: 13px;
				color: var(--text-color);
				margin-top: 4px;
			}
			.otp-card .otp-copy-btn { margin-left: 12px; }
			.otp-badge {
				font-size: 11px;
				padding: 2px 8px;
				border-radius: 10px;
				text-transform: uppercase;
				font-weight: 600;
			}
		</style>`).appendTo("head");
	}

	render_filter() {
		this.$filter_bar = $(`
			<div class="otp-filter-bar">
				<select class="form-control otp-number-select" style="max-width: 320px; display: inline-block;">
					<option value="">${__("All numbers")}</option>
				</select>
			</div>
		`).appendTo(this.page.body);

		this.$filter_bar.find(".otp-number-select").on("change", (e) => {
			this.selected_number = e.target.value;
			this.load();
		});
	}

	load_numbers() {
		return frappe.call({
			method: "frappe.client.get_list",
			args: {
				doctype: "OTP Phone Number",
				fields: ["name", "phone_number", "label", "is_active"],
				filters: { is_active: 1 },
				limit_page_length: 0,
			},
			callback: (r) => {
				const $select = this.$filter_bar.find(".otp-number-select");
				(r.message || []).forEach((row) => {
					$select.append(
						`<option value="${frappe.utils.escape_html(row.name)}">${frappe.utils.escape_html(
							row.label || row.phone_number
						)}</option>`
					);
				});
			},
		});
	}

	load() {
		const filters = {};
		if (this.selected_number) filters.phone_number = this.selected_number;

		frappe.call({
			method: "frappe.client.get_list",
			args: {
				doctype: "SMS OTP",
				fields: [
					"name",
					"otp_code",
					"from_number",
					"to_number",
					"phone_number",
					"message",
					"received_at",
					"copied_at",
					"status",
				],
				filters,
				order_by: "received_at desc",
				limit_page_length: 50,
			},
			callback: (r) => {
				this.$container.empty();
				this.cards = {};
				(r.message || []).forEach((row) => this.upsert_card(row, false));
				if (!r.message || !r.message.length) {
					this.$container.html(`<div class="text-muted">${__("No OTPs received yet.")}</div>`);
				}
			},
		});
	}

	seconds_since(iso) {
		if (!iso) return null;
		return (Date.now() - new Date(iso.replace(" ", "T") + "Z").getTime()) / 1000;
	}

	make_card(data) {
		const code = frappe.utils.escape_html(data.otp_code || "—");
		const from = frappe.utils.escape_html(data.from_number || "");
		const to = frappe.utils.escape_html(data.to_number || "");
		const message = frappe.utils.escape_html(data.message || "");
		const when = data.received_at ? comment_when(data.received_at) : "";
		const status = data.status || "New";

		const $card = $(`
			<div class="otp-card" data-name="${data.name}">
				<div class="otp-left">
					<div class="otp-top-row">
						<div class="otp-code">${code}</div>
						<span class="otp-badge" style="background: var(--bg-${STATUS_COLORS[status] || "blue"}); color: var(--text-on-${STATUS_COLORS[status] || "blue"}, #fff);">${status}</span>
					</div>
					<div class="otp-meta">${__("From")} ${from} ${__("to")} ${to} · ${when}</div>
					<div class="otp-message">${message}</div>
				</div>
				<button class="btn btn-sm btn-default otp-copy-btn">${__("Copy")}</button>
			</div>
		`);

		$card.find(".otp-copy-btn").on("click", () => {
			frappe.utils.copy_to_clipboard(data.otp_code || "");
			frappe.show_alert({ message: __("Copied"), indicator: "blue" });
			frappe.call({
				method: "telnyx_otp.telnyx_otp.doctype.sms_otp.sms_otp.mark_copied",
				args: { name: data.name },
				callback: (r) => {
					if (r.message) {
						data.copied_at = r.message.copied_at;
						data.status = r.message.status;
						this.update_status_badge(data.name, data.status);
					}
				},
			});
		});

		return $card;
	}

	upsert_card(data, prepend) {
		if (this.cards[data.name]) {
			this.cards[data.name].data = data;
			this.update_status_badge(data.name, data.status || "New");
			return;
		}
		const $el = this.make_card(data);
		this.cards[data.name] = { data, $el };
		if (prepend) this.$container.prepend($el);
		else this.$container.append($el);
	}

	update_status_badge(name, status) {
		const entry = this.cards[name];
		if (!entry) return;
		entry.data.status = status;
		const $badge = entry.$el.find(".otp-badge");
		$badge.text(status);
		$badge.css({
			background: `var(--bg-${STATUS_COLORS[status] || "blue"})`,
			color: `var(--text-on-${STATUS_COLORS[status] || "blue"}, #fff)`,
		});
		entry.$el.toggleClass("is-used", status === "Used");
		entry.$el.toggleClass("is-expired", status === "Expired");
	}

	tick() {
		// Purely visual: nudge "Copied" cards toward "Used" client-side so the
		// UI feels live between scheduler runs. The scheduler job remains the
		// source of truth and will correct/broadcast the real status.
		Object.values(this.cards).forEach(({ data }) => {
			if (data.status === "Copied" && data.copied_at) {
				const secs = this.seconds_since(data.copied_at);
				if (secs !== null && secs >= 60) {
					this.update_status_badge(data.name, "Used");
				}
			}
		});
	}
}
