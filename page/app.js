/* 帳本 — the owner's private ledger page.
 *
 * Reads ONLY the CONTRACT §5 shapes through the §5.1 envelope: a response
 * counts only when the HTTP status is OK *and* body.ok === true. Anything else
 * is drawn as "couldn't load — this does not mean nothing was spent", never as
 * an empty list or a zero, and is never cached.
 *
 * ?fixtures=1 runs against made-up data in fixtures/ (no server needed; it
 * works opened straight from disk). Add &fail=overview,trips to see what a
 * failed load looks like.
 */
"use strict";
(function () {
	// ---------------------------------------------------------------- setup
	const params = new URLSearchParams(location.search);
	const FIXTURES = params.has("fixtures");
	const FAIL = new Set((params.get("fail") || "").split(",").filter(Boolean));
	let FX = null; // fixtures, when in fixture mode
	let DB = null; // mutable copy of the fixtures

	const $ = (sel, root = document) => root.querySelector(sel);
	const VIEW = $("#view"); // the tab on screen
	let $view = VIEW; // where a view draws: VIEW, or route()'s hidden stage while it builds

	// ---------------------------------------------------------------- icons
	const P = {
		overview: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
		lines: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
		trips: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
		subs: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
		ok: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		theme: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
		close: '<path d="M18 6 6 18M6 6l12 12"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z"/><path d="M12 9v4M12 17h.01"/>',
		info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
		left: '<path d="m15 18-6-6 6-6"/>',
		right: '<path d="m9 18 6-6-6-6"/>',
		search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
		clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
		up: '<path d="m18 15-6-6-6 6"/>',
		spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
		card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
		upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
	};
	const icon = (n) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ""}</svg>`;
	const paintIcons = (root = document) => root.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon); el.removeAttribute("data-icon"); });

	// ---------------------------------------------------------------- the owner's home and language
	/// The owner's home — currency, time zone, country — and language, told by the worker in a
	/// <meta name="ledger-home"> (worker/src/page.ts). The demo (?fixtures=1, or the file opened
	/// from disk) has no worker: its made-up data is Singapore's, in English, unless the address
	/// asks for another (&lang=zh-Hant, &home=EUR&tz=Europe/Berlin&country=DE).
	const HOME = (() => {
		try { const m = document.querySelector('meta[name="ledger-home"]'); if (m) return JSON.parse(m.getAttribute("content")); } catch { /* the demo's home below */ }
		return { currency: (params.get("home") || "SGD").toUpperCase(), time_zone: params.get("tz") || "Asia/Singapore", country: (params.get("country") || "SG").toUpperCase(), language: params.get("lang") || "en" };
	})();
	const HC = HOME.currency;
	/// Every word the page says comes from words.js — one catalogue per language, made from the
	/// server's own (src/words/*.ts), so the two never disagree. `say(key, vars)` fills {blanks}
	/// and picks a count's form, exactly like the server's say() (src/words.ts).
	const ALL_WORDS = window.LEDGER_WORDS || {};
	const LANG = ALL_WORDS[HOME.language] ? HOME.language : "en";
	const WORDS = ALL_WORDS[LANG] || {};
	const PLURAL = new Intl.PluralRules(LANG);
	function say(key, vars) {
		let w = WORDS[key];
		if (w === undefined) return key;
		if (typeof w === "object") w = w[PLURAL.select(Number(vars && vars.n) || 0)] ?? w.other;
		return vars ? w.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : w;
	}
	/// How money and days are written: the language with the home's country ("en-SG", "zh-Hant-DE").
	const LOCALE = (() => { try { return Intl.getCanonicalLocales(`${LANG}-${HOME.country}`)[0]; } catch { return LANG; } })();
	document.documentElement.lang = LANG;

	// ---------------------------------------------------------------- words that are keys (categories, kinds, flags)
	/// Built-in category keys the ledger may use; any other category is the owner's own name, shown as he typed it.
	const CAT_ALIAS = { Rent: "rent", "Family Support": "family_support", uncategorized: "uncategorised", Uncategorised: "uncategorised" };
	const CAT_KEYS = new Set(["flights", "lodging", "dining", "groceries", "transport", "shopping", "subscriptions", "utilities", "health", "fees", "entertainment", "travel", "income", "education", "insurance", "gifts", "home", "personal_care", "charity", "taxes", "rent", "family_support", "uncategorised", "other"]);
	const catName = (c) => { if (!c) return say("cat.uncategorised"); const k = CAT_ALIAS[c] || c; return CAT_KEYS.has(k) ? say("cat." + k) : c; };
	const KIND_KEYS = ["wallet_offset", "refund", "fee", "rebate", "income", "transfer", "card_payment", "investment", "investment_transfer", "loan_repayment", "repayment", "friend_transfer"];
	const KIND = Object.fromEntries(KIND_KEYS.map((k) => [k, say("kind." + k)]));
	/// Money out that is not spending, as the owner can mark it (POST /api/lines/:id/kind).
	const NON_SPEND = ["investment", "loan_repayment", "friend_transfer", "transfer", "card_payment"].map((k) => [k, KIND[k]]);
	/// The categories the owner can pick (round 2 adds rent, family support).
	const PICK_CATS = ["dining", "groceries", "transport", "shopping", "rent", "family_support", "utilities", "subscriptions", "health", "entertainment", "lodging", "flights", "education", "insurance", "gifts", "home", "personal_care", "fees", "taxes", "charity", "other"];
	let CATS = []; // the owner's own categories (GET /api/categories), loaded at boot
	let CAT_WAS = {}; // a category the owner renamed → the name it started as (it keeps that one's icon)
	/// A small icon in front of each category, so the owner finds it at a glance (22 Oct 2026). Emoji: the
	/// iPhone draws them in colour in light and dark, and a name the owner adds still gets one (the tag).
	/// Keyed by the category's own name or key, never by the words shown for it.
	const CAT_ICON = {
		food: "🍜", dining: "🍜", drinks: "🧋", snacks: "🍪", supermarket: "🛒", groceries: "🛒",
		transportation: "🚇", transport: "🚇", "grab/uber": "🚗", grab: "🚗", taxi: "🚕", social: "🥂",
		gift: "🎁", gifts: "🎁", tax: "🧾", taxes: "🧾", clothes: "👕", shopping: "🛍️", furniture: "🛋️", home: "🛋️",
		"gym membership": "🏋️", gym: "🏋️", equipment: "🛠️", "ai subscription": "🤖", "other subscription": "🔁",
		subscriptions: "🔁", haircut: "💈", personal_care: "💈", healthcare: "🩺", health: "🩺", insurance: "🛡️",
		"finance cost": "🏦", fees: "🏦", rent: "🏠", "family support": "👪", family_support: "👪",
		entertainment: "🎬", others: "📦", other: "📦", travel: "🧳", flights: "✈️", lodging: "🏨",
		utilities: "💡", education: "📚", charity: "🤝", salary: "💰", income: "💰", uncategorised: "❔", uncategorized: "❔",
		// The Traditional Chinese starting list (src/words "categories.default"), same icons as the English one.
		餐飲: "🍜", 超市: "🛒", 飲料: "🧋", 交通: "🚇", 購物: "🛍️", 服飾: "👕", 娛樂: "🎬", 訂閱: "🔁",
		醫療: "🩺", 保險: "🛡️", 房租: "🏠", 水電: "💡", 禮物: "🎁", 旅行: "🧳", 其他: "📦",
	};
	/// A name not in the list above: its words (in any language the owner typed it), else the tag.
	const CAT_WORDS = [[/subscri|訂閱/i, "🔁"], [/food|meal|餐|吃/i, "🍜"], [/drink|coffee|tea|咖啡|飲/i, "🧋"], [/gym|fitness|健身/i, "🏋️"], [/health|medic|doctor|醫/i, "🩺"], [/pet|寵物/i, "🐾"], [/travel|trip|旅/i, "🧳"], [/book|書/i, "📚"], [/phone|mobile|電話/i, "📱"]];
	const catIcon = (c) => {
		const k = String(c || "uncategorised").toLowerCase(), was = c && CAT_WAS[c];
		return CAT_ICON[k] || (CAT_WORDS.find(([re]) => re.test(k)) || [])[1] || (was && was !== c ? catIcon(was) : "🏷️");
	};
	/// A→Z by the name the owner reads, case-insensitive, in his language's order.
	const BY_NAME = new Intl.Collator(LANG, { sensitivity: "base", numeric: true });
	const isUncat = (c) => !c || /^uncategori[sz]ed$/i.test(c);
	const sortCats = (list) => [...new Set(list)].sort((a, b) => BY_NAME.compare(catName(a), catName(b)) || BY_NAME.compare(a, b));
	let TRIPS = []; // confirmed trips, for "add to a trip" in a line's detail
	const EVIDENCE = Object.fromEntries(["alert", "apple_pay_shortcut", "receipt", "statement_line", "manual", "sms"].map((k) => [k, say("evidence." + k)]));
	const FLAG = Object.fromEntries(["missed_by_alerts", "not_on_statement", "unlinked_refund", "no_rate", "needs_review"].map((k) => [k, say("flag." + k, { currency: currencyName(HC) })]));
	const RECON = Object.fromEntries(["not_reconcilable", "no_total", "no_balances", "printed_total_disagrees", "statement_lines_mismatch", "ledger_mismatch", "unmatched_statement_line", "line_in_review", "estimate_on_statement", "currency_mismatch", "wallet_balance_mismatch"].map((k) => [k, say("recon." + k)]));
	const CADENCE = Object.fromEntries(["weekly", "monthly", "quarterly", "yearly"].map((k) => [k, say("cadence." + k)]));
	const SUB_THRESHOLD = { weekly: 4, monthly: 3, quarterly: 3, yearly: 2 }; // CONTRACT §11.10
	const CURRENCIES = [HC, ...["SGD", "JPY", "TWD", "USD", "MYR", "THB", "KRW", "HKD", "CNY", "EUR", "GBP", "AUD", "IDR", "VND"].filter((c) => c !== HC)];

	// ---------------------------------------------------------------- money (integer minor units, never floats for storage)
	/// Written with Intl in the owner's locale (src/words.ts sayMoney does the same): "€12.50",
	/// "$4.50" (his own dollars), "US$4.50", "¥1,200".
	const EXP = { JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, PYG: 0, UGX: 0, XAF: 0, XOF: 0, BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3 };
	const exp = (c) => (EXP[String(c).toUpperCase()] ?? 2);
	const NUMBER_FORMATS = new Map();
	function currencyFormat(cur, display) {
		const key = cur + "|" + display;
		let f = NUMBER_FORMATS.get(key);
		if (!f) {
			const e = exp(cur);
			try { f = new Intl.NumberFormat(LOCALE, { style: "currency", currency: cur, currencyDisplay: display, minimumFractionDigits: e, maximumFractionDigits: e }); }
			catch { f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: e, maximumFractionDigits: e }); }
			NUMBER_FORMATS.set(key, f);
		}
		return f;
	}
	const markOf = (cur, display, loc) => { try { return new Intl.NumberFormat(loc || LOCALE, { style: "currency", currency: cur, currencyDisplay: display }).formatToParts(0).find((p) => p.type === "currency").value; } catch { return cur; } };
	const MARKS = new Map();
	/// The mark the owner reads: his own currency's symbol (its narrow one when the locale would
	/// spell the code); another currency's symbol unless it would look like his own — then the
	/// English one, else its code.
	function markFor(cur) {
		if (MARKS.has(cur)) return MARKS.get(cur);
		const homeSym = markOf(HC, "symbol"), homeMark = homeSym === HC ? markOf(HC, "narrowSymbol") : homeSym;
		let r;
		if (cur === HC) r = { display: homeMark === homeSym ? "symbol" : "narrowSymbol", text: homeMark };
		else {
			const m = markOf(cur, "symbol"), en = markOf(cur, "symbol", "en");
			r = m !== homeMark ? { display: "symbol", text: m } : en !== homeMark && en !== cur ? { display: "symbol", text: en } : { display: "code", text: cur };
		}
		MARKS.set(cur, r);
		return r;
	}
	/// An exact decimal string of minor units: Intl formats it without a float standing in for money.
	const decimal = (minor, cur) => { const e = exp(cur), s = String(Math.abs(minor)).padStart(e + 1, "0"); return e ? s.slice(0, -e) + "." + s.slice(-e) : s; };
	function fmt(minor, cur) {
		const c = String(cur).toUpperCase(), m = markFor(c);
		const body = currencyFormat(c, m.display).formatToParts(decimal(minor, c)).map((p) => (p.type === "currency" ? m.text : p.value)).join("");
		return (minor < 0 ? "−" : "") + body;
	}
	/// A missing or broken amount (null, no currency, NaN) reads "—", never "NaN" or "undefined".
	const fm = (m) => (m && Number.isFinite(m.minor) && m.currency ? fmt(m.minor, m.currency) : "—");
	const home = (minor) => fmt(minor, HC);
	/// A currency's name in the owner's language ("Euro", "新加坡幣").
	function currencyName(code) { try { return new Intl.DisplayNames([LOCALE], { type: "currency" }).of(code) || code; } catch { return code; } }
	/// Exchange rates the way the owner reads them: "$1 = ¥110.5" — how much foreign money one unit of the
	/// card's own money buys. JPY 1 decimal, TWD 2 decimals, others 4 significant figures.
	function perUnit(x, cur) {
		if (!(x > 0) || !Number.isFinite(x)) return null;
		const c = String(cur).toUpperCase();
		const t = c === "JPY" ? x.toFixed(1) : c === "TWD" ? x.toFixed(2) : String(+x.toPrecision(4));
		const d = (t.split(".")[1] || "").length;
		return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }).format(t);
	}
	const sym = (c) => markFor(String(c).toUpperCase()).text;
	/// rate = units of `base` per one unit of `foreign` (as the ledger stores it); shown inverted.
	const rateText = (base, foreign, rate) => { const x = rate > 0 ? perUnit(1 / rate, foreign) : null; return x ? `${sym(base)}1 = ${sym(foreign)}${x}` : "—"; };
	const feePct = (m) => (m === null || m === undefined ? "" : String(+(m * 100).toFixed(2)) + "%");
	/// Parse a typed amount without floats (mirrors parseMajor): "1,200" → 1200 (JPY), "12.5" → 1250 (SGD).
	function parseMajor(text, cur) {
		const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(String(text).trim().replace(/,/g, ""));
		if (!m) return null;
		const e = exp(cur), frac = m[3] || "";
		if (frac.length > e) return null;
		const n = Number(m[2] + frac.padEnd(e, "0"));
		return Number.isSafeInteger(n) ? (m[1] ? -n : n) : null;
	}

	// ---------------------------------------------------------------- dates (the owner's calendar, written in his locale)
	const parts = (iso) => iso.split("-").map(Number);
	const DATE_FORMATS = new Map();
	/// A calendar day (or month) through Intl, at noon UTC so no zone moves it.
	const dfmt = (opts) => { const k = JSON.stringify(opts); let f = DATE_FORMATS.get(k); if (!f) DATE_FORMATS.set(k, (f = new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone: "UTC" }))); return f; };
	const noon = (iso) => new Date(iso.slice(0, 10) + "T12:00:00Z");
	/// Chinese spells the month as a number with 月 ("long"); English abbreviates it.
	const MONTH = { "zh-Hant": "long" }[LANG] || "short";
	/// A date carries its year whenever it is not this year's (the owner, round 2: the year everywhere).
	const fdate = (iso) => { if (!/^\d{4}-\d{2}-\d{2}/.test(iso || "")) return "—"; const y = +iso.slice(0, 4); return dfmt({ ...(y === +todayLocal().slice(0, 4) ? {} : { year: "numeric" }), month: MONTH, day: "numeric" }).format(noon(iso)); };
	const addDays = (iso, n) => { const t = new Date(iso + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
	const weekday = (iso) => dfmt({ weekday: "short" }).format(noon(iso));
	const fmonth = (ym) => dfmt({ year: "numeric", month: "long" }).format(noon(ym + "-15"));
	const fshortMonth = fmonth; // round 2: a month is always shown with its year
	const fyear = (y) => dfmt({ year: "numeric" }).format(noon(`${y}-06-15`));
	const fmonthOnly = (ym) => dfmt({ month: "short" }).format(noon(ym + "-15"));
	/// A day range. Chinese keeps its own shape (「10月1日–5日」); other languages ask Intl ("1–5 Oct").
	const RANGE = {
		"zh-Hant": (a, b) => {
			const [ya, ma] = parts(a), [yb, mb, db] = parts(b);
			if (ya === yb && ma === mb) return `${fdate(a)}–${db}日`;
			if (ya !== yb) return `${ya}年${fdate(a).replace(/^\d+年/, "")}–${yb}年${fdate(b).replace(/^\d+年/, "")}`;
			return `${fdate(a)}–${fdate(b)}`;
		},
	};
	const intlRange = (a, b) => {
		const thisYear = +todayLocal().slice(0, 4), year = +a.slice(0, 4) !== thisYear || +b.slice(0, 4) !== thisYear;
		const f = dfmt({ ...(year ? { year: "numeric" } : {}), month: MONTH, day: "numeric" });
		return f.formatRange ? f.formatRange(noon(a), noon(b)) : `${fdate(a)} – ${fdate(b)}`;
	};
	function frange(a, b) {
		if (!a || !b) return a || b ? fdate(a || b) : "—";
		if (a === b) return fdate(a);
		return (RANGE[LANG] || intlRange)(a, b);
	}
	const dayNum = (iso) => { const [y, m, d] = parts(iso); return Date.UTC(y, m - 1, d) / 86400000; };
	const daysBetween = (a, b) => dayNum(b) - dayNum(a);
	function monthBounds(ym) {
		const [y, m] = parts(ym + "-01");
		const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
		return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
	}
	function addMonth(ym, n) {
		const [y, m] = ym.split("-").map(Number);
		const t = y * 12 + (m - 1) + n;
		return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
	}
	/// Today on the owner's calendar (his time zone), YYYY-MM-DD.
	const todayLocal = () => (FX ? FX.today : new Intl.DateTimeFormat("en-CA", { timeZone: HOME.time_zone }).format(new Date()));

	// ---------------------------------------------------------------- text safety
	const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	/// Cut text to `max` UTF-8 bytes (D1 LIKE patterns are capped; CONTRACT §3, §6.1).
	function byteCap(s, max) {
		const enc = new TextEncoder();
		let out = "";
		for (const ch of s) { if (enc.encode(out + ch).length > max) break; out += ch; }
		return out;
	}

	// ---------------------------------------------------------------- the API (envelope rule, §5.1)
	class LoadError extends Error {
		constructor(message, status) { super(message); this.status = status; }
	}
	/// What the page has read, by address: successes only, never a failure (§5.1).
	/// A tab the owner has seen draws AT ONCE from here (20 Oct 2026 — 「切換分頁都很慢，
	/// 大概3-5秒」): within FRESH_MS it is used as it is; older (up to STALE_MS) it is shown
	/// and a fresh copy is fetched behind it — the tab redraws only if something changed.
	/// Past STALE_MS the page waits for the server, as it always did. Any change the owner
	/// makes (a POST) empties it, so what he just did is never shown from memory.
	const CACHE = new Map(); // path → {t, body}
	const FRESH_MS = 30000, STALE_MS = 10 * 60000;
	const INFLIGHT = new Map(); // path → the one fetch of it under way (two tabs asking share it)
	async function api(path, opts = {}) {
		const get = !opts.method || opts.method === "GET";
		if (!get) {
			CACHE.clear(); INFLIGHT.clear();
			const body = await apiRaw(path, opts);
			CACHE.clear(); INFLIGHT.clear();
			return body;
		}
		const hit = CACHE.get(path);
		const age = hit ? Date.now() - hit.t : Infinity;
		if (age < FRESH_MS) return JSON.parse(hit.body);
		if (age < STALE_MS) { revalidate(path); return JSON.parse(hit.body); }
		return JSON.parse(await fetchInto(path));
	}
	/// Fetches a GET into the cache (once, however many ask), answering its text.
	function fetchInto(path) {
		let p = INFLIGHT.get(path);
		if (!p) {
			p = apiRaw(path).then((body) => {
				const text = JSON.stringify(body);
				if (INFLIGHT.get(path) === p) CACHE.set(path, { t: Date.now(), body: text });
				return text;
			}).finally(() => { if (INFLIGHT.get(path) === p) INFLIGHT.delete(path); });
			INFLIGHT.set(path, p);
		}
		return p;
	}
	/// The fresh copy behind a remembered answer. Changed → the tab on screen redraws
	/// (where the owner is reading, never while he is typing or has a sheet open). A failure
	/// leaves the remembered answer; a lock shows the lock.
	function revalidate(path) {
		if (INFLIGHT.has(path)) return;
		const before = CACHE.get(path);
		fetchInto(path).then((text) => {
			if (before && text === before.body) return;
			if (path === "/api/needs-ok") { try { setBadge(okCount(JSON.parse(text))); } catch { /* the badge stays */ } }
			redrawSoon();
		}, (e) => { if (e && e.status === 401) showLocked(); });
	}
	function redrawSoon() {
		clearTimeout(redrawSoon.t);
		redrawSoon.t = setTimeout(() => {
			if (LOCKED || $("#sheet").hasAttribute("open")) return;
			const a = document.activeElement;
			if (a && a !== document.body && VIEW.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
			const panel = document.getElementById("ln-panel");
			if (panel && !panel.hidden) return;
			if (VIEW.querySelector('[data-action="toggle-line"][aria-expanded="true"]')) return; // a line he opened stays open
			route({ soft: true });
		}, 60);
	}
	/// After the first tab has drawn: the other tabs' reads, fetched quietly, so the
	/// first visit to each draws from memory too.
	function prefetch() {
		const m = state.month;
		const quiet = (p) => p.catch(() => { /* the tab fetches it itself when opened */ });
		quiet(api("/api/overview" + qstr({ month: m })));
		quiet(allLines(linesQuery(new URLSearchParams(), m)));
		quiet(api("/api/payments"));
		quiet(api("/api/months"));
		quiet(api("/api/needs-ok"));
	}
	async function apiRaw(path, opts = {}) {
		if (FIXTURES) return fixtureApi(path, opts);
		let res;
		try {
			res = await fetch(path, {
				method: opts.method || "GET",
				credentials: "same-origin",
				cache: "no-store",
				headers: opts.body ? { "content-type": "application/json" } : {},
				body: opts.body ? JSON.stringify(opts.body) : undefined,
			});
		} catch {
			throw new LoadError(say("err.offline"), 0);
		}
		let body = null;
		try { body = await res.json(); } catch { /* not JSON: a crash page */ }
		if (res.status === 401) throw new LoadError("locked", 401);
		if (!res.ok || !body || body.ok !== true) {
			throw new LoadError(body && typeof body.message === "string" && body.message ? body.message : say("err.server", { status: res.status }), res.status);
		}
		return body;
	}
	const qstr = (o) => {
		const u = new URLSearchParams();
		for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") u.set(k, v);
		const s = u.toString();
		return s ? "?" + s : "";
	};

	// ---------------------------------------------------------------- fixture server (made-up data, in memory)
	async function fixtureApi(path, opts) {
		await new Promise((r) => setTimeout(r, 90));
		const u = new URL(path, "https://fixture.invalid");
		const p = u.pathname, q = u.searchParams, method = opts.method || "GET", body = opts.body || {};
		let m, name;
		if (method === "GET" && p === "/api/overview") name = "overview";
		else if (method === "GET" && p === "/api/lines") name = "lines";
		else if (method === "GET" && p === "/api/months") name = "months";
		else if (method === "GET" && p === "/api/trips") name = "trips";
		else if (method === "GET" && p === "/api/subscriptions") name = "subscriptions";
		else if (method === "GET" && p === "/api/needs-ok") name = "needs-ok";
		else if (method === "GET" && p === "/api/reimbursable-ranges") name = "reimbursable-ranges";
		else if (method === "GET" && p === "/api/accounts") name = "accounts";
		else if (method === "GET" && p === "/api/wallets") name = "wallets";
		else if (method === "GET" && p === "/api/payments") name = "payments";
		else if (method === "POST" && (m = /^\/api\/accounts\/([^/]+)\/settings$/.exec(p))) name = "account-settings";
		else if (method === "POST" && (m = /^\/api\/lines\/([^/]+)\/subscription$/.exec(p))) name = "line-subscription";
		else if (method === "POST" && !okItemByPath(p) && (m = /^\/api\/lines\/([^/]+)\/(kind|category)$/.exec(p))) name = "line-" + m[2];
		else if (method === "POST" && p === "/api/reimbursable-ranges") name = "reimbursable-ranges-post";
		else if (method === "POST" && p === "/api/cash") name = "cash";
		else if (method === "POST" && (m = /^\/api\/trips\/([^/]+)\/(confirm|reject)$/.exec(p))) name = "trip-" + m[2];
		else if (method === "POST" && (m = /^\/api\/lines\/([^/]+)\/reimbursable$/.exec(p))) name = "line-reimbursable";
		else if (method === "POST" && (m = /^\/api\/reimbursable-ranges\/([^/]+)\/delete$/.exec(p))) name = "range-delete";
		else if (method === "POST" && (m = /^\/api\/subscriptions\/([^/]+)$/.exec(p))) name = "subscription-action";
		else if (method === "POST" && p === "/api/wallet-names") name = "wallet-names";
		else if (method === "GET" && p === "/api/status") return demoStatus();
		else if (method === "GET" && p === "/api/statements/uploads") return JSON.parse(JSON.stringify({ ok: true, uploads: DEMO_UPLOADS }));
		else if (method === "POST" && okItemByPath(p)) name = "action";
		else if (method === "POST" && (m = /^\/api\/payments\/([^/]+)\/paid$/.exec(p))) name = "bill-paid";
		else if (method === "GET" && p === "/api/categories") name = "categories";
		else if (method === "POST" && p === "/api/trips") name = "trip-create";
		else if (method === "POST" && p === "/api/categories") name = "categories-edit";
		else if (method === "POST" && (m = /^\/api\/lines\/([^/]+)\/offset$/.exec(p))) name = "line-offset";
		else if (method === "POST" && (m = /^\/api\/trips\/([^/]+)\/edit$/.exec(p))) name = "trip-edit";
		else if (method === "POST" && (m = /^\/api\/lines\/([^/]+)\/category$/.exec(p))) name = "line-category";
		else throw new LoadError(say("demo.no_route"), 404);
		if (FAIL.has(name)) throw new LoadError(say("demo.fail", { name }), 500);
		const L = DB.lines.lines;
		const clone = (x) => JSON.parse(JSON.stringify(x));

		switch (name) {
			case "overview": {
				const month = q.get("month") || FX.month;
				const base = DB["overview." + month] || (month === FX.month ? DB.overview : { ...DB.overview, month });
				const { from, to } = monthBounds(month);
				const inMonth = L.filter((v) => v.date >= from && v.date <= to && v.state !== "void");
				const group = (key, head) => {
					const g = new Map();
					for (const v of inMonth.filter((x) => x.spending)) {
						const k = key(v);
						if (!g.has(k)) g.set(k, { ...head(v), rows: [] });
						g.get(k).rows.push(v);
					}
					return [...g.values()].map(({ rows, ...rest }) => ({ ...rest, ...sums(rows) })).sort((a, b) => b.spending_home.minor - a.spending_home.minor);
				};
				const all = sums(inMonth.filter((v) => v.spending));
				return clone({
					...base,
					totals: { spending_home: all.spending_home, count: all.count, unconfirmed_home: all.unconfirmed_home, missing_rate_count: inMonth.filter((v) => v.flags.includes("no_rate")).length },
					categories: group((v) => v.category || "Uncategorised", (v) => ({ category: v.category || "Uncategorised" })),
					// every active wallet is always listed, as the route does (19 Oct 2026)
					by_account: ((g) => g.concat(DB.accounts.accounts.filter((a) => a.kind === "wallet" && a.active !== false && !g.some((x) => x.account_id === a.id)).map((a) => ({ account_id: a.id, name: a.name, kind: "wallet", ...sums([]) }))))(group((v) => v.account.id, (v) => ({ account_id: v.account.id, name: v.account.name, kind: v.account.kind }))),
					// Dev's shape: group_by + groups[{key, spending_home, unconfirmed_home, count, share_pct}]
					group_by: q.get("group_by") === "merchant" ? "merchant" : "category",
					groups: (q.get("group_by") === "merchant" ? group((v) => v.merchant.name || v.merchant.raw, (v) => ({ key: v.merchant.name || v.merchant.raw })) : group((v) => v.category || "Uncategorised", (v) => ({ key: v.category || "Uncategorised" })))
						.map((g) => ({ ...g, share_pct: all.spending_home.minor ? Math.round((g.spending_home.minor / all.spending_home.minor) * 1000) / 10 : null })),
				});
			}
			case "lines": {
				let rows = L;
				const f = (k) => q.get(k);
				if (f("from")) rows = rows.filter((v) => v.date >= f("from"));
				if (f("to")) rows = rows.filter((v) => v.date <= f("to"));
				if (f("account")) rows = rows.filter((v) => v.account.id === f("account"));
				if (f("category")) rows = rows.filter((v) => (v.category || "Uncategorised") === f("category"));
				if (f("trip")) rows = rows.filter((v) => v.trip_id === f("trip"));
				if (f("kind")) rows = rows.filter((v) => v.kind === f("kind"));
				if (f("reimbursable")) rows = rows.filter((v) => String(v.reimbursable.effective) === f("reimbursable"));
				if (f("q")) { const s = f("q").toLowerCase(); rows = rows.filter((v) => [v.merchant.name, v.merchant.raw, v.note].some((t) => t && t.toLowerCase().includes(s))); }
				if (f("sort") === "amount") { const dir = f("order") === "asc" ? 1 : -1; rows = rows.slice().sort((a, b) => dir * (a.amount.home.minor - b.amount.home.minor)); }
				else if (f("order") === "asc") rows = rows.slice().reverse();
				const start = Number(f("cursor") || 0), size = Number(f("limit") || 50);
				return clone({ ok: true, lines: rows.slice(start, start + size), next_cursor: start + size < rows.length ? String(start + size) : null });
			}
			case "months": case "trips": case "subscriptions": case "reimbursable-ranges": case "accounts": case "payments":
				return clone(DB[name]);
			case "wallets":
				return clone(DB.wallets || { ok: true, wallets: [] });
			case "needs-ok": {
				const { line_actions: acts = {}, ...n } = DB["needs-ok"];
				const ids = new Set(n.lines.map((l) => l.id));
				const trips = DB.trips.trips.filter((t) => t.status === "proposed"), lines = L.filter((v) => ids.has(v.id)).map((v) => ({ ...v, actions: acts[v.id] || [] }));
				const extra = Object.values(n).filter((x) => Array.isArray(x) && x !== n.lines && x !== n.trips).reduce((s, x) => s + x.length, 0);
				return clone({ ...n, trips, lines, count: trips.length + lines.length + extra });
			}
			case "trip-confirm": case "trip-reject": {
				const t = DB.trips.trips.find((x) => x.id === decodeURIComponent(m[1]));
				if (!t) throw new LoadError(say("demo.no_trip"), 404);
				if (t.status !== "proposed") throw new LoadError(say("demo.trip_done"), 409);
				t.status = name === "trip-confirm" ? "confirmed" : "dismissed";
				return clone({ ok: true, trip: t });
			}
			case "categories-edit": {
				DB.categories = DB.categories || { categories: ["Food", "Supermarket", "Drinks", "Transportation", "Grab/Uber", "Others"], was: {} };
				const C = DB.categories, was = (C.was = C.was || {});
				const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
				if (body.add) C.categories.push(body.add);
				const from = body.rename ?? body.delete;
				if (from !== undefined) {
					const to = body.rename !== undefined ? body.to : body.move_to || null;
					if (body.delete !== undefined && !to && L.some((v) => same(v.category, from))) throw new LoadError(`'${from}' is used by lines; say which category they move to`, 400);
					for (const v of L) if (same(v.category, from)) v.category = to;
					C.categories = body.rename !== undefined ? C.categories.map((c) => (same(c, from) ? to : c)) : C.categories.filter((c) => !same(c, from));
					if (body.rename !== undefined) was[to] = was[from] || from;
					delete was[from];
				}
				return clone({ ok: true, categories: C.categories, was });
			}
			case "line-offset": {
				const v = L.find((x) => x.id === decodeURIComponent(m[1]));
				if (!v) throw new LoadError(say("demo.no_line"), 404);
				if (body.to === "none") { v.income_offset = null; v.kind = "income"; v.spending = false; }
				else if (body.to === "salary") { v.income_offset = { to: "salary", account_id: null }; v.kind = "income"; v.category = "Salary"; v.spending = false; }
				else { const t = body.to === "line" ? L.find((x) => x.id === body.target_line_id) : null; v.income_offset = { to: body.to, account_id: body.to === "card" ? body.account_id : t && t.account.id }; v.kind = "refund"; v.spending = true; if (t) { v.category = t.category; v.refund_of = t.id; } }
				return clone({ ok: true, line: v });
			}
			case "trip-create": {
				const t = { id: "trip-new-" + Date.now(), name: body.name, destination: body.destination || body.name, countries: [], start_date: body.start_date, end_date: body.end_date, status: "confirmed",
					total_home: { currency: HC, minor: 0 }, unconfirmed_home: { currency: HC, minor: 0 }, reimbursable_home: { currency: HC, minor: 0 }, line_count: 0 };
				const members = L.filter((v) => v.spending && v.date >= t.start_date && v.date <= t.end_date && v.amount.original.currency !== HC);
				for (const v of members) v.trip_id = t.id;
				t.line_count = members.length; t.total_home.minor = members.reduce((a, v) => a + v.amount.home.minor, 0);
				DB.trips.trips.unshift(t);
				return clone({ ok: true, trip: t, lines: members });
			}
			case "trip-edit": {
				const t = DB.trips.trips.find((x) => x.id === decodeURIComponent(m[1]));
				if (!t) throw new LoadError(say("demo.no_trip"), 404);
				for (const id of body.include_line_ids || []) { const v = L.find((x) => x.id === id); if (v) v.trip_id = t.id; }
				for (const id of body.exclude_line_ids || []) { const v = L.find((x) => x.id === id); if (v && v.trip_id === t.id) v.trip_id = null; }
				const members = L.filter((v) => v.trip_id === t.id);
				t.line_count = members.length; t.total_home = { currency: HC, minor: members.reduce((a, v) => a + v.amount.home.minor, 0) };
				return clone({ ok: true, trip: t, lines: members });
			}
			case "categories": {
				const list = DB.categories ? DB.categories.categories : ["Food", "Supermarket", "Drinks", "Transportation", "Grab/Uber", "Others"];
				const usage = Object.fromEntries(list.map((c) => [c, { lines: L.filter((v) => v.state !== "void" && String(v.category || "").toLowerCase() === c.toLowerCase()).length, rules: 0 }]));
				return clone({ ok: true, categories: list, was: (DB.categories && DB.categories.was) || {}, usage });
			}
			case "line-category": {
				const v = L.find((x) => x.id === decodeURIComponent(m[1]));
				if (!v) throw new LoadError(say("demo.no_line"), 404);
				const person = /PAYNOW|LEE |TAN /i.test(v.merchant.raw || "");
				const scope = body.scope === "line" || (body.scope !== "merchant" && person) ? "line" : "merchant";
				let others = 0;
				if (scope === "merchant") for (const x of L) if (x.id !== v.id && x.merchant.name === v.merchant.name && x.category !== body.category) { x.category = body.category; others++; }
				v.category = body.category;
				return clone({ ok: true, line: v, scope, person, merchant_name: v.merchant.name, others });
			}
			case "line-reimbursable": {
				const v = L.find((x) => x.id === decodeURIComponent(m[1]));
				if (!v) throw new LoadError(say("demo.no_line"), 404);
				if (typeof body.value !== "boolean" && body.value !== null) throw new LoadError(say("demo.bad_value"), 400);
				if (body.value === null) {
					const hit = v.spending && DB["reimbursable-ranges"].ranges.find((r) => v.date >= r.start_date && v.date <= r.end_date);
					v.reimbursable = hit ? { effective: true, source: "range", range_id: hit.id } : { effective: false, source: null, range_id: null };
				} else v.reimbursable = { effective: body.value, source: "override", range_id: null };
				return clone({ ok: true, line: v });
			}
			case "reimbursable-ranges-post": {
				const { from, to, note } = body;
				if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) throw new LoadError(say("demo.bad_dates"), 400);
				if (from > to) throw new LoadError(say("demo.end_before_start"), 400);
				const range = { id: "rr-demo-" + Date.now(), start_date: from, end_date: to, note: note || null };
				DB["reimbursable-ranges"].ranges.unshift(range);
				let n = 0;
				for (const v of L) {
					if (v.spending && v.reimbursable.source !== "override" && !v.reimbursable.effective && v.date >= from && v.date <= to) {
						v.reimbursable = { effective: true, source: "range", range_id: range.id }; n++;
					}
				}
				return clone({ ok: true, range, count: n });
			}
			case "range-delete": {
				const id = decodeURIComponent(m[1]);
				const rs = DB["reimbursable-ranges"].ranges;
				if (!rs.some((r) => r.id === id)) throw new LoadError(say("demo.no_range"), 404);
				DB["reimbursable-ranges"].ranges = rs.filter((r) => r.id !== id);
				let n = 0;
				for (const v of L) if (v.reimbursable.source === "range" && v.reimbursable.range_id === id) { v.reimbursable = { effective: false, source: null, range_id: null }; n++; }
				return clone({ ok: true, ranges: DB["reimbursable-ranges"].ranges, affected_lines: n });
			}
			case "subscription-action": {
				const sub = DB.subscriptions.subscriptions.find((x) => x.id === decodeURIComponent(m[1]));
				if (!sub) throw new LoadError(say("demo.no_sub"), 404);
				if (body.action === "ignore") sub.status = "ignored";
				else if (body.action === "cancelled") sub.status = "cancelled";
				else if (body.action === "active") sub.status = "active";
				else if (body.action === "restore") sub.status = daysBetween(sub.next_renewal, FX.today) > 7 ? "lapsed" : "active";
				else throw new LoadError(say("demo.bad_action"), 400);
				return clone(DB.subscriptions);
			}
			case "account-settings": {
				const a = DB.accounts.accounts.find((x) => x.id === decodeURIComponent(m[1]));
				if (!a || a.kind !== "credit_card") throw new LoadError(say("demo.no_card"), 404);
				if ("autopay" in body) {
					a.autopay = body.autopay;
					const c = (DB.payments.cards || []).find((x) => x.account.id === a.id);
					if (c) {
						c.autopay = body.autopay === null ? { on: false, source: null } : { on: body.autopay, source: "owner" };
						if (c.status === "overdue" && body.autopay) Object.assign(c, { status: "autopay_pending", status_reason: null });
						else if (c.status === "autopay_pending" && !body.autopay) Object.assign(c, { status: "overdue", status_reason: "no_payment_seen" });
					}
					return clone({ ok: true, account: a, message: say(body.autopay === null ? "demo.autopay_ledger" : body.autopay ? "demo.autopay_on" : "demo.autopay_off") });
				}
				const ok = (d) => d === null || (Number.isInteger(d) && d >= 1 && d <= 31);
				if (!ok(body.statement_day) || !ok(body.due_day)) throw new LoadError(say("demo.bad_day"), 400);
				Object.assign(a, { statement_day: body.statement_day, due_day: body.due_day, settings_source: "owner" });
				return clone({ ok: true, account: a });
			}
			case "line-subscription": {
				const v = L.find((x) => x.id === decodeURIComponent(m[1]));
				if (!v) throw new LoadError(say("demo.no_line"), 404);
				const subs = DB.subscriptions.subscriptions, key = (v.merchant.name || v.merchant.raw || "").toLowerCase();
				let s = subs.find((x) => x.merchant.toLowerCase() === key);
				if (body.value === true) {
					if (!CADENCE[body.cadence]) throw new LoadError(say("demo.bad_cadence"), 400);
					if (!s) { s = { id: "sub-demo-" + Date.now(), merchant: v.merchant.name || v.merchant.raw, amount: v.amount.billed, previous_amount: null, price_changed_on: null, last_charged: v.date, occurrences: 1, monthly_equivalent: v.amount.billed }; subs.push(s); }
					const step = { weekly: 0, monthly: 1, quarterly: 3, yearly: 12 }[body.cadence];
					Object.assign(s, { cadence: body.cadence, status: "active", next_renewal: step ? addMonth(v.date.slice(0, 7), step) + v.date.slice(7) : v.date });
					v.subscription = { id: s.id, cadence: s.cadence, status: s.status };
				} else if (body.value === false) {
					if (s) s.status = "ignored";
					v.subscription = null;
				} else throw new LoadError(say("demo.bad_value_bool"), 400);
				return clone({ ok: true, line: v, subscription: s || null });
			}
			case "line-kind": case "line-category": {
				const v = L.find((x) => x.id === decodeURIComponent(m[1]));
				if (!v) throw new LoadError(say("demo.no_line"), 404);
				const key = (x) => (x.merchant.name || x.merchant.raw || "").toLowerCase();
				const set = name === "line-kind"
					? (x) => { const topup = body.kind === "wallet_topup" || body.kind === "grabpay_topup"; if (!KIND[body.kind] && body.kind !== "purchase" && !topup) throw new LoadError(say("demo.bad_kind"), 400); if (body.kind === "wallet_topup" && !body.wallet) throw new LoadError(say("demo.which_wallet"), 400); x.kind = topup ? "transfer" : body.kind; x.spending = body.kind === "purchase"; }
					: (x) => { if (!body.category) throw new LoadError(say("demo.need_category"), 400); x.category = body.category; };
				const hit = body.apply_to_merchant ? L.filter((x) => key(x) === key(v)) : [v];
				hit.forEach(set);
				return clone({ ok: true, line: v, changed: hit.length });
			}
			case "action": {
				if (FAIL.has("action")) throw new LoadError(say("demo.action_fails"), 500);
				const hit = okItemByPath(p), n = DB["needs-ok"];
				if (hit.list === "lines") {
					n.lines = n.lines.filter((l) => l.id !== hit.id);
					const v = L.find((x) => x.id === hit.id);
					if (v && body.category) v.category = body.category;
					if (v) v.flags = [];
				} else n[hit.list] = n[hit.list].filter((x) => x !== hit.item);
				return { ok: true };
			}
			case "bill-paid": {
				const id = decodeURIComponent(m[1]);
				const c = (DB.payments.cards || []).find((x) => x.last_statement && x.last_statement.statement_id === id);
				if (!c) throw new LoadError(say("demo.no_bill"), 404);
				if (body.paid) { c.was = c.was || { status: c.status, status_reason: c.status_reason || null }; Object.assign(c, { status: "paid", status_reason: null, paid_source: "owner" }); }
				else if (c.was) { Object.assign(c, c.was, { paid_source: null }); delete c.was; }
				return clone({ ok: true, card: c, message: say(body.paid ? "demo.paid" : "demo.paid_undo") });
			}
			case "wallet-names": {
				const n = DB["needs-ok"];
				const before = n.held_taps.length;
				if (!body.account_id || !body.name) throw new LoadError(say("demo.need_card"), 400);
				n.held_taps = n.held_taps.filter((h) => h.card !== body.name);
				return clone({ ok: true, wallet_key: body.name, account_id: body.account_id, recorded: before - n.held_taps.length, still_held: 0 });
			}
			case "cash": {
				const cur = body.currency;
				const minor = parseMajor(body.amount, cur);
				if (minor === null || minor <= 0) throw new LoadError(say("demo.bad_amount"), 400);
				if (!body.merchant) throw new LoadError(say("demo.need_merchant"), 400);
				const DEMO_RATE = { SGD: 1, JPY: 0.00905, TWD: 0.0405, USD: 1.3021, MYR: 0.2961, THB: 0.0392, KRW: 0.00097, HKD: 0.1668, CNY: 0.1812, EUR: 1.457, GBP: 1.71, AUD: 0.861, IDR: 0.0000815, VND: 0.0000512 };
				const r = DEMO_RATE[cur] || 1;
				const sg = Math.round((minor / 10 ** exp(cur)) * r * 100);
				const acct = (({ id, name, kind, institution }) => ({ id, name, kind, institution }))(DB.accounts.accounts.find((a) => (body.account_id ? a.id === body.account_id : a.kind === "cash")) || DB.accounts.accounts.find((a) => a.kind === "cash"));
				const mny = (mi, c) => ({ currency: c, minor: mi, display: "" });
				const v = {
					id: "ln-demo-new-" + Date.now(), date: body.date, account: acct, kind: "purchase", state: "open", spending: true, provisional: false,
					merchant: { name: body.merchant, raw: body.merchant, country: null }, category: body.category || null,
					amount: { original: mny(minor, cur), billed: { ...mny(minor, cur), status: "exact" }, home: { ...mny(sg, HC), status: cur === HC ? "exact" : "reference", set_by: "rules" }, overseas_fee: null },
					fx: null, flags: [], evidence: ["manual"], refund_of: null, transfer_group: null, statement_id: null, trip_id: null,
					reimbursable: { effective: false, source: null, range_id: null }, note: body.note || null,
				};
				L.push(v);
				L.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
				return clone({ ok: true, line: v });
			}
		}
		throw new LoadError("unreachable", 500);
	}
	/// Fixture mode: which 待確認 item owns an action that POSTs to this path.
	function okItemByPath(p) {
		const n = DB["needs-ok"];
		for (const [id, acts] of Object.entries(n.line_actions || {})) if (acts.some((a) => a.path === p) && n.lines.some((l) => l.id === id)) return { list: "lines", id };
		for (const [k, list] of Object.entries(n)) {
			if (!Array.isArray(list) || k === "lines") continue;
			const item = list.find((x) => x && Array.isArray(x.actions) && x.actions.some((a) => a.path === p));
			if (item) return { list: k, item };
		}
		return null;
	}
	function money(minor, currency = HC) { return { currency, minor, display: fmt(minor, currency) }; }
	function sums(rows) {
		return {
			spending_home: money(rows.reduce((s, v) => s + v.amount.home.minor, 0)),
			unconfirmed_home: money(rows.filter((v) => v.amount.home.status === "estimate" || v.amount.home.status === "reference").reduce((s, v) => s + v.amount.home.minor, 0)),
			count: rows.length,
		};
	}

	/// Demo of the status strip: `&gmail=none|secret|alarm|unset` shows the other states.
	function demoStatus() {
		const mode = params.get("gmail") || "page";
		const gmail = mode === "unset" ? { ready: false, via: null, email: null, connected_at: null }
			: mode === "none" ? { ready: true, via: null, email: null, connected_at: null }
			: mode === "secret" ? { ready: true, via: "secret", email: null, connected_at: null }
			: { ready: true, via: "page", email: "demo.mailbox@example.com", connected_at: "2026-10-01T02:00:00.000Z" };
		const alarms = mode === "alarm" ? [{ key: "google_signin", message: say("demo.signin_alarm"), raised_at: "2026-10-09T02:00:00.000Z" }] : [];
		return { ok: true, alarms, last_run: null, last_tick_at: null, phase: "daily", queue: { waiting: 0, failed: 0 }, estimate: null, gmail };
	}

	// ---------------------------------------------------------------- shared pieces
	let LOCKED = false;
	function failCard(what, err) {
		if (err && err.status === 401) { showLocked(); return ""; }
		return `<div class="card fail" role="alert">${icon("alert")}<div>
			<b>${esc(say("fail.title", { what }))}</b>
			<p>${say("fail.body_html")}</p>
			<p class="muted small">${esc(err && err.message)}</p>
			<button class="btn" type="button" data-action="retry">${say("fail.retry")}</button></div></div>`;
	}
	function showLocked() {
		LOCKED = true;
		$view.innerHTML = `<div class="locked card"><h1>${say("locked.title")}</h1><p>${say("locked.body")}</p></div>`;
	}
	const loading = (what = say("loading")) => `<p class="loading">${esc(what)}</p>`;
	function toast(msg) {
		const t = $("#toast");
		t.textContent = msg; t.hidden = false;
		clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200);
	}

	/// The confirmed-plus-estimate split, used everywhere a total appears (the owner's FX rule).
	function splitBlock(total, unconfirmed, { missing = 0, note = true } = {}) {
		const t = Math.max(total.minor, 0), u = Math.min(Math.max(unconfirmed.minor, 0), t), c = t - u;
		const w = (x) => (t > 0 ? (x / t) * 100 : 0);
		return `<div class="split">
			<div class="split-bar" role="img" aria-label="${esc(say("split.aria", { confirmed: home(c), estimate: home(u) }))}">${c > 0 ? `<i class="c" style="width:${w(c)}%"></i>` : ""}${u > 0 ? `<i class="e" style="width:${w(u)}%"></i>` : ""}</div>
			<div class="split-legend"><span><i class="sw c"></i>${say("split.confirmed")} <b class="num">${home(total.minor - unconfirmed.minor)}</b></span><span>+</span><span><i class="sw e"></i>${say("split.estimate")} <b class="num">${home(unconfirmed.minor)}</b></span></div>
			${note && u > 0 ? `<p class="muted small" style="margin-top:6px">${say("split.note")}</p>` : ""}
			${missing > 0 ? `<p class="l-flag" style="margin-top:6px">${icon("alert")}<span>${say("split.missing", { n: missing })}</span></p>` : ""}
		</div>`;
	}

	/// Coverage in the owner's words (CONTRACT §5.6). The engine's own sentence rides along as the title.
	function coverageText(c, name) {
		// A wallet: recorded from its cut-over date, with what is in it now. A prepaid card
		// with no mail (Sample Bistro) says its balance is only what the owner told.
		if (c.mode === "wallet" && c.wallet && c.wallet.told_only) return { text: say("cov.wallet_told", { balance: creditNum(c.wallet.balance), worth: worth(c.wallet) }), tone: c.wallet.balance.minor < 0 ? "warn" : "" };
		if (c.mode === "wallet") return { text: say("cov.wallet_since", { since: c.wallet ? fdate(c.wallet.since) : say("cov.cutover") }) + (c.wallet ? say("cov.wallet_balance", { balance: creditNum(c.wallet.balance), worth: worth(c.wallet) }) : ""), tone: "good" };
		if (c.mode === "live") return { text: say("cov.live"), tone: "good" };
		if (c.mode === "manual") return { text: say("cov.manual"), tone: "" };
		if (!c.complete_through) return { text: say(c.last_tap_date ? "cov.none_taps" : "cov.none"), tone: "warn" };
		if (!c.partial) return { text: say("cov.complete", { date: fdate(c.complete_through) }), tone: "good" };
		// Between two statements is normal (a grey note, never a warning): what came after
		// the last one is not known yet — not zero. Only a late statement is trouble.
		if (c.overdue) return { text: overdueText(c), tone: "warn" };
		const taps = c.last_tap_date && c.last_tap_date > c.complete_through ? say("cov.taps_only") : "";
		return { text: say("cov.after", { date: fdate(addDays(c.complete_through, 1)) }) + (c.next_statement_due ? say("cov.closing", { date: fdate(c.next_statement_due) }) : "") + taps, tone: "" };
	}
	/// A statement that is late, and why when the ledger knows (CONTRACT §5.6).
	function overdueText(c) {
		const r = c.overdue_reason || {};
		const why = r.kind === "pdf_password" ? say("late.pdf")
			: r.kind === "read_failed" ? say("late.unread")
			: r.kind === "reading" ? say("late.reading")
			: r.kind === "no_mail" ? (r.since ? say("late.no_mail_since", { date: fdate(r.since) }) : say("late.no_mail"))
			: say("late.unknown");
		return say("late.text", { due: fdate(c.next_statement_due), why, after: fdate(c.complete_through) });
	}
	const accountName = (id, accounts, fallback) => {
		const a = (accounts || []).find((x) => x.id === id) || ACCOUNTS.get(id);
		if (a) return a.name;
		// a Coverage message starts with the account's name: "Card A: up to date…"
		if (fallback && fallback.message) { const i = fallback.message.indexOf(": "); if (i > 0) return fallback.message.slice(0, i); }
		return say("account");
	};
	const ACCOUNTS = new Map(); // learned from every response that carries accounts
	const learnAccounts = (list) => (list || []).forEach((a) => a && a.id && ACCOUNTS.set(a.id, a));
	/// Prepaid wallets (19 Oct 2026): a card's balance is the SHOP'S credit — a plain number, not money —
	/// and remaining_value is what that credit is worth in money: prepaid, not used yet.
	const creditNum = (m) => (m && Number.isFinite(m.minor) ? `${m.minor < 0 ? "−" : ""}${(Math.abs(m.minor) / 100).toFixed(2)}` : "—");
	const walletCovs = (cov) => (cov || []).filter((c) => c.mode === "wallet" && c.wallet);
	const walletHref = (id) => `#/wallet/${encodeURIComponent(id)}`;
	const worth = (w) => (w && w.remaining_value ? ` ≈ ${home(w.remaining_value.minor)}` : "");

	/// Horizontal bars: one hue, confirmed solid + estimate lighter step, 2px gap, 4px rounded data end.
	function barList(items) {
		const max = Math.max(1, ...items.map((i) => i.total));
		return `<ul class="bars">${items.map((it) => {
			const t = Math.max(it.total, 0), u = Math.min(Math.max(it.unconf, 0), t), c = t - u;
			const tipData = esc(JSON.stringify({ t: it.label, total: home(it.total), conf: home(it.total - it.unconf), est: home(it.unconf), n: it.count }));
			return `<li><a class="bar-row" href="${esc(it.href)}" data-tip="${tipData}" aria-label="${esc(say("bar.aria", { label: it.label, total: home(it.total), estimate: home(it.unconf), n: it.count }))}">
				<span class="bar-label">${esc(it.label)}</span>
				<span class="bar-track" aria-hidden="true">${c > 0 ? `<i class="c${u > 0 ? " has-e" : ""}" style="width:${(c / max) * 100}%"></i>` : ""}${u > 0 ? `<i class="e" style="width:${(u / max) * 100}%"></i>` : ""}</span>
				<span class="bar-val">${it.total === 0 && it.count > 0 && !it.netZero ? `<span class="muted">${say("bar.unconverted")}</span><small>${say("bar.no_rate")}</small>` : home(it.total)}${it.netZero && it.count > 0 && it.total === 0 ? `<small>${say("kind.wallet_offset")}</small>` : ""}${it.share != null || it.unconf > 0 ? `<small>${[it.share != null ? say("bar.share", { pct: pct(it.share) }) : "", it.unconf > 0 ? say("bar.estimate", { amount: home(it.unconf) }) : ""].filter(Boolean).join(" · ")}</small>` : ""}</span></a></li>`;
		}).join("")}</ul>`;
	}
	const pct = (x) => (x >= 0.995 ? "100%" : x > 0 && x < 0.01 ? "<1%" : Math.round(x * 100) + "%");
	const barLegend = `<div class="legend"><span><i class="sw c"></i>${say("split.confirmed")}</span><span><i class="sw e"></i>${say("split.estimate")}</span></div>`;

	// ---------------------------------------------------------------- one line
	function homeBadge(v) {
		const s = v.amount.home;
		if (v.flags.includes("no_rate")) return `<span class="chip warn">${icon("alert")}${say("bar.no_rate")}</span>`;
		if (s.set_by === "owner") return `<span class="chip solid">${say("badge.owner")}</span>`;
		if (s.status === "estimate") return `<span class="chip est">${say("split.estimate")}</span>`;
		if (s.status === "reference") return `<span class="chip est">${say("badge.reference")}</span>`;
		if (s.status === "confirmed") return `<span class="chip conf">${icon("check")}${say("split.confirmed")}</span>`;
		return "";
	}
	function amountText(v) {
		const s = v.amount.home;
		if (v.flags.includes("no_rate")) return { text: fm(v.amount.billed), cls: "off" };
		const est = s.status === "estimate" || s.status === "reference";
		const neg = s.minor < 0;
		return { text: (est ? "≈" : "") + (neg ? "−" + home(-s.minor).replace("−", "") : home(s.minor)), cls: [est ? "est" : "", neg && v.spending ? "neg" : "", !v.spending ? "off" : ""].join(" ") };
	}
	/// The card's rate for a foreign purchase: estimate (with the fee) or the statement's real one.
	function cardRate(v) {
		const o = v.amount.original, b = v.amount.billed, f = v.fx;
		if (!f || !f.market_rate) return "";
		if (b.status === "confirmed" && f.effective_rate) return say("rate.actual", { rate: rateText(b.currency, o.currency, f.effective_rate) });
		return say("rate.estimate", { rate: rateText(b.currency, o.currency, f.market_rate * (1 + (f.markup || 0))), fee: feePct(f.markup || 0) });
	}
	/// The home-currency reference rate for a line billed in another currency (a TWD card) or foreign cash, read off its own two amounts.
	function refRate(v) {
		const b = v.amount.billed, s = v.amount.home;
		if (s.status !== "reference" || v.flags.includes("no_rate") || !s.minor || !b.minor || b.currency === HC) return "";
		const rate = (s.minor / 10 ** exp(HC)) / (b.minor / 10 ** exp(b.currency)); // home currency per one unit of the bill currency
		return say("rate.reference", { rate: rateText(HC, b.currency, rate) });
	}
	function fxLine(v) {
		const o = v.amount.original, b = v.amount.billed;
		if (o.currency === HC) return "";
		if (v.flags.includes("no_rate") && o.currency === b.currency) return ""; // the amount on the right already says it
		const out = [`<b>${fm(o)}</b>`];
		if (b.currency !== o.currency && b.currency !== HC) out.push(`→ ${fm(b)}${b.status === "estimate" ? say("rate.est_short") : ""}`);
		const card = cardRate(v), ref = refRate(v);
		if (card && b.currency === HC) out.push(card);
		if (ref) out.push(ref);
		return `<div class="l-fx">${out.join(" · ")}</div>`;
	}
	function lineRow(v, { flags = false, trip = true, rank = 0 } = {}) {
		const t = v.topup || null; // a top-up of a prepaid wallet: ONE line, money paid → credit got (19 Oct 2026)
		const a = t ? { text: home(t.paid.minor), cls: "off" } : amountText(v);
		const meta = [esc(t && t.role === "wallet" && t.from ? t.from.name : v.account.name)];
		if (!t && (v.spending || v.category)) meta.push(esc(catName(v.category)));
		if (rank) meta.unshift(fdate(v.date));
		if (trip && v.trip_id) meta.push(say("line.trip"));
		const kind = t ? `<span class="tag">${say("line.topup")}</span>` : KIND[v.kind] ? `<span class="tag">${KIND[v.kind]}</span>` : "";
		const co = v.reimbursable.effective ? `<span class="tag co">${say("line.company")}</span>` : "";
		const look = !flags && v.flags.some((f) => f !== "no_rate") ? `<span class="tag warn">${say("line.look")}</span>` : "";
		const flagHtml = flags && v.flags.length ? v.flags.map((f) => `<div class="l-flag">${icon("alert")}<span>${esc(FLAG[f] || f)}</span></div>`).join("") : "";
		return `<article class="line${v.spending ? "" : " non-spend"}" data-line="${esc(v.id)}">
			<button class="line-main" type="button" data-action="toggle-line" aria-expanded="false">
				${rank ? `<span class="rank-n">${rank}</span>` : ""}<div class="l-left">
					<div class="l-merchant">${esc(t ? t.title : v.merchant.name || v.merchant.raw || say("line.no_merchant"))}${kind}${co}${look}</div>
					<div class="l-meta">${meta.join(" · ")}${t ? say("line.prepaid") : v.spending ? "" : say("line.not_spending")}</div>
					${t ? "" : fxLine(v)}${creditLine(v)}${precountedNote(v)}${flagHtml}
				</div>
				<div class="l-right"><div class="l-amt ${a.cls}">${a.text}</div>${t ? (t.credit !== creditNum(t.paid) ? `<span class="l-credit">${esc(say("line.to_credit", { credit: t.credit }))}</span>` : "") : homeBadge(v)}</div>
			</button>
			<div class="line-detail" hidden></div>
		</article>`;
	}
	/// A meal paid with bonus credit: the shop's credit it used, then its real cost.
	const creditLine = (v) => (v.credit && !v.topup ? `<div class="l-fx">${say("line.credit_used", { used: `<b>${esc(v.credit.used)}</b>`, cost: fm(v.credit.cost) })}</div>` : "");
	/// A wallet purchase paid with balance already counted at old top-ups: a small note under it,
	/// instead of a separate minus line in the list (the offset still counts in every total).
	function precountedNote(v) {
		const w = v.wallet;
		if (!w || v.kind === "wallet_offset" || !w.precounted || !w.precounted.minor) return "";
		const whole = w.precounted.minor >= v.amount.home.minor;
		return `<div class="l-note">${icon("info")}<span>${whole ? say("line.precounted") : say("line.precounted_part", { amount: fm(w.precounted) })}</span></div>`;
	}
	/// A top-up's two legs, in the detail: where the money left, what the wallet got.
	function topUpBlock(v) {
		const t = v.topup;
		return `<div class="detail-block topup-legs"><p><b>${say("topup.both_legs")}</b></p>
			<dl class="kv"><dt>${say("topup.paid")}</dt><dd>${esc(t.from ? t.from.name : say("topup.unpaired"))}${say("colon")}${home(t.paid.minor)}</dd><dt>${say("topup.got")}</dt><dd>${esc(t.wallet.name)}${say("colon")}${esc(say("topup.credit", { credit: t.credit }))}</dd></dl>
			<p class="muted small" style="margin-top:6px">${say("topup.explain")}${t.from ? esc(say("topup.source_stays", { name: t.from.name })) : ""}</p>
			<p style="margin-top:6px"><a href="${walletHref(t.wallet.id)}">${esc(say("wallet.see", { name: t.wallet.name }))}</a></p></div>`;
	}
	function lineDetail(v) {
		const o = v.amount.original, b = v.amount.billed, s = v.amount.home;
		const rows = [];
		const st = (k) => ({ estimate: say("detail.estimate"), confirmed: say("detail.confirmed"), reference: say("detail.reference") })[k] || "";
		if (o.currency !== b.currency || o.currency !== HC) rows.push([say("detail.spent"), fm(o)]);
		if (b.currency !== HC) rows.push([say("detail.charged"), fm(b) + (b.status === "estimate" || b.status === "confirmed" ? st(b.status) : "")]);
		const homeState = v.flags.includes("no_rate") ? say("bar.no_rate") : st(s.status);
		rows.push([currencyName(HC), v.flags.includes("no_rate") ? "—" : home(s.minor) + homeState]);
		if (v.amount.overseas_fee) rows.push([say("detail.fee"), fm(v.amount.overseas_fee) + say("detail.fee_included")]);
		let fx = "";
		if (v.fx && v.fx.market_rate) {
			const f = v.fx;
			const src = say(f.markup_source === "learned" ? "detail.fee_learned" : "detail.fee_default");
			const market = rateText(b.currency, o.currency, f.market_rate);
			fx = b.status === "confirmed" && f.effective_rate
				? `<div class="detail-block"><p>${say("detail.fx_confirmed_html", { rate: rateText(b.currency, o.currency, f.effective_rate), market, fee: feePct(f.observed_markup) })}</p></div>`
				: `<div class="detail-block"><p>${say("detail.fx_estimate_html", { rate: cardRate(v), market, fee: feePct(f.markup || 0), source: src })}</p><p class="muted">${say("detail.fx_later")}</p></div>`;
		}
		if (s.status === "reference") {
			const ref = refRate(v);
			const cur = currencyName(HC);
			fx += `<div class="detail-block"><p>${v.account.kind === "cash" ? say("detail.foreign_cash") : say("detail.foreign_card", { currency: cur })}${ref ? say("detail.ref_rate", { currency: cur, rate: ref }) : say("detail.ref_none", { currency: cur })}</p></div>`;
		}
		const wallet = v.account.kind === "wallet";
		const evName = (e) => (wallet && e === "alert" && v.account.institution === "grab" ? say("evidence.grab") : wallet && e === "manual" ? say("evidence.told") : EVIDENCE[e] || e);
		const ev = v.evidence.length ? `<div class="chips" style="margin-top:10px">${v.evidence.map((e) => `<span class="chip solid">${esc(evName(e))}</span>`).join("")}</div>` : "";
		const name = { name: v.account.name };
		const state = v.provisional ? (wallet ? say("state.wait_wallet", name) : say("state.wait")) : v.statement_id ? (wallet ? say("state.on_wallet", name) : say("state.on")) : v.account.kind === "cash" ? say("state.cash") : wallet ? say("state.wallet_told") : "";
		const flags = v.flags.map((f) => `<p class="l-flag">${icon("alert")}<span>${esc(FLAG[f] || f)}</span></p>`).join("");
		const r = v.reimbursable;
		const reimbSrc = r.source === "override" ? say("reimb.by_you") : r.source === "range" ? say("reimb.by_range") : "";
		const toggle = v.spending ? `<label class="switch detail-block"><span>${say("reimb.label")}${reimbSrc ? `<br><small class="muted">${reimbSrc}</small>` : ""}</span>
			<input type="checkbox" role="switch" data-action="reimb" data-id="${esc(v.id)}" ${r.effective ? "checked" : ""}></label>
			${r.source === "override" ? `<button class="btn btn-quiet small" type="button" data-action="reimb-clear" data-id="${esc(v.id)}">${say("reimb.clear")}</button>` : ""}` : "";
		return `<dl class="kv">${rows.map(([k, val]) => `<dt>${k}</dt><dd>${esc(val)}</dd>`).join("")}</dl>
			${fx}${flags ? `<div style="margin-top:8px">${flags}</div>` : ""}
			${v.refund_of ? `<p class="muted small" style="margin-top:8px">${say("detail.refund_linked")}</p>` : ""}
			${v.topup ? topUpBlock(v) : v.transfer_group ? `<p class="muted small" style="margin-top:8px">${v.account.kind === "wallet" ? esc(say("detail.topup_into", { name: v.account.name })) : say("detail.own_transfer")}</p>` : ""}
			${v.wallet && v.wallet.message ? `<p class="notice compact" style="margin-top:8px">${icon("info")}<span>${esc(v.wallet.message)}</span></p>` : ""}
			${v.credit && v.credit.message ? `<p class="notice compact" style="margin-top:8px">${icon("info")}<span>${esc(v.credit.message)}</span></p>` : ""}
			${(v.folded || []).filter((k) => k.kind === "wallet_offset").map((k) => `<dl class="kv" style="margin-top:8px"><dt>${say("detail.auto_offset")}</dt><dd>${esc(say("detail.auto_offset_value", { amount: home(k.amount.home.minor), category: catName(k.category) }))}</dd></dl>`).join("")}
			${v.account.kind === "wallet" && !v.topup ? `<p style="margin-top:8px"><a href="${walletHref(v.account.id)}">${esc(say("wallet.see", { name: v.account.name }))}</a></p>` : ""}
			${v.note ? `<p style="margin-top:8px">${say("detail.note")}${esc(v.note)}</p>` : ""}
			${ev}
			${state ? `<p class="muted small" style="margin-top:6px">${say("detail.evidence")}${esc(state)}</p>` : ""}
			${v.trip_id ? `<p style="margin-top:8px"><a href="#/trip/${encodeURIComponent(v.trip_id)}">${say("detail.in_trip")}</a></p>` : ""}
			${editBlock(v)}
			${offsetPicker(v)}
			${tripPicker(v)}
			${toggle}${subBlock(v)}`;
	}
	/// 「改分類」 and 「這筆不算花費」 on one line (round 2): category / kind, for this line or the merchant.
	function editBlock(v) {
		if (v.kind === "wallet_offset") return "";
		if (v.kind === "refund" || v.kind === "fee" || v.kind === "rebate" || v.kind === "income") return "";
		const out = v.amount.home.minor > 0 || v.amount.billed.minor > 0;
		return `<div class="detail-block edit-block" data-id="${esc(v.id)}">
			${v.spending ? `<div class="edit-row"><span>${say("edit.category")}<b>${esc(catName(v.category))}</b></span><button class="btn small" type="button" data-action="cat-open" aria-haspopup="dialog">${say("edit.change_category")}</button></div>` : ""}
			${out || !v.spending ? `<div class="edit-row"><span>${v.spending ? say("edit.is_spending") : `${say("edit.not_spending")}<b>${esc(KIND[v.kind] || v.kind)}</b>`}</span><button class="btn small" type="button" data-action="edit-open" data-p="kind" aria-expanded="false">${v.spending ? say("edit.not_spending_btn") : say("edit.change")}</button></div>` : ""}
			<div class="edit-panel" hidden></div></div>`;
	}
	function editPanel(btn) {
		const blk = btn.closest(".edit-block"), panel = blk.querySelector(".edit-panel"), v = LINES.get(blk.dataset.id);
		const open = btn.getAttribute("aria-expanded") === "true";
		blk.querySelectorAll("[data-action=edit-open]").forEach((b) => b.setAttribute("aria-expanded", "false"));
		if (open || !v) { panel.hidden = true; return; }
		btn.setAttribute("aria-expanded", "true");
		const who = esc(v.merchant.name || v.merchant.raw || say("edit.this_merchant"));
		const topUpOk = v.spending && ["bank", "debit_card", "credit_card"].includes(v.account.kind) && walletList().length > 0;
		const chips = NON_SPEND.map(([k, t]) => `<button class="fchip${k === v.kind ? " on" : ""}" type="button" data-action="line-edit" data-f="kind" data-v="${k}">${t}</button>`).join("")
				+ (topUpOk ? `<button class="fchip" type="button" data-action="topup-open" aria-expanded="false">${say("edit.topup")}</button>` : "")
				+ (v.spending ? "" : `<button class="fchip" type="button" data-action="line-edit" data-f="kind" data-v="purchase">${say("edit.is_spending_after_all")}</button>`);
		// 「儲值到…」 opens one plain button per wallet (no dropdown); picking one asks for the
		// credit it gave (19 Oct 2026: a shop may give a bonus — pay 200, get 240), prefilled.
		const topUps = topUpOk ? `<div class="topup-row" hidden><div class="chips-row" style="margin-top:6px;align-items:center"><span class="small muted">${say("edit.topup_where")}</span>${walletList().map((w) => `<button class="fchip" type="button" data-action="topup-pick" data-w="${esc(w.id)}">${esc(w.name)}</button>`).join("")}</div><div class="topup-credit" style="margin-top:8px" hidden></div></div>` : "";
		panel.innerHTML = `<div class="small act-q">${say("edit.what_money")}</div>
			<div class="chips-row">${chips}</div>${topUps}
			<label class="check"><input type="checkbox" name="merchant" checked><span>${say("edit.all_from", { who })}</span></label>`;
		panel.hidden = false;
	}
	/// 「儲值到…」 → a wallet: one plain number field 「拿到的儲值金額」, prefilled with what was paid
	/// (or, for a shop whose usual deal the ledger knows, the credit that deal gives), then 確定.
	function topUpPick(el) {
		const blk = el.closest(".edit-block"), v = LINES.get(blk.dataset.id), w = ACCOUNTS.get(el.dataset.w), box = blk.querySelector(".topup-credit");
		if (!v || !box) return;
		el.closest(".chips-row").querySelectorAll("[data-action=topup-pick]").forEach((b) => b.classList.toggle("on", b === el));
		const paid = Math.abs(v.amount.billed.minor);
		const deal = w && w.wallet && w.wallet.topup_deal;
		const got = deal ? Math.round((paid * deal.credit.minor) / deal.paid.minor) : paid;
		box.innerHTML = `<label class="small act-q" for="credit-${esc(v.id)}">${say("edit.credit_got")}${deal ? esc(say("edit.credit_deal", { name: w.name, paid: (deal.paid.minor / 100).toFixed(2), credit: (deal.credit.minor / 100).toFixed(2) })) : say("edit.credit_hint")}</label>
			<div class="chips-row" style="align-items:center"><input class="input" id="credit-${esc(v.id)}" name="credit" inputmode="decimal" autocomplete="off" value="${(got / 100).toFixed(2)}" style="max-width:9em">
			<button class="btn btn-primary small" type="button" data-action="line-edit" data-f="kind" data-v="wallet_topup" data-w="${esc(el.dataset.w)}">${esc(say("edit.topup_confirm", { name: w ? w.name : say("edit.wallet") }))}</button></div>`;
		box.hidden = false;
	}
	async function lineEdit(el) {
		const blk = el.closest(".edit-block"), f = el.dataset.f, val = el.dataset.v;
		// A wallet top-up is set one line at a time (a payee rule could move a real Grab ride,
		// or a meal paid by card at the same restaurant).
		const topup = val === "wallet_topup";
		const all = !topup && blk.querySelector("input[name=merchant]").checked;
		const creditBox = topup ? blk.querySelector("input[name=credit]") : null;
		const credit = creditBox ? creditBox.value.trim().replace(/,/g, "") : "";
		if (creditBox && !/^\d+(\.\d{1,2})?$/.test(credit)) { toast(say("edit.credit_number")); return; }
		return saveLine(blk, f, val, all, topup ? { wallet: el.dataset.w, ...(credit ? { credit } : {}) } : {});
	}
	/// POST one line's category or kind (for its payee too when `all`), then redraw it open.
	async function saveLine(blk, f, val, all, extra) {
		const id = blk.dataset.id, topup = val === "wallet_topup";
		const w = topup ? ACCOUNTS.get(extra.wallet) : null;
		blk.querySelectorAll("button").forEach((b) => (b.disabled = true));
		try {
			const sent = api(`/api/lines/${encodeURIComponent(id)}/${f}`, { method: "POST", body: { [f]: val, apply_to_merchant: all, ...extra } });
			SAVING = sent.catch(() => { /* said below */ });
			const r = await sent;
			const n = r.changed ?? r.count;
			toast((f === "category" ? say("toast.category", { name: catName(val) }) : val === "purchase" ? say("toast.spending_again") : topup ? say("toast.topup", { name: w ? w.name : say("edit.wallet") }) : say("toast.kind", { kind: KIND[val] })) + (all && n > 1 ? say("toast.same_merchant", { n }) : ""));
			if (all && n > 1) route(); else redrawOpen(blk.closest(".line"), r.line);
			refreshBadge();
		} catch (x) {
			if (x.status === 401) return showLocked();
			blk.querySelectorAll("button").forEach((b) => (b.disabled = false));
			toast(say("toast.not_changed", { why: x.message }));
		}
	}
	// ---------------------------------------------------------------- choosing a category (one picker everywhere)
	/// The owner, 22 Oct 2026: 「分類可以做成下拉式選單嗎 前面要可以放相關的小icon … 順序依照字母」, and adding a
	/// new one from the phone. One bottom-sheet list, A→Z, an icon on each row, a field on top that
	/// narrows the list and offers 新增 for a name not in it. `CAT_PICK` = what the open list is for.
	let CAT_PICK = null;
	function catSheet(pick) {
		CAT_PICK = pick;
		openSheet(`${sheetHead(pick.title, pick.sub, `<button class="btn small" type="button" data-action="cat-manage">${say("cat.edit")}</button>`)}
			<input class="input cat-find" type="text" data-cat-find placeholder="${esc(say("cat.find"))}" maxlength="40" autocomplete="off" autocapitalize="sentences" enterkeyhint="done" aria-label="${esc(say("cat.find_aria"))}">
			<div class="cat-list" role="listbox" aria-label="${esc(say("cat.label"))}">${catRows("")}</div>${pick.foot || ""}`);
	}
	function catRows(typed) {
		const q = typed.trim(), lq = q.toLowerCase(), cur = CAT_PICK.current;
		const all = sortCats(CATS.length ? CATS : PICK_CATS);
		const hit = (c) => c.toLowerCase().includes(lq) || catName(c).toLowerCase().includes(lq);
		const shown = q ? all.filter(hit) : all;
		const known = all.some((c) => c.toLowerCase() === lq || catName(c).toLowerCase() === lq);
		const row = (c, label, on, attrs) => `<button type="button" class="cat-row${on ? " on" : ""}" role="option" aria-selected="${on}" ${attrs}><span class="cat-ic" aria-hidden="true">${c}</span><span class="cat-nm">${label}</span>${on ? icon("check") : ""}</button>`;
		return (CAT_PICK.auto && !q ? row("✨", say("cat.auto_long"), !cur, `data-action="cat-pick" data-auto`) : "")
			+ (q && !known && !/[,\n]/.test(q) ? row("+", say("cat.add", { name: esc(q) }), false, `data-action="cat-new" data-name="${esc(q)}"`) : "")
			+ shown.map((c) => row(catIcon(c), esc(catName(c)), c === cur, `data-action="cat-pick" data-c="${esc(c)}"`)).join("")
			+ (shown.length || q ? "" : `<p class="muted small">${say("cat.none")}</p>`);
	}
	/// 改分類 on one line: the list, and 「以前和以後的都這樣」 under it (on by default, as before).
	function catForLine(blk) {
		const v = blk && LINES.get(blk.dataset.id);
		if (!v) return;
		const who = esc(v.merchant.name || v.merchant.raw || say("edit.this_merchant"));
		catSheet({
			title: say("cat.which"), sub: say("cat.now", { cat: `${catIcon(v.category)} ${esc(catName(v.category))}` }), current: v.category || "",
			foot: `<label class="check cat-foot"><input type="checkbox" name="cat-merchant" checked><span>${say("edit.all_from", { who })}</span></label>`,
			pick(c) {
				if (!c) return;
				const all = $("#sheet input[name=cat-merchant]")?.checked ?? true;
				closeSheet();
				const now = document.querySelector(`.edit-block[data-id="${CSS.escape(v.id)}"]`);
				if (now) saveLine(now, "category", c, all, {});
			},
		});
	}
	/// The 現金 sheet's 分類 (optional: 自動 lets the ledger decide, as before).
	function catForCash() {
		const f = $("#cash-form");
		catSheet({ title: say("cat.label"), sub: say("cat.optional"), current: f.category.value, auto: true, pick(c) { setCashCat(c); closeSheet(); } });
	}
	function setCashCat(c) {
		$("#cash-form").category.value = c;
		$("#cash-cat").innerHTML = `<span class="cat-ic" aria-hidden="true">${c ? catIcon(c) : "✨"}</span><span class="cat-nm">${c ? esc(catName(c)) : say("cat.auto")}</span><span class="caret" aria-hidden="true"></span>`;
	}
	/// One choice per opening: a second tap while the sheet slides away is ignored.
	function catChosen(c) {
		const pick = CAT_PICK;
		CAT_PICK = null;
		if (pick) pick.pick(c);
	}
	/// 新增分類「…」: add it to the owner's list, then choose it at once.
	async function catAdd(el) {
		const name = el.dataset.name.trim(), pick = CAT_PICK;
		if (!name || !pick) return;
		el.disabled = true;
		try {
			CATS = (await api("/api/categories", { method: "POST", body: { add: name } })).categories || CATS;
			toast(say("toast.cat_added", { name }));
			if (CAT_PICK === pick) catChosen(CATS.find((c) => c.toLowerCase() === name.toLowerCase()) || name);
		} catch (x) {
			if (x.status === 401) { closeSheet(); return showLocked(); }
			el.disabled = false;
			toast(say("toast.not_added", { why: x.message }));
		}
	}
	// ---------------------------------------------------------------- managing categories (rename / delete)
	/// The owner, 23 Oct 2026: 「現在可以加新的分類 但根本無法改名字 不夠方便 也刪不掉 如果刪掉的分類有牽連到已分類記得提醒使用者
	/// 然後讓他確定然後在刪除前給新的分類」. 編輯 in the category sheet turns it into a list to manage (each with how
	/// many lines use it); a tap opens that one category: rename, or delete — when lines or rules use it, he picks
	/// where they go from the same A→Z list, then confirms; the server moves everything and deletes in one step.
	/// The page behind redraws when the sheet closes (CAT_DIRTY), so the line he opened stays put meanwhile.
	let CAT_MANAGE = null; // {pick, usage, c, target}
	let CAT_DIRTY = false;
	let SAVING = null; // the line save under way (a redraw after 編輯 waits for it, so it never shows the old pick)
	function cmShow(html) {
		const body = $("#sheet-body");
		body.innerHTML = html;
		paintIcons(body);
	}
	function catManage() {
		if (!CAT_PICK) return;
		CAT_MANAGE = { pick: CAT_PICK, usage: null, c: null, target: null };
		cmList();
		cmUsage();
	}
	/// What uses each category, always fresh from the server (never from memory).
	async function cmUsage() {
		const m = CAT_MANAGE;
		try {
			const r = await apiRaw("/api/categories?usage=1");
			CATS = r.categories || CATS; CAT_WAS = r.was || CAT_WAS;
			if (CAT_MANAGE !== m) return;
			m.usage = r.usage || {};
			if (m.view === "list") cmList();
		} catch (x) {
			if (x.status === 401) { closeSheet(); return showLocked(); }
			if (CAT_MANAGE === m && m.view === "list") toast(say("cm.usage_failed", { why: x.message }));
		}
	}
	const cmUse = (c) => (CAT_MANAGE.usage && CAT_MANAGE.usage[c]) || null;
	const cmRow = (c, action, trail = "") => `<button type="button" class="cat-row" data-action="${action}" data-c="${esc(c)}"><span class="cat-ic" aria-hidden="true">${catIcon(c)}</span><span class="cat-nm">${esc(catName(c))}</span>${trail}</button>`;
	const cmBack = `<button class="btn small" type="button" data-action="cm-back">${icon("left")}${say("cm.back")}</button>`;
	function cmList() {
		const m = CAT_MANAGE;
		m.view = "list"; m.c = null; m.target = null;
		cmShow(`${sheetHead(say("cm.title"), say("cm.sub"), `<button class="btn small btn-primary" type="button" data-action="cm-done">${say("cm.done")}</button>`)}
			<div class="cat-list" role="list" aria-label="${esc(say("cat.label"))}">${sortCats(CATS).map((c) => {
				const u = cmUse(c);
				return cmRow(c, "cm-open", `${m.usage ? `<span class="cm-count">${u && u.lines ? say("lines.count", { n: u.lines }) : ""}</span>` : ""}${icon("right")}`);
			}).join("") || `<p class="muted small">${say("cat.none")}</p>`}</div>`);
	}
	function cmOne(c) {
		const m = CAT_MANAGE, u = cmUse(c);
		m.view = "one"; m.c = c; m.target = null;
		cmShow(`${sheetHead(`${catIcon(c)} ${catName(c)}`, u ? (u.lines ? say("cm.used_by", { n: u.lines }) : say("cm.unused")) : "", cmBack)}
			<label class="field"><span>${say("cm.name")}</span><input class="input" type="text" data-cm-name value="${esc(catName(c))}" maxlength="40" autocomplete="off" autocapitalize="sentences" enterkeyhint="done"></label>
			<p class="cm-msg form-error" role="alert"></p>
			<div class="sheet-actions"><button class="btn btn-primary" type="button" data-action="cm-rename">${say("cm.rename")}</button></div>
			<div class="cm-sep" role="separator"></div>
			<button class="btn btn-danger cm-del" type="button" data-action="cm-delete">${say("cm.delete_this")}</button>`);
	}
	/// The rules that move with the lines, said under the warning (the owner's payee rules, the reader's
	/// learned shops, a wallet's default).
	const cmRules = (u) => (u && u.rules ? `<p class="muted small cm-rules">${say("cm.rules_move", { n: u.rules })}</p>` : "");
	async function cmDelete() {
		const m = CAT_MANAGE, c = m.c;
		if (!m.usage) await cmUsage();
		if (CAT_MANAGE !== m) return;
		const u = cmUse(c) || { lines: 0, rules: 0 };
		m.target = null;
		if (!u.lines && !u.rules) return cmConfirm();
		m.view = "move";
		const what = u.lines ? say("cm.used_by_lines", { n: u.lines }) : say("cm.used_by_rules", { n: u.rules });
		cmShow(`${sheetHead(say("cm.delete_title", { name: catName(c) }), "", cmBack)}
			<p class="notice cm-warn">${what}${say("cm.pick_target")}</p>${cmRules(u.lines ? u : null)}
			<div class="cat-list" role="listbox" aria-label="${esc(say("cm.move_to"))}">${sortCats(CATS.filter((x) => x !== c)).map((x) => cmRow(x, "cm-move")).join("")}</div>`);
	}
	function cmConfirm() {
		const m = CAT_MANAGE, c = m.c, t = m.target, u = cmUse(c) || { lines: 0, rules: 0 };
		m.view = "confirm";
		const msg = !t ? say("cm.sure", { name: esc(catName(c)) })
			: say("cm.will_move", { what: u.lines ? say("lines.count", { n: u.lines }) : say("cm.rules"), to: esc(catName(t)), name: esc(catName(c)) });
		cmShow(`${sheetHead(say("cm.delete_title", { name: catName(c) }), "", cmBack)}
			<p class="notice cm-warn">${msg}</p>${t ? cmRules(u.lines ? u : null) : ""}
			<p class="cm-msg form-error" role="alert"></p>
			<div class="sheet-actions"><button class="btn" type="button" data-action="cm-back">${say("cancel")}</button><button class="btn btn-danger-solid" type="button" data-action="cm-confirm">${t ? say("cm.move_delete") : say("cm.delete")}</button></div>`);
	}
	function cmBackOne() {
		const m = CAT_MANAGE;
		if (!m) return;
		if (m.view === "one") cmList(); else cmOne(m.c);
	}
	/// Leaves 編輯: the picker it came from, with the list as it is now.
	function cmDone() {
		const m = CAT_MANAGE;
		CAT_MANAGE = null;
		if (m) catSheet(m.pick);
	}
	const cmSay = (msg) => { const el = $("#sheet .cm-msg"); if (el) el.textContent = msg; };
	async function cmRename(btn) {
		const m = CAT_MANAGE, c = m.c, box = $("#sheet [data-cm-name]");
		const v = box ? box.value.trim() : "";
		if (!v || /[,\n]/.test(v)) return cmSay(say("cm.bad_name"));
		if (v === c || v === catName(c)) return cmList();
		const other = CATS.find((x) => x !== c && (x.toLowerCase() === v.toLowerCase() || catName(x).toLowerCase() === v.toLowerCase()));
		if (other) return cmSay(say("cm.exists", { other: catName(other), name: catName(c) }));
		btn.disabled = true;
		try {
			const r = await api("/api/categories", { method: "POST", body: { rename: c, to: v } });
			const to = (r.categories || []).find((x) => x.toLowerCase() === v.toLowerCase()) || v;
			cmApplied(r, c, to);
			toast(say("toast.renamed", { name: catName(to) }));
		} catch (x) {
			if (x.status === 401) { closeSheet(); return showLocked(); }
			btn.disabled = false;
			cmSay(say("toast.not_changed", { why: x.message }));
		}
	}
	async function cmDo(btn) {
		const m = CAT_MANAGE, c = m.c, t = m.target;
		btn.disabled = true;
		try {
			const r = await api("/api/categories", { method: "POST", body: t ? { delete: c, move_to: t } : { delete: c } });
			cmApplied(r, c, t);
			toast(t ? say("toast.deleted_moved", { name: catName(c), to: catName(t) }) : say("toast.deleted", { name: catName(c) }));
		} catch (x) {
			if (x.status === 401) { closeSheet(); return showLocked(); }
			btn.disabled = false;
			cmSay(say("toast.not_deleted", { why: x.message }));
		}
	}
	/// After a rename (to = new name) or delete (to = where it moved, or null): every copy the page
	/// holds follows — the list, the open picker's tick, the 現金 sheet's choice, the 明細 filter
	/// in the address — then back to the list with fresh counts. The tab redraws when the sheet closes.
	function cmApplied(r, from, to) {
		CATS = r.categories || CATS; CAT_WAS = r.was || CAT_WAS;
		CAT_DIRTY = true;
		const m = CAT_MANAGE;
		if (m && m.pick.current === from) m.pick.current = to || "";
		const cash = $("#cash-form");
		if (cash && cash.category && cash.category.value === from) setCashCat(to || "");
		const { parts, q } = hash();
		if (q.get("category") === from) {
			if (to) q.set("category", to); else q.delete("category");
			q.delete("p");
			history.replaceState(null, "", "#/" + parts.join("/") + (q.toString() ? "?" + q.toString() : ""));
		}
		if (!m) return;
		m.usage = null;
		cmList();
		cmUsage();
	}
	/// 「設為訂閱」 / 「不是訂閱」 on one line (meeting point B). The line's own `subscription` wins;
	/// until the route carries it, the subscription list is matched by merchant name.
	const SUB_CADENCES = ["monthly", "quarterly", "yearly", "weekly"].map((c) => [c, say("every." + c)]);
	function lineSub(v) {
		if (v.subscription !== undefined) return v.subscription;
		return SUBS.get(String(v.merchant.name || v.merchant.raw || "").toLowerCase()) || null;
	}
	function subBlock(v) {
		if (!v.spending || v.amount.home.minor < 0 || ["refund", "card_payment", "transfer", "income", "rebate"].includes(v.kind)) return "";
		const s = lineSub(v);
		if (s && s.status !== "ignored") {
			const st = ["active", "lapsed", "cancelled"].includes(s.status) ? say("sub." + s.status) : "";
			return `<div class="detail-block sub-block"><p><b>${say("sub.label")}</b>${say("colon")}${esc(SUB_CADENCES.find(([c]) => c === s.cadence)?.[1] || "")}${st ? ` · ${st}` : ""}</p>
				<div class="actions"><button class="btn small" type="button" data-action="line-sub" data-id="${esc(v.id)}" data-value="false">${say("sub.not")}</button></div></div>`;
		}
		const g = "cad-" + esc(v.id);
		return `<div class="detail-block sub-block"><p><b>${say("sub.is_it")}</b><span class="muted small">${say("sub.is_it_note")}</span></p>
			<div class="chips-row pick" role="radiogroup" aria-label="${esc(say("sub.how_often"))}">${SUB_CADENCES.map(([c, t], i) => `<label class="opt"><input type="radio" name="${g}" value="${c}" ${i === 0 ? "checked" : ""}><span>${t}</span></label>`).join("")}</div>
			<div class="actions"><button class="btn btn-primary small" type="button" data-action="line-sub" data-id="${esc(v.id)}" data-value="true">${say("sub.set")}</button></div></div>`;
	}
	async function loadTrips() {
		try { TRIPS = ((await api("/api/trips")).trips || []).filter((t) => t.status === "confirmed").sort((a, b) => (a.start_date < b.start_date ? 1 : -1)); } catch { /* no trip picker */ }
	}
	/// Put this line in a trip, or take it out (the owner's word beats the automatic dates).
	function tripPicker(v) {
		if (!v.spending) return "";
		if (v.trip_id) {
			const t = TRIPS.find((x) => x.id === v.trip_id);
			return `<div class="detail-block"><p class="small"><b>${say("line.trip")}</b>${say("colon")}${t ? esc(tripName(t)) : say("trip.a_trip")}</p>
				<button class="btn btn-quiet small" type="button" data-action="trip-out" data-id="${esc(v.id)}" data-trip="${esc(v.trip_id)}" style="margin-top:6px">${say("trip.take_out")}</button></div>`;
		}
		if (!TRIPS.length) return "";
		return `<div class="detail-block"><p class="small"><b>${say("line.trip")}</b>${say("colon")}${say("trip.none")}</p>
			<div class="trip-add" style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap"><select data-trip-pick aria-label="${esc(say("trip.pick"))}">${TRIPS.map((t) => `<option value="${esc(t.id)}">${esc(tripName(t))}</option>`).join("")}</select>
			<button class="btn small" type="button" data-action="trip-in" data-id="${esc(v.id)}">${say("trip.add")}</button></div></div>`;
	}
	/// Money the owner received: say what it offsets, so the summary is true.
	function offsetPicker(v) {
		if (!(v.kind === "income" || v.income_offset)) return "";
		const cards = [...ACCOUNTS.values()].filter((a) => a.kind === "credit_card" && a.active !== false);
		const cur = v.income_offset;
		const now = !cur ? say("income.plain") : cur.to === "salary" ? say("income.salary") : cur.to === "card" ? say("income.card_now", { name: esc((ACCOUNTS.get(cur.account_id) || {}).name || cur.account_id) }) : say("income.line_now");
		const opt = (val, label, sel) => `<option value="${val}"${sel ? " selected" : ""}>${label}</option>`;
		return `<div class="detail-block offset-pick"><p class="small"><b>${say("income.this")}</b>${say("colon")}${now}</p>
			<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><select data-offset-to aria-label="${esc(say("income.what"))}">
				${opt("none", say("income.plain_option"), !cur)}${opt("salary", say("income.salary"), cur && cur.to === "salary")}
				${cards.map((a) => opt("card:" + esc(a.id), say("income.card", { name: esc(a.name) }), cur && cur.to === "card" && cur.account_id === a.id)).join("")}
				${opt("line", say("income.line"), cur && cur.to === "line")}
			</select><button class="btn small" type="button" data-action="offset" data-id="${esc(v.id)}">${say("ok")}</button></div>
			<div data-offset-lines hidden style="margin-top:8px"></div></div>`;
	}
	const LINES = new Map(); // id → LineView currently on screen
	const remember = (lines) => lines.forEach((v) => { LINES.set(v.id, v); (v.folded || []).forEach((k) => LINES.set(k.id, k)); });
	function linesByDay(lines, opts) {
		remember(lines);
		const days = new Map();
		for (const v of lines) { if (!days.has(v.date)) days.set(v.date, []); days.get(v.date).push(v); }
		return [...days].map(([d, vs]) => {
			// the day's sum counts the folded lines too (an offset under its meal): the totals never change
			const spent = vs.flatMap((v) => [v, ...(v.folded || [])]).filter((v) => v.spending && !v.flags.includes("no_rate")).reduce((s, v) => s + v.amount.home.minor, 0);
			const anyEst = vs.some((v) => v.spending && (v.amount.home.status === "estimate" || v.amount.home.status === "reference"));
			return `<section class="day"><div class="day-head"><span>${fdate(d)} ${weekday(d)}</span><span class="num">${anyEst ? "≈" : ""}${home(spent)}</span></div>
				<div class="day-list">${vs.map((v) => lineRow(v, opts)).join("")}</div></section>`;
		}).join("");
	}

	/// Lines by amount: one ranked list, the date on each row instead of day headings.
	/// One row per story in a list (19 Oct 2026, the owner: the +/− 互轉 pair was confusing): a top-up's
	/// wallet leg folds into its source leg, and an automatic offset folds under the meal it offsets —
	/// only when both are in the list. Totals are worked out from the whole list BEFORE this, so
	/// nothing changes but what is drawn; the folded lines stay in each row's detail.
	function foldList(lines) {
		const ids = new Set(lines.map((v) => v.id)), into = new Map();
		for (const v of lines) {
			const t = v.topup && v.topup.role === "wallet" && v.topup.source_line_id && ids.has(v.topup.source_line_id) ? v.topup.source_line_id
				: v.kind === "wallet_offset" && v.wallet && v.wallet.offset_of && ids.has(v.wallet.offset_of) ? v.wallet.offset_of : null;
			if (t) into.set(v.id, t);
		}
		const kids = new Map();
		for (const v of lines) if (into.has(v.id)) { const t = into.get(v.id); if (!kids.has(t)) kids.set(t, []); kids.get(t).push(v); }
		return lines.filter((v) => !into.has(v.id)).map((v) => (kids.has(v.id) ? { ...v, folded: kids.get(v.id) } : v));
	}
	function rankList(lines, offset = 0) {
		remember(lines);
		return `<div class="day-list rank" style="margin-top:12px">${lines.map((v, i) => lineRow(v, { rank: offset + i + 1 })).join("")}</div>`;
	}

	// ---------------------------------------------------------------- state + router
	const state = { month: null, token: 0 };
	function currentMonth() { return FX ? FX.month : todayLocal().slice(0, 7); }
	function hash() {
		const h = location.hash.replace(/^#\/?/, "");
		const [path, query = ""] = h.split("?");
		return { parts: path.split("/").filter(Boolean), q: new URLSearchParams(query) };
	}
	function go(path, q) { location.hash = "#/" + path + (q && q.toString() ? "?" + q.toString() : ""); }
	function monthBar(view) {
		const m = state.month, max = todayLocal().slice(0, 7);
		return `<div class="month-bar" role="group" aria-label="${esc(say("month.label"))}">
			<button class="icon-btn" type="button" data-action="month" data-view="${view}" data-step="-1" aria-label="${esc(say("month.prev"))}">${icon("left")}</button>
			<button class="label month-label" type="button" data-action="mpick" aria-haspopup="dialog" aria-label="${esc(say("month.pick_aria", { month: fmonth(m) }))}">${fmonth(m)}<span class="caret" aria-hidden="true"></span></button>
			<button class="icon-btn" type="button" data-action="month" data-view="${view}" data-step="1" aria-label="${esc(say("month.next"))}" ${m >= max ? "disabled" : ""}>${icon("right")}</button></div>`;
	}

	// ---------------------------------------------------------------- motion (20 Oct 2026 — 「動畫…變得更乾淨」)
	/// Movement is short, on transform and opacity only, and none at all when the
	/// phone asks for less motion. A tab change stays instant, as on iOS.
	const calm = matchMedia("(prefers-reduced-motion: reduce)");
	const narrow = matchMedia("(max-width: 759px)");
	const IOS_EASE = "cubic-bezier(.32,.72,0,1)"; // the curve of an iOS sheet
	const dialogMove = () => narrow.matches
		? [{ transform: "translateY(100%)" }, { transform: "none" }]
		: [{ transform: "scale(.97)", opacity: 0 }, { transform: "none", opacity: 1 }];
	/// A dialog in: on a phone it slides up from the bottom edge, on a wide screen it
	/// settles in place; the dimmed backdrop fades with it.
	function showDialog(d) {
		if (d._slideOut) { d._slideOut.cancel(); d._slideOut = null; if (d._backdropOut) d._backdropOut.cancel(); d._backdropOut = null; }
		if (d.open) return;
		if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
		if (calm.matches || typeof d.animate !== "function") return;
		d.animate(dialogMove(), { duration: narrow.matches ? 300 : 200, easing: IOS_EASE });
		try { d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, easing: "ease-out", pseudoElement: "::backdrop" }); } catch { /* the backdrop just appears */ }
	}
	/// A dialog out: the same movement backwards, a little quicker; closed when it ends.
	function hideDialog(d) {
		if (!d.open || d._slideOut) return;
		const shut = () => { d._slideOut = null; if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); d.getAnimations().concat(d._backdropOut || []).forEach((x) => x.cancel()); d._backdropOut = null; };
		if (calm.matches || typeof d.animate !== "function") return shut();
		const a = d._slideOut = d.animate(dialogMove().reverse(), { duration: narrow.matches ? 220 : 150, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
		try { d._backdropOut = d.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: "ease-in", fill: "forwards", pseudoElement: "::backdrop" }); } catch { /* the backdrop just goes */ }
		a.finished.then(() => { if (d._slideOut === a) shut(); }, () => { /* reopened while closing */ });
	}

	/// Something opening in place (a line's details, the filter panel) eases in rather than popping.
	function easeIn(el) {
		if (el && !calm.matches && typeof el.animate === "function") el.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" });
	}

	// ---------------------------------------------------------------- the sheet (one bottom sheet for every picker)
	function openSheet(html, onClose) {
		const d = $("#sheet");
		$("#sheet-body").innerHTML = html;
		paintIcons(d);
		openSheet.onClose = onClose || null;
		showDialog(d);
	}
	function closeSheet() { hideDialog($("#sheet")); }
	const sheetHead = (title, sub, extra) => `<div class="sheet-head"><div><h2 id="sheet-title">${esc(title)}</h2>${sub ? `<p class="muted small">${sub}</p>` : ""}</div>
		${extra ? `<div class="sheet-head-btns">${extra}` : ""}<button class="icon-btn" type="button" data-action="close-sheet" aria-label="${esc(say("close"))}">${icon("close")}</button>${extra ? "</div>" : ""}</div>`;

	// ---------------------------------------------------------------- month / year picker (the owner, round 2)
	const FIRST_YEAR = 2024;
	function yearRow(sel, action) {
		const last = +todayLocal().slice(0, 4), ys = [];
		for (let y = Math.min(FIRST_YEAR, sel); y <= last; y++) ys.push(y);
		return `<div class="yr-row" role="group" aria-label="${esc(say("month.year"))}">${ys.map((y) => `<button type="button" class="fchip${y === sel ? " on" : ""}" data-action="${action}" data-y="${y}" aria-pressed="${y === sel}">${fyear(y)}</button>`).join("")}</div>`;
	}
	/// Twelve months of `year`; `mark(ym)` returns "" | "on" | "in" (inside a range); later than this month = disabled.
	function monthGrid(year, mark, action) {
		const max = todayLocal().slice(0, 7);
		let out = "";
		for (let i = 1; i <= 12; i++) {
			const ym = `${year}-${String(i).padStart(2, "0")}`, k = mark(ym);
			out += `<button type="button" class="mcell${k ? " " + k : ""}" data-action="${action}" data-ym="${ym}" ${ym > max ? "disabled" : ""} aria-pressed="${k === "on"}">${fmonthOnly(ym)}</button>`;
		}
		return `<div class="mgrid" role="group" aria-label="${esc(say("month.grid", { year: fyear(year) }))}">${out}</div>`;
	}
	function monthPicker(year) {
		const cur = state.month, now = todayLocal().slice(0, 7);
		openSheet(`${sheetHead(say("month.pick"), say("month.showing", { month: fmonth(cur) }))}
			${yearRow(year, "mpick-year")}
			${monthGrid(year, (ym) => (ym === cur ? "on" : ""), "mpick-month")}
			<div class="sheet-actions">${cur === now ? "" : `<button class="btn" type="button" data-action="mpick-month" data-ym="${now}">${say("month.back_now")}</button>`}</div>`);
	}
	function goMonth(ym) {
		const { parts: p, q } = hash();
		state.month = ym;
		q.set("m", ym); q.delete("p");
		go(p.join("/") || "overview", q);
	}

	// ---------------------------------------------------------------- short pages: tabs + pager (the owner, round 2: no long scrolls)
	const PER_PAGE = 6;
	const store = {
		get(k) { try { return localStorage.getItem(k); } catch { return null; } },
		set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: just not remembered */ } },
	};
	/// The tab a view is on: the address first, then the one the owner last used, then the first.
	function tabFor(view, q, ids) {
		const want = q.get("t") || store.get("ledger-tab:" + view);
		return ids.includes(want) ? want : ids[0];
	}
	function segTabs(view, tabs, cur) {
		return `<div class="seg" role="tablist" aria-label="${esc(say("tabs"))}">${tabs.map(([id, label, n]) =>
			`<button type="button" role="tab" class="seg-b" aria-selected="${id === cur}" data-action="seg" data-view="${view}" data-tab="${id}">${esc(label)}${n ? `<span class="seg-n">${n}</span>` : ""}</button>`).join("")}</div>`;
	}
	function pageOf(list, q, size = PER_PAGE) {
		const pages = Math.max(1, Math.ceil(list.length / size));
		const p = Math.min(Math.max(1, Number(q.get("p")) || 1), pages);
		return { items: list.slice((p - 1) * size, p * size), p, pages };
	}
	function pager(p, pages) {
		if (pages <= 1) return "";
		return `<nav class="pager" aria-label="${esc(say("pager.label"))}">
			<button class="btn" type="button" data-action="page" data-p="${p - 1}" ${p <= 1 ? "disabled" : ""}>${icon("left")}${say("pager.prev")}</button>
			<span class="muted num">${say("pager.page", { p, pages })}</span>
			<button class="btn" type="button" data-action="page" data-p="${p + 1}" ${p >= pages ? "disabled" : ""}>${say("pager.next")}${icon("right")}</button></nav>`;
	}
	/// One short line pointing at the 完整度 page, instead of a long notice.
	/// A late statement is a warning (what is wrong, and why); a card simply between two
	/// statements is a quiet grey note — still saying its newest spending is not known yet.
	function compactNotice(coverage, m) {
		const partial = (coverage || []).filter((c) => c.partial);
		if (!partial.length) return "";
		const late = partial.filter((c) => c.overdue);
		const quiet = partial.filter((c) => !c.overdue);
		const href = `#/overview?m=${m}&t=cov`;
		const name = (c) => accountName(c.account_id, null, c);
		const note = (c) => !c.complete_through ? say("notice.no_statement", { name: name(c) }) : say("notice.after", { name: name(c), date: fdate(addDays(c.complete_through, 1)) }) + (c.next_statement_due ? say("cov.closing", { date: fdate(c.next_statement_due) }) : "");
		return (late.length ? `<a class="notice compact" href="${href}" title="${esc(late.map((c) => c.message).join("\n"))}">${icon("alert")}<span><b>${say("notice.late")}</b>${esc(late.map((c) => say("notice.late_item", { name: name(c), text: overdueText(c) })).join(say("notice.sep")))}</span>${icon("right")}</a>` : "")
			+ (quiet.length ? `<a class="notice compact quiet" href="${href}" title="${esc(quiet.map((c) => c.message).join("\n"))}">${icon("info")}<span>${esc(quiet.map(note).join(say("notice.sep")))}</span>${icon("right")}</a>` : "");
	}

	// ---------------------------------------------------------------- the engine's status strip: alarms and 「連接 Gmail」
	/// Above every tab: open alarms (the Gmail one with its 「重新連接 Gmail」 button) and,
	/// when Gmail is not connected, the button to connect it. The quiet "connected: x" line
	/// shows on 總覽 only. A strip that cannot load hides itself; it never costs the page.
	/// An alarm's title by its key ("pdf_password:HSBC" → its kind, pdf_password); an unknown one is a plain "needs you".
	const ALARMS = new Set(["google_signin", "credit_exhausted", "credit_low", "key_rejected", "backfill_cap", "backfill_extra_cap", "model_unavailable", "catchup_cap", "mail_stuck", "mail_check_late", "reader_idle", "pdf_password", "bank_unverified", "wallet_unverified", "alerts_silent", "bank_sender_unknown"]);
	const alarmTitle = (key) => { const kind = key.split(":")[0]; return say(ALARMS.has(kind) ? "alarm." + kind : "alarm.other"); };
	const gmailButton = (label, primary) => `<a class="btn small${primary ? " btn-primary" : ""}" href="/google/connect">${label}</a>`;
	async function refreshEngine(view, live) {
		const el = $("#engine");
		let s;
		try { s = await api("/api/status"); } catch { if (live()) el.hidden = true; return; }
		if (!live()) return; // a newer tab is drawing
		const gm = s.gmail || null;
		const alarms = Array.isArray(s.alarms) ? s.alarms : [];
		const signinAlarm = alarms.some((a) => a.key === "google_signin");
		const out = alarms.map((a) => `<div class="notice${a.key === "google_signin" ? " crit" : ""}" role="alert">${icon("alert")}<div>
			<b>${esc(alarmTitle(a.key))}</b><span class="engine-msg">${esc(a.message)}</span>
			${a.key === "google_signin" && gm && gm.ready ? `<div class="engine-act">${gmailButton(say("gmail.reconnect"), true)}${gm.email ? `<span class="muted small">${esc(say("gmail.now", { email: gm.email }))}</span>` : ""}</div>` : ""}</div></div>`);
		if (gm && !signinAlarm) {
			if (gm.via === "page" || gm.via === "secret") {
				if (view === "overview") out.push(`<div class="gmail-line">${icon("check")}<span>${gm.via === "page" ? say("gmail.connected", { email: `<b>${esc(gm.email || "")}</b>` }) : say("gmail.connected_old")}</span>${gm.ready ? gmailButton(say("gmail.reconnect"), false) : ""}</div>`);
			} else if (gm.ready) {
				out.push(`<div class="notice">${icon("info")}<div><b>${say("gmail.not_connected")}</b><span class="engine-msg">${say("gmail.why_connect")}</span><div class="engine-act">${gmailButton(say("gmail.connect"), true)}</div></div></div>`);
			} else if (view === "overview") {
				out.push(`<div class="gmail-line">${icon("info")}<span>${say("gmail.not_set_up")}</span></div>`);
			}
		}
		// The older months' reading (LEDGER_BACKFILL_MONTHS raised later): its progress, on 總覽 only.
		const om = s.older_months;
		if (om && !om.done && view === "overview")
			out.push(`<div class="gmail-line">${icon("info")}<span>${esc(say("engine.older", { from: om.from, to: om.to, read: Number(om.read) || 0, total: Number(om.total) || 0, spent: fmt(Math.round((Number(om.spent_usd) || 0) * 100), "USD") }))}</span></div>`);
		// Reading on the owner's Claude subscription (LEDGER_READER): what waits for his routines, on 總覽 only.
		const rd = s.reader;
		if (rd && rd.mode === "subscription" && view === "overview") {
			const open = rd.open || {};
			const waiting = (Number(open.daily) || 0) + (Number(open.senior) || 0);
			const last = rd.last_submit_at ? new Date(rd.last_submit_at).toLocaleString(LOCALE, { timeZone: HOME.time_zone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : say("reader.never");
			out.push(`<div class="gmail-line">${icon("info")}<span>${esc((waiting ? say("reader.waiting", { daily: Number(open.daily) || 0, senior: Number(open.senior) || 0 }) : say("reader.none")) + say("reader.last", { last }))}</span></div>`);
		}
		el.innerHTML = out.join("");
		el.hidden = !out.length;
		paintIcons(el);
	}

	async function route(opts = {}) {
		if (LOCKED) return;
		const soft = !!opts.soft, keepY = scrollY; // soft: the same tab redrawn with fresher data
		const { parts: p, q } = hash();
		const view = p[0] || "overview";
		if (q.get("m") && /^\d{4}-\d{2}$/.test(q.get("m"))) state.month = q.get("m");
		if (!state.month) state.month = currentMonth();
		document.querySelectorAll(".tab").forEach((t) => t.toggleAttribute("aria-current", false));
		const tab = { overview: "overview", lines: "lines", trips: "trips", trip: "trips", subs: "subs", ok: "ok", reimb: "overview", wallet: "overview" }[view] || "overview";
		const el = document.querySelector(`.tab[data-tab="${tab}"]`);
		if (el) el.setAttribute("aria-current", "page");
		const token = ++state.token;
		const live = () => token === state.token && !LOCKED;
		refreshEngine(view === "reimb" ? "overview" : view, live);
		LINES.clear(); ACTS.clear();
		hideTip();
		// The view builds on a hidden stage and reaches the screen in one piece: a tab drawn
		// from memory never shows 載入中, and only the parts that changed are replaced
		// (20 Oct 2026 — a sub-tab redrew the whole page; a quiet refresh flashed 載入中).
		if (state.stage) state.stage.remove();
		const stage = state.stage = document.createElement("div");
		stage.hidden = true;
		VIEW.before(stage);
		$view = stage;
		let shown = false;
		const show = (complete) => {
			if (shown) return;
			shown = true;
			stage.remove();
			if (state.stage === stage) state.stage = null;
			if ($view === stage) $view = VIEW;
			if (!live()) return;
			paintIcons(stage);
			if (!soft) scrollTo(0, 0); // before the swap, while the old layout is still clean
			swapIn(VIEW, stage, complete);
		};
		const run = (async () => {
			try {
				if (view === "lines") await viewLines(q, live);
				else if (view === "trips") await viewTrips(q, live);
				else if (view === "trip") await viewTrip(decodeURIComponent(p[1] || ""), q, live);
				else if (view === "subs") await viewSubs(q, live);
				else if (view === "ok") await viewOk(q, live);
				else if (view === "reimb") await viewReimb(q, live);
				else if (view === "wallet") await viewWallet(decodeURIComponent(p[1] || ""), q, live);
				else await viewOverview(q, live);
			} catch (err) {
				if (live()) $view.innerHTML = failCard(say("fail.this_page"), err);
			}
		})();
		// A view still waiting on the network after this task shows what it has now (its
		// 載入中, an honest wait) and fills in on screen. A quiet refresh never does: the
		// old tab stays until the new one is whole.
		if (!soft) setTimeout(() => show(false), 0);
		await run;
		show(true);
		if (live()) paintIcons(VIEW);
		if (soft && live()) scrollTo(0, keepY);
	}
	/// The stage's nodes onto the screen. A whole view replaces only the top-level parts
	/// that differ (the title and month bar stay the same nodes); a view still loading
	/// moves over as it is, since it goes on writing into its own nodes.
	function swapIn(screen, stage, complete) {
		const now = [...screen.childNodes], next = [...stage.childNodes];
		if (!complete || now.length !== next.length || now.some((n, i) => n.nodeName !== next[i].nodeName)) return screen.replaceChildren(...next);
		next.forEach((n, i) => { if (!now[i].isEqualNode(n)) now[i].replaceWith(n); });
	}

	// ---------------------------------------------------------------- 總覽 overview: 摘要 | 分類 | 帳戶 | 完整度 | 對帳
	async function viewOverview(q, live) {
		const m = state.month;
		const tab = tabFor("overview", q, ["sum", "cat", "acct", "cov", "pay"]);
		$view.innerHTML = `<div class="page-title"><h1>${say("tab.overview")}</h1>${tab === "pay" ? "" : monthBar("overview")}</div>
			${segTabs("overview", [["sum", say("ov.sum")], ["cat", say("ov.cat")], ["acct", say("ov.acct")], ["cov", say("ov.cov")], ["pay", say("ov.pay")]], tab)}
			<div class="pane" id="pane">${loading()}</div>`;
		const pane = $("#pane");
		if (tab === "pay") return viewPay(pane, q, live);
		const byMerchant = tab === "cat" && q.get("by") === "merchant";
		let o;
		try { o = await api("/api/overview" + qstr({ month: m, group_by: byMerchant ? "merchant" : "" })); } catch (err) { if (live()) pane.innerHTML = failCard(say("ov.fail", { month: fmonth(m) }), err); return; }
		if (!live()) return;
		const lq = (k, v) => `#/lines?m=${m}&${k}=${encodeURIComponent(v)}`;
		if (tab === "sum") {
			const t = o.totals, reimb = await reimbursableTotal(o, m);
			if (!live()) return;
			const personal = reimb ? t.spending_home.minor - reimb.minor : null;
			pane.innerHTML = `<section class="card hero">
					<div class="label">${say("ov.spent", { month: fshortMonth(m) })} · ${say("lines.count", { n: t.count })}</div>
					<div class="hero-num">${home(t.spending_home.minor)}</div>
					${splitBlock(t.spending_home, t.unconfirmed_home, { missing: t.missing_rate_count })}
					<div class="kpis">
						<a class="kpi" href="#/lines?m=${m}&reimbursable=false"><div class="k">${say("ov.personal")}</div><div class="v num">${personal === null ? say("unknown") : home(personal)}</div></a>
						<a class="kpi" href="#/reimb?m=${m}"><div class="k">${say("reimb.label")} ${icon("right")}</div><div class="v num">${reimb ? home(reimb.minor) : say("unknown")}</div></a>
					</div>
					${o.income ? `<div class="kpis"><a class="kpi" href="#/lines?m=${m}&category=Salary"><div class="k">${say("ov.salary")}</div><div class="v num">${home(o.income.salary_home.minor)}</div></a><div class="kpi"><div class="k">${say("ov.other_income")}</div><div class="v num">${home(o.income.other_home.minor)}</div></div></div>` : ""}
				</section>${prepaidTile(o, m)}<div id="non-spend"></div><div id="pay-link"></div>${compactNotice(o.coverage, m)}`;
			nonSpend(o, m, live); payLink(live);
		} else if (tab === "cat" || tab === "acct") {
			const big = (k, v) => `${lq(k, v)}&sort=amount&order=desc`; // a group's lines, biggest first
			const unc = (g) => (g.unconfirmed_home ? g.unconfirmed_home.minor : 0);
			let groups = tab === "acct"
				? accts(o).map((g) => ({ label: g.name, total: g.spending_home.minor, unconf: unc(g), count: g.count, netZero: isWalletId(g), href: isWalletId(g) ? walletHref(g.id) : big("account", g.id) }))
				: byMerchant
					? merchants(o).map((g) => ({ label: g.name, total: g.spending_home.minor, unconf: unc(g), count: g.count, share_pct: g.share_pct, href: big("q", byteCap(g.name, 44)) }))
					: cats(o).map((g) => ({ label: catName(g.key), total: g.spending_home.minor, unconf: unc(g), count: g.count, href: big("category", g.key) }));
			const sortBy = tab === "cat" && ["amount", "count", "name"].includes(q.get("sort")) ? q.get("sort") : "amount";
			const whole = o.totals.spending_home.minor;
			groups = groups.map((g) => ({ ...g, share: typeof g.share_pct === "number" ? g.share_pct / 100 : whole > 0 ? g.total / whole : null }));
			groups.sort(sortBy === "count" ? (a, b) => b.count - a.count || b.total - a.total : sortBy === "name" ? (a, b) => a.label.localeCompare(b.label, LANG) : (a, b) => b.total - a.total);
			const pg = pageOf(groups, q, 10);
			const chip = (k, v, label, on) => `<button class="fchip${on ? " on" : ""}" type="button" data-action="qset" data-k="${k}" data-v="${v}" aria-pressed="${on}">${label}</button>`;
			const controls = tab === "cat" ? `<div class="sort-row" role="group" aria-label="${esc(say("sort"))}">
					<div class="chips-row">${chip("sort", "amount", say("sort.amount"), sortBy === "amount")}${chip("sort", "count", say("sort.count"), sortBy === "count")}${chip("sort", "name", say("sort.name"), sortBy === "name")}</div>
					<div class="seg mini" role="group" aria-label="${esc(say("ov.group"))}">${["cat", "merchant"].map((b) => `<button type="button" class="seg-b" aria-selected="${(b === "merchant") === byMerchant}" data-action="qset" data-k="by" data-v="${b}">${b === "cat" ? say("ov.cat") : say("ov.merchant")}</button>`).join("")}</div></div>` : "";
			const what = tab === "acct" ? say("ov.by_account") : byMerchant ? say("ov.by_merchant") : say("ov.by_category");
			pane.innerHTML = `${tab === "acct" ? walletCard(o) : ""}${controls}<section class="card"><div class="card-head"><h2>${what} · ${say("ov.tap_row")}</h2>${barLegend}</div>
				${groups.length ? barList(pg.items) : `<p class="empty">${say("ov.empty")}</p>`}
				${tab === "acct" && walletCovs(o.coverage).length ? `<p class="muted small" style="margin-top:10px">${say("ov.wallet_note", { zero: home(0) })}</p>` : ""}</section>
				${pager(pg.p, pg.pages)}${compactNotice(o.coverage, m)}`;
		} else {
			const pg = pageOf(o.coverage || [], q, 10);
			pane.innerHTML = `<section class="card"><h2>${say("ov.cov_title")}</h2>
				<ul class="cov">${pg.items.map((c) => { const ct = coverageText(c); return `<li title="${esc(c.message)}"><span class="name">${esc(accountName(c.account_id, null, c))}</span><span class="chip ${ct.tone}">${ct.tone === "good" ? icon("check") : ct.tone === "warn" ? icon("clock") : ""}${esc(ct.text)}</span></li>`; }).join("")}</ul>
				${(o.coverage || []).some((c) => c.mode === "statement_only") ? `<p class="muted small" style="margin-top:10px">${say("ov.cov_statement_only")}</p>` : ""}
				${(o.coverage || []).some((c) => c.mode === "wallet" && !(c.wallet && c.wallet.told_only)) ? `<p class="muted small" style="margin-top:6px">${say("ov.cov_wallets")}</p>` : ""}
				${(o.coverage || []).filter((c) => c.mode === "wallet" && c.wallet && c.wallet.told_only).map((c) => `<p class="muted small" style="margin-top:6px">${esc(c.message)}${say("ov.cov_told")}</p>`).join("")}</section>${pager(pg.p, pg.pages)}`;
		}
	}
	// ---------------------------------------------------------------- 儲值卡 prepaid wallets (19 Oct 2026)
	const isWalletId = (g) => g.kind === "wallet" || (ACCOUNTS.get(g.id) || {}).kind === "wallet";
	/// 總覽 → 摘要: the money that is prepaid and not used yet, so it is visibly somewhere.
	function prepaidTile(o, m) {
		const ws = walletCovs(o.coverage).filter((c) => c.wallet.remaining_value);
		if (!ws.length) return "";
		const val = ws.reduce((s, c) => s + c.wallet.remaining_value.minor, 0);
		const pre = ws.reduce((s, c) => s + Math.min(c.wallet.precounted_left.minor, c.wallet.remaining_value.minor), 0);
		return `<a class="card tile" href="#/overview?m=${m}&t=acct"><div class="tile-main"><div class="tile-k">${icon("card")}${say("tile.title")}</div>
			<div class="tile-v num">≈ ${home(val)}</div>
			<div class="muted small">${say("tile.cards", { n: ws.length })}${pre > 0 ? say("tile.precounted", { amount: home(pre) }) : ""}${say("tile.rest")}</div></div>${icon("right")}</a>`;
	}
	/// 總覽 → 帳戶: every active wallet, always — its balance and what it is worth.
	function walletCard(o) {
		const ws = walletCovs(o.coverage);
		if (!ws.length) return "";
		return `<section class="card" style="margin-bottom:12px"><div class="card-head"><h2>${say("wallets.title")}</h2></div>
			<ul class="wallets">${ws.map((c) => `<li><a class="wallet-row" href="${walletHref(c.account_id)}">
				<span class="w-name">${esc(accountName(c.account_id, null, c))}<small>${say("wallets.prepaid")}</small></span>
				<span class="w-bal"><b class="num">${say("wallets.balance", { balance: creditNum(c.wallet.balance) })}</b><small class="num">${c.wallet.remaining_value ? `≈ ${home(c.wallet.remaining_value.minor)}` : "—"}</small></span>${icon("right")}</a></li>`).join("")}</ul></section>`;
	}
	/// One wallet: its balance and real value, every use, every top-up (lot), and why a total can read 0.
	async function viewWallet(id, q, live) {
		const name = (ACCOUNTS.get(id) || {}).name || say("wallets.one");
		$view.innerHTML = `<a class="back" href="#/overview?t=acct">${icon("left")}${say("ov.acct")}</a><div class="page-title"><h1 id="wv-name">${esc(name)}</h1></div><div id="wv">${loading()}</div>`;
		let r;
		try { r = await api("/api/wallets"); } catch (err) { if (live()) $("#wv").innerHTML = failCard(say("wallets.one"), err); return; }
		if (!live()) return;
		const w = (r.wallets || []).find((x) => x.account.id === id);
		if (!w) { $("#wv").innerHTML = `<p class="empty">${say("wallets.not_found")}</p>`; return; }
		$("#wv-name").textContent = w.account.name;
		const tab = tabFor("wallet", q, ["use", "lots", "why"]);
		const pre = w.precounted_left.minor > 0;
		const preUsed = w.used.precounted.minor > 0;
		const old = w.opening_story || "";
		const hero = `<section class="card hero">
			<div class="label">${w.bonus ? say("wv.balance_bonus") : say("wv.balance")}</div>
			<div class="hero-num num">${w.bonus ? creditNum(w.balance) : home(w.balance.minor)}</div>
			<p class="wv-value">${w.bonus ? say("wv.worth", { value: `<b class="num">${home(w.remaining_value.minor)}</b>` }) + " · " : ""}${say("wallets.prepaid")}</p>
			<p class="muted small" style="margin-top:4px">${pre ? say("wv.precounted", { amount: home(w.precounted_left.minor) }) : say("wv.counts_when_used")}</p>
			<div class="kpis three">
				<div class="kpi"><div class="k">${w.bonus ? say("wv.used_credit") : say("wv.used")}</div><div class="v num">${w.bonus ? esc(w.used.credit) : home(w.used.cost.minor)}</div></div>
				<div class="kpi"><div class="k">${say("wv.real_cost")}</div><div class="v num">${home(w.used.cost.minor)}</div></div>
				<div class="kpi"><div class="k">${say("wv.counted")}</div><div class="v num">${home(w.used.counted_now.minor)}</div></div>
			</div>
			${preUsed ? `<p class="muted small" style="margin-top:8px">${say("wv.pre_used", { cost: home(w.used.cost.minor), pre: home(w.used.precounted.minor), counted: home(w.used.counted_now.minor) })}</p>` : ""}
		</section>
		${old ? `<p class="notice compact quiet" style="margin-top:12px">${icon("info")}<span>${esc(old)}</span></p>` : ""}`;
		let body = "";
		if (tab === "use") {
			const pg = pageOf(w.uses, q);
			body = !w.uses.length ? `<p class="empty">${say("wv.no_uses")}</p>`
				: `<ul class="wl">${pg.items.map((u) => `<li>
					<div class="wl-top"><span class="wl-name">${esc(u.merchant || say("line.no_merchant"))}${u.needs_review ? ` <span class="tag warn">${say("line.look")}</span>` : ""}</span><span class="num">${w.bonus ? `−${esc(u.credit)}` : `−${home(u.cost.minor)}`}</span></div>
					<div class="wl-sub"><span>${fdate(u.date)} · ${esc(catName(u.category))}</span>${w.bonus ? `<span class="num">${say("wv.real", { amount: home(u.cost.minor) })}</span>` : ""}</div>
					${u.precounted ? `<div class="l-note">${icon("info")}<span>${u.precounted.minor >= u.cost.minor ? say("wv.use_precounted", { amount: home(u.precounted.minor) }) : say("wv.use_precounted_part", { amount: home(u.precounted.minor) })}</span></div>` : ""}</li>`).join("")}</ul>
				${w.uses_count > w.uses.length ? `<p class="muted small" style="margin-top:8px">${say("wv.only_latest", { shown: w.uses.length, n: w.uses_count })}</p>` : ""}${pager(pg.p, pg.pages)}`;
		} else if (tab === "lots") {
			const pg = pageOf(w.lots.slice().reverse(), q);
			body = `<ul class="wl">${pg.items.map((l) => {
				const credit = Number(l.credit), used = Number(l.used), pct = credit > 0 ? Math.min(100, (used / credit) * 100) : 0;
				const ratio = credit > 0 ? l.paid.minor / 100 / credit : 1;
				const title = esc(l.kind === "opening" ? say("lot.opening", { date: fdate(l.date) }) : l.kind === "topup" ? say("lot.topup", { date: fdate(l.date), from: l.from ? l.from.name : say("lot.own_account") }) : say("lot.refund", { date: fdate(l.date) }));
				const paid = esc(l.kind === "opening" ? (Math.abs(ratio - 1) > 0.0001 ? say("lot.opening_cost", { paid: home(l.paid.minor), credit: l.credit }) : `${home(l.paid.minor)}`) : w.bonus ? say("lot.paid_credit", { paid: home(l.paid.minor), credit: l.credit }) : `${home(l.paid.minor)}`);
				return `<li><div class="wl-top"><span class="wl-name">${title}</span>${l.precounted ? `<span class="tag">${say("lot.precounted")}</span>` : ""}</div>
					<div class="wl-sub"><span>${paid}</span>${Math.abs(ratio - 1) > 0.0001 ? `<span class="num">${say("lot.ratio", { value: home(Math.round(ratio * 10 ** exp(HC))) })}</span>` : ""}</div>
					<div class="lot-bar" role="img" aria-label="${esc(say("lot.used_left_aria", { used: l.used, left: l.left }))}"><i style="width:${pct}%"></i></div>
					<div class="wl-sub"><span>${esc(say("lot.used_left", { used: l.used, left: l.left }))}</span><span class="num">${w.bonus ? say("lot.worth_left", { value: home(l.value_left.minor) }) : ""}</span></div></li>`;
			}).join("")}</ul>${pager(pg.p, pg.pages)}`;
		} else {
			body = `<section class="card"><ul class="story">${w.story.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
				${w.precounted_topups.length ? `<h2 style="margin-top:14px">${say("wv.earlier_topups")}</h2><ul class="wl plain">${w.precounted_topups.map((h) => `<li><div class="wl-top"><span>${fdate(h.date)} · ${esc(h.account)}</span><span class="num">${home(h.paid.minor)}</span></div></li>`).join("")}</ul>` : ""}
				<p class="muted small" style="margin-top:10px">${say(w.account.takes_sms ? "wv.how_sms" : w.account.told_only ? "wv.how_told" : "wv.how_mail")}</p></section>`;
		}
		$("#wv").innerHTML = `${hero}<div style="margin-top:12px">${segTabs("wallet", [["use", say("wv.tab_use"), w.uses_count], ["lots", say("wv.tab_lots"), w.lots.length], ["why", say("wv.tab_why")]], tab)}</div>
			<div class="pane">${body}</div>
			<p style="margin-top:12px"><a class="btn" href="#/lines?account=${encodeURIComponent(w.account.id)}&m=${state.month}">${say("wv.see_lines")}</a></p>`;
		paintIcons($("#wv"));
	}

	// ---------------------------------------------------------------- 繳款 card payments (meeting point D) + card days (C)
	/// A card whose due date the ledger does not know (no date on the bill, no due day set) has no day count.
	const dueKnown = (p) => Number.isFinite(p.days_left) && !!p.due_date;
	const PAY_STATUS = {
		paid: (p) => ({ cls: "good", text: say("pay.paid"), icon: "check" }),
		due: (p) => (dueKnown(p) ? { cls: p.days_left <= 7 ? "warn" : "", text: p.days_left === 0 ? say("pay.due_today") : say("pay.days_left", { n: p.days_left }), icon: "clock" } : null),
		overdue: (p) => (p.status_reason === "previous_unpaid" ? { cls: "crit", text: say("pay.prev_unpaid"), icon: "alert" } : dueKnown(p) ? { cls: "crit", text: say("pay.days_late", { n: Math.abs(p.days_left) }), icon: "alert" } : null),
		// Paid by auto-debit from an account the ledger does not track (台新): neutral, never 逾期 on its own.
		autopay_pending: () => ({ cls: "", text: say("pay.autopay_pending"), icon: "clock" }),
		unknown: () => ({ cls: "", text: say("pay.no_bill"), icon: "info" }),
	};
	const PAY_ORDER = { overdue: 0, due: 1, unknown: 2, autopay_pending: 3, paid: 4 };
	/// The newest statement says the bill before it was not paid in full.
	function prevUnpaidLine(p) {
		const b = p.previous_bill;
		if (!b || b.verdict !== "unpaid") return "";
		const why = b.reason === "balance_carried" ? say("pay.carried", { paid: fm(b.payments_credited), bill: fm(b.statement_balance) }) : say("pay.late_fee");
		return `<div class="pay-recon crit">${icon("alert")}<span><b>${esc(say("pay.prev_unpaid_on", { date: fdate(b.period_to) }))}</b>${say("gap")}${why}${b.owner_said_paid ? say("pay.said_paid_disagree") : ""}</span></div>`;
	}
	/// 「我已繳款」 for a bill the ledger cannot see paid, or taking the owner's word back.
	function paidButton(p) {
		const ls = p.last_statement;
		if (!ls || !ls.statement_id) return "";
		if (p.status === "paid" && p.paid_source === "owner")
			return `<div class="pay-owner"><span class="muted small">${icon("check")}${say("pay.you_said_paid")}</span><button class="btn btn-quiet small" type="button" data-action="bill-paid" data-id="${esc(ls.statement_id)}" data-paid="0">${say("pay.undo_paid")}</button></div>`;
		if (p.status === "paid" || p.status === "unknown") return "";
		return `<div class="pay-owner"><span class="muted small">${p.status === "autopay_pending" ? say("pay.autopay_wait") : say("pay.paid_elsewhere")}</span><button class="btn small" type="button" data-action="bill-paid" data-id="${esc(ls.statement_id)}" data-paid="1">${say("pay.i_paid")}</button></div>`;
	}
	/// 「截止日未知 · 設定」: the chip itself opens that card's date settings.
	const dueUnknownChip = (p) => `<button type="button" class="chip warn chip-act" data-action="card-days" data-which="due_day" data-id="${esc(p.account.id)}">${icon("info")}${say("pay.due_unknown")} · <u>${say("pay.set")}</u></button>`;
	/// Soonest first; a card with no known due date goes after every card that has one.
	const byDue = (a, b) => (dueKnown(a) ? a.days_left : Infinity) - (dueKnown(b) ? b.days_left : Infinity);
	const dayText = (d) => (d ? say("pay.day_of_month", { d }) : say("pay.day_unknown"));
	const SRC = { owner: say("pay.src_owner"), statement: say("pay.src_statement") };
	/// The statement's reconciliation: the route's own field when it has one, else the matching MonthView.
	function payRecon(p, months) {
		if (p.reconciliation) return p.reconciliation;
		const ls = p.last_statement;
		if (!ls || !months) return null;
		return months.find((s) => s.account_id === p.account.id && s.period_end === ls.period_to) || null;
	}
	function reconLine(rc) {
		if (!rc) return `<div class="pay-recon muted">${icon("clock")}<span>${say("recon.not_yet")}</span></div>`;
		if (rc.status === "reconciled") return `<div class="pay-recon good"><span><b>${say("recon.ok")}</b>${say("gap")}${say("recon.ok_note")}</span></div>`;
		if (rc.status === "escalated" || rc.status === "mismatch") {
			const d = rc.difference;
			return `<a class="pay-recon crit" href="#/ok?t=months">${icon("alert")}<span>${say("recon.off")}${d && d.minor ? say(d.minor < 0 ? "recon.short" : "recon.over", { amount: fmt(Math.abs(d.minor), d.currency) }) : ""}${say("gap")}${say("recon.go_review")}</span></a>`;
		}
		return `<div class="pay-recon muted">${icon("clock")}<span>${say("recon.checking")}</span></div>`;
	}
	function payCard(p, months, acct) {
		const ls = p.last_statement, st = (PAY_STATUS[p.status] || PAY_STATUS.unknown)(p);
		const due = p.due_date || (ls && ls.due_date);
		const a = acct || ACCOUNTS.get(p.account.id) || {};
		const name = p.account.name || a.name || say("pay.this_card");
		return `<section class="card pay-card${p.status === "overdue" ? " overdue" : ""}">
			<div class="pay-top"><div class="pay-name">${esc(name)}</div>${st ? `<span class="chip ${st.cls}">${icon(st.icon)}${st.text}</span>` : dueUnknownChip(p)}</div>
			${ls ? `<div class="pay-main"><div><div class="k">${p.status === "paid" ? say("pay.this_paid") : say("pay.to_pay")}</div><div class="pay-amt num">${fm(p.outstanding)}</div></div>
				<div class="pay-due"><div class="k">${say("pay.due")}</div><div class="v">${due ? fdate(due) : say("pay.unknown")}</div></div></div>
				<dl class="kv pay-kv"><dt>${say("pay.bill_amount", { range: frange(ls.period_from, ls.period_to) })}</dt><dd>${fm(ls.statement_balance)}</dd>
				<dt>${say("pay.paid_since")}</dt><dd>${fm(p.paid_since_statement)}</dd>
				${p.autopay && p.autopay.on ? `<dt>${say("pay.how")}</dt><dd>${say("pay.autopay")}${say(p.autopay.source === "owner" ? "pay.by_you" : "pay.by_statement")}</dd>` : ""}
				${p.status === "paid" ? "" : `<dt>${say("pay.minimum")}</dt><dd>${fm(ls.minimum_due)}</dd>`}
				<dt>${say("pay.unbilled_next")}</dt><dd>${fm(p.unbilled)}</dd></dl>
				${prevUnpaidLine(p)}
				${reconLine(payRecon(p, months))}
				${paidButton(p)}`
			: `<p class="muted small" style="margin-top:6px">${say("pay.no_bill_yet", { unbilled: fm(p.unbilled) })}</p>`}
			<button class="pay-set" type="button" data-action="card-days" data-id="${esc(p.account.id)}">
				<span>${icon("card")}${say("pay.cutoff")} <b>${dayText(a.statement_day)}</b> · ${say("pay.due_day")} <b>${dayText(a.due_day)}</b></span>
				<span class="muted small">${SRC[a.settings_source] || say("pay.can_set")} ›</span></button>
		</section>`;
	}
	async function viewPay(pane, q, live) {
		const [pr, mr, ar] = await Promise.allSettled([api("/api/payments"), api("/api/months"), api("/api/accounts")]);
		if (!live()) return;
		if (pr.status === "rejected") { pane.innerHTML = failCard(say("ov.pay"), pr.reason); return; }
		if (ar.status === "fulfilled") learnAccounts(ar.value.accounts);
		const r = pr.value, months = mr.status === "fulfilled" ? mr.value.months : null;
		const cards = (r.cards || r.payments || []).slice().sort((a, b) => ((PAY_ORDER[a.status] ?? 2) - (PAY_ORDER[b.status] ?? 2)) || byDue(a, b));
		const t = r.total || {};
		const next = cards.find((c) => c.status === "due" || (c.status === "overdue" && (dueKnown(c) || c.status_reason === "previous_unpaid")));
		const owe = t.outstanding_home || t.outstanding;
		const pg = pageOf(cards, q, 3);
		pane.innerHTML = `<section class="card hero pay-hero"><div class="label">${say("pay.total")}</div>
				<div class="hero-num">${owe ? (t.estimate ? "≈" : "") + fm(owe) : say("unknown")}</div>
				${next ? `<p class="pay-next">${!dueKnown(next) ? `<b>${esc(next.account.name)}</b> ${say("pay.due_unknown")}${say("gap")}<button type="button" class="linkish" data-action="card-days" data-which="due_day" data-id="${esc(next.account.id)}">${say("pay.set")}</button>` : next.status === "overdue" ? `<b class="crit-ink">${esc(next.account.name)} ${next.status_reason === "previous_unpaid" ? say("pay.prev_unpaid") : say("pay.days_late", { n: Math.abs(next.days_left) })}</b>` : `${say("pay.next_due")}<b>${esc(next.account.name)}</b> ${fdate(next.due_date)}${say("pay.in_days", { when: next.days_left === 0 ? say("pay.today") : say("pay.days_left", { n: next.days_left }) })}`}</p>` : `<p class="pay-next">${icon("check")} ${say("pay.all_paid")}</p>`}
				<div class="kpis"><div class="kpi"><div class="k">${say("pay.minimum_total")}</div><div class="v num">${fm(t.minimum_due_home || t.minimum_due)}</div></div>
				<div class="kpi"><div class="k">${say("pay.unbilled")}</div><div class="v num">${fm(t.unbilled_home || t.unbilled)}</div></div></div>
				${t.estimate ? `<p class="muted small" style="margin-top:8px">${say("pay.estimate_note", { currency: currencyName(HC) })}</p>` : ""}
				<p class="muted small" style="margin-top:4px">${say("pay.transfers_note")}</p></section>
			${uploadCard()}
			${months === null ? `<div class="notice compact">${icon("alert")}<span>${say("pay.no_recon_html")}</span></div>` : ""}
			<div class="cards">${pg.items.map((p) => payCard(p, months)).join("")}</div>${pager(pg.p, pg.pages)}`;
		UPL.live = live;
		paintUploads();
		loadUploads();
	}

	// ---------------------------------------------------------------- 上傳帳單 statement PDFs the owner uploads (Citi emails none)
	/// POST /api/statements/upload one file per request (a phone's memory, and a row per file in the list);
	/// GET /api/statements/uploads for where each one stands. The reading happens on the server, every minute.
	const UPL = { local: [], server: null, failed: false, all: false, live: () => false, timer: 0, polls: 0 };
	const UP_MAX = 10 * 1024 * 1024;
	const UP_STATE = {
		sending: { cls: "", text: say("up.sending"), icon: "clock" },
		queued: { cls: "", text: say("up.queued"), icon: "clock" },
		read: { cls: "", text: say("up.read"), icon: "clock" },
		imported: { cls: "good", text: say("up.imported"), icon: "check" },
		duplicate: { cls: "", text: say("up.duplicate"), icon: "check" },
		needs_account: { cls: "warn", text: say("up.needs_account"), icon: "alert", ok: true },
		needs_password: { cls: "warn", text: say("up.needs_password"), icon: "alert", ok: true },
		failed: { cls: "crit", text: say("up.failed"), icon: "alert" },
		refused: { cls: "crit", text: say("up.refused"), icon: "alert" },
		error: { cls: "crit", text: say("up.error"), icon: "alert" },
	};
	const DEMO_UPLOADS = [
		{ id: "d1", filename: "Citi eStatement Sep 2026.pdf", state: "imported", message: say("demo.up_imported"), created_at: "2026-10-11T09:00:00.000Z", statements: [] },
		{ id: "d2", filename: "Citi eStatement Aug 2026.pdf", state: "duplicate", message: say("demo.up_duplicate"), created_at: "2026-10-11T09:00:00.000Z", statements: [] },
	];
	function uploadCard() {
		return `<section class="card up-card"><div class="up-head"><div><b>${say("up.title")}</b>
			<p class="muted small">${say("up.note")}</p></div>
			<label class="btn btn-primary up-pick">${icon("upload")}${say("up.title")}<input type="file" accept="application/pdf,.pdf" multiple data-action="upload-pick"></label></div>
			<div id="up-list" class="up-list" aria-live="polite"></div></section>`;
	}
	function upRow(u) {
		const st = UP_STATE[u.state] || UP_STATE.failed;
		const chip = `<span class="chip ${st.cls}">${icon(st.icon)}${st.text}</span>`;
		return `<div class="up-row"><div class="up-top"><span class="up-name">${esc(u.filename || say("up.default_name"))}</span>${st.ok ? `<a href="#/ok?t=uploads" class="chip-link">${chip}</a>` : chip}</div>
			${u.message ? `<div class="small muted">${esc(u.message)}${st.ok ? `${say("gap")}<a href="#/ok?t=uploads">${say("up.go_review")}</a>` : ""}</div>` : ""}</div>`;
	}
	function paintUploads() {
		const el = $("#up-list");
		if (!el || !UPL.live()) return;
		const server = UPL.server || [], shown = UPL.all ? server : server.slice(0, 5);
		const rows = UPL.local.concat(shown);
		// Many at once (a two-year catalogue): a count per state, then the newest few.
		const tally = server.length > 5 ? Object.entries(server.reduce((t, u) => ((t[u.state] = (t[u.state] || 0) + 1), t), {})).map(([k, n]) => `${(UP_STATE[k] || UP_STATE.failed).text} ${n}`).join(" · ") : "";
		el.innerHTML = (tally ? `<p class="small up-tally">${esc(say("up.tally", { n: server.length, tally }))}</p>` : "")
			+ (rows.length ? rows.map(upRow).join("") : UPL.failed ? `<p class="muted small">${say("up.no_list")}</p>` : "")
			+ (server.length > 5 ? `<button type="button" class="btn btn-quiet small" data-action="up-all">${UPL.all ? say("up.latest_5") : say("up.all", { n: server.length })}</button>` : "");
		paintIcons(el);
	}
	async function loadUploads() {
		clearTimeout(UPL.timer);
		try { UPL.server = (await apiRaw("/api/statements/uploads")).uploads || []; UPL.failed = false; }
		catch (e) { if (e.status === 401) { showLocked(); return; } UPL.failed = true; }
		if (!UPL.live()) return;
		paintUploads();
		// Still being read on the server: look again shortly (the reading runs every minute).
		const busy = (UPL.server || []).some((u) => u.state === "queued" || u.state === "read");
		if (busy && UPL.polls++ < 40) UPL.timer = setTimeout(() => { if (UPL.live()) loadUploads(); }, 15000);
	}
	async function uploadOne(file) {
		if (FIXTURES) {
			await new Promise((r) => setTimeout(r, 300));
			const row = { id: "f" + Date.now(), filename: file.name, state: "queued", message: say("demo.up_queued"), created_at: new Date().toISOString(), statements: [] };
			DEMO_UPLOADS.unshift(row);
			setTimeout(() => Object.assign(row, { state: "imported", message: say("demo.up_imported_now") }), 4000);
			return { status: "queued", message: row.message };
		}
		const fd = new FormData();
		fd.append("files", file, file.name);
		let res;
		try { res = await fetch("/api/statements/upload", { method: "POST", credentials: "same-origin", cache: "no-store", body: fd }); }
		catch { throw new LoadError(say("err.offline"), 0); }
		let body = null;
		try { body = await res.json(); } catch { /* not JSON */ }
		if (res.status === 401) throw new LoadError("locked", 401);
		if (!res.ok || !body || body.ok !== true) throw new LoadError(body && body.message ? body.message : say("err.server", { status: res.status }), res.status);
		return (body.files || [])[0] || { status: "error", message: say("up.no_answer") };
	}
	async function sendUploads(files) {
		UPL.polls = 0;
		const mine = files.map((f) => ({ filename: f.name, state: "sending", message: "", file: f }));
		UPL.local = mine.concat(UPL.local.filter((u) => u.state !== "sending"));
		paintUploads();
		for (const u of mine) {
			if (u.file.size > UP_MAX) Object.assign(u, { state: "refused", message: say("up.too_big") });
			else {
				try { const r = await uploadOne(u.file); Object.assign(u, { state: r.status === "duplicate" ? "duplicate" : r.status === "refused" ? "refused" : r.status === "queued" ? "queued" : "error", message: r.message || "" }); }
				catch (e) { if (e.status === 401) { showLocked(); return; } Object.assign(u, { state: "error", message: e.message }); }
			}
			delete u.file;
			paintUploads();
		}
		const n = mine.filter((u) => u.state === "queued").length;
		toast(n ? say("up.toast_n", { n }) : say("up.toast_none"));
		// What the server took is in its own list now; keep only what it refused or never got.
		UPL.local = UPL.local.filter((u) => u.state === "refused" || u.state === "error");
		CACHE.clear();
		await loadUploads();
		refreshBadge();
	}
	/// 「不算花費」 under the spending total: money out that left but was not spent. The overview's own
	/// `non_spending` when it has it ([{kind, total_home, count}]), else summed from the month's lines.
	async function nonSpend(o, m, live) {
		const kinds = ["investment", "loan_repayment", "friend_transfer", "card_payment"];
		let rows = Array.isArray(o.non_spending) ? o.non_spending.map((x) => ({ kind: x.kind, minor: (x.total_home || x.amount_home || {}).minor || 0, count: x.count })) : null;
		if (!rows) {
			const { from, to } = monthBounds(m);
			let ls = null;
			try { ls = await allLines({ from, to }); } catch { /* shown as unknown below */ }
			if (!live()) return;
			// only money leaving (a card's own "payment received" credit is the other half of the same bill payment)
			rows = ls && kinds.map((k) => { const xs = ls.filter((v) => v.kind === k && v.state !== "void" && v.amount.home.minor > 0); return { kind: k, minor: xs.reduce((s, v) => s + v.amount.home.minor, 0), count: xs.length }; });
		}
		const el = $("#non-spend");
		if (!el || !live()) return;
		const label = KIND;
		el.innerHTML = `<div class="non-spend"><span class="ns-h">${say("ns.title")}</span>${rows
			? kinds.map((k) => { const r = rows.find((x) => x.kind === k) || { minor: 0, count: 0 }; return `<a class="ns-item" href="#/lines?m=${m}&kind=${k}"><span>${label[k]}</span><b class="num">${home(r.minor)}</b></a>`; }).join("")
			: `<span class="muted small">${say("unknown")}</span>`}</div>`;
	}
	/// One line under 摘要 pointing at 繳款. Quiet when it cannot load.
	async function payLink(live) {
		let r; try { r = await api("/api/payments"); } catch { return; }
		const el = $("#pay-link");
		if (!live() || !el) return;
		const cards = r.cards || r.payments || [], t = r.total || {}, owe = t.outstanding_home || t.outstanding;
		const late = cards.filter((c) => c.status === "overdue"), next = cards.filter((c) => c.status === "due").sort(byDue)[0];
		// 自動扣繳 past its due date is not money to pay and not late (the next statement confirms it).
		if (!owe && !late.length) return;
		el.innerHTML = `<a class="notice compact pay-link${late.length ? " crit" : ""}" href="#/overview?t=pay">${icon(late.length ? "alert" : "card")}<span><b>${say("paylink.owe", { amount: (t.estimate ? "≈" : "") + fm(owe) })}</b>${say("gap")}${late.length ? esc(say("paylink.late", { name: late[0].account.name })) : next ? (dueKnown(next) ? say("paylink.next", { date: fdate(next.due_date), when: next.days_left === 0 ? say("pay.today") : say("paylink.days", { n: next.days_left }) }) : `${esc(next.account.name)} ${say("pay.due_unknown")}`) : ""}</span>${icon("right")}</a>`;
		paintIcons(el);
	}
	/// The cut-off / due day sheet for one credit card (meeting point C).
	const CDAYS = { id: null, which: "statement_day", statement_day: null, due_day: null };
	function cardDays(id, keep, which) {
		const a = ACCOUNTS.get(id);
		if (!a) return toast(say("cd.no_card"));
		if (!keep) Object.assign(CDAYS, { id, which: which === "due_day" ? "due_day" : "statement_day", statement_day: a.statement_day ?? null, due_day: a.due_day ?? null });
		const field = (k, label) => `<button type="button" class="day-field" data-action="cd-which" data-k="${k}" aria-pressed="${CDAYS.which === k}">
			<span class="small">${label}</span><b>${dayText(CDAYS[k])}</b>
			<span class="muted small">${CDAYS[k] !== (a[k] ?? null) ? say("cd.changed") : CDAYS[k] == null ? say("cd.pick_below") : SRC[a.settings_source] || say("pay.can_set")}</span></button>`;
		let grid = "";
		for (let d = 1; d <= 31; d++) grid += `<button type="button" class="dcell${CDAYS[CDAYS.which] === d ? " on" : ""}" data-action="cd-day" data-d="${d}" aria-pressed="${CDAYS[CDAYS.which] === d}">${d}</button>`;
		openSheet(`${sheetHead(say("cd.title", { name: a.name || say("pay.this_card") }), say("cd.sub"))}
			<div class="day-fields">${field("statement_day", say("cd.cutoff"))}${field("due_day", say("cd.due"))}</div>
			<div class="small act-q">${say("cd.pick", { which: CDAYS.which === "statement_day" ? say("cd.cutoff") : say("cd.due") })}</div>
			<div class="dgrid" role="group">${grid}</div>
			<p class="muted small">${say("cd.short_months")}</p>
			<div class="small act-q">${say("pay.how")}</div>
			<div class="actions autopay-row" role="group" aria-label="${esc(say("pay.how"))}">
				<button type="button" class="btn${a.autopay === true ? " btn-primary" : ""}" data-action="cd-autopay" data-v="1" aria-pressed="${a.autopay === true}">${say("pay.autopay")}</button>
				<button type="button" class="btn${a.autopay === false ? " btn-primary" : ""}" data-action="cd-autopay" data-v="0" aria-pressed="${a.autopay === false}">${say("cd.self")}</button>
			</div>
			<p class="muted small">${a.autopay === true || a.autopay === false ? `${say("cd.by_you")}<button type="button" class="linkish" data-action="cd-autopay" data-v="">${say("cd.ledger_decides")}</button>` : say("cd.not_set")}${say("cd.autopay_note")}</p>
			<p class="form-error" id="cd-error" role="alert" hidden></p>
			<div class="sheet-actions"><button class="btn" type="button" data-action="close-sheet">${say("cancel")}</button><button class="btn btn-primary" type="button" data-action="cd-save">${say("save")}</button></div>`);
	}
	/// 繳費方式: the owner's word that a card is paid by auto-debit (or by him); "" = the ledger decides again.
	async function saveAutopay(el) {
		const v = el.dataset.v, autopay = v === "1" ? true : v === "0" ? false : null;
		const err = $("#cd-error");
		el.disabled = true;
		try {
			const r = await api(`/api/accounts/${encodeURIComponent(CDAYS.id)}/settings`, { method: "POST", body: { autopay } });
			toast(r.message || say("saved"));
			learnAccounts((await api("/api/accounts")).accounts);
			cardDays(CDAYS.id, true);
			route();
		} catch (x) {
			if (x.status === 401) { closeSheet(); return showLocked(); }
			el.disabled = false; err.textContent = say("toast.not_saved", { why: x.message }); err.hidden = false;
		}
	}
	/// 繳款 →「我已繳款」/「改回帳本判斷」 on one bill.
	async function billPaid(el) {
		el.disabled = true;
		try {
			const r = await api(`/api/payments/${encodeURIComponent(el.dataset.id)}/paid`, { method: "POST", body: { paid: el.dataset.paid === "1" } });
			toast(r.message || say("saved"));
			route(); refreshBadge();
		} catch (x) {
			if (x.status === 401) return showLocked();
			el.disabled = false; toast(say("toast.not_saved", { why: x.message }));
		}
	}
	async function saveCardDays(el) {
		const err = $("#cd-error");
		el.disabled = true;
		try {
			await api(`/api/accounts/${encodeURIComponent(CDAYS.id)}/settings`, { method: "POST", body: { statement_day: CDAYS.statement_day, due_day: CDAYS.due_day } });
			closeSheet(); toast(say("cd.saved"));
			learnAccounts((await api("/api/accounts")).accounts);
			route();
		} catch (x) {
			if (x.status === 401) { closeSheet(); return showLocked(); }
			el.disabled = false; err.textContent = say("toast.not_saved", { why: x.message }); err.hidden = false;
		}
	}

	function monthItem(s) {
		const chip = s.status === "reconciled" ? `<span class="chip good">${icon("check")}${say("month.ok")}</span>`
			: s.status === "escalated" ? `<span class="chip crit">${icon("alert")}${say("recon.off")}</span>` : `<span class="chip">${icon("clock")}${say("recon.checking")}</span>`;
		const d = s.difference;
		const gap = d && d.minor ? say(d.minor < 0 ? "month.short" : "month.over", { amount: fmt(Math.abs(d.minor), d.currency) }) : "";
		const diff = s.status === "escalated" ? `<p class="muted small">${s.expected ? say("month.figures", { statement: fm(s.expected), ledger: fm(s.ledger) }) : ""}${gap}${say("month.escalated")}</p>` : "";
		return `<li><div class="top-line"><span>${esc(accountName(s.account_id))}<span class="muted small"> · ${frange(s.period_start, s.period_end)}</span></span>${chip}</div>${diff}</li>`;
	}

	/// Overview groups, read the way Dev's route spells them (and tolerant of key/account forms).
	const cats = (o) => (o.categories || o.by_category || []).map((g) => ({ ...g, key: g.category ?? g.key ?? "Uncategorised" }));
	/// group_by=merchant: read `merchants` (or `by_merchant`); every row {merchant|name, spending_home, unconfirmed_home, count}.
	const merchants = (o) => (o.merchants || o.by_merchant || (o.group_by === "merchant" ? o.groups : null) || []).map((g) => ({ ...g, name: g.merchant ?? g.name ?? g.key ?? say("line.no_merchant") }));
	const accts = (o) => (o.by_account || []).map((g) => ({ ...g, id: g.account_id ?? (g.account && g.account.id) ?? g.key, name: g.name ?? (g.account && g.account.name) ?? accountName(g.account_id) }));
	/// The month's company-reimbursable total: from the overview when it carries it,
	/// else the sum of the month's reimbursable lines. null = unknown — never guessed as zero.
	async function reimbursableTotal(o, m) {
		if (o.reimbursable_home) return o.reimbursable_home;
		try {
			const { from, to } = monthBounds(m);
			const lines = await allLines({ from, to, reimbursable: "true" });
			if (!lines) return null;
			// the same sum as reimbursableTotal() in src/reimbursable.ts: every live line marked reimbursable
			return money(lines.filter((v) => v.state !== "void").reduce((s, v) => s + v.amount.home.minor, 0));
		} catch { return null; }
	}
	/// Every line for a filter, walking the route's pages. null when there are too many to hold.
	/// Every page comes from the same moment as the first or later: a page remembered
	/// from before the first page's copy is read again (so a list, and its sum, never
	/// mixes an old page with a new one).
	async function allLines(query, maxPages = 20) {
		let out = [], cursor = null, pages = 0, since = 0;
		do {
			const path = "/api/lines" + qstr({ ...query, limit: 200, cursor });
			const hit = CACHE.get(path);
			const r = pages && hit && hit.t < since ? JSON.parse(await fetchInto(path)) : await api(path);
			if (!pages) since = (CACHE.get(path) || { t: 0 }).t;
			out = out.concat(r.lines); cursor = r.next_cursor;
		} while (cursor && ++pages < maxPages);
		return cursor ? null : out;
	}
	/// Spending totals of a COMPLETE list (the caller only passes a whole filter, never one page).
	function listTotals(lines) {
		const x = sums(lines.filter((v) => v.spending && !v.flags.includes("no_rate")));
		return { ...x, missing_rate_count: lines.filter((v) => v.flags.includes("no_rate")).length };
	}
	const totalsLine = (t) => `<div class="result-sum"><span>${say("sum.spent", { amount: `<b class="num">${home(t.spending_home.minor)}</b>` })} · ${say("lines.count", { n: t.count })}${t.missing_rate_count ? say("sum.no_rate", { n: t.missing_rate_count }) : ""}</span><span class="small">${say("sum.split", { confirmed: home(t.spending_home.minor - t.unconfirmed_home.minor), estimate: home(t.unconfirmed_home.minor) })}</span></div>`;

	// ---------------------------------------------------------------- 明細 lines: chip filters, pages of 8
	let FILTER_OPTS = null; // the options behind each filter chip, for the panel
	const FILTER_LABEL = { account: say("filter.account"), category: say("filter.category"), trip: say("filter.trip"), reimbursable: say("filter.reimbursable") };
	/// The lines a 明細 address asks for (one place, so prefetch() warms exactly what the tab reads).
	function linesQuery(q, m) {
		const { from, to } = monthBounds(m);
		const f = { account: q.get("account") || "", category: q.get("category") || "", trip: q.get("trip") || "", reimbursable: q.get("reimbursable") || "", q: q.get("q") || "", kind: q.get("kind") || "" };
		const isDay = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x || "");
		const range = isDay(q.get("from")) && isDay(q.get("to")) && q.get("from") <= q.get("to") ? { from: q.get("from"), to: q.get("to") } : null;
		const top = q.get("top") === "10";
		const sort = top || q.get("sort") === "amount" ? "amount" : "date", order = top ? "desc" : q.get("order") === "asc" ? "asc" : "desc";
		return { sort, order, from: f.trip ? "" : range ? range.from : from, to: f.trip ? "" : range ? range.to : to, account: f.account, category: f.category, trip: f.trip, reimbursable: f.reimbursable, kind: f.kind, q: f.q ? byteCap(f.q, 44) : "" };
	}
	async function viewLines(q, live) {
		const m = state.month, { from, to } = monthBounds(m);
		const f = { account: q.get("account") || "", category: q.get("category") || "", trip: q.get("trip") || "", reimbursable: q.get("reimbursable") || "", q: q.get("q") || "", kind: q.get("kind") || "" };
		const isDay = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x || "");
		const range = isDay(q.get("from")) && isDay(q.get("to")) && q.get("from") <= q.get("to") ? { from: q.get("from"), to: q.get("to") } : null;
		const top = q.get("top") === "10";
		const sort = top || q.get("sort") === "amount" ? "amount" : "date", order = top ? "desc" : q.get("order") === "asc" ? "asc" : "desc";
		const sortKey = top ? "top" : sort === "date" ? "new" : order === "desc" ? "high" : "low";
		$view.innerHTML = `<div class="page-title"><h1>${say("tab.lines")}</h1>${f.trip || range ? "" : monthBar("lines")}</div>
			<div id="ln-cov"></div>
			<div class="filters" id="ln-filters">
				<label class="search">${icon("search")}<span class="sr">${say("lines.search")}</span><input type="search" name="q" value="${esc(f.q)}" placeholder="${esc(say("lines.search"))}" enterkeyhint="search"></label>
				<div class="chips-row" id="ln-chips">${loading("")}</div>
				<div class="fpanel" id="ln-panel" hidden></div>
				<div class="sort-row" role="group" aria-label="${esc(say("sort"))}"><div class="chips-row">${[["new", say("lines.newest")], ["high", say("lines.highest")], ["low", say("lines.lowest")], ["top", say("lines.top10")]].map(([k, t]) => `<button class="fchip${k === sortKey ? " on" : ""}" type="button" data-action="lsort" data-s="${k}" aria-pressed="${k === sortKey}">${t}</button>`).join("")}</div></div>
			</div>
			<div id="ln-sum"></div><div id="ln-list">${loading()}</div><div id="ln-pager"></div>`;
		const query = linesQuery(q, m);
		const [ov, trips, lines] = await Promise.allSettled([api("/api/overview" + qstr({ month: m })), api("/api/trips"), allLines(query)]);
		if (!live()) return;
		const o = ov.status === "fulfilled" ? ov.value : null;
		$("#ln-cov").innerHTML = f.trip ? "" : o ? compactNotice(o.coverage, m) : `<div class="notice compact">${icon("alert")}<span>${say("lines.no_cov_html")}</span></div>`;
		const catSet = new Set(o ? cats(o).map((g) => g.key) : []);
		if (f.category) catSet.add(f.category);
		const tripList = trips.status === "fulfilled" ? trips.value.trips.filter((t) => t.status === "confirmed") : [];
		FILTER_OPTS = {
			account: [...ACCOUNTS.values()].map((a) => [a.id, a.name]).concat(ACCOUNTS.size || !o ? [] : accts(o).map((g) => [g.id, g.name])),
			// A→Z like the picker; 未分類 (no category at all) last, since it is not one the owner chose.
			category: sortCats([...catSet].filter((c) => !isUncat(c))).concat([...catSet].filter(isUncat)).map((c) => [c, catName(c)]),
			trip: tripList.map((t) => [t.id, tripName(t)]),
			reimbursable: [["false", say("filter.personal")], ["true", say("filter.company")]],
		};
		const valueName = (k) => (FILTER_OPTS[k].find(([v]) => v === f[k]) || [, f[k]])[1];
		const dateChip = f.trip ? "" : range
			? `<button class="fchip on" type="button" data-action="fclear" data-k="range" aria-label="${esc(say("filter.clear_range"))}">${esc(rangeLabel(range.from, range.to))}${icon("close")}</button>`
			: `<button class="fchip" type="button" data-action="fpanel" data-k="date" aria-expanded="false">${say("filter.range")}</button>`;
		$("#ln-chips").innerHTML = dateChip + Object.keys(FILTER_LABEL).map((k) => f[k]
			? `<button class="fchip on" type="button" data-action="fclear" data-k="${k}" aria-label="${esc(say("filter.clear", { name: FILTER_LABEL[k] }))}">${esc(valueName(k))}${icon("close")}</button>`
			: `<button class="fchip" type="button" data-action="fpanel" data-k="${k}" aria-expanded="false">${esc(FILTER_LABEL[k])}</button>`).join("")
			+ (f.q ? `<button class="fchip on" type="button" data-action="fclear" data-k="q">${esc(say("filter.q", { q: f.q }))}${icon("close")}</button>` : "")
			+ (f.kind ? `<button class="fchip on" type="button" data-action="fclear" data-k="kind">${esc(KIND[f.kind] || f.kind)}${icon("close")}</button>` : "");
		if (lines.status === "rejected") { $("#ln-list").innerHTML = failCard(say("tab.lines"), lines.reason); return; }
		const all = lines.value;
		if (all === null) { $("#ln-list").innerHTML = `<p class="empty">${say("lines.too_many")}</p>`; return; }
		const tot = listTotals(all);
		// the route sorts; the page sorts the same whole list again so the order never depends on it
		const amt = (v) => (v.flags.includes("no_rate") ? null : v.amount.home.minor);
		let shown = foldList(all);
		// by amount: spending first (that is the question), money that is not spending after it
		if (sort === "amount") shown.sort((a, b) => { if (a.spending !== b.spending) return a.spending ? -1 : 1; const x = amt(a), y = amt(b); return x === null ? 1 : y === null ? -1 : order === "asc" ? x - y : y - x; });
		if (top) shown = shown.filter((v) => v.spending && v.amount.home.minor > 0 && !v.flags.includes("no_rate")).slice(0, 10);
		const topSum = top ? shown.reduce((s2, v) => s2 + v.amount.home.minor, 0) : 0;
		$("#ln-sum").innerHTML = totalsLine(tot) + (top && tot.spending_home.minor > 0 ? `<p class="muted small top-note">${say("lines.top_note", { amount: home(topSum), pct: pct(topSum / tot.spending_home.minor) })}</p>` : "");
		const pg = top ? { items: shown, p: 1, pages: 1 } : pageOf(shown, q, sort === "date" ? 5 : 8);
		$("#ln-list").innerHTML = !shown.length ? `<p class="empty" style="margin-top:16px">${say("lines.none")}</p>`
			: sort === "date" ? linesByDay(pg.items, {}) : rankList(pg.items, (pg.p - 1) * 8);
		$("#ln-pager").innerHTML = pager(pg.p, pg.pages);
	}
	/// A chosen period by name: a year, a month, a run of months, else the day range with its year.
	/// Chinese keeps its own shape (「2026年3月–6月」); other languages ask Intl ("Mar – Jun 2026").
	const MONTH_RANGE = {
		"zh-Hant": (a, b, ya, ma, yb, mb) => (ya === yb ? `${ya}年${ma}月–${mb}月` : `${ya}年${ma}月–${yb}年${mb}月`),
	};
	const DAY_RANGE = { "zh-Hant": (a, b, ya) => `${ya}年${frange(a, b).replace(/^\d+年/, "")}` };
	function rangeLabel(a, b) {
		const [ya, ma, da] = parts(a), [yb, mb] = parts(b);
		const wholeMonths = da === 1 && b === monthBounds(b.slice(0, 7)).to;
		if (!wholeMonths) return (DAY_RANGE[LANG] || ((x, y) => dfmt({ year: "numeric", month: MONTH, day: "numeric" }).formatRange(noon(x), noon(y))))(a, b, ya);
		if (ya === yb && ma === 1 && mb === 12) return fyear(ya);
		if (ya === yb && ma === mb) return fmonth(a.slice(0, 7));
		return (MONTH_RANGE[LANG] || ((x, y) => dfmt({ year: "numeric", month: "short" }).formatRange(noon(x), noon(y))))(a, b, ya, ma, yb, mb);
	}
	const RNG = { year: 0, a: null, b: null }; // the 自訂 range being picked
	function rangeCustom() {
		const el = $("#rng-custom");
		if (!el) return;
		const { a, b } = RNG;
		const mark = (ym) => (a && (ym === a || ym === b) ? "on" : a && b && ym > a && ym < b ? "in" : "");
		const said = !a ? say("rng.how") : say("rng.from_to", { from: `<b>${fmonth(a)}</b>`, to: `<b>${fmonth(b || a)}</b>` });
		el.innerHTML = `${yearRow(RNG.year, "rng-year")}${monthGrid(RNG.year, mark, "rng-month")}
			<div class="rng-foot"><span class="small">${said}</span><button class="btn btn-primary small" type="button" data-action="rng-apply" ${a ? "" : "disabled"}>${say("rng.apply")}</button></div>`;
		el.hidden = false;
	}
	function datePanel() {
		const panel = $("#ln-panel");
		const quick = [["this", say("rng.this")], ["last", say("rng.last")], ["year", say("rng.year")], ["lastyear", say("rng.lastyear")], ["custom", say("rng.custom")]];
		panel.innerHTML = `<div class="fpanel-head"><b>${say("filter.range")}</b><span class="muted small">${say("pick_one")}</span></div>
			<div class="chips-row">${quick.map(([r, t]) => `<button class="fchip" type="button" data-action="rng" data-r="${r}">${t}</button>`).join("")}</div>
			<div class="rng-custom" id="rng-custom" hidden></div>`;
		panel.hidden = false;
	}
	function setRange(from, to) {
		const { q } = hash();
		q.delete("p");
		if (from) { q.set("from", from); q.set("to", to); } else { q.delete("from"); q.delete("to"); }
		q.set("m", state.month);
		go("lines", q);
	}
	function filterPanel(k) {
		if (k === "date") return datePanel();
		const panel = $("#ln-panel");
		const opts = (FILTER_OPTS && FILTER_OPTS[k]) || [];
		panel.innerHTML = `<div class="fpanel-head"><b>${esc(FILTER_LABEL[k])}</b><span class="muted small">${say("pick_one")}</span></div>
			<div class="chips-row">${opts.length ? opts.map(([v, t]) => `<button class="fchip" type="button" data-action="fset" data-k="${k}" data-v="${esc(v)}">${k === "category" ? `<span class="cat-ic" aria-hidden="true">${catIcon(v)}</span>` : ""}${esc(t)}</button>`).join("") : `<span class="muted small">${say("filter.nothing")}</span>`}</div>`;
		panel.hidden = false;
		paintIcons(panel);
	}

	// ---------------------------------------------------------------- 旅行 trips: 待確認 | 已確認 | 不是旅行
	const tripName = (t) => t.name || t.destination;
	const nights = (t) => daysBetween(t.start_date, t.end_date);
	function proposalCard(t, acts) {
		return `<section class="card proposal" data-trip="${esc(t.id)}">
			<div class="q">${say("trip.is_it")}</div>
			<div class="trip-top" style="margin-top:4px"><div class="trip-name">${esc(tripName(t))}</div><div class="trip-total">${t.unconfirmed_home.minor > 0 ? "≈" : ""}${home(t.total_home.minor)}</div></div>
			<div class="trip-sub">${frange(t.start_date, t.end_date)} · ${say("lines.count", { n: t.line_count })} · ${say("trip.guessed")}</div>
			${acts || `<div class="actions"><button class="btn btn-primary" type="button" data-action="trip" data-do="confirm" data-id="${esc(t.id)}">${say("trip.yes")}</button><button class="btn" type="button" data-action="trip" data-do="reject" data-id="${esc(t.id)}">${say("trip.no")}</button></div>`}
		</section>`;
	}
	const tripCard = (t) => `<a class="card trip-card" href="#/trip/${encodeURIComponent(t.id)}">
		<div class="trip-top"><div class="trip-name">${esc(tripName(t))}</div><div class="trip-total">${home(t.total_home.minor)}</div></div>
		<div class="trip-sub">${frange(t.start_date, t.end_date)} · ${say("trip.nights", { n: nights(t) })} · ${say("lines.count", { n: t.line_count })}${t.unconfirmed_home.minor > 0 ? say("trip.est", { amount: home(t.unconfirmed_home.minor) }) : ""}</div></a>`;
	async function viewTrips(q, live) {
		$view.innerHTML = `<div class="page-title"><h1>${say("tab.trips")}</h1><button class="btn btn-primary small" type="button" data-action="trip-form">${say("trip.new")}</button></div>
			<form id="trip-new" class="card" hidden onsubmit="return false" style="margin-bottom:12px">
				<label class="small">${say("trip.name")}<input name="tname" placeholder="${esc(say("trip.name_eg"))}" maxlength="120"></label>
				<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><label class="small">${say("trip.start")}<input name="tstart" type="date"></label><label class="small">${say("trip.end")}<input name="tend" type="date"></label></div>
				<label class="small" style="display:block;margin-top:8px">${say("trip.place")}<input name="tdest" placeholder="${esc(say("trip.place_eg"))}" maxlength="120"></label>
				<p class="muted small" style="margin-top:8px">${say("trip.auto_note")}</p>
				<button class="btn btn-primary" type="button" data-action="trip-new" style="margin-top:8px">${say("trip.create")}</button>
			</form><div id="tr">${loading()}</div>`;
		let r;
		try { r = await api("/api/trips"); } catch (err) { if (live()) $("#tr").innerHTML = failCard(say("tab.trips"), err); return; }
		if (!live()) return;
		const by = (s) => r.trips.filter((t) => t.status === s).sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
		const proposed = by("proposed"), confirmed = by("confirmed"), dismissed = by("dismissed");
		const tabs = [["proposed", say("trip.tab_proposed"), proposed.length], ["confirmed", say("trip.tab_confirmed"), confirmed.length], ["dismissed", say("trip.no"), dismissed.length]].filter(([id, , n]) => id === "confirmed" || n);
		const tab = tabFor("trips", q, tabs.map((t) => t[0]));
		const list = { proposed, confirmed, dismissed }[tab];
		const pg = pageOf(list, q, 6);
		$("#tr").innerHTML = segTabs("trips", tabs, tab) + (
			tab === "proposed" ? `<div class="cards">${pg.items.map((t) => proposalCard(t, t.actions ? actionBar(t) : "")).join("")}</div>`
			: tab === "dismissed" ? `<section class="card"><ul class="months">${pg.items.map((t) => `<li><div class="top-line"><span>${esc(tripName(t))}<span class="muted small"> · ${frange(t.start_date, t.end_date)}</span></span><span class="muted small">${say("trip.you_said_no")}</span></div></li>`).join("")}</ul></section>`
			: confirmed.length ? `<div class="cards">${pg.items.map(tripCard).join("")}</div>` : `<p class="empty">${say("trip.none_yet")}</p>`) + pager(pg.p, pg.pages);
	}
	async function viewTrip(id, q, live) {
		$view.innerHTML = `<a class="back" href="#/trips">${icon("left")}${say("tab.trips")}</a><div id="tp">${loading()}</div>`;
		let trips;
		try { trips = await api("/api/trips"); } catch (err) { if (live()) $("#tp").innerHTML = failCard(say("trip.this"), err); return; }
		if (!live()) return;
		const t = trips.trips.find((x) => x.id === id);
		if (!t) { $("#tp").innerHTML = `<p class="empty">${say("trip.not_found")}</p>`; return; }
		let lines = [], err = null;
		try { lines = await allLines({ trip: id }); if (!lines) throw new LoadError(say("trip.too_many"), 0); } catch (e) { err = e; lines = []; }
		if (!live()) return;
		const tab = tabFor("trip", q, ["sum", "cat", "lines"]);
		const head = `<div class="page-title"><h1>${esc(tripName(t))}</h1><span class="muted">${frange(t.start_date, t.end_date)} · ${say("trip.nights", { n: nights(t) })}</span></div>
			${segTabs("trip", [["sum", say("ov.sum")], ["cat", say("ov.cat")], ["lines", say("tab.lines"), lines.length]], tab)}`;
		if (tab === "lines") {
			const sorted = lines.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
			const pg = pageOf(sorted, q, 5);
			$("#tp").innerHTML = head + (err ? failCard(say("trip.lines"), err) : linesByDay(pg.items, { trip: false }) + pager(pg.p, pg.pages));
			return;
		}
		const spend = lines.filter((v) => v.spending && !v.flags.includes("no_rate"));
		const byCat = new Map();
		for (const v of spend) {
			const k = v.category || "Uncategorised";
			const g = byCat.get(k) || { total: 0, unconf: 0, count: 0 };
			g.total += v.amount.home.minor; g.count++;
			if (v.amount.home.status === "estimate" || v.amount.home.status === "reference") g.unconf += v.amount.home.minor;
			byCat.set(k, g);
		}
		// Overseas fees are inside each purchase; shown in the home currency (pro-rated for a card in another currency).
		let fee = 0, feeEst = false;
		for (const v of spend) {
			const f = v.amount.overseas_fee;
			if (!f) continue;
			if (f.currency === HC) fee += f.minor;
			else if (v.amount.billed.minor) { fee += Math.round((f.minor * v.amount.home.minor) / v.amount.billed.minor); feeEst = true; }
			if (v.amount.billed.status === "estimate") feeEst = true;
		}
		const cs = [...byCat].sort((a, b) => b[1].total - a[1].total);
		const feeNote = fee > 0 ? `<p class="fee-note">${icon("info")} ${say("trip.fees", { amount: (feeEst ? "≈" : "") + home(fee) })}</p>` : "";
		const big = (k) => (byCat.get(k) || { total: 0 }).total;
		$("#tp").innerHTML = head + (tab === "cat"
			? `<section class="card"><div class="card-head"><h2>${say("trip.where")}</h2>${barLegend}</div>
				${err ? failCard(say("trip.lines"), err) : barList(cs.map(([k, g]) => ({ label: catName(k), total: g.total, unconf: g.unconf, count: g.count, href: `#/lines?trip=${encodeURIComponent(id)}&category=${encodeURIComponent(k)}` })))}${feeNote}</section>`
			: `<section class="card hero"><div class="label">${say("trip.total")}</div>
				<div class="hero-num">${home(t.total_home.minor)}</div>
				${splitBlock(t.total_home, t.unconfirmed_home)}
				${err ? "" : `<div class="kpis"><div class="kpi"><div class="k">${catName("flights")}</div><div class="v num">${home(big("flights"))}</div></div><div class="kpi"><div class="k">${catName("lodging")}</div><div class="v num">${home(big("lodging"))}</div></div></div>`}
				${feeNote}
				${t.reimbursable_home.minor > 0 ? `<p class="fee-note">${say("trip.reimb", { amount: home(t.reimbursable_home.minor) })}</p>` : ""}
			</section>`);
	}

	// ---------------------------------------------------------------- 訂閱 subscriptions: 訂閱中 | 可能已停止 | 已取消 (+ 已移除的項目)
	function isNewThisWeek(s) {
		return s.status === "active" && s.occurrences === SUB_THRESHOLD[s.cadence] && daysBetween(s.last_charged, todayLocal()) <= 7;
	}
	/// What the owner can say about a subscription in each state. His word beats detection (meeting point B).
	const SUB_ACTS = {
		active: [["cancelled", say("sub.cancelled")], ["ignore", say("sub.not")]],
		lapsed: [["active", say("sub.still")], ["cancelled", say("sub.cancelled")], ["ignore", say("sub.not")]],
		cancelled: [["active", say("sub.still")], ["ignore", say("sub.not")]],
		ignored: [["restore", say("sub.restore")]],
	};
	const SUBS = new Map(); // merchant (lower case) → SubscriptionView, for 明細's 「設為訂閱」
	const learnSubs = (list) => { SUBS.clear(); (list || []).forEach((x) => x.status !== "ignored" && SUBS.set(String(x.merchant).toLowerCase(), x)); };
	async function viewSubs(q, live) {
		$view.innerHTML = `<div class="page-title"><h1>${say("tab.subs")}</h1></div><div id="sb">${loading()}</div>`;
		let r;
		try { r = await api("/api/subscriptions"); } catch (err) { if (live()) $("#sb").innerHTML = failCard(say("tab.subs"), err); return; }
		if (!live()) return;
		learnSubs(r.subscriptions);
		const today = todayLocal();
		const by = (st) => r.subscriptions.filter((s) => s.status === st);
		const active = by("active").sort((a, b) => (a.next_renewal < b.next_renewal ? -1 : 1));
		const lapsed = by("lapsed").sort((a, b) => (a.last_charged < b.last_charged ? 1 : -1));
		const cancelled = by("cancelled").sort((a, b) => (a.last_charged < b.last_charged ? 1 : -1));
		const ignored = by("ignored");
		const changed = active.filter((s) => s.price_changed_on && s.previous_amount && daysBetween(s.price_changed_on, today) <= 60);
		const fresh = active.filter(isNewThisWeek);
		const per = (s) => `${fm(s.amount)} / ${CADENCE[s.cadence]}`;
		const due = (s) => { const d = daysBetween(today, s.next_renewal); return d < 0 ? say("sub.overdue", { date: fdate(s.next_renewal) }) : d === 0 ? say("sub.today") : d === 1 ? say("sub.tomorrow") : say("sub.renews", { date: fdate(s.next_renewal), n: d }); };
		const when = { active: due, lapsed: (s) => say("sub.lapsed_when", { date: fdate(s.next_renewal), last: fdate(s.last_charged) }), cancelled: (s) => say("sub.cancelled_when", { last: fdate(s.last_charged) }), ignored: (s) => say("sub.ignored_when", { every: esc(CADENCE[s.cadence]), last: fdate(s.last_charged) }) };
		const row = (s) => {
			const tags = [];
			if (fresh.includes(s)) tags.push(`<span class="tag co">${say("sub.new_week")}</span>`);
			if (changed.includes(s)) tags.push(`<span class="tag">${say(s.amount.minor > s.previous_amount.minor ? "sub.up" : "sub.down")}</span>`);
			return `<li class="sub${s.status === "active" ? "" : " stopped"}" data-sub="${esc(s.id)}"><div class="sub-top"><div><div class="nm">${esc(s.merchant)}${tags.join("")}</div>
				<div class="when">${when[s.status](s)}</div></div>
				<div class="amt">${per(s)}${s.cadence !== "monthly" && s.status === "active" ? `<small>${say("sub.per_month", { amount: fm(s.monthly_equivalent) })}</small>` : ""}${s.amount.currency !== HC ? `<small>${say("sub.foreign")}</small>` : ""}</div></div>
				<div class="sub-acts">${SUB_ACTS[s.status].map(([act, label]) => `<button class="btn small${act === "ignore" ? " btn-danger" : ""}" type="button" data-action="sub" data-do="${act}" data-id="${esc(s.id)}">${label}</button>`).join("")}</div></li>`;
		};
		const tab = q.get("t") === "removed" ? "removed" : tabFor("subs", q, ["active", "lapsed", "cancelled"]);
		const list = { active, lapsed, cancelled, removed: ignored }[tab];
		const pg = pageOf(list, q, 5);
		const empty = say("sub.empty_" + tab);
		const hint = tab === "active" ? "" : say("sub.hint_" + tab);
		const notes = tab === "active" && (changed.length || fresh.length) ? `<div class="highlight">
			${changed.map((s) => `<div class="hl ${s.amount.minor > s.previous_amount.minor ? "up" : ""}">${icon(s.amount.minor > s.previous_amount.minor ? "up" : "info")}<div><b>${esc(s.merchant)} ${say(s.amount.minor > s.previous_amount.minor ? "sub.up" : "sub.down")}</b><div class="small">${say("sub.changed", { from: fm(s.previous_amount), to: fm(s.amount), date: fdate(s.price_changed_on) })}</div></div></div>`).join("")}
			${fresh.map((s) => `<div class="hl">${icon("spark")}<div><b>${say("sub.found", { merchant: esc(s.merchant) })}</b><div class="small">${say("sub.found_note", { per: per(s), n: s.occurrences })}</div></div></div>`).join("")}</div>` : "";
		const head = tab === "removed"
			? `<button class="back link-btn" type="button" data-action="seg" data-view="subs" data-tab="active">${icon("left")}${say("sub.active")}</button><h2 class="sub-h">${say("sub.removed")}</h2>`
			: `<div class="sub-total"><span>${say("sub.monthly", { amount: `<b class="num">${fm(r.monthly_total_home)}</b>` })}</span><span class="muted small">${say("sub.active_n", { n: active.length })}${r.monthly_total_missing ? say("sub.missing", { n: r.monthly_total_missing, currency: currencyName(HC) }) : ""}</span></div>
				${segTabs("subs", [["active", say("sub.active"), active.length], ["lapsed", say("sub.lapsed"), lapsed.length], ["cancelled", say("sub.cancelled"), cancelled.length]], tab)}`;
		$("#sb").innerHTML = head + `<div class="pane">${hint ? `<p class="muted small sub-hint">${hint}</p>` : ""}${notes}
			<section class="card">${list.length ? `<ul class="subs">${pg.items.map(row).join("")}</ul>` : `<p class="empty">${empty}</p>`}</section>${pager(pg.p, pg.pages)}
			${tab === "removed" ? "" : `<p class="removed-link"><button class="link-btn" type="button" data-action="seg" data-view="subs-removed" data-tab="removed">${say("sub.removed")}${ignored.length ? say("sub.removed_n", { n: ignored.length }) : ""}</button></p>`}</div>`;
	}

	// ---------------------------------------------------------------- 待確認 needs your OK: one tab per kind, every item actionable
	/// Meeting point A: every item carries `actions: [{id, label, method, path, body, style, choices?}]`.
	/// The page draws them generically; an action with `choices` first asks for a pick (tappable chips)
	/// and sends it as `body[choice_key]` (default "choice"). After a success the list is fetched again.
	const ACTS = new Map(); // uid → action, for the buttons on screen
	let actSeq = 0;
	const choiceOf = (c) => (c && typeof c === "object" ? { v: String(c.value ?? c.id ?? ""), t: c.label ?? c.label ?? c.name ?? String(c.value ?? c.id ?? "") } : { v: String(c), t: String(c) });
	let fieldSeq = 0;
	const grpId = (x) => (x.__fid || (x.__fid = "f" + ++fieldSeq));
	function actionBar(item) {
		const acts = Array.isArray(item.actions) ? item.actions.filter((x) => x && (x.path || x.instructions)) : [];
		const steps = item.instructions ? `<p class="act-steps">${icon("info")}<span>${esc(item.instructions)}</span></p>` : "";
		if (!acts.length) return steps ? `<div class="acts">${steps}</div>` : "";
		const cls = (st) => (st === "primary" ? " btn-primary" : st === "danger" ? " btn-danger" : "");
		const btn = (x) => {
			const uid = "a" + ++actSeq;
			ACTS.set(uid, x);
			return `<button class="btn${cls(x.style)}" type="button" data-action="do-act" data-uid="${uid}">${esc(x.label || say("ok"))}</button>`;
		};
		const picks = acts.filter((x) => x.path && Array.isArray(x.choices) && x.choices.length);
		const plain = acts.filter((x) => x.path && !picks.includes(x));
		// An action that needs one number first (19 Oct 2026: the credit a top-up gave) gets a plain field above the buttons.
		const fields = plain.filter((x) => x.input_key).map((x) => `<label class="small act-q" for="in-${grpId(x)}">${esc(x.input_label || say("act.amount"))}</label>
			<input class="input act-input" id="in-${grpId(x)}" data-key="${esc(x.input_key)}" inputmode="decimal" autocomplete="off" value="${esc(x.input_value || "")}" style="max-width:9em">`).join("");
		const info = acts.filter((x) => !x.path).map((x) => `<p class="act-steps">${icon("info")}<span>${esc(x.instructions)}</span></p>`).join("");
		const grp = "g" + actSeq;
		// a pick that is the main answer comes first; a secondary pick ("or change the category") after the buttons
		const pickHtml = (x, i) => `<div class="act-pick"><div class="small act-q">${esc(x.choice_label || say("pick_one"))}</div>
				<div class="chips-row pick" role="radiogroup" aria-label="${esc(x.choice_label || say("pick_one"))}">${x.choices.map(choiceOf).map((c) => `<label class="opt"><input type="radio" name="${grp}-${i}" value="${esc(c.v)}"><span>${esc(c.t)}</span></label>`).join("")}</div>
				<div class="actions">${btn(x)}</div></div>`;
		const main = picks.filter((x) => x.style === "primary"), rest = picks.filter((x) => x.style !== "primary");
		return `<div class="acts">${steps}${info}
			${main.map(pickHtml).join("")}
			${fields}${plain.length ? `<div class="actions">${plain.map(btn).join("")}</div>` : ""}
			${rest.map((x, i) => pickHtml(x, i + main.length)).join("")}
			<p class="form-error act-err" role="alert" hidden></p></div>`;
	}
	async function doAction(el) {
		const x = ACTS.get(el.dataset.uid);
		if (!x) return;
		const box = el.closest(".acts"), err = box.querySelector(".act-err");
		let body = { ...(x.body || {}) };
		if (Array.isArray(x.choices) && x.choices.length) {
			const picked = el.closest(".act-pick").querySelector("input[type=radio]:checked");
			if (!picked) { err.textContent = say("act.pick_first"); err.hidden = false; return; }
			body[x.choice_key || "choice"] = picked.value;
		}
		if (x.input_key) {
			const field = box.querySelector(`.act-input[data-key="${x.input_key}"]`);
			const val = field ? field.value.trim().replace(/,/g, "") : "";
			if (!/^\d+(\.\d{1,2})?$/.test(val)) { err.textContent = say("act.fill_first", { what: x.input_label || say("act.amount") }); err.hidden = false; return; }
			body[x.input_key] = val;
		}
		box.querySelectorAll("button").forEach((b) => (b.disabled = true));
		err.hidden = true;
		try {
			const r = await api(x.path, { method: x.method || "POST", body });
			toast(r.message || say("act.done", { what: x.label || say("act.handled") }));
			route(); refreshBadge();
		} catch (e) {
			if (e.status === 401) return showLocked();
			box.querySelectorAll("button").forEach((b) => (b.disabled = false));
			err.textContent = say("act.failed", { why: e.message });
			err.hidden = false;
		}
	}
	const OK_TAB = Object.fromEntries(["trips", "held_taps", "months", "lines", "pdf_passwords", "uploads", "bills", "wallet_topups", "wallet_sms"].map((k) => [k, say("oktab." + k)]));
	const OK_ORDER = ["trips", "held_taps", "months", "lines"];
	async function viewOk(q, live) {
		$view.innerHTML = `<div class="page-title"><h1>${say("okv.title")}</h1></div><div id="ok">${loading()}</div>`;
		let r;
		try { r = await api("/api/needs-ok"); } catch (err) { if (live()) $("#ok").innerHTML = failCard(say("okv.list"), err); setBadge(null); return; }
		if (!live()) return;
		const n = okCount(r);
		setBadge(n);
		const otherNote = r.other_held ? `<p class="muted small" style="margin:12px 4px 0">${say("okv.other_held", { n: r.other_held })}</p>` : "";
		if (!n) { $("#ok").innerHTML = `<section class="card all-clear">${icon("check")}<div><b>${say("okv.clear")}</b><p class="muted small">${say("okv.clear_note")}</p></div></section>${otherNote}`; return; }
		// the known lists first, then any other list of items that carry actions (drawn generically)
		const extra = Object.keys(r).filter((k) => !OK_ORDER.includes(k) && Array.isArray(r[k]) && r[k].some((x) => x && typeof x === "object"));
		const keys = OK_ORDER.concat(extra).filter((k) => Array.isArray(r[k]) && r[k].length);
		const tabs = keys.map((k) => [k === "held_taps" ? "cards" : k, OK_TAB[k] || say("oktab.other"), r[k].length]);
		const tab = tabFor("ok", q, tabs.map((t) => t[0]));
		const key = tab === "cards" ? "held_taps" : tab;
		const list = r[key];
		let body;
		if (key === "trips") {
			const pg = pageOf(list, q, 3);
			body = `<div class="cards one">${pg.items.map((t) => (t.actions ? proposalCard(t, actionBar(t)) : proposalCard(t))).join("")}</div>${pager(pg.p, pg.pages)}`;
		} else if (key === "held_taps") {
			const pg = pageOf(list, q, 3);
			body = `<section class="card">${pg.items.map((h) => `<div class="ok-item" data-held="${esc(h.evidence_id)}">
				<div class="t">${esc(h.merchant || say("line.no_merchant"))} · ${fm(h.amount)}</div>
				<div class="d">${fdate(h.date)}${h.time ? " " + esc(h.time) : ""} · ${esc(say("okv.tap_card", { card: h.card || "?" }))}</div>
				<div class="what">${say("okv.tap_what")}</div>
				${h.actions ? actionBar(h) : `<div class="acts"><div class="chips-row pick" role="radiogroup" aria-label="${esc(say("okv.which_card"))}">${cardChips(h.evidence_id)}</div>
					<div class="actions"><button class="btn btn-primary" type="button" data-action="wallet" data-card="${esc(h.card)}">${say("ok")}</button></div></div>`}</div>`).join("")}</section>${pager(pg.p, pg.pages)}`;
		} else if (key === "months") {
			const pg = pageOf(list, q, 3);
			body = `<section class="card">${pg.items.map((s) => `<div class="ok-item"><ul class="months">${monthItem(s).replace(/<\/li>$/, (s.problems && s.problems.length ? `<ul class="problems">${s.problems.map((p) => `<li title="${esc(p.message)}">${esc(RECON[p.code] || p.message)}</li>`).join("")}</ul>` : "") + "</li>")}</ul>${actionBar(s)}</div>`).join("")}</section>${pager(pg.p, pg.pages)}`;
		} else if (key === "lines") {
			const pg = pageOf(list, q, 3);
			list.forEach((v) => LINES.set(v.id, v));
			body = pg.items.map((v) => `<section class="ok-card"><div class="ok-date">${fdate(v.date)} ${weekday(v.date)}</div>${lineRow(v, { flags: true })}${actionBar(v)}</section>`).join("") + pager(pg.p, pg.pages);
		} else {
			const pg = pageOf(list, q, 3);
			body = `<section class="card">${pg.items.map((x) => `<div class="ok-item"><div class="t">${esc(x.title || say("okv.look"))}</div>
				${x.detail ? `<div class="d">${esc(x.detail)}</div>` : ""}${actionBar(x)}</div>`).join("")}</section>${pager(pg.p, pg.pages)}`;
		}
		$("#ok").innerHTML = segTabs("ok", tabs, tab) + `<div class="pane">${body}</div>${otherNote}`;
	}
	const cardChips = (name) => [...ACCOUNTS.values()].filter((a) => a.kind === "credit_card" || a.kind === "debit_card")
		.map((a) => `<label class="opt"><input type="radio" name="card-${esc(name)}" value="${esc(a.id)}"><span>${esc(a.name)}</span></label>`).join("");
	const okCount = (r) => (typeof r.count === "number" ? r.count : Object.values(r).filter(Array.isArray).reduce((s, x) => s + x.length, 0));
	function setBadge(n) {
		const b = $("#ok-badge");
		if (n === null) { b.textContent = "?"; b.hidden = false; b.title = say("okv.badge_unknown"); return; }
		b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n); b.title = "";
	}
	async function refreshBadge() { try { setBadge(okCount(await api("/api/needs-ok"))); } catch (e) { if (e.status === 401) showLocked(); else setBadge(null); } }

	// ---------------------------------------------------------------- 公司報帳 company-reimbursable: 摘要 | 日期範圍 | 明細
	async function viewReimb(q, live) {
		const m = state.month, { from, to } = monthBounds(m);
		const tab = tabFor("reimb", q, ["sum", "ranges", "lines"]);
		$view.innerHTML = `<a class="back" href="#/overview?m=${m}&t=sum">${icon("left")}${say("tab.overview")}</a>
			<div class="page-title"><h1>${say("reimb.label")}</h1>${tab === "ranges" ? "" : monthBar("reimb")}</div>
			${segTabs("reimb", [["sum", say("ov.sum")], ["ranges", say("filter.range")], ["lines", say("tab.lines")]], tab)}<div class="pane stack" id="pane">${loading()}</div>`;
		const pane = $("#pane");
		if (tab === "sum") {
			let o;
			try { o = await api("/api/overview" + qstr({ month: m })); } catch (err) { if (live()) pane.innerHTML = failCard(say("rb.total"), err); return; }
			const r = await reimbursableTotal(o, m);
			if (!live()) return;
			pane.innerHTML = (r ? `<section class="card hero"><div class="label">${say("rb.month", { month: fshortMonth(m) })}</div><div class="hero-num">${home(r.minor)}</div>
				<p class="muted" style="margin-top:6px">${say("rb.personal", { personal: home(o.totals.spending_home.minor - r.minor), total: home(o.totals.spending_home.minor) })}</p></section>`
				: failCard(say("rb.total"), new LoadError(say("rb.no_lines"), 0)))
				+ `<section class="card"><h2>${say("rb.add_range")}</h2>
					<form id="range-form" class="form-grid three" style="margin-top:12px" novalidate>
						<label class="field"><span>${say("trip.start")}</span><input type="date" name="from" required></label>
						<label class="field"><span>${say("trip.end")}</span><input type="date" name="to" required></label>
						<label class="field"><span>${say("rb.note")}</span><input name="note" placeholder="${esc(say("rb.note_eg"))}" autocomplete="off"></label>
						<button class="btn btn-primary" type="submit">${say("trip.add")}</button>
					</form>
					<p class="form-error" id="range-error" role="alert" hidden></p>
					<p class="muted small" style="margin-top:8px">${say("rb.range_note")}</p></section>`;
		} else if (tab === "ranges") {
			let r;
			try { r = await api("/api/reimbursable-ranges"); } catch (err) { if (live()) pane.innerHTML = failCard(say("filter.range"), err); return; }
			if (!live()) return;
			const rs = r.ranges.slice().sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
			const pg = pageOf(rs, q);
			pane.innerHTML = `<section class="card">${rs.length ? `<ul class="months">${pg.items.map((x) => `<li><div class="top-line"><span>${frange(x.start_date, x.end_date)} ${x.start_date.slice(0, 4)}<span class="muted small"> ${esc(x.note || "")}</span></span><button class="btn btn-quiet small" type="button" data-action="range-delete" data-id="${esc(x.id)}">${say("rb.remove")}</button></div></li>`).join("")}</ul>` : `<p class="empty">${say("rb.none")}</p>`}</section>${pager(pg.p, pg.pages)}`;
		} else {
			let ls;
			try { ls = await allLines({ from, to, reimbursable: "true" }); } catch (err) { if (live()) pane.innerHTML = failCard(say("rb.lines"), err); return; }
			if (!live()) return;
			if (ls === null) { pane.innerHTML = `<p class="empty">${say("rb.too_many")}</p>`; return; }
			const pg = pageOf(ls, q);
			pane.innerHTML = ls.length ? `<div>${linesByDay(pg.items, {})}</div>${pager(pg.p, pg.pages)}` : `<p class="empty">${say("rb.empty")}</p>`;
		}
	}

	// ---------------------------------------------------------------- 現金 add cash
	const QUICK = [[/NT\$/i, "TWD"], [/US\$/i, "USD"], [/HK\$/i, "HKD"], [/S\$/i, "SGD"], [/A\$/i, "AUD"], [/RM/i, "MYR"], [/[¥円]/, "JPY"], [/₩/, "KRW"], [/฿/, "THB"], [/€/, "EUR"], [/£/, "GBP"], [/\$/, HC]];
	/// "拉麵 ¥1,200" → {merchant, amount, currency}. "cash"/"現金" are dropped.
	function parseQuick(text) {
		let t = " " + text.trim() + " ";
		let currency = null;
		const code = /\b(SGD|JPY|TWD|USD|MYR|THB|KRW|HKD|CNY|EUR|GBP|AUD|IDR|VND)\b/i.exec(t);
		if (code) { currency = code[1].toUpperCase(); t = t.replace(code[0], " "); }
		if (!currency) for (const [re, c] of QUICK) if (re.test(t)) { currency = c; t = t.replace(re, " "); break; }
		if (!currency && /(日圓|日幣|円)/.test(t)) currency = "JPY";
		if (!currency && /(台幣|新台幣)/.test(t)) currency = "TWD";
		t = t.replace(/(日圓|日幣|台幣|新台幣|元)/g, " ");
		const num = /(\d[\d,]*(?:\.\d+)?)/.exec(t);
		const amount = num ? num[1].replace(/,/g, "") : "";
		if (num) t = t.replace(num[0], " ");
		const merchant = t.replace(/\b(cash|paid|in)\b/gi, " ").replace(/現金|付現/g, " ").replace(/\s+/g, " ").trim();
		return { merchant, amount, currency };
	}
	/// 現金, GrabPay 錢包, Sample Bistro 儲值卡… : one tab per wallet, shown only when the ledger has one.
	const CASH_HINT = say("cash.hint", { currency: currencyName(HC) });
	const walletHint = (w) => say(w.wallet && w.wallet.told_only ? "cash.wallet_told" : "cash.wallet_pre", { name: w.name, currency: w.currency || HC });
	let CASH_FROM = "cash";
	const walletList = () => [...ACCOUNTS.values()].filter((a) => a.kind === "wallet" && a.active !== false);
	const walletAccount = () => (CASH_FROM === "cash" ? null : walletList().find((a) => a.id === CASH_FROM) || null);
	function cashFrom(which) {
		const f = $("#cash-form");
		CASH_FROM = walletList().some((a) => a.id === which) ? which : "cash";
		const w = walletAccount();
		$("#cash-from").querySelectorAll(".seg-b").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.v === CASH_FROM)));
		$("#cash-title").textContent = w ? say("cash.title_wallet", { name: w.name }) : say("cash.title");
		$("#cash-hint").textContent = w ? walletHint(w) : CASH_HINT;
		if (w) f.currency.value = w.currency || HC;
		f.currency.disabled = !!w;
	}
	function openCash() {
		const d = $("#cash"), f = $("#cash-form");
		f.reset();
		f.date.value = todayLocal();
		$("#cash-error").hidden = true;
		const ws = walletList(), seg = $("#cash-from");
		seg.innerHTML = [["cash", say("cash.cash")], ...ws.map((w) => [w.id, w.name])].map(([id, name]) => `<button type="button" class="seg-b" role="tab" aria-selected="false" data-action="cash-from" data-v="${esc(id)}">${esc(name)}</button>`).join("");
		seg.hidden = !ws.length;
		cashFrom("cash");
		setCashCat("");
		showDialog(d);
		setTimeout(() => f.quick.focus(), 30);
	}
	function closeCash() { hideDialog($("#cash")); }
	async function submitCash(e) {
		e.preventDefault();
		const f = e.target, err = $("#cash-error"), btn = $("#cash-submit");
		const cur = f.currency.value, merchant = f.merchant.value.trim(), amount = f.amount.value.trim().replace(/,/g, "");
		const minor = parseMajor(amount, cur);
		const problem = !merchant ? say("cash.need_merchant") : minor === null ? (/\./.test(amount) && exp(cur) === 0 ? say("cash.no_decimals", { currency: cur }) : say("cash.bad_amount")) : minor <= 0 ? say("cash.positive") : !/^\d{4}-\d{2}-\d{2}$/.test(f.date.value) ? say("cash.need_date") : "";
		if (problem) { err.textContent = problem; err.hidden = false; return; }
		btn.disabled = true; err.hidden = true;
		try {
			const w = walletAccount();
			const r = await api("/api/cash", { method: "POST", body: { date: f.date.value, amount, currency: cur, merchant, note: f.note.value.trim() || undefined, ...(f.category.value ? { category: f.category.value } : {}), ...(w ? { account_id: w.id } : {}) } });
			closeCash();
			const s = r.line.amount.home;
			toast(r.already_recorded ? say("cash.joined", { what: `${merchant} ${fmt(minor, cur)}` })
				: say("cash.recorded", { what: `${merchant} ${fmt(minor, cur)}` }) + (cur !== HC ? say("cash.estimated", { amount: home(s.minor) }) : "") + (r.line.wallet ? say("cash.precounted") : ""));
			route(); refreshBadge();
		} catch (x) {
			if (x.status === 401) { closeCash(); showLocked(); return; }
			err.textContent = say("cash.failed", { why: x.message }); err.hidden = false;
		} finally { btn.disabled = false; }
	}

	// ---------------------------------------------------------------- tooltip (enhances; every value is also printed)
	const tip = $("#tip");
	function showTip(el) {
		let d; try { d = JSON.parse(el.dataset.tip); } catch { return; }
		tip.innerHTML = `<b>${esc(d.t)}</b><div class="row"><span>${say("tip.total")}</span><span>${esc(d.total)}</span></div><div class="row"><span>${say("split.confirmed")}</span><span>${esc(d.conf)}</span></div><div class="row"><span>${say("split.estimate")}</span><span>${esc(d.est)}</span></div><div class="row"><span>${say("sort.count")}</span><span>${d.n}</span></div>`;
		tip.hidden = false;
		const r = el.querySelector(".bar-track").getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
		let x = Math.min(Math.max(8, r.left), innerWidth - tw - 8), y = r.top - th - 8;
		if (y < 64) y = r.bottom + 8;
		tip.style.left = x + "px"; tip.style.top = y + "px";
	}
	function hideTip() { tip.hidden = true; }
	const hoverable = matchMedia("(hover: hover)");
	document.addEventListener("pointerover", (e) => { const el = e.target.closest && e.target.closest("[data-tip]"); if (el && hoverable.matches) showTip(el); });
	document.addEventListener("pointerout", (e) => { const el = e.target.closest && e.target.closest("[data-tip]"); if (el && !el.contains(e.relatedTarget)) hideTip(); });
	document.addEventListener("focusin", (e) => { const el = e.target.closest && e.target.closest("[data-tip]"); if (el) showTip(el); else hideTip(); });
	addEventListener("scroll", hideTip, { passive: true });

	// ---------------------------------------------------------------- events
	document.addEventListener("click", async (e) => {
		const el = e.target.closest("[data-action]");
		if (!el) return;
		const a = el.dataset.action;
		if (a === "retry") route();
		else if (a === "open-cash") openCash();
		else if (a === "cash-from") cashFrom(el.dataset.v);
		else if (a === "close-cash") closeCash();
		else if (a === "theme") cycleTheme();
		else if (a === "close-sheet") closeSheet();
		else if (a === "mpick") monthPicker(+state.month.slice(0, 4));
		else if (a === "mpick-year") monthPicker(+el.dataset.y);
		else if (a === "mpick-month") { closeSheet(); goMonth(el.dataset.ym); }
		else if (a === "rng") {
			const now = todayLocal().slice(0, 7), y = +now.slice(0, 4), r = el.dataset.r;
			if (r === "this" || r === "last") { state.month = r === "this" ? now : addMonth(now, -1); setRange(null); }
			else if (r === "year") setRange(`${y}-01-01`, `${y}-12-31`);
			else if (r === "lastyear") setRange(`${y - 1}-01-01`, `${y - 1}-12-31`);
			else { Object.assign(RNG, { year: +state.month.slice(0, 4), a: null, b: null }); el.parentElement.querySelectorAll(".fchip").forEach((b) => b.classList.toggle("on", b === el)); rangeCustom(); }
		} else if (a === "rng-year") { RNG.year = +el.dataset.y; rangeCustom(); }
		else if (a === "rng-month") {
			const ym = el.dataset.ym;
			if (!RNG.a || RNG.b) Object.assign(RNG, { a: ym, b: null });
			else if (ym < RNG.a) Object.assign(RNG, { a: ym, b: RNG.a });
			else RNG.b = ym;
			rangeCustom();
		} else if (a === "rng-apply") { if (RNG.a) setRange(`${RNG.a}-01`, monthBounds(RNG.b || RNG.a).to); }
		else if (a === "qset") {
			const { parts: p, q } = hash();
			q.set(el.dataset.k, el.dataset.v); q.delete("p");
			go(p.join("/") || "overview", q);
		} else if (a === "lsort") {
			const { q } = hash();
			q.delete("p"); q.delete("top"); q.delete("sort"); q.delete("order");
			const k = el.dataset.s;
			if (k === "top") q.set("top", "10");
			else if (k !== "new") { q.set("sort", "amount"); q.set("order", k === "high" ? "desc" : "asc"); }
			q.set("m", state.month);
			go("lines", q);
		} else if (a === "do-act") doAction(el);
		else if (a === "edit-open") editPanel(el);
		else if (a === "line-edit") lineEdit(el);
		else if (a === "topup-pick") topUpPick(el);
		else if (a === "topup-open") { const row = el.closest(".edit-panel").querySelector(".topup-row"); const open = el.getAttribute("aria-expanded") === "true"; el.setAttribute("aria-expanded", String(!open)); if (row) row.hidden = open; }
		else if (a === "line-sub") {
			const want = el.dataset.value === "true", blk = el.closest(".sub-block");
			const cad = want ? (blk.querySelector("input[type=radio]:checked") || {}).value || "monthly" : undefined;
			blk.querySelectorAll("button").forEach((b) => (b.disabled = true));
			try {
				const r = await api(`/api/lines/${encodeURIComponent(el.dataset.id)}/subscription`, { method: "POST", body: want ? { value: true, cadence: cad } : { value: false } });
				try { learnSubs((await api("/api/subscriptions")).subscriptions); } catch { /* the list just is not refreshed */ }
				const v = (r && r.line) || LINES.get(el.dataset.id);
				if (v && !(r && r.line)) v.subscription = want ? { cadence: cad, status: "active" } : null;
				redrawOpen(el.closest(".line"), v);
				toast(want ? say("toast.sub_set", { every: SUB_CADENCES.find(([c]) => c === cad)[1] }) : say("toast.sub_unset"));
			} catch (x) {
				if (x.status === 401) return showLocked();
				blk.querySelectorAll("button").forEach((b) => (b.disabled = false));
				toast(say("toast.failed", { why: x.message }));
			}
		} else if (a === "card-days") cardDays(el.dataset.id, false, el.dataset.which);
		else if (a === "up-all") { UPL.all = !UPL.all; paintUploads(); }
		else if (a === "cd-which") { CDAYS.which = el.dataset.k; cardDays(CDAYS.id, true); }
		else if (a === "cd-day") {
			CDAYS[CDAYS.which] = +el.dataset.d;
			if (CDAYS.which === "statement_day" && CDAYS.due_day === null) CDAYS.which = "due_day"; // walk on to the next blank
			cardDays(CDAYS.id, true);
		} else if (a === "cd-save") saveCardDays(el);
		else if (a === "cd-autopay") saveAutopay(el);
		else if (a === "bill-paid") billPaid(el);
		else if (a === "month") {
			const { parts: p, q } = hash();
			state.month = addMonth(state.month, Number(el.dataset.step));
			q.set("m", state.month); q.delete("p");
			go(p.join("/") || "overview", q);
		} else if (a === "seg") {
			const { parts: p, q } = hash();
			store.set("ledger-tab:" + el.dataset.view, el.dataset.tab);
			q.set("t", el.dataset.tab); q.delete("p");
			go(p.join("/") || "overview", q);
		} else if (a === "page") {
			const { parts: p, q } = hash();
			q.set("p", el.dataset.p);
			go(p.join("/") || "overview", q);
		} else if (a === "fpanel") {
			const open = el.getAttribute("aria-expanded") === "true";
			document.querySelectorAll("#ln-chips [data-action=fpanel]").forEach((b) => b.setAttribute("aria-expanded", "false"));
			if (open) $("#ln-panel").hidden = true;
			else { el.setAttribute("aria-expanded", "true"); filterPanel(el.dataset.k); easeIn($("#ln-panel")); }
		} else if (a === "fset" || a === "fclear") {
			const { q } = hash();
			q.set("m", state.month); q.delete("p");
			if (a === "fset") q.set(el.dataset.k, el.dataset.v);
			else if (el.dataset.k === "range") { q.delete("from"); q.delete("to"); }
			else q.delete(el.dataset.k);
			go("lines", q);
		} else if (a === "toggle-line") {
			const art = el.closest(".line"), det = art.querySelector(".line-detail"), v = LINES.get(art.dataset.line);
			const open = el.getAttribute("aria-expanded") === "true";
			el.setAttribute("aria-expanded", String(!open));
			if (!open && v) { det.innerHTML = lineDetail(v); paintIcons(det); }
			det.hidden = open;
			if (!open) easeIn(det);
		} else if (a === "cat-open") catForLine(el.closest(".edit-block"));
		else if (a === "cash-cat") catForCash();
		else if (a === "cat-pick") catChosen(el.dataset.c || "");
		else if (a === "cat-new") catAdd(el);
		else if (a === "cat-manage") catManage();
		else if (CAT_MANAGE && a.startsWith("cm-")) {
			if (a === "cm-open") cmOne(el.dataset.c);
			else if (a === "cm-done") cmDone();
			else if (a === "cm-back") cmBackOne();
			else if (a === "cm-rename") cmRename(el);
			else if (a === "cm-delete") cmDelete();
			else if (a === "cm-move") { CAT_MANAGE.target = el.dataset.c; cmConfirm(); }
			else if (a === "cm-confirm") cmDo(el);
		}
		else if (a === "offset" || a === "offset-pick") {
			const art = el.closest(".line"), box = art.querySelector(".offset-pick");
			const choice = a === "offset-pick" ? "line" : box.querySelector("[data-offset-to]").value;
			const v = LINES.get(el.dataset.id);
			if (choice === "line" && a === "offset") {
				// Show the purchases it could pay back: the 60 days before it, newest first.
				const list = box.querySelector("[data-offset-lines]");
				list.hidden = false; list.innerHTML = loading();
				try {
					const from = addDays(v.date, -60);
					const r = await api(`/api/lines?from=${from}&to=${v.date}&kind=purchase&limit=100`);
					const ls = (r.lines || []).filter((x) => x.spending && x.id !== v.id).sort((x, y) => (x.date < y.date ? 1 : -1));
					list.innerHTML = ls.length ? `<select data-offset-target aria-label="${esc(say("income.which"))}" style="width:100%">${ls.map((x) => `<option value="${esc(x.id)}">${fdate(x.date)} · ${esc(x.merchant.name || x.merchant.raw || "")} · ${home(x.amount.home.minor)}</option>`).join("")}</select>
						<button class="btn small" type="button" data-action="offset-pick" data-id="${esc(v.id)}" style="margin-top:6px">${say("income.offset_this")}</button>` : `<p class="muted small">${say("income.none_60")}</p>`;
				} catch (x) { if (x.status === 401) return showLocked(); list.innerHTML = failCard(say("income.list"), x); }
				return;
			}
			const body = choice === "line" ? { to: "line", target_line_id: box.querySelector("[data-offset-target]").value }
				: choice.startsWith("card:") ? { to: "card", account_id: choice.slice(5) } : { to: choice };
			el.disabled = true;
			try {
				const r = await api(`/api/lines/${encodeURIComponent(el.dataset.id)}/offset`, { method: "POST", body });
				redrawOpen(art, r.line);
				toast(say("toast.offset_" + body.to));
			} catch (x) {
				if (x.status === 401) return showLocked();
				el.disabled = false;
				toast(say("toast.not_changed", { why: x.message }));
			}
		} else if (a === "trip-in" || a === "trip-out") {
			const art = el.closest(".line");
			const trip = a === "trip-in" ? art.querySelector("[data-trip-pick]").value : el.dataset.trip;
			el.disabled = true;
			try {
				const body = a === "trip-in" ? { include_line_ids: [el.dataset.id] } : { exclude_line_ids: [el.dataset.id] };
				const r = await api(`/api/trips/${encodeURIComponent(trip)}/edit`, { method: "POST", body });
				const fresh = (r.lines || []).find((x) => x.id === el.dataset.id) || { ...LINES.get(el.dataset.id), trip_id: a === "trip-in" ? trip : null };
				await loadTrips();
				if (location.hash.startsWith("#/trip/") && a === "trip-out") { toast(say("toast.trip_out")); route(); return; }
				redrawOpen(art, fresh);
				toast(a === "trip-in" ? say("toast.trip_in", { name: tripName(r.trip) }) : say("toast.trip_out"));
			} catch (x) {
				if (x.status === 401) return showLocked();
				el.disabled = false;
				toast(say("toast.not_changed", { why: x.message }));
			}
		} else if (a === "trip-new") {
			const f = el.closest("form");
			const body = { name: f.tname.value.trim(), start_date: f.tstart.value, end_date: f.tend.value, destination: f.tdest.value.trim() || undefined };
			if (!body.name || !body.start_date || !body.end_date) { toast(say("toast.trip_need")); return; }
			el.disabled = true;
			try {
				const r = await api("/api/trips", { method: "POST", body });
				await loadTrips();
				toast(say("toast.trip_created", { name: tripName(r.trip), n: r.lines ? r.lines.length : 0 }));
				location.hash = `#/trip/${encodeURIComponent(r.trip.id)}`;
			} catch (x) {
				if (x.status === 401) return showLocked();
				el.disabled = false;
				toast(say("toast.not_created", { why: x.message }));
			}
		} else if (a === "trip-form") {
			const box = $("#trip-new"); box.hidden = !box.hidden;
			if (!box.hidden) box.querySelector("input").focus();
		} else if (a === "reimb-clear") {
			el.disabled = true;
			if (!(await setReimb(el, null))) el.disabled = false;
		} else if (a === "range-delete") {
			if (!confirm(say("rb.confirm_remove"))) return;
			el.disabled = true;
			try {
				const r = await api(`/api/reimbursable-ranges/${encodeURIComponent(el.dataset.id)}/delete`, { method: "POST", body: {} });
				toast(say("toast.range_removed", { n: r.affected_lines ?? 0 })); route();
			} catch (x) { if (x.status === 401) return showLocked(); el.disabled = false; toast(say("toast.not_removed", { why: x.message })); }
		} else if (a === "sub") {
			el.disabled = true;
			try {
				await api(`/api/subscriptions/${encodeURIComponent(el.dataset.id)}`, { method: "POST", body: { action: el.dataset.do } });
				toast(say("toast.sub_" + el.dataset.do)); route();
			} catch (x) { if (x.status === 401) return showLocked(); el.disabled = false; toast(say("toast.failed", { why: x.message })); }
		} else if (a === "wallet") {
			const picked = el.closest(".ok-item").querySelector("input[type=radio]:checked");
			if (!picked) { toast(say("toast.pick_card")); return; }
			el.disabled = true;
			try {
				const r = await api("/api/wallet-names", { method: "POST", body: { name: el.dataset.card, account_id: picked.value } });
				toast(say("toast.remembered") + (r.recorded ? say("toast.placed", { n: r.recorded }) : "") + (r.still_held ? say("toast.still_held", { n: r.still_held }) : ""));
				route(); refreshBadge();
			} catch (x) { if (x.status === 401) return showLocked(); el.disabled = false; toast(say("toast.failed", { why: x.message })); }
		} else if (a === "trip") {
			const card = el.closest("[data-trip]");
			card.querySelectorAll("button").forEach((b) => (b.disabled = true));
			try {
				const r = await api(`/api/trips/${encodeURIComponent(el.dataset.id)}/${el.dataset.do}`, { method: "POST", body: {} });
				toast(say(r.trip.status === "confirmed" ? "toast.trip_confirmed" : "toast.trip_rejected", { name: tripName(r.trip) }));
				route(); refreshBadge();
			} catch (x) {
				if (x.status === 401) return showLocked();
				card.querySelectorAll("button").forEach((b) => (b.disabled = false));
				toast(say("toast.failed", { why: x.message }));
			}
		}
	});
	/// Redraw one line with its detail open, from a fresh LineView.
	function redrawOpen(art, line) {
		if (!art || !line) return route();
		LINES.set(line.id, line);
		const tmp = document.createElement("div");
		tmp.innerHTML = lineRow(line, { flags: true });
		const fresh = tmp.firstElementChild;
		fresh.querySelector(".line-main").setAttribute("aria-expanded", "true");
		const det = fresh.querySelector(".line-detail");
		det.innerHTML = lineDetail(line);
		det.hidden = false;
		art.replaceWith(fresh); paintIcons(fresh);
	}
	/// POST a line's company-reimbursable choice (true / false / null = follow the ranges) and redraw it open.
	async function setReimb(el, value) {
		try {
			const r = await api(`/api/lines/${encodeURIComponent(el.dataset.id)}/reimbursable`, { method: "POST", body: { value } });
			redrawOpen(el.closest(".line"), r.line);
			toast(say(value === null ? (r.line.reimbursable.effective ? "toast.reimb_range_company" : "toast.reimb_range_personal") : value ? "toast.reimb_company" : "toast.reimb_personal"));
			return true;
		} catch (x) {
			if (x.status === 401) { showLocked(); return true; }
			toast(say("toast.not_changed", { why: x.message }));
			return false;
		}
	}
	// 上傳帳單 also takes PDFs dragged onto it (a Mac's Finder: select many, drag them in).
	document.addEventListener("dragover", (e) => {
		const zone = e.target.closest && e.target.closest(".up-card");
		if (!zone) return;
		e.preventDefault();
		zone.classList.add("drop");
	});
	document.addEventListener("dragleave", (e) => { const zone = e.target.closest && e.target.closest(".up-card"); if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("drop"); });
	document.addEventListener("drop", (e) => {
		const zone = e.target.closest && e.target.closest(".up-card");
		if (!zone) return;
		e.preventDefault();
		zone.classList.remove("drop");
		const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
		const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
		if (pdfs.length < files.length) toast(say("toast.not_pdf", { n: files.length - pdfs.length }));
		if (pdfs.length) sendUploads(pdfs);
	});
	document.addEventListener("change", async (e) => {
		const t = e.target;
		if (t.matches("[data-action=upload-pick]")) {
			const files = [...(t.files || [])];
			t.value = "";
			if (files.length) sendUploads(files);
			return;
		}
		if (t.matches("[data-action=reimb]")) {
			const want = t.checked;
			t.disabled = true;
			const done = await setReimb(t, want);
			if (!done) { t.checked = !want; t.disabled = false; }
		}
	});
	document.addEventListener("input", (e) => {
		if (e.target.matches("[data-cat-find]") && CAT_PICK) $("#sheet .cat-list").innerHTML = catRows(e.target.value);
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && e.target.matches("[data-cm-name]")) {
			e.preventDefault();
			if (!e.isComposing) $("#sheet [data-action=cm-rename]")?.click();
			return;
		}
		// Enter in the category field takes the first row: 新增 a new name, or the one match.
		if (e.key === "Enter" && e.target.matches("[data-cat-find]")) {
			e.preventDefault();
			if (!e.isComposing && e.target.value.trim()) $("#sheet .cat-list .cat-row")?.click();
			return;
		}
		if (e.key === "Enter" && e.target.matches("#ln-filters input[name=q]")) {
			const { q } = hash();
			q.set("m", state.month);
			const v = e.target.value.trim();
			q.delete("p");
			if (v) q.set("q", byteCap(v, 44)); else q.delete("q");
			go("lines", q);
		}
		if (e.key === "Escape") hideTip();
	});
	document.addEventListener("search", (e) => { if (e.target.matches("#ln-filters input[name=q]") && !e.target.value) { const { q } = hash(); q.delete("q"); go("lines", q); } }, true);
	document.addEventListener("submit", async (e) => {
		if (e.target.id === "cash-form") return submitCash(e);
		if (e.target.id === "range-form") {
			e.preventDefault();
			const f = e.target, err = $("#range-error");
			const from = f.from.value, to = f.to.value;
			if (!from || !to) { err.textContent = say("rb.need_dates"); err.hidden = false; return; }
			if (from > to) { err.textContent = say("demo.end_before_start"); err.hidden = false; return; }
			err.hidden = true;
			try {
				const r = await api("/api/reimbursable-ranges", { method: "POST", body: { from, to, note: f.note.value.trim() || undefined } });
				toast(say("toast.range_added", { range: frange(from, to), n: r.count ?? r.affected_lines ?? 0 }));
				route();
			} catch (x) {
				if (x.status === 401) return showLocked();
				err.textContent = say("toast.not_added", { why: x.message }); err.hidden = false;
			}
		}
	});
	$("#cash-form").addEventListener("input", (e) => {
		if (e.target.name !== "quick") return;
		const f = e.currentTarget, p = parseQuick(e.target.value);
		f.merchant.value = p.merchant;
		f.amount.value = p.amount;
		if (p.currency) f.currency.value = p.currency;
	});

	// ---------------------------------------------------------------- theme (a per-viewer convenience)
	function applyTheme(t) { if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
	function cycleTheme() {
		const cur = document.documentElement.dataset.theme || "auto";
		const next = { auto: "dark", dark: "light", light: "auto" }[cur];
		applyTheme(next);
		try { localStorage.setItem("ledger-theme", next); } catch { /* private mode */ }
		toast(say("theme." + next));
	}

	// ---------------------------------------------------------------- boot
	/// The demo's made-up data is Singapore's. For another home (&home=EUR), the same figures are
	/// told in that currency — a neutral variant, made up either way; nothing is converted.
	function rehome(node) {
		if (Array.isArray(node)) { node.forEach(rehome); return; }
		if (!node || typeof node !== "object") return;
		for (const [k, v] of Object.entries(node)) {
			if (k === "currency" && v === "SGD") node[k] = HC;
			else if (typeof v === "string" && v.includes("SGD")) node[k] = v.replace(/\bSGD\b/g, HC);
			else rehome(v);
		}
	}
	function loadScript(src) {
		return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
	}
	/// The page's shell (index.html) carries English as written; its words come from the catalogue
	/// like everything else: data-say (text), data-say-aria / -title / -placeholder (attributes).
	function paintWords(root = document) {
		root.querySelectorAll("[data-say]").forEach((el) => { el.textContent = say(el.dataset.say); });
		for (const [attr, key] of [["aria-label", "sayAria"], ["title", "sayTitle"], ["placeholder", "sayPlaceholder"]]) root.querySelectorAll(`[data-say-${attr === "aria-label" ? "aria" : attr}]`).forEach((el) => el.setAttribute(attr, say(el.dataset[key])));
		document.title = say("app.name");
		const apple = document.querySelector('meta[name="apple-mobile-web-app-title"]');
		if (apple) apple.setAttribute("content", say("app.name"));
		$("#cash-hint").textContent = CASH_HINT;
	}
	async function boot() {
		paintWords();
		try { applyTheme(localStorage.getItem("ledger-theme")); } catch { /* no storage */ }
		const sel = $("#cash-form").currency;
		sel.innerHTML = CURRENCIES.map((c) => `<option value="${c}">${c}${sym(c) !== c ? " " + sym(c) : ""}</option>`).join("");
		paintIcons();
		if (FIXTURES) {
			window.LEDGER_DEMO_LANG = LANG; // the made-up data's words follow the page's language
			try { await loadScript("fixtures/all.js"); await loadScript("fixtures/round2.js"); await loadScript("fixtures/wallet.js"); } catch { /* handled below */ }
			FX = window.LEDGER_FIXTURES || null;
			if (FX && HC !== "SGD") rehome(FX.routes);
			if (!FX) { $view.innerHTML = failCard(say("demo.data"), new LoadError(say("demo.no_fixtures"), 0)); paintIcons($view); return; }
			DB = JSON.parse(JSON.stringify(FX.routes));
			$("#demo").hidden = false;
		}
		// The three reads every tab leans on, asked together (they used to wait for one another).
		const [acc, cat] = await Promise.allSettled([api("/api/accounts"), api("/api/categories"), loadTrips()]);
		if (acc.status === "fulfilled") learnAccounts(acc.value.accounts);
		else if (acc.reason && acc.reason.status === 401) return showLocked(); /* else names fall back to other sources */
		if (cat.status === "fulfilled") { CATS = cat.value.categories || []; CAT_WAS = cat.value.was || {}; } /* else no picker; categories still show */
		addEventListener("hashchange", () => { closeSheet(); route(); });
		$("#sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSheet(); }); // a tap on the dimmed backdrop
		// A category renamed or deleted in 編輯: the tab behind redraws once the sheet has gone.
		$("#sheet").addEventListener("close", () => {
			CAT_MANAGE = null;
			if (!CAT_DIRTY) return;
			CAT_DIRTY = false;
			setTimeout(() => Promise.resolve(SAVING).finally(() => route()), 0); // after a pick's save has started, and landed
		});
		// iPhone Safari shows a pressed state (:active) only on a page listening for touchstart.
		document.addEventListener("touchstart", () => {}, { passive: true });
		// Escape slides a dialog away like every other close, instead of the browser's instant one.
		for (const d of [$("#sheet"), $("#cash")]) d.addEventListener("cancel", (e) => { e.preventDefault(); hideDialog(d); });
		route().then(() => { if (!LOCKED) prefetch(); });
		refreshBadge();
		api("/api/subscriptions").then((r) => learnSubs(r.subscriptions), () => { /* 明細 just offers 設為訂閱 */ });
	}
	boot();
})();
