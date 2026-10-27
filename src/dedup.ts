/// Three layers stop one purchase being counted twice:
///
///   1. messages.gmail_id — a Gmail message is processed once, ever.
///   2. evidence UNIQUE(type, fingerprint) — the same fact arriving in two
///      different emails (a bank re-sending an alert, a receipt forwarded to
///      himself) is stored once. The fingerprints are below.
///   3. matching (src/matching.ts) — an alert, a receipt and a statement line
///      for one purchase attach to ONE ledger line as evidence.
///
/// And one email is never evidence at all: the ledger's own weekly summary,
/// which is full of merchants and amounts and would otherwise read as receipts.

import { merchantKey } from "./merchant";

export interface AlertFacts {
	institution: string;
	last4: string | null;
	currency: string;
	amount_minor: number;
	txn_date: string;
	txn_time: string | null;
	merchant_raw: string | null;
}

/// Same bank, card, amount, merchant and minute → the same alert.
///
/// Without a time, two genuine identical purchases on one day would collapse
/// into one. That is accepted on purpose: the statement then brings the second
/// one in as "missed by alerts", so the ledger heals itself. The other way
/// round (keying on the message id) would double-count every re-sent alert.
export function alertFingerprint(f: AlertFacts): string {
	return [
		"alert",
		f.institution,
		f.last4 ?? "-",
		f.currency,
		f.amount_minor,
		f.txn_date,
		f.txn_time ?? "-",
		merchantKey(f.merchant_raw),
	].join("|");
}

/// A receipt with an order number is the same receipt wherever it came from;
/// without one, only the Gmail message identifies it.
export function receiptFingerprint(senderDomain: string, orderId: string | null | undefined, messageId: string): string {
	return orderId ? `receipt|${senderDomain.toLowerCase()}|${orderId.trim()}` : `receipt|msg|${messageId}`;
}

/// Two identical statement lines (two $4.50 coffees) are two purchases, so
/// the line's position on its statement is part of its identity.
export function statementLineFingerprint(statementId: string, seq: number): string {
	return `stmt|${statementId}|${seq}`;
}

export function manualFingerprint(id: string): string {
	return `manual|${id}`;
}

// ------------------------------------------------- the weekly summary email

/// The worker stamps every summary it sends with BOTH of these. the daily engine must
/// send them; this file is their single definition.
export const SUMMARY_HEADER = "X-Ledger-Summary";
export const SUMMARY_MARKER = "ledger-weekly-summary:v1";

export interface InboundMessage {
	from: string; // raw From header, e.g. 'Ledger <ledger@example.com>'
	subject: string;
	headers: Readonly<Record<string, string>>;
	body: string; // plain-text body (or HTML; the marker is matched as text)
}

export function emailAddress(fromHeader: string): string {
	const angle = /<([^>]+)>/.exec(fromHeader);
	return (angle?.[1] ?? fromHeader).trim().toLowerCase();
}

/// True for the ledger's own summary — sent, forwarded, or replied to.
///   * the header: the original as delivered;
///   * the sender: the worker's own From address;
///   * the marker in the body: survives forwarding and quoting, where both of
///     the above are lost.
/// The subject alone is never enough — the owner could title anything "Ledger".
export function isOwnSummary(message: InboundMessage, summaryFrom: string): boolean {
	const hasHeader = Object.keys(message.headers).some((h) => h.toLowerCase() === SUMMARY_HEADER.toLowerCase());
	if (hasHeader) return true;
	if (summaryFrom && emailAddress(message.from) === summaryFrom.trim().toLowerCase()) return true;
	return message.body.includes(SUMMARY_MARKER);
}
