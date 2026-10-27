/// A bank that goes quiet (18 Oct 2026). DBS's alert emails stopped
/// reaching the ledger after 13 Oct and nothing said so for five days: every
/// other alarm watches mail that ARRIVED, none watches mail that never came.
///
/// So, every few hours: a bank the owner's accounts expect alerts from
/// (accounts.alerts_expected = 1 — DBS, HSBC, Citi; never 台新) whose last
/// alert email arrived SILENT_DAYS or more ago, while the ledger has seen other
/// activity on his accounts in those days (another bank's alert, an Apple Pay
/// tap), raises `alerts_silent:<BANK>` on his page, in Chinese. It clears the
/// moment an alert of that bank is read (pipeline.ts ingestRead), and at the
/// next look once the bank is no longer quiet.
///
/// One query each time it looks, at most once every SILENCE_EVERY_MS. Times are
/// when the email ARRIVED (messages.received_at), so mail read late — the
/// catch-up, a backfill — is never mistaken for a bank speaking today.

import { say } from "../../src/words";
import { daysBetween } from "../../src/dates";
import { localDate } from "../../src/home";
import type { Step, Tick } from "./tick";
import { todaysMailPhase } from "./pull";

export const SILENT_DAYS = 3;
export const SILENCE_EVERY_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

export const silenceKey = (institution: string) => `alerts_silent:${institution.toUpperCase()}` as const;

/// `name`: how the owner calls the bank (his bank list's name, BankList.label).
export function silenceMessage(institution: string, days: number, name = institution.toUpperCase()): string {
	return say("alarm.alerts_silent", { name, n: days });
}

interface Quiet {
	institution: string;
	own_at: string | null;
	other_at: string | null;
}

/// Per bank that should alert: its last alert email, and the last other activity.
export async function bankQuiet(t: Pick<Tick, "db">): Promise<Quiet[]> {
	return (
		await t.db
			.prepare(
				"SELECT b.institution AS institution, " +
					"MAX(CASE WHEN e.type = 'alert' AND e.institution = b.institution THEN COALESCE(m.received_at, e.created_at) END) AS own_at, " +
					"MAX(CASE WHEN e.type = 'apple_pay_shortcut' OR (e.type = 'alert' AND COALESCE(e.institution, '') <> b.institution) THEN COALESCE(m.received_at, e.created_at) END) AS other_at " +
					"FROM (SELECT DISTINCT institution FROM accounts WHERE alerts_expected = 1 AND active = 1) b " +
					"LEFT JOIN evidence e ON e.type IN ('alert', 'apple_pay_shortcut') LEFT JOIN messages m ON m.gmail_id = e.message_id " +
					"GROUP BY b.institution ORDER BY b.institution",
			)
			.bind()
			.all<Quiet>()
	).results;
}

export const alertSilence: Step = {
	name: "alert_silence",
	async run(t) {
		// While mail does not flow (before the backfill reaches today, Gmail
		// signed out), quiet is expected and another alarm already says why.
		if (!todaysMailPhase(t) || !t.svc.gmail || t.gmailStopped || t.isOpen("google_signin") || t.isOpen("mail_check_late") || !t.room(4)) return;
		const last = t.get<string>("alert_silence_at");
		if (last && t.now().getTime() - new Date(last).getTime() < SILENCE_EVERY_MS) return;
		t.putLater("alert_silence_at", t.iso());
		const now = t.now().getTime();
		for (const q of await bankQuiet(t)) {
			const key = silenceKey(q.institution);
			// A bank never heard from at all is not "gone quiet" (a new install, a new bank).
			const quiet = q.own_at !== null && now - new Date(q.own_at).getTime() >= SILENT_DAYS * DAY_MS;
			const othersActive = q.other_at !== null && now - new Date(q.other_at).getTime() < SILENT_DAYS * DAY_MS;
			if (quiet && othersActive) {
				// Said in calendar days, as the owner counts them: last heard 13 Oct, today 18 Oct = 5 days.
				t.raise(key, silenceMessage(q.institution, daysBetween(localDate(new Date(q.own_at!)), t.today()), t.banks().label(q.institution)));
				t.count("alerts_silent");
			} else t.clear(key);
		}
	},
};
