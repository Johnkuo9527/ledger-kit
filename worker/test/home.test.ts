/// The worker and the owner's home (src/home.ts): every door refuses until the
/// home is set, the page is told it, and a ledger never changes its currency
/// under its own figures.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../../test/helpers/sqlite-db";
import { setHome, SINGAPORE } from "../../src/home";
import { handleRequest, type App } from "../src/app";
import type { Step } from "../src/tick";
import { runTick } from "../src/tick";
import { CTX, get, makeDeps, makeEnv, PAGE_TELL, seedWorld, signedIn, TEST_ASSETS } from "./helpers/harness";

let db: TestDb;
let app: App & { deps: ReturnType<typeof makeDeps> };
beforeEach(async () => {
	db = freshDb();
	await seedWorld(db);
	app = { assets: TEST_ASSETS, deps: makeDeps() };
});
afterEach(() => {
	db.close();
	setHome(SINGAPORE);
});

const asOwner = async (path: string) => get(path, await signedIn());

describe("a worker not given its home", () => {
	it("refuses every door with what to set, and never opens the page", async () => {
		const env = makeEnv(db, { LEDGER_HOME_CURRENCY: undefined, LEDGER_TIMEZONE: "Mars/Olympus" });
		const res = await handleRequest(await asOwner("/"), env, CTX, app);
		expect(res.status).toBe(503);
		const body = await res.text();
		expect(body).toMatch(/LEDGER_HOME_CURRENCY/);
		expect(body).toMatch(/LEDGER_TIMEZONE/);
		expect(body).not.toContain(PAGE_TELL);
		const tap = await handleRequest(new Request("https://ledger.test.workers.dev/api/shortcut/tap", { method: "POST", body: "{}" }), env, CTX, app);
		expect(tap.status).toBe(503);
	});

	it("does not tick", async () => {
		let ran = false;
		const step: Step = { name: "x", run: async () => void (ran = true) };
		const r = await runTick(makeEnv(db, { LEDGER_HOME_COUNTRY: "" }), makeDeps(), {}, [step]);
		expect(r.ran).toBe(false);
		expect(ran).toBe(false);
	});
});

describe("the page", () => {
	it("is told the home in a meta tag (no inline script)", async () => {
		const env = makeEnv(db, { LEDGER_HOME_CURRENCY: "EUR", LEDGER_TIMEZONE: "Europe/Berlin", LEDGER_HOME_COUNTRY: "DE" });
		const res = await handleRequest(await asOwner("/"), env, CTX, app);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain(PAGE_TELL);
		expect(body).toContain(`<meta name="ledger-home" content="{&quot;currency&quot;:&quot;EUR&quot;,&quot;time_zone&quot;:&quot;Europe/Berlin&quot;,&quot;country&quot;:&quot;DE&quot;,&quot;language&quot;:&quot;zh-Hant&quot;}">`);
	});
});

describe("the home currency is the ledger's for good", () => {
	it("the first working tick records it; a changed LEDGER_HOME_CURRENCY stops the tick with an alarm until it is put back", async () => {
		const deps = makeDeps();
		let runs = 0;
		const work: Step = { name: "work", run: async (t) => { runs++; t.count("x"); } };
		await runTick(makeEnv(db), deps, {}, [work]);
		expect(db.raw.prepare("SELECT value FROM sync_state WHERE key = 'home_currency'").get()).toEqual({ value: "SGD" });
		deps.advance(60_000);
		await runTick(makeEnv(db, { LEDGER_HOME_CURRENCY: "USD", LEDGER_TIMEZONE: "America/New_York", LEDGER_HOME_COUNTRY: "US" }), deps, {}, [work]);
		expect(runs).toBe(1);
		const alarm = db.raw.prepare("SELECT message FROM alarms WHERE key = 'home_changed' AND cleared_at IS NULL").get() as { message: string };
		expect(alarm.message).toMatch(/now USD, but this ledger's amounts are all in SGD/);
		deps.advance(60_000);
		await runTick(makeEnv(db), deps, {}, [work]);
		expect(runs).toBe(2);
		expect(db.raw.prepare("SELECT cleared_at FROM alarms WHERE key = 'home_changed'").get()).not.toEqual({ cleared_at: null });
	});
});
