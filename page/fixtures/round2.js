// Round-2 fixtures (11 Oct 2026) — MADE-UP data, hand-written, loaded after all.js in
// ?fixtures=1 mode. They add the shapes of meeting points A–D (CONTRACT, round 2) on top of
// the generated fixtures, and only where all.js does not already carry them — so once
// make-fixtures.ts produces them from the real builders, this file quietly steps aside.
(function () {
	const F = window.LEDGER_FIXTURES;
	if (!F) return;
	const R = F.routes;
	// The demo's words, in the language the page asked for (window.LEDGER_DEMO_LANG; English otherwise):
	// made-up account names and the sentences the worker would write in that language.
	const W = {
		en: {
			uob: "UOB card", invest: "Endowus investment account", loan: "HDB home loan", rent: "Rent — Tan", parents: "To my parents", friend: "PayNow to K. Lin (TWD swap)",
			yes: "Yes, confirm", noTrip: "Not a trip", thisOne: "This one", tapQ: (c) => `Which card is "${c}" in your Wallet?`, notMine: "Not mine; skip it",
			cats: [["dining", "Dining"], ["groceries", "Groceries"], ["transport", "Transport"], ["shopping", "Shopping"], ["entertainment", "Entertainment"], ["other", "Other"]],
			fine: "It's fine", toCat: "Change to this category", orCat: "Or change its category:", useRef: "Use the reference rate for now", waitRate: "Wait for the rate",
			linkThis: "Link to this one", whichPurchase: "Which purchase was it?", amazon1: "12 Sept Amazon SG $12.00", amazon2: "3 Sept Amazon SG $39.90", alone: "Not found; keep it as a refund on its own",
			deposit: "It was a deposit, already returned", real: "This is a real purchase", reviewed: "I've looked at it", recheck: "Ask Opus to check again",
			pdfTitle: "Taishin statement PDFs will not open", pdfDetail: "2 Taishin statements will not open (wrong password): the one that arrived in September 2026, the one that arrived in August 2026. The statements are waiting; it tries again every day.",
			pdfSteps: "On your laptop, ask Claude Code: \"Set my ledger's Taishin PDF password\". It will use this command so you can type the password (it never appears in the chat): store the right password with npx wrangler secret put LEDGER_PDF_PW_TAISHIN. Once it is set, tap the button below.", pdfRetry: "I've updated it; try again now",
			billTitle: (n) => `${n}: the bill that closed on 31 Aug was not paid in full`, billDetail: "The next statement shows only SGD 200.00 paid (the bill was SGD 432.10), with SGD 232.10 carried to the next one; interest may be charged.", seen: "Got it",
			upTitle: "Which card is this statement for? eStatement_Jul2026.pdf", upDetail: "The card on the statement (last digits 0000) matches no card in the ledger. Pick a card and the ledger will read it again with it.", upQ: "Which card (or account) is this statement for?", hsbc: "HSBC card", skip: "Skip this one",
		},
		"zh-Hant": {
			uob: "UOB 信用卡", invest: "Endowus 投資帳戶", loan: "HDB 房貸", rent: "房租 — Tan", parents: "給爸媽", friend: "PayNow to K. Lin（換台幣）",
			yes: "是，確認", noTrip: "不是旅行", thisOne: "就是這張", tapQ: (c) => `錢包裡的「${c}」是哪一張卡？`, notMine: "不是我的，略過",
			cats: [["dining", "餐飲"], ["groceries", "超市日用"], ["transport", "交通"], ["shopping", "購物"], ["entertainment", "娛樂"], ["other", "其他"]],
			fine: "沒問題", toCat: "改成這個分類", orCat: "或者改分類：", useRef: "先用參考匯率算", waitRate: "等匯率出來",
			linkThis: "對到這一筆", whichPurchase: "原本是哪一筆消費？", amazon1: "9月12日 Amazon SG S$12.00", amazon2: "9月3日 Amazon SG S$39.90", alone: "找不到，當成單獨的退款",
			deposit: "是押金，已經退回", real: "這筆是真的消費", reviewed: "我看過了", recheck: "請 Opus 再查一次",
			pdfTitle: "台新 的帳單 PDF 打不開", pdfDetail: "有 2 期台新帳單打不開（密碼不對）：2026年9月寄來的、2026年8月寄來的。帳單在等，每天會再試一次。",
			pdfSteps: "在筆電的 Claude Code 說：「幫我設定帳本的 台新 PDF 密碼」，它會用這個指令讓你輸入密碼（密碼不會出現在對話裡）：npx wrangler secret put LEDGER_PDF_PW_TAISHIN 存正確的密碼。設好之後按下面的按鈕。", pdfRetry: "我更新好了，現在再試",
			billTitle: (n) => `${n} 8月31日結帳的帳單沒有繳清`, billDetail: "下一期帳單顯示只繳了 SGD 200.00（帳單是 SGD 432.10），還差 SGD 232.10 轉到下一期，可能會被收利息。", seen: "知道了",
			upTitle: "這份帳單是哪張卡？eStatement_Jul2026.pdf", upDetail: "帳單上的卡（末四碼 0000）對不到帳本裡的卡，選一張卡，帳本會用它再讀一次。", upQ: "這份帳單是哪張卡（或哪個帳戶）？", hsbc: "HSBC 信用卡", skip: "略過這份",
		},
	}[window.LEDGER_DEMO_LANG === "zh-Hant" ? "zh-Hant" : "en"];
	const nameOf = (id) => (R.accounts.accounts.find((a) => a.id === id) || {}).name || id;
	const EXP0 = { JPY: 1, KRW: 1 };
	const m = (minor, currency = "SGD") => {
		const e = EXP0[currency] ? 0 : 2, s = (Math.abs(minor) / 10 ** e).toFixed(e).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		return { currency, minor, display: `${minor < 0 ? "−" : ""}${currency} ${s}` };
	};

	// ---- C. cards: cut-off and due days
	const DAYS = {
		"acc-demo-hsbc-a": [25, 15, "statement"],
		"acc-demo-hsbc-b": [4, 29, "statement"],
		"acc-demo-citi": [30, 25, "owner"],
		"acc-demo-taishin-a": [15, 3, "statement"],
		"acc-demo-taishin-b": [null, null, null],
	};
	// A card the ledger knows nothing about yet: no days set, and (below) a bill that printed no due date.
	if (!R.accounts.accounts.some((a) => a.id === "acc-demo-uob")) {
		const tpl = R.accounts.accounts.find((a) => a.kind === "credit_card");
		if (tpl) R.accounts.accounts.push({ ...JSON.parse(JSON.stringify(tpl)), id: "acc-demo-uob", name: W.uob, institution: "UOB", currency: "SGD" });
	}
	for (const a of R.accounts.accounts) {
		if (a.kind !== "credit_card" || "statement_day" in a) continue;
		const [s, d, src] = DAYS[a.id] || [null, null, null];
		Object.assign(a, { statement_day: s, due_day: d, settings_source: src });
	}

	// ---- D. payments
	if (!R.payments) {
		const st = (from, to, bal, min, due, prev, paid, cur = "SGD") => ({ period_from: from, period_to: to, statement_balance: m(bal, cur), minimum_due: m(min, cur), due_date: due, previous_balance: m(prev, cur), payments_credited: m(paid, cur) });
		const card = (id, name, cur, last, paidSince, outstanding, due, daysLeft, status, unbilled, more = {}) => ({
			account: { id, name: nameOf(id), kind: "credit_card", institution: id.split("-")[2] },
			last_statement: { statement_id: `st-demo-${id}`, ...last }, paid_since_statement: m(paidSince, cur), outstanding: m(outstanding, cur),
			due_date: due, days_left: daysLeft, status, status_reason: status === "overdue" ? "no_payment_seen" : null,
			paid_source: status === "paid" ? "ledger" : null, autopay: { on: false, source: null }, previous_bill: null, unbilled: m(unbilled, cur), ...more,
		});
		R.payments = {
			ok: true,
			cards: [
				card("acc-demo-taishin-a", null, "TWD", st("2026-08-16", "2026-09-15", 1842000, 184200, "2026-10-03", 1210000, 1210000, "TWD"), 0, 1842000, "2026-10-03", -6, "autopay_pending", 235000, { autopay: { on: true, source: "statement" } }),
				card("acc-demo-hsbc-a", null, "SGD", st("2026-08-26", "2026-09-25", 241755, 5000, "2026-10-15", 98000, 98000), 100000, 141755, "2026-10-15", 6, "due", 31240),
				card("acc-demo-taishin-b", null, "TWD", st("2026-08-11", "2026-09-10", 456000, 45600, "2026-10-20", 0, 0, "TWD"), 200000, 256000, "2026-10-20", 11, "due", 18500),
				card("acc-demo-citi", null, "SGD", st("2026-09-01", "2026-09-30", 61377, 5000, "2026-10-25", 43210, 43210), 0, 61377, "2026-10-25", 16, "overdue", 8800, {
					// The newest statement shows the bill before was not paid in full (14 Oct 2026).
					status_reason: "previous_unpaid",
					previous_bill: { statement_id: "st-demo-citi-aug", period_to: "2026-08-31", due_date: "2026-09-25", statement_balance: m(43210), payments_credited: m(20000), verdict: "unpaid", reason: "balance_carried", owner_said_paid: false, seen_by_owner: false },
				}),
				// No due date anywhere (bill printed none, no due day set) and no minimum: days_left is null —
				// the page must say "due date unknown · set", never "null days left".
				card("acc-demo-uob", null, "SGD", { ...st("2026-08-28", "2026-09-27", 18990, 0, null, 0, 0), minimum_due: null }, 0, 18990, null, null, "due", 4200),
				card("acc-demo-hsbc-b", null, "SGD", st("2026-08-05", "2026-09-04", 61240, 5000, "2026-09-29", 52010, 52010), 61240, 0, "2026-09-29", -10, "paid", 45510),
			],
			total: { outstanding_home: m(288101), minimum_due_home: m(39248), unbilled_home: m(50253), estimate: true },
		};
	}
	if (!R["account-settings"]) R["account-settings"] = { ok: true };

	// ---- B. subscriptions: one cancelled, one wrongly-detected, so every tab has something
	const subs = R.subscriptions.subscriptions;
	const sub = (id, merchant, cadence, minor, last, next, n, status) => ({ id, merchant, cadence, amount: m(minor), previous_amount: null, price_changed_on: null, last_charged: last, next_renewal: next, occurrences: n, status, monthly_equivalent: m(minor) });
	if (!subs.some((s) => s.status === "cancelled")) subs.push(sub("sub-demo-applemusic", "Apple Music", "monthly", 1098, "2026-07-03", "2026-08-03", 9, "cancelled"));
	if (!subs.some((s) => s.id === "sub-demo-coldstorage")) subs.push(sub("sub-demo-coldstorage", "Cold Storage", "monthly", 4620, "2026-07-18", "2026-08-18", 3, "lapsed"));
	if (!R["line-subscription"]) R["line-subscription"] = { ok: true };

	// ---- money out that is not spending (investment, loan repayment), and the categories rent and family support
	const L = R.lines.lines, tpl = L.find((l) => l.id === "ln-demo-033");
	if (tpl && !L.some((l) => l.id === "ln-demo-r2-invest")) {
		const line = (id, date, name, minor, kind, category) => {
			const v = JSON.parse(JSON.stringify(tpl));
			Object.assign(v, { id, date, kind, category, spending: kind === "purchase", transfer_group: null, statement_id: null, provisional: false, flags: [] });
			v.merchant = { name, raw: name.toUpperCase(), country: "SG" };
			v.amount.original = m(minor); v.amount.billed = { ...m(minor), status: "exact" }; v.amount.home = { ...m(minor), status: "exact", set_by: "rules" };
			return v;
		};
		L.push(line("ln-demo-r2-invest", "2026-09-15", W.invest, 100000, "investment", null),
			line("ln-demo-r2-loan", "2026-09-10", W.loan, 128000, "loan_repayment", null),
			line("ln-demo-r2-rent", "2026-09-01", W.rent, 240000, "purchase", "rent"),
			line("ln-demo-r2-family", "2026-09-05", W.parents, 50000, "purchase", "family_support"),
			line("ln-demo-r2-friend", "2026-09-20", W.friend, 60000, "friend_transfer", null));
		L.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
	}
	if (!R["line-kind"]) R["line-kind"] = { ok: true };

	// ---- A. every item to review carries its own actions
	const n = R["needs-ok"];
	const cards = R.accounts.accounts.filter((a) => a.kind === "credit_card" || a.kind === "debit_card").map((a) => ({ value: a.id, label: a.name }));
	const act = (id, label, path, body, style = "secondary", extra = {}) => ({ id, label, method: "POST", path, body, style, ...extra });
	for (const t of R.trips.trips) {
		if (t.status !== "proposed" || t.actions) continue;
		t.actions = [act("confirm", W.yes, `/api/trips/${t.id}/confirm`, {}, "primary"), act("reject", W.noTrip, `/api/trips/${t.id}/reject`, {})];
	}
	for (const h of n.held_taps) {
		if (h.actions) continue;
		h.actions = [
			act("assign", W.thisOne, "/api/wallet-names", { name: h.card }, "primary", { choice_key: "account_id", choice_label: W.tapQ(h.card), choices: cards }),
			act("dismiss", W.notMine, `/api/needs-ok/held/${h.evidence_id}/dismiss`, { reason: "not_mine" }),
		];
	}
	const CATS = W.cats.map(([value, label]) => ({ value, label }));
	const LINE_ACTS = {
		"ln-demo-038": [act("accept", W.fine, "/api/lines/ln-demo-038/review", { action: "accept" }, "primary"),
			act("category", W.toCat, "/api/lines/ln-demo-038/category", {}, "secondary", { choice_key: "category", choice_label: W.orCat, choices: CATS })],
		"ln-demo-037": [act("ref", W.useRef, "/api/lines/ln-demo-037/review", { action: "use_reference_rate" }, "primary"),
			act("wait", W.waitRate, "/api/lines/ln-demo-037/review", { action: "wait" })],
		"ln-demo-030": [act("link", W.linkThis, "/api/lines/ln-demo-030/refund-of", {}, "primary", { choice_key: "line_id", choice_label: W.whichPurchase, choices: [{ value: "ln-demo-x1", label: W.amazon1 }, { value: "ln-demo-x2", label: W.amazon2 }] }),
			act("alone", W.alone, "/api/lines/ln-demo-030/review", { action: "accept" })],
		"ln-demo-024": [act("void", W.deposit, "/api/lines/ln-demo-024/review", { action: "void" }, "danger"),
			act("keep", W.real, "/api/lines/ln-demo-024/review", { action: "accept" })],
	};
	if (!n.line_actions) n.line_actions = LINE_ACTS; // the fixture server pins these onto the live LineViews
	for (const s of n.months) {
		if (s.actions) continue;
		s.actions = [
			act("reviewed", W.reviewed, `/api/months/${s.statement_id}/reviewed`, {}, "primary"),
			act("recheck", W.recheck, `/api/months/${s.statement_id}/recheck`, {}),
		];
	}
	if (!n.pdf_passwords) n.pdf_passwords = [{
		// The words the worker writes (worker/src/pdf-locks.ts): each locked bill by the month it arrived.
		id: "pdf-demo-taishin", title: W.pdfTitle, detail: W.pdfDetail,
		instructions: W.pdfSteps,
		actions: [act("retry", W.pdfRetry, "/api/needs-ok/pdf/pdf-demo-taishin/retry", {}, "primary")],
	}];
	// (14 Oct 2026): a bill the next statement shows was not paid in full.
	if (!n.bills) n.bills = [{
		id: "unpaid:st-demo-citi-aug", kind: "unpaid_on_next_statement", account_id: "acc-demo-citi", statement_id: "st-demo-citi-aug",
		title: W.billTitle(nameOf("acc-demo-citi")),
		detail: W.billDetail,
		actions: [act("seen", W.seen, "/api/payments/st-demo-citi-aug/seen", {}, "primary")],
	}];
	// : an uploaded statement whose card the ledger could not tell (Dev, 12 Oct 2026).
	if (!n.uploads) n.uploads = [{
		id: "up-demo", state: "needs_account", filename: "eStatement_Jul2026.pdf",
		title: W.upTitle, detail: W.upDetail,
		actions: [
			act("account", W.thisOne, "/api/statements/uploads/up-demo/account", {}, "primary", { choice_key: "account_id", choice_label: W.upQ, choices: [{ value: "citi-5508", label: nameOf("acc-demo-citi") }, { value: "hsbc-5507", label: W.hsbc }] }),
			act("dismiss", W.skip, "/api/statements/uploads/up-demo/dismiss", {}, "danger"),
		],
	}];
})();
