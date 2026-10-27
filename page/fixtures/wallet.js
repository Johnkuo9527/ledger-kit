// Wallet fixtures (GrabPay 14 Oct 2026; prepaid cards 19 Oct) — hand-written, loaded after round2.js in
// ?fixtures=1 mode. Three made-up wallets, like the rest of the demo:
//   GrabPay wallet       opening 42.00 (all pre-counted), a 5.44 drink → balance 36.56, worth 36.56
//   Demo Noodle card     opening 288.88 credit that cost 247.61 (pre-counted); 31.40 credit = 26.91 → 257.48 ≈ 220.70
//   Sample Bistro card   200 on the Citi card → 240 credit; a 15.74 meal = 13.12 → 224.26 ≈ 186.88
// Its words follow window.LEDGER_DEMO_LANG (English otherwise), as the worker would write them.
// Every figure is what src/queries.ts walletDetails gives for the same lines (test/wallet-view.test.ts).
// Steps aside once all.js carries a wallet.
(function () {
	const F = window.LEDGER_FIXTURES;
	if (!F) return;
	const R = F.routes;
	if (R.accounts.accounts.some((a) => a.kind === "wallet")) return;
	const m = (minor, currency = "SGD") => ({ currency, minor, display: `${minor < 0 ? "−" : ""}${currency} ${(Math.abs(minor) / 100).toFixed(2)}` });
	const ref = (a) => ({ id: a.id, name: a.name, kind: a.kind, institution: a.institution });
	const W = {
		en: {
			grab: "GrabPay wallet", noodle: "Demo Noodle card", bistro: "Sample Bistro card", noodleShop: "Demo Noodle House",
			covSince: (n, since) => `${n}: recorded from ${since}; top-ups before then were counted as spending`, covSms: (n) => `${n}: the shop texts after every purchase; the ledger records each SMS and checks the balance`, covTold: (n) => `${n}: the balance counts only the purchases you tell me`,
			offsetName: "Wallet balance already counted at top-up",
			paidPre: (n) => `Paid from ${n} balance already counted at top-up: recorded in its real category, but not counted in the totals again.`,
			offsetNote: (since, n) => `Offset: this was paid from ${n} balance topped up before ${since}, which was counted as spending then, so it is not counted again.`,
			offsetMsg: (n, a) => `Offset: the purchase paid from ${n} balance already counted at top-up; ${a} is taken back here, so it is not counted twice.`,
			credit: (u, c) => `Used ${u} of credit; real cost ${c} (the top-up came with a bonus, costed in proportion)`,
			topupTitle: (n) => `Top-up: ${n}`, topupMsg: "$200.00 → 240.00 of credit (prepaid; counted as spending when used)", legName: (n) => `Top-up (${n})`,
			legNote: "Paid SGD 200.00, got 240.00 of credit (the bonus is spread over each purchase's real cost)",
			storyH: ["Balance 224.26 (the shop's credit), worth about $186.88: prepaid money not used yet, counted as spending when it is used.", "A top-up moves your own money somewhere else: the day you pay it is not spending; it counts at its real cost in the month it is used.", "This card sends no notices: a purchase is recorded only when you tell me."],
			storyG: ["Balance 36.56, worth about $36.56: prepaid money not used yet, counted as spending when it is used.", "When recording started on 14 Oct the card held 42.00, left from earlier top-ups. Top-ups before 2026-10-14 were counted as spending when they were paid by card, so purchases paid with it are recorded in their real category with an automatic offset, never counted twice.", "Of the money left, $36.56 was already counted as spending at top-up."],
			storyX: ["Balance 257.48 (the shop's credit), worth about $220.70: prepaid money not used yet, counted as spending when it is used.", "When recording started on 18 Oct the card held 288.88, left from earlier top-ups. Those top-ups were counted as spending when they were paid by card on 2 Mar, 30 Apr, so purchases paid with it are recorded in their real category with an automatic offset, never counted twice.", "Of the money left, $220.70 was already counted as spending at top-up."],
			smsTitle: (n) => `${n} SMS says the balance is 250.00; the ledger has 257.48`, smsDetail: "Demo: an SMS says the card has 250.00 left, 7.65 less than the ledger worked out. Taking the SMS's balance, the ledger adds a purchase of 7.65 of credit (one may have been missed).",
			smsAccept: "Use the SMS's balance (record an adjustment)", smsMyself: "I'll check myself",
		},
		"zh-Hant": {
			grab: "GrabPay 錢包", noodle: "範例 儲值卡", bistro: "Sample Bistro 儲值卡", noodleShop: "範例麵館",
			covSince: (n, since) => `${n}：從 ${since} 起記錄；之前的儲值已算作支出`, covSms: (n) => `${n}：每次消費店家會傳簡訊，帳本照簡訊記下並核對餘額`, covTold: (n) => `${n}：餘額只算你告訴我的消費`,
			offsetName: "儲值時已算過的錢包餘額",
			paidPre: (n) => `用儲值時已算過的 ${n}餘額付的：這筆照實際分類記，但不再重複計入合計。`,
			offsetNote: (since, n) => `抵銷：這筆是用 ${since} 以前儲值、當時已算作支出的 ${n}餘額付的，所以不再重複計入。`,
			offsetMsg: (n, a) => `抵銷：用儲值時已算過的 ${n}餘額付的那筆消費，這裡扣回 ${a}，所以不會重複計入。`,
			credit: (u, c) => `用了儲值金 ${u}，實際成本 ${c}（儲值時有送，按比例算）`,
			topupTitle: (n) => `儲值 ${n}`, topupMsg: "$200.00 → 儲值金 240.00（預付，用掉時才算支出）", legName: (n) => `儲值（${n}）`,
			legNote: "付 SGD 200.00，拿到儲值金 240.00（有送的部分，之後每次消費按比例算實際成本）",
			storyH: ["餘額 224.26（店家的儲值金），約值 $186.88：已預付、還沒用掉的錢，用掉時才算支出。", "每次儲值是把自己的錢換個地方放：刷卡那天不算花費，用掉時才照實際成本算進當月支出。", "這張卡沒有通知，消費要跟我說才會記下。"],
			storyG: ["餘額 36.56，約值 $36.56：已預付、還沒用掉的錢，用掉時才算支出。", "10月14日 開始記錄時卡裡有 42.00，是之前儲值剩下的。2026-10-14 以前的儲值，當時刷卡已經算過支出，所以用它付的消費照實際分類記，另有一筆自動抵銷，不會算第二次。", "剩下的錢裡，$36.56 是儲值時已經算過支出的。"],
			storyX: ["餘額 257.48（店家的儲值金），約值 $220.70：已預付、還沒用掉的錢，用掉時才算支出。", "10月18日 開始記錄時卡裡有 288.88，是之前儲值剩下的。這筆儲值在 3月2日、4月30日 刷卡時已經算過支出，所以用它付的消費照實際分類記，另有一筆自動抵銷，不會算第二次。", "剩下的錢裡，$220.70 是儲值時已經算過支出的。"],
			smsTitle: (n) => `${n} 簡訊餘額 250.00，帳本算出 257.48`, smsDetail: "示範：一則簡訊說卡裡剩 250.00，比帳本算的少 7.65。用簡訊的餘額，帳本會多記一筆 7.65 儲值金的消費（可能有一次沒記到）。",
			smsAccept: "用簡訊的餘額（記一筆調整）", smsMyself: "我自己查",
		},
	}[window.LEDGER_DEMO_LANG === "zh-Hant" ? "zh-Hant" : "en"];
	const nameOf = (id) => (R.accounts.accounts.find((a) => a.id === id) || {}).name || id;
	const CITI = { id: "acc-demo-citi", name: nameOf("acc-demo-citi"), kind: "credit_card", institution: "Citi" };
	const HSBC = { id: "acc-demo-hsbc-a", name: nameOf("acc-demo-hsbc-a"), kind: "credit_card", institution: "HSBC" };
	const G = { id: "grabpay", name: W.grab, kind: "wallet", institution: "grab", since: "2026-10-14" };
	const X = { id: "demo-noodle", name: W.noodle, kind: "wallet", institution: "demo-noodle", since: "2026-10-18" };
	const H = { id: "sample-bistro", name: W.bistro, kind: "wallet", institution: "sample-bistro", since: "2026-10-19" };

	// ------------------------------------------------ accounts + coverage: balance (credit) and what it is worth
	const state = {
		[G.id]: { balance: 3656, pre: 3656, value: 3656, cat: "Grab/Uber", told: false, deal: null },
		[X.id]: { balance: 25748, pre: 22070, value: 22070, cat: "Food", told: true, deal: { paid: m(30000), credit: m(35000) } },
		[H.id]: { balance: 22426, pre: 0, value: 18688, cat: null, told: true, deal: null },
	};
	const msg = { [G.id]: W.covSince(G.name, G.since), [X.id]: W.covSms(X.name), [H.id]: W.covTold(H.name) };
	for (const w of [G, X, H]) {
		const s = state[w.id];
		const wallet = { since: w.since, balance: m(s.balance), precounted_left: m(s.pre), remaining_value: m(s.value), told_only: s.told };
		R.accounts.accounts.push({ ...ref(w), currency: "SGD", active: true, wallet_names: [], statement_day: null, due_day: null, settings_source: null, replaced_by: null, autopay: null,
			wallet: { ...wallet, precounted_category: s.cat, topup_deal: s.deal } });
		const cov = { account_id: w.id, mode: "wallet", complete_through: null, last_statement_date: null, last_tap_date: null, partial: false, message: msg[w.id], wallet };
		for (const k of ["overview", "overview.2026-10"]) if (R[k] && R[k].coverage) R[k].coverage.push(cov);
	}

	// ------------------------------------------------ lines
	const line = (over) => ({
		kind: "purchase", state: "open", spending: true, provisional: false, merchant: { name: null, raw: null, country: null }, category: null,
		fx: null, flags: [], evidence: ["manual"], refund_of: null, income_offset: null, transfer_group: null, statement_id: null, trip_id: null,
		reimbursable: { effective: false, source: null, range_id: null }, note: null, subscription: null, wallet: null, credit: null, topup: null, ...over,
	});
	const amt = (credit, home = credit) => ({ original: m(credit), billed: { ...m(credit), status: "exact" }, home: { ...m(home), status: "exact", set_by: "rules" }, overseas_fee: null });
	const named = (n) => ({ name: n, raw: n, country: null });
	const OFFSET_NAME = W.offsetName;

	const drink = line({ id: "ln-demo-grab-drink", account: ref(G), date: "2026-10-14", merchant: named("Drink"), category: "Drinks", amount: amt(544), evidence: ["manual"],
		wallet: { precounted: m(544), offset_line_id: "ln-demo-grab-offset", offset_of: null, message: W.paidPre(G.name) } });
	const drinkOffset = line({ id: "ln-demo-grab-offset", account: ref(G), date: "2026-10-14", kind: "wallet_offset", merchant: named(OFFSET_NAME), category: "Grab/Uber", amount: amt(-544), evidence: [],
		note: W.offsetNote(G.since, G.name),
		wallet: { precounted: m(544), offset_line_id: "ln-demo-grab-offset", offset_of: "ln-demo-grab-drink", message: W.offsetMsg(G.name, "SGD 5.44") } });

	const xmeal = line({ id: "ln-demo-xx-meal", account: ref(X), date: "2026-10-18", merchant: named(W.noodleShop), category: "Food", amount: amt(3140, 2691), evidence: ["sms"],
		credit: { used: "31.40", cost: m(2691), message: W.credit("31.40", "SGD 26.91") },
		wallet: { precounted: m(2691), offset_line_id: "ln-demo-xx-offset", offset_of: null, message: W.paidPre(X.name) } });
	const xoffset = line({ id: "ln-demo-xx-offset", account: ref(X), date: "2026-10-18", kind: "wallet_offset", merchant: named(OFFSET_NAME), category: "Food", amount: amt(-2691), evidence: [],
		note: W.offsetNote(X.since, X.name),
		wallet: { precounted: m(2691), offset_line_id: "ln-demo-xx-offset", offset_of: "ln-demo-xx-meal", message: W.offsetMsg(X.name, "SGD 26.91") } });

	const topup = { wallet: { id: H.id, name: H.name }, from: { id: CITI.id, name: CITI.name }, source_line_id: "ln-demo-hg-citi", wallet_line_id: "ln-demo-hg-leg", paid: m(20000), credit: "240.00",
		title: W.topupTitle(H.name), message: W.topupMsg };
	const citi = line({ id: "ln-demo-hg-citi", account: CITI, date: "2026-10-19", kind: "transfer", spending: false, provisional: true, merchant: named("SAMPLE BISTRO SINGAPORE"), amount: amt(20000), evidence: ["alert"],
		transfer_group: "tg-demo-hg", topup: { role: "source", ...topup } });
	const leg = line({ id: "ln-demo-hg-leg", account: ref(H), date: "2026-10-19", kind: "transfer", spending: false, merchant: named(W.legName(CITI.name)), amount: amt(-24000, -20000), evidence: [],
		transfer_group: "tg-demo-hg", note: W.legNote, topup: { role: "wallet", ...topup } });
	const hmeal = line({ id: "ln-demo-hg-meal", account: ref(H), date: "2026-10-19", merchant: named("Sample Bistro"), category: "Food", amount: amt(1574, 1312),
		credit: { used: "15.74", cost: m(1312), message: W.credit("15.74", "SGD 13.12") } });

	if (R.lines && Array.isArray(R.lines.lines)) {
		R.lines.lines.push(drink, drinkOffset, xmeal, xoffset, citi, leg, hmeal);
		R.lines.lines.sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1));
	}

	// ------------------------------------------------ GET /api/wallets: one wallet as the owner reads it when he taps it
	const use = (l, precounted = null) => ({ line_id: l.id, date: l.date, kind: l.kind, merchant: l.merchant.name, category: l.category, credit: (l.amount.original.minor / 100).toFixed(2), cost: m(l.amount.home.minor), precounted, needs_review: false });
	const used = (credit, cost, pre) => ({ credit, cost: m(cost), precounted: m(pre), counted_now: m(cost - pre) });
	R.wallets = { ok: true, wallets: [
		{
			account: { id: H.id, name: H.name, institution: H.institution, told_only: true, takes_sms: false }, since: H.since,
			balance: m(22426), remaining_value: m(18688), precounted_left: m(0), precounted_category: null, bonus: true,
			lots: [{ kind: "topup", line_id: leg.id, date: "2026-10-19", from: { id: CITI.id, name: CITI.name }, paid: m(20000), credit: "240.00", used: "15.74", left: "224.26", value_left: m(18688), precounted: false }],
			uses: [use(hmeal)], uses_count: 1, used: used("15.74", 1312, 0), precounted_topups: [],
			story: W.storyH, opening_story: null,
		},
		{
			account: { id: G.id, name: G.name, institution: G.institution, told_only: false, takes_sms: false }, since: G.since,
			balance: m(3656), remaining_value: m(3656), precounted_left: m(3656), precounted_category: "Grab/Uber", bonus: false,
			lots: [{ kind: "opening", line_id: null, date: G.since, from: null, paid: m(4200), credit: "42.00", used: "5.44", left: "36.56", value_left: m(3656), precounted: true }],
			uses: [use(drink, m(544))], uses_count: 1, used: used("5.44", 544, 544), precounted_topups: [],
			story: W.storyG, opening_story: W.storyG[1],
		},
		{
			account: { id: X.id, name: X.name, institution: X.institution, told_only: true, takes_sms: true }, since: X.since,
			balance: m(25748), remaining_value: m(22070), precounted_left: m(22070), precounted_category: "Food", bonus: true,
			lots: [{ kind: "opening", line_id: null, date: X.since, from: null, paid: m(24761), credit: "288.88", used: "31.40", left: "257.48", value_left: m(22070), precounted: true }],
			uses: [use(xmeal, m(2691))], uses_count: 1, used: used("31.40", 2691, 2691),
			precounted_topups: [
				{ line_id: "ln-demo-xx-0430", date: "2026-04-30", account: HSBC.name, paid: m(30000) },
				{ line_id: "ln-demo-xx-0302", date: "2026-03-02", account: HSBC.name, paid: m(30000) },
			],
			story: W.storyX, opening_story: W.storyX[1],
		},
	] };

	// ------------------------------------------------ to review: a Demo Noodle SMS whose balance differs (the ledger's 257.48)
	const n = R["needs-ok"];
	if (n) {
		n.wallet_topups = [];
		n.wallet_sms = [{
			id: "sms-demo-1", account_id: X.id, title: W.smsTitle(X.name),
			detail: W.smsDetail,
			actions: [
				{ id: "accept", label: W.smsAccept, method: "POST", path: "/api/wallet-sms/sms-demo-1/accept", body: {}, style: "primary" },
				{ id: "checked", label: W.smsMyself, method: "POST", path: "/api/wallet-sms/sms-demo-1/checked", body: {}, style: "secondary" },
			],
		}];
		n.count = (n.count || 0) + 1;
	}
})();
