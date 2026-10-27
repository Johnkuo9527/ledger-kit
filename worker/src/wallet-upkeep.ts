/// The wallet's net (14 Oct 2026): every write to a GrabPay line
/// already tidies the wallet at once (engine.ts tidyWallet — its top-up legs
/// and the offsets for the balance already counted at top-up). Two writes at
/// the same moment (the connector and the cron) could each work the offsets out
/// from what it saw; this step works them out again once an hour, so any such
/// slip lasts an hour at most. Cheap: a few queries, and nothing written when
/// nothing differs.

import { loadAccounts, tidyWallet } from "../../src/engine";
import { isWallet } from "../../src/wallet";
import { engineFor } from "./pipeline";
import type { Step } from "./tick";

export const WALLET_TIDY_EVERY_MS = 3_600_000;

export const walletTidy: Step = {
	name: "wallet_tidy",
	async run(t) {
		const last = t.get<string>("wallet_tidy_at");
		if (last && t.now().getTime() - new Date(last).getTime() < WALLET_TIDY_EVERY_MS) return;
		if (!t.room(40)) return;
		const wallets = (await loadAccounts(t.db)).filter(isWallet);
		const engine = engineFor(t, await t.head(), "rules");
		for (const w of wallets) await tidyWallet(engine, w);
		await t.put("wallet_tidy_at", t.iso()).run();
	},
};
