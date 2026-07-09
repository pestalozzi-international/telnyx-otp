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
	Info: "grey",
};

class OTPInbox {
	constructor(page) {
		this.page = page;
		this.selected_endpoint = ""; // "" = all
		this.selected_channel = ""; // "" = all
		this.cards = {}; // name -> {data, $el}

		this.render_styles();
		this.render_filter();

		this.$container = $('<div class="otp-inbox"></div>').appendTo(page.body);

		this.page.set_secondary_action("Refresh", () => this.load());

		this.load_endpoints().then(() => this.load());

		frappe.realtime.on("sms_otp_new", (data) => {
			if (this.selected_endpoint && data.endpoint !== this.selected_endpoint) return;
			if (this.selected_channel && data.channel !== this.selected_channel) return;
			this.upsert_card(data, true);
			frappe.show_alert({
				message: data.otp_code
					? __("New OTP received: {0}", [data.otp_code])
					: __("New alert: {0}", [data.subject || data.message || ""]),
				indicator: "green",
			});
		});

		frappe.realtime.on("sms_otp_status", (data) => {
			this.update_status_badge(data.name, data.status);
		});

		// Client-side ticker so "Copied" cards visibly count toward Used
		// even before the server-side job runs.
		this.ticker = setInterval(() => this.tick(), 1000);
	}

	render_styles() {
		if ($("#otp-inbox-style").length) return;
		$(`<style id="otp-inbox-style">
			.otp-inbox { padding: 15px; }
			.otp-filter-bar { padding: 0 15px 10px; display: flex; gap: 10px; }
			.otp-filter-bar select { max-width: 260px; }
			.otp-card {
				display: flex;
				align-items: flex-start;
				justify-content: space-between;
				background: var(--card-bg, #fff);
				border: 1px solid var(--border-color);
				border-radius: 8px;
				padding: 14px 18px;
				margin-bottom: 10px;
			}
			.otp-card.is-used, .otp-card.is-expired { opacity: 0.55; }
			.otp-card .otp-left { flex: 1; min-width: 0; }
			.otp-card .otp-top-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
			.otp-card .otp-code {
				font-size: 26px;
				font-weight: 700;
				letter-spacing: 1px;
				font-family: monospace;
			}
			.otp-card .otp-subject {
				font-size: 15px;
				font-weight: 600;
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
				overflow-wrap: anywhere;
			}
			.otp-card .otp-actions { margin-left: 12px; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
			.otp-channel-pill {
				font-size: 10px;
				padding: 1px 7px;
				border-radius: 10px;
				text-transform: uppercase;
				font-weight: 600;
				background: var(--control-bg);
				color: var(--text-muted);
			}
			.otp-badge {
				font-size: 11px;
				padding: 2px 8px;
				border-radius: 10px;
				text-transform: uppercase;
				font-weight: 600;
			}
			.otp-email-frame {
				width: 100%;
				height: 60vh;
				border: 1px solid var(--border-color);
				border-radius: 6px;
				background: #fff;
			}
		</style>`).appendTo("head");
	}

	render_filter() {
		this.$filter_bar = $(`
			<div class="otp-filter-bar">
				<select class="form-control otp-endpoint-select">
					<option value="">${__("All accounts")}</option>
				</select>
				<select class="form-control otp-channel-select">
					<option value="">${__("All channels")}</option>
					<option value="SMS">${__("SMS")}</option>
					<option value="Email">${__("Email")}</option>
				</select>
			</div>
		`).appendTo(this.page.body);

		this.$filter_bar.find(".otp-endpoint-select").on("change", (e) => {
			this.selected_endpoint = e.target.value;
			this.load();
		});
		this.$filter_bar.find(".otp-channel-select").on("change", (e) => {
			this.selected_channel = e.target.value;
			this.load();
		});
	}

	load_endpoints() {
		return frappe.call({
			method: "frappe.client.get_list",
			args: {
				doctype: "Monitored Endpoint",
				fields: ["name", "value", "label", "endpoint_type", "is_active"],
				filters: { is_active: 1 },
				limit_page_length: 0,
			},
			callback: (r) => {
				const $select = this.$filter_bar.find(".otp-endpoint-select");
				(r.message || []).forEach((row) => {
					const tag = row.endpoint_type === "Email" ? "\u2709" : "\u260E";
					$select.append(
						`<option value="${frappe.utils.escape_html(row.name)}">${tag} ${frappe.utils.escape_html(
							row.label || row.value
						)}</option>`
					);
				});
			},
		});
	}

