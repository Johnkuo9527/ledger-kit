/// POST /api/shortcut/tap — the owner's iPhone reports each Apple Pay tap
/// (CONTRACT.md §6.6). Its own key, LEDGER_SHORTCUT_KEY, not the page's: it
/// lives inside a Shortcut on the phone, so a lost phone is cut off by rotating
/// it, without locking the owner out of his page.
///
///   200 {ok:true, status:"created"|"attached"|"duplicate"|"held", line_id|null, message}
///   400 {ok:false, message}            the tap could not be read (says which field)
///   401 {ok:false, message:"not authorised"}
///
/// A tap from a Wallet card name the ledger does not know is HELD and escalated
/// — never guessed onto a card. Naming the card on the page (POST
/// /api/wallet-names) re-tries every held tap.
///
/// `message` is one plain sentence the Shortcut can show as a notification.

import { say } from "../../src/words";
import { ingestTap } from "../../src/engine";
import { formatMoney } from "../../src/money";
import { shortcutAuthorised } from "../../src/shortcut";
import type { Deps, LedgerEnv } from "./env";
import { fail, HttpError, ok, readJsonObject } from "./http";
import { makeOp } from "./ops";

/// A tap is a few hundred bytes; anything near this is not a tap.
export const TAP_MAX_BYTES = 8 * 1024;

export async function tapRoute(request: Request, env: LedgerEnv, deps: Deps): Promise<Response> {
	if (request.method !== "POST") return fail(405, say("tap.use_post"), { Allow: "POST" });
	// The key first: a stranger learns nothing, not even whether the body was good.
	if (!(await shortcutAuthorised(request.headers.get("Authorization"), env.LEDGER_SHORTCUT_KEY))) return fail(401, say("sms.not_authorised"));
	let body: Record<string, unknown>;
	try {
		body = await readJsonObject(request, TAP_MAX_BYTES);
	} catch (e) {
		if (e instanceof HttpError) return fail(400, e.message);
		throw e;
	}
	const op = await makeOp(env, deps, "rules");
	const r = await ingestTap(op.engine, body);
	if (r.status === "refused") return fail(400, r.message);
	if (r.status === "created" || r.status === "attached") {
		const row = await op.db
			.prepare("SELECT l.merchant_name, l.orig_minor, l.orig_currency, a.name AS account FROM lines l JOIN accounts a ON a.id = l.account_id WHERE l.id = ?")
			.bind(r.line_id)
			.first<{ merchant_name: string | null; orig_minor: number; orig_currency: string; account: string }>();
		const what = row ? say("tap.what", { merchant: row.merchant_name ?? say("tap.purchase"), amount: formatMoney(row.orig_minor, row.orig_currency), account: row.account }) : say("tap.the_purchase");
		return ok({ status: r.status, line_id: r.line_id, message: say(r.status === "created" ? "tap.recorded" : "tap.attached", { what }) });
	}
	if (r.status === "duplicate") return ok({ status: "duplicate", line_id: null, message: say("tap.duplicate") });
	return ok({ status: "held", line_id: null, message: say("tap.held") });
}
