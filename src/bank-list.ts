/// The owner's banks: which institutions are his, and which mail domains each
/// one sends from. It is DATA, chosen at install (seed/accounts.json "banks",
/// docs/accounts.md), loaded into sync_state['banks'] by the seed SQL — never a
/// code edit, so anyone anywhere adds their own bank.
///
/// Threat model: anyone can email the owner. A mail counts as a bank's only
/// when BOTH hold (worker/src/banks.ts, read.ts):
///   1. its From domain is on this list (a domain, or a sub-domain of one), and
///   2. Gmail's own Authentication-Results vouches (DMARC/DKIM pass) for a
///      domain of that SAME bank.
/// Being on the list is not being trusted: the list also decides what the Gmail
/// search looks for, and listing is never trusting.

export interface BankEntry {
	/// The id the owner's accounts use in "institution" (lower case: "dbs", "thames").
	institution: string;
	/// How the owner calls it ("DBS", "Thames Bank"): alarms and the page say this.
	name: string;
	/// Every domain the bank sends alerts and statements from ("dbs.com", "posb.com.sg").
	domains: string[];
	/// Words its alert mail's sender NAME uses even when the address is not one of
	/// its domains ("iBanking Alerts", "digibank"): searched for in Gmail, and a
	/// transaction alert naming them from an unknown address raises an alarm.
	sender_names?: string[];
	/// false: this bank emails its statement PDFs WITHOUT a password. By default
	/// an unlocked "statement" is refused (every bank the kit started with locks
	/// them, so an unlocked one is someone else's document); the owner's word here
	/// lets his bank's unlocked statements be read — still only from mail Gmail
	/// vouched for as that bank's.
	pdf_password?: boolean;
}

export const BANKS_KEY = "banks";

/// Public mailbox providers: a whole one of these is never a bank's, nor a "sender".
export const FREEMAIL = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "qq.com", "163.com", "yahoo.com.tw", "singnet.com.sg"];

/// The domain of an address, "@domain" or bare domain (lower case).
export function domainOf(sender: string): string {
	const s = sender.trim().toLowerCase();
	return s.startsWith("@") ? s.slice(1) : s.includes("@") ? s.split("@").pop()! : s;
}

export const within = (d: string, base: string): boolean => d === base || d.endsWith(`.${base}`);

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const ID = /^[a-z0-9][a-z0-9_-]*$/;
const WORD = /^[\p{L}\p{N}]+$/u;
/// Institution ids the ledger uses for things that are not banks.
const RESERVED = ["cash", "other", "grab"];

/// Every reason this bank list is unsafe to use. Empty = fine.
export function bankListProblems(banks: unknown): string[] {
	if (!Array.isArray(banks)) return ['"banks" must be a list (it may be empty: [])'];
	const out: string[] = [];
	const ids = new Set<string>();
	const owner = new Map<string, string>();
	for (const [i, b] of banks.entries()) {
		const where = `banks[${i}]`;
		if (typeof b !== "object" || b === null) {
			out.push(`${where}: must be { institution, name, domains }`);
			continue;
		}
		const e = b as Partial<BankEntry>;
		if (typeof e.institution !== "string" || !ID.test(e.institution)) out.push(`${where}: institution must be a short lower-case id such as "dbs" or "thames"`);
		else if (RESERVED.includes(e.institution)) out.push(`${where}: "${e.institution}" is not a bank's id`);
		else if (ids.has(e.institution)) out.push(`${where}: ${e.institution} is listed twice`);
		else ids.add(e.institution);
		if (typeof e.name !== "string" || !e.name.trim()) out.push(`${where}: name is empty`);
		if (!Array.isArray(e.domains) || !e.domains.length) out.push(`${where}: domains must list at least one mail domain, e.g. ["examplebank.com"]`);
		for (const d of Array.isArray(e.domains) ? e.domains : []) {
			const dom = typeof d === "string" ? d.trim().toLowerCase() : "";
			if (!DOMAIN.test(dom)) out.push(`${where}: "${String(d)}" is not a plain domain such as examplebank.com (no @, no spaces)`);
			else if (FREEMAIL.some((f) => within(dom, f) || within(f, dom))) out.push(`${where}: ${dom} is a public mailbox provider, never a bank's own domain`);
			else if (owner.has(dom) && owner.get(dom) !== e.institution) out.push(`${where}: ${dom} already belongs to ${owner.get(dom)}`);
			else owner.set(dom, String(e.institution));
		}
		if (e.pdf_password !== undefined && typeof e.pdf_password !== "boolean") out.push(`${where}: pdf_password must be true or false`);
		if (e.sender_names !== undefined && (!Array.isArray(e.sender_names) || e.sender_names.some((w) => typeof w !== "string" || !WORD.test(w)))) out.push(`${where}: sender_names must be single words, e.g. ["iBanking", "digibank"]`);
	}
	return out;
}