	load() {
		const filters = {};
		if (this.selected_endpoint) filters.endpoint = this.selected_endpoint;
		if (this.selected_channel) filters.channel = this.selected_channel;

		frappe.call({
			method: "frappe.client.get_list",
			args: {
				doctype: "OTP Message",
				fields: [
					"name",
					"otp_code",
					"channel",
					"from_display",
					"to_display",
					"endpoint",
					"subject",
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
					this.$container.html(`<div class="text-muted">${__("Nothing here yet.")}</div>`);
				}
			},
		});
	}

	seconds_since(iso) {
		if (!iso) return null;
		return (Date.now() - new Date(iso.replace(" ", "T") + "Z").getTime()) / 1000;
	}

	make_card(data) {
		const status = data.status || "New";
		const isEmail = data.channel === "Email";

		const $card = $(`
			<div class="otp-card" data-name="${data.name}">
				<div class="otp-left">
					<div class="otp-top-row">
						<span class="otp-channel-pill">${isEmail ? __("Email") : __("SMS")}</span>
						${
							data.otp_code
								? `<div class="otp-code">${frappe.utils.escape_html(data.otp_code)}</div>`
								: isEmail
								? `<div class="otp-subject">${frappe.utils.escape_html(data.subject || __("(no subject)"))}</div>`
								: ""
						}
						<span class="otp-badge" style="background: var(--bg-${STATUS_COLORS[status] || "blue"}); color: var(--text-on-${STATUS_COLORS[status] || "blue"}, #fff);">${status}</span>
					</div>
					<div class="otp-meta">
						${__("From")} ${frappe.utils.escape_html(data.from_display || "")}
						${__("to")} ${frappe.utils.escape_html(data.to_display || "")}
						\u00b7 ${data.received_at ? comment_when(data.received_at) : ""}
					</div>
					<div class="otp-message">${frappe.utils.escape_html(data.message || "")}</div>
				</div>
				<div class="otp-actions">
					${data.otp_code ? `<button class="btn btn-sm btn-default otp-copy-btn">${__("Copy code")}</button>` : ""}
					${isEmail ? `<button class="btn btn-sm btn-default otp-view-btn">${__("View email")}</button>` : ""}
				</div>
			</div>
		`);

		if (data.otp_code) {
			$card.find(".otp-copy-btn").on("click", () => {
				frappe.utils.copy_to_clipboard(data.otp_code);
				frappe.show_alert({ message: __("Copied"), indicator: "blue" });
				frappe.call({
					method: "telnyx_otp.telnyx_otp.doctype.otp_message.otp_message.mark_copied",
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
		}

		if (isEmail) {
			$card.find(".otp-view-btn").on("click", () => this.show_email(data.name));
		}

		return $card;
	}

	show_email(name) {
		frappe.call({
			method: "frappe.client.get",
			args: { doctype: "OTP Message", name },
			callback: (r) => {
				const doc = r.message;
				if (!doc) return;
				const dialog = new frappe.ui.Dialog({
					title: doc.subject || __("Email"),
					size: "large",
					fields: [{ fieldtype: "HTML", fieldname: "preview" }],
				});
				const html = doc.body_html || `<pre>${frappe.utils.escape_html(doc.body_text || "")}</pre>`;
				// Rendered via an iframe with no allow-scripts, so any script
				// tags in the original email simply don't execute - safer
				// than dropping raw email HTML straight into the desk DOM.
				dialog.fields_dict.preview.$wrapper.html(
					`<iframe class="otp-email-frame" sandbox="allow-same-origin" srcdoc="${frappe.utils.escape_html(html)}"></iframe>`
				);
				dialog.show();
			},
		});
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
		// Purely visual nudge between scheduler runs; the scheduled job
		// remains the source of truth and will correct/broadcast the real
		// status regardless.
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
