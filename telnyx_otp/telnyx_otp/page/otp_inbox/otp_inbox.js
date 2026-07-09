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
		this.selected_endpoint = "";
		this.selected_channel = "";
		this.selected_name = null;
		this.rows = {}; // name -> {data, $row}

		this.render_styles();
		this.render_filter();
		this.render_layout();

		this.page.set_secondary_action("Refresh", () => this.load());

		this.load_endpoints().then(() => this.load());

		frappe.realtime.on("sms_otp_new", (data) => {
			if (this.selected_endpoint && data.endpoint !== this.selected_endpoint) return;
			if (this.selected_channel && data.channel !== this.selected_channel) return;
			this.upsert_row(data, true);
			frappe.show_alert({
				message: data.otp_code
					? __("New OTP received: {0}", [data.otp_code])
					: __("New message: {0}", [data.subject || data.message || ""]),
				indicator: "green",
			});
		});

		frappe.realtime.on("sms_otp_status", (data) => {
			this.update_status_badge(data.name, data.status);
		});

		this.ticker = setInterval(() => this.tick(), 1000);
	}

	render_styles() {
		if ($("#otp-inbox-style").length) return;
		$(`<style id="otp-inbox-style">
			.otp-inbox-body { display: flex; gap: 0; height: 72vh; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; }
			.otp-filter-bar { padding: 0 0 10px; display: flex; gap: 10px; }
			.otp-filter-bar select { max-width: 240px; }
			.otp-list-pane { width: 340px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--border-color); background: var(--card-bg, #fff); }
			.otp-row { padding: 10px 14px; border-bottom: 1px solid var(--border-color); cursor: pointer; }
			.otp-row:hover { background: var(--control-bg); }
			.otp-row.selected { background: var(--bg-blue); }
			.otp-row-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
			.otp-row-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
			.otp-row-code { font-family: monospace; font-weight: 700; font-size: 14px; }
			.otp-row-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; display: flex; justify-content: space-between; gap: 6px; }
			.otp-row-snippet { font-size: 12px; color: var(--text-muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.otp-detail-pane { flex: 1; overflow-y: auto; padding: 20px; background: var(--card-bg, #fff); }
			.otp-detail-empty { color: var(--text-muted); padding: 40px; text-align: center; }
			.otp-detail-header { margin-bottom: 14px; }
			.otp-detail-code { font-size: 32px; font-weight: 700; font-family: monospace; letter-spacing: 1px; }
			.otp-detail-subject { font-size: 18px; font-weight: 600; }
			.otp-detail-meta { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
			.otp-detail-message { margin-top: 14px; padding: 12px 14px; background: var(--control-bg); border-radius: 6px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
			.otp-action-links { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
			.otp-action-links a.btn { text-decoration: none; }
			.otp-email-frame { width: 100%; height: 55vh; border: 1px solid var(--border-color); border-radius: 6px; background: #fff; margin-top: 14px; }
			.otp-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; font-weight: 600; }
			.otp-channel-pill { font-size: 10px; padding: 1px 7px; border-radius: 10px; text-transform: uppercase; font-weight: 600; background: var(--control-bg); color: var(--text-muted); flex-shrink: 0; }
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

	render_layout() {
		this.$body = $('<div class="otp-inbox-body"></div>').appendTo(this.page.body);
		this.$list = $('<div class="otp-list-pane"></div>').appendTo(this.$body);
		this.$detail = $('<div class="otp-detail-pane"></div>').appendTo(this.$body);
		this.render_empty_detail();
	}

	render_empty_detail() {
		this.$detail.html(`<div class="otp-detail-empty">${__("Select a message to view it")}</div>`);
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
					"action_links",
					"received_at",
					"copied_at",
					"status",
				],
				filters,
				order_by: "received_at desc",
				limit_page_length: 50,
			},
			callback: (r) => {
				this.$list.empty();
				this.rows = {};
				this.selected_name = null;
				this.render_empty_detail();
				(r.message || []).forEach((row) => this.upsert_row(row, false));
				if (!r.message || !r.message.length) {
					this.$list.html(`<div class="text-muted" style="padding:20px;">${__("Nothing here yet.")}</div>`);
				} else {
					this.select_row(r.message[0].name);
				}
			},
		});
	}

	seconds_since(iso) {
		if (!iso) return null;
		return (Date.now() - new Date(iso.replace(" ", "T") + "Z").getTime()) / 1000;
	}

	make_row(data) {
		const isEmail = data.channel === "Email";
		const status = data.status || "New";
		const title = data.otp_code
			? `<span class="otp-row-code">${frappe.utils.escape_html(data.otp_code)}</span>`
			: frappe.utils.escape_html(isEmail ? data.subject || __("(no subject)") : data.message || "");

		const $row = $(`
			<div class="otp-row" data-name="${data.name}">
				<div class="otp-row-top">
					<span class="otp-channel-pill">${isEmail ? __("Email") : __("SMS")}</span>
					<div class="otp-row-title">${title}</div>
					<span class="otp-badge" style="background: var(--bg-${STATUS_COLORS[status] || "blue"}); color: var(--text-on-${STATUS_COLORS[status] || "blue"}, #fff);">${status}</span>
				</div>
				<div class="otp-row-meta">
					<span>${frappe.utils.escape_html(data.from_display || "")}</span>
					<span>${data.received_at ? comment_when(data.received_at) : ""}</span>
				</div>
				${isEmail ? `<div class="otp-row-snippet">${frappe.utils.escape_html(data.message || "")}</div>` : ""}
			</div>
		`);

		$row.on("click", () => this.select_row(data.name));
		return $row;
	}

	upsert_row(data, prepend) {
		if (this.rows[data.name]) {
			this.rows[data.name].data = data;
			this.update_status_badge(data.name, data.status || "New");
			return;
		}
		const $row = this.make_row(data);
		this.rows[data.name] = { data, $row };
		if (prepend) this.$list.prepend($row);
		else this.$list.append($row);
	}

	select_row(name) {
		this.selected_name = name;
		Object.values(this.rows).forEach(({ $row }) => $row.removeClass("selected"));
		if (this.rows[name]) this.rows[name].$row.addClass("selected");
		this.render_detail(name);
	}

	render_detail(name) {
		frappe.call({
			method: "frappe.client.get",
			args: { doctype: "OTP Message", name },
			callback: (r) => {
				const doc = r.message;
				if (!doc || this.selected_name !== name) return;

				const isEmail = doc.channel === "Email";
				const status = doc.status || "New";
				let links = [];
				try {
					links = doc.action_links ? JSON.parse(doc.action_links) : [];
				} catch (e) {
					links = [];
				}

				let html = `<div class="otp-detail-header">`;
				if (doc.otp_code) {
					html += `<div class="otp-detail-code">${frappe.utils.escape_html(doc.otp_code)}</div>`;
				} else if (isEmail) {
					html += `<div class="otp-detail-subject">${frappe.utils.escape_html(doc.subject || __("(no subject)"))}</div>`;
				}
				html += `<div class="otp-detail-meta">
					${__("From")} ${frappe.utils.escape_html(doc.from_display || "")}
					${__("to")} ${frappe.utils.escape_html(doc.to_display || "")}
					\u00b7 ${doc.received_at ? comment_when(doc.received_at) : ""}
					\u00b7 <span class="otp-badge" data-status-badge style="background: var(--bg-${STATUS_COLORS[status] || "blue"}); color: var(--text-on-${STATUS_COLORS[status] || "blue"}, #fff);">${status}</span>
				</div></div>`;

				if (doc.otp_code) {
					html += `<button class="btn btn-sm btn-default otp-copy-btn">${__("Copy code")}</button>`;
				}

				if (links.length) {
					html += `<div class="otp-action-links">`;
					links.forEach((link) => {
						html += `<a class="btn btn-sm btn-primary" href="${frappe.utils.escape_html(link.url)}" target="_blank" rel="noopener noreferrer">${frappe.utils.escape_html(link.text || link.url)}</a>`;
					});
					html += `</div>`;
				}

				if (isEmail) {
					// Always show the full formatted email, whether or not a
					// code/link was extracted from it - these often carry
					// verification links rather than codes, so the reading
					// pane needs to be readable end-to-end regardless.
					const body = doc.body_html || `<pre>${frappe.utils.escape_html(doc.body_text || "")}</pre>`;
					html += `<iframe class="otp-email-frame" sandbox="allow-popups" srcdoc="${frappe.utils.escape_html(body)}"></iframe>`;
				} else {
					// Always show the full SMS text too, even when a code
					// was found - the code+copy button is a shortcut, not a
					// replacement for reading the actual message.
					html += `<div class="otp-detail-message">${frappe.utils.escape_html(doc.message || "")}</div>`;
				}

				this.$detail.html(html);

				if (doc.otp_code) {
					this.$detail.find(".otp-copy-btn").on("click", () => {
						frappe.utils.copy_to_clipboard(doc.otp_code);
						frappe.show_alert({ message: __("Copied"), indicator: "blue" });
						frappe.call({
							method: "telnyx_otp.telnyx_otp.doctype.otp_message.otp_message.mark_copied",
							args: { name: doc.name },
							callback: (res) => {
								if (res.message) {
									this.update_status_badge(doc.name, res.message.status);
									if (this.rows[doc.name]) this.rows[doc.name].data.copied_at = res.message.copied_at;
								}
							},
						});
					});
				}
			},
		});
	}

	update_status_badge(name, status) {
		const entry = this.rows[name];
		if (entry) {
			entry.data.status = status;
			const $badge = entry.$row.find(".otp-badge");
			$badge.text(status);
			$badge.css({
				background: `var(--bg-${STATUS_COLORS[status] || "blue"})`,
				color: `var(--text-on-${STATUS_COLORS[status] || "blue"}, #fff)`,
			});
		}
		if (this.selected_name === name) {
			const $badge = this.$detail.find("[data-status-badge]");
			$badge.text(status);
			$badge.css({
				background: `var(--bg-${STATUS_COLORS[status] || "blue"})`,
				color: `var(--text-on-${STATUS_COLORS[status] || "blue"}, #fff)`,
			});
		}
	}

	tick() {
		Object.values(this.rows).forEach(({ data }) => {
			if (data.status === "Copied" && data.copied_at) {
				const secs = this.seconds_since(data.copied_at);
				if (secs !== null && secs >= 60) {
					this.update_status_badge(data.name, "Used");
				}
			}
		});
	}
}
