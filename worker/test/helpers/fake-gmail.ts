/// A made-up mailbox standing in for Gmail in the engine's tests. It honours
/// the `after:` / `before:` epochs of a search (so the backfill's month-by-
/// month listing is real), pages its answers, and can be told to fail.

import { emailAddress } from "../../../src/dedup";
import { domainOf } from "../../src/banks";
import { GmailError, type Mail } from "../../src/gmail";
import type { MailSource } from "../../src/tick";

/// A made-up message. Unless the test says otherwise (`auth: []` = a spoof),
/// Gmail vouches for its sender's own domain, as it does for real bank mail.
export function mail(over: Partial<Mail> & Pick<Mail, "id">): Mail {
	const m = { thread_id: null, from: "Bank <alerts@dbs.com>", subject: "Card transaction alert", headers: {}, received_at: "2026-10-08T02:00:00.000Z", text: "", pdfs: [], ...over };
	return { ...m, auth: over.auth ?? [domainOf(emailAddress(m.from))] };
}

export class FakeGmail implements MailSource {
	messages = new Map<string, Mail>();
	attachments = new Map<string, Uint8Array>();
	pageSize = 100;
	fail: GmailError | null = null;
	calls = { list: 0, message: 0, attachment: 0 };
	queries: string[] = [];

	add(...ms: Mail[]): this {
		for (const m of ms) this.messages.set(m.id, m);
		return this;
	}

	async list(q: string, pageToken?: string, max = 100): Promise<{ ids: string[]; next: string | null }> {
		this.calls.list++;
		this.queries.push(q);
		if (this.fail) throw this.fail;
		const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
		const before = Number(/before:(\d+)/.exec(q)?.[1] ?? 9e12) * 1000;
		const ids = [...this.messages.values()]
			.filter((m) => {
				const at = new Date(m.received_at).getTime();
				return at >= after && at < before;
			})
			.sort((a, b) => b.received_at.localeCompare(a.received_at) || a.id.localeCompare(b.id))
			.map((m) => m.id);
		const size = Math.min(max, this.pageSize);
		const start = Number(pageToken ?? 0);
		const slice = ids.slice(start, start + size);
		return { ids: slice, next: start + size < ids.length ? String(start + size) : null };
	}

	async message(id: string): Promise<Mail> {
		this.calls.message++;
		if (this.fail) throw this.fail;
		const m = this.messages.get(id);
		if (!m) throw new GmailError("refused", `no message ${id}`);
		return m;
	}

	async attachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
		this.calls.attachment++;
		if (this.fail) throw this.fail;
		const a = this.attachments.get(`${messageId}/${attachmentId}`);
		if (!a) throw new GmailError("refused", "no attachment");
		return a;
	}
}