/// The list in the shape the worker keeps (lower-case domains, trimmed names).
export function normaliseBanks(banks: readonly BankEntry[]): BankEntry[] {
	return banks.map((b) => ({
		institution: b.institution,
		name: b.name.trim(),
		domains: [...new Set(b.domains.map((d) => d.trim().toLowerCase()))],
		...(b.sender_names?.length ? { sender_names: b.sender_names.map((w) => w.trim()) } : {}),
		...(b.pdf_password === false ? { pdf_password: false } : {}),
	}));
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/// The owner's banks as the worker asks about them. Built from sync_state's
/// stored list; an entry that does not pass bankListProblems is left out (so a
/// broken row can only trust LESS, never more).
export class BankList {
	readonly entries: readonly BankEntry[];

	constructor(entries: readonly BankEntry[]) {
		this.entries = entries;
	}

	/// From the stored JSON (sync_state['banks']), whatever state it is in.
	static from(raw: unknown): BankList {
		let list: unknown = raw;
		if (typeof raw === "string") {
			try {
				list = JSON.parse(raw);
			} catch {
				list = [];
			}
		}
		if (!Array.isArray(list)) return new BankList([]);
		const good = list.filter((b) => bankListProblems([b]).length === 0) as BankEntry[];
		// A domain claimed by two entries trusts neither (the seed check refuses it; this is the net).
		const seen = new Map<string, number>();
		for (const b of good) for (const d of new Set(b.domains.map((x) => x.toLowerCase()))) seen.set(d, (seen.get(d) ?? 0) + 1);
		const ids = new Set<string>();
		const clean = normaliseBanks(good)
			.filter((b) => !ids.has(b.institution) && ids.add(b.institution))
			.map((b) => ({ ...b, domains: b.domains.filter((d) => seen.get(d) === 1) }))
			.filter((b) => b.domains.length);
		return new BankList(clean);
	}

	get isEmpty(): boolean {
		return this.entries.length === 0;
	}

	/// The bank whose domain (or a sub-domain of it) this is; null = not one of his banks.
	bankOfDomain(domain: string): string | null {
		const d = domain.trim().toLowerCase();
		if (!d) return null;
		for (const b of this.entries) if (b.domains.some((x) => within(d, x))) return b.institution;
		return null;
	}

	/// Is this mail really from one of his banks? Its From domain is that bank's,
	/// AND Gmail vouches (DMARC or DKIM pass) for a domain of that SAME bank.
	authenticated(fromAddr: string, auth: readonly string[]): string | null {
		const bank = this.bankOfDomain(domainOf(fromAddr));
		if (!bank) return null;
		return auth.some((a) => this.bankOfDomain(a) === bank) ? bank : null;
	}

	/// Would a sender pattern cover (or sit inside) any of his banks' mail, or any
	/// of the given known bank senders? "com", "@dbs.com", "x.hsbc.com.sg" all do.
	touches(pattern: string, knownBankSenders: readonly string[] = []): boolean {
		const d = domainOf(pattern);
		if (!d) return true;
		const banks = [...this.entries.flatMap((b) => b.domains), ...knownBankSenders.map(domainOf).filter(Boolean)];
		return banks.some((b) => within(d, b) || within(b, d));
	}

	/// Every domain the Gmail search must always ask for.
	searchDomains(): string[] {
		return [...new Set(this.entries.flatMap((b) => b.domains))];
	}

	/// Sender-name words for the Gmail search (plain ASCII words only: anything
	/// else could change what the search means).
	searchNames(): string[] {
		return [...new Set(this.entries.flatMap((b) => b.sender_names ?? []).map((w) => w.toLowerCase()).filter((w) => /^[a-z0-9]+$/.test(w)))];
	}

	/// The bank a sender's NAME speaks for ("HSBC Transaction Alerts",
	/// "iBanking Alerts", "台新銀行"): its id, its name's words and its sender
	/// names, each at the start of a word (a non-Latin word anywhere). null = none.
	namedIn(text: string): string | null {
		for (const b of this.entries) {
			const words = [b.institution, ...b.name.split(/[\s/,&()·-]+/), ...(b.sender_names ?? [])].filter((w) => w && w.length >= 2 && !/^(?:bank|the|of|and)$/i.test(w));
			for (const w of words) {
				const re = /^[\x20-\x7e]+$/.test(w) ? new RegExp(`(?:^|[^a-z0-9])${escapeRe(w)}`, "i") : new RegExp(escapeRe(w), "u");
				if (re.test(text)) return b.institution;
			}
		}
		return null;
	}

	/// Does this bank email its statements as UNLOCKED PDFs (the owner said so)?
	sendsUnlockedPdfs(institution: string | null): boolean {
		return !!institution && this.entries.some((b) => b.institution === institution && b.pdf_password === false);
	}

	/// How the owner calls a bank (its name on his list), else its id in capitals.
	label(institution: string): string {
		return this.entries.find((b) => b.institution === institution)?.name ?? institution.toUpperCase();
	}
}

/// A sender pattern too broad to ever name one sender: a bare top-level
/// domain, or a whole public mailbox provider (an exact address is fine).
export function tooBroad(pattern: string): boolean {
	const p = pattern.trim().toLowerCase();
	const exact = p.includes("@") && !p.startsWith("@");
	const d = domainOf(p);
	if (!d.includes(".")) return true;
	return !exact && FREEMAIL.some((f) => within(d, f));
}
