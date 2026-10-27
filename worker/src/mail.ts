/// Sending an email through Resend — the sign-in code here, and the seam the daily engine's
/// weekly summary uses (it adds the X-Ledger-Summary header, src/dedup.ts).
///
/// Resend's shared test sender (onboarding@resend.dev) only delivers to the
/// Resend account owner's own address. The ledger only ever emails the owner, so
/// that is enough until a domain is verified; LEDGER_MAIL_FROM changes it.
/// It compares that address case-sensitively (a capitalised
/// LEDGER_OWNER_EMAIL was refused with a 403), so the recipient is lowercased.

import { normalizeEmail } from "./codes";
import type { Deps, LedgerEnv } from "./env";

export const DEFAULT_FROM = "Ledger <onboarding@resend.dev>";

export interface Mail {
	to: string;
	subject: string;
	text: string;
	headers?: Record<string, string>;
}

export type MailResult = "sent" | "not_configured" | "failed";

export async function sendMail(env: LedgerEnv, deps: Deps, mail: Mail): Promise<MailResult> {
	if (!env.RESEND_API_KEY) return "not_configured";
	try {
		const res = await deps.fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
			body: JSON.stringify({ from: env.LEDGER_MAIL_FROM || DEFAULT_FROM, to: [normalizeEmail(mail.to) ?? mail.to], subject: mail.subject, text: mail.text, ...(mail.headers ? { headers: mail.headers } : {}) }),
		});
		if (!res.ok) {
			console.error(`resend refused the email: ${res.status}`);
			return "failed";
		}
		return "sent";
	} catch (e) {
		console.error("resend could not be reached", e);
		return "failed";
	}
}
