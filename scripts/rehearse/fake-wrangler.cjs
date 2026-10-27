#!/usr/bin/env node
// A FAKE wrangler, for rehearsing scripts/setup.sh without Cloudflare (scripts/rehearse/rehearse-setup.py).
// The wizard uses it when LEDGER_SETUP_WRANGLER names it:
//   LEDGER_SETUP_WRANGLER="node --no-warnings scripts/rehearse/fake-wrangler.cjs" bash scripts/setup.sh
//
// No network. Its "Cloudflare account" is a folder, $FAKE_STATE (state.json, d1.sqlite, wrangler.log):
//   - the log keeps every call's arguments and whether stdin/stdout were a terminal; for `secret put`
//     only the secret's NAME and its value's LENGTH, never the value;
//   - D1 is real SQLite (node:sqlite), so the migrations and the seed SQL really run against the schema;
//   - a brand-new account has NO workers.dev subdomain. `deploy` then behaves as wrangler 4.105 does
//     (wrangler-dist/cli.js getWorkersDevSubdomain + confirm): it asks to register one only when stdin
//     AND stdout are a terminal; otherwise it says "Using fallback value in non-interactive context: no"
//     and fails with the onboarding link. FAKE_SUBDOMAIN_REGISTERED=<name> stands for the owner having
//     chosen one in the dashboard meanwhile.
//   - `deploy` appends wrangler's own record to $WRANGLER_OUTPUT_FILE_PATH when it is set, as wrangler does
//     ({"type":"deploy", "targets":[…]}).
const fs = require("fs");
const path = require("path");

const STATE = process.env.FAKE_STATE;
if (!STATE) {
	console.error("fake-wrangler: set FAKE_STATE to a folder for the fake account");
	process.exit(2);
}
fs.mkdirSync(STATE, { recursive: true });
const stFile = path.join(STATE, "state.json");
const st = fs.existsSync(stFile) ? JSON.parse(fs.readFileSync(stFile, "utf8")) : { loggedIn: false, secrets: {}, d1: null, kv: null, subdomain: null, applied: [], deploys: 0 };
const save = () => fs.writeFileSync(stFile, JSON.stringify(st, null, 2));
const argv = process.argv.slice(2);
const tty = { stdin: !!process.stdin.isTTY, stdout: !!process.stdout.isTTY };
const log = (extra = "") =>
	fs.appendFileSync(path.join(STATE, "wrangler.log"), `stdinTTY=${tty.stdin} stdoutTTY=${tty.stdout} :: wrangler ${argv.join(" ")} ${extra}\n`);

const flag = (n) => {
	const i = argv.indexOf(n);
	return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n) => argv.includes(n);
const VALUED = ["-c", "--config", "--file", "--command", "--format", "--outdir"];
const pos = argv.filter((a, i) => !a.startsWith("-") && !(i > 0 && VALUED.includes(argv[i - 1])));

function readLine(prompt) {
	return new Promise((res) => {
		if (prompt) process.stdout.write(prompt);
		let buf = "";
		const onData = (c) => {
			buf += c;
			const nl = buf.search(/\r?\n|\r/);
			if (nl >= 0) {
				process.stdin.removeListener("data", onData);
				process.stdin.pause();
				res(buf.slice(0, nl));
			}
		};
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", onData);
		process.stdin.on("end", () => res(buf));
		process.stdin.resume();
	});
}
function db() {
	const { DatabaseSync } = require("node:sqlite");
	return new DatabaseSync(path.join(STATE, "d1.sqlite"));
}
function requireConfig() {
	const c = flag("-c") || flag("--config");
	if (!c) {
		console.error(`✘ [ERROR] Missing configuration: no wrangler.toml in ${process.cwd()} and no -c given`);
		process.exit(1);
	}
	const p = path.resolve(c);
	if (!fs.existsSync(p)) {
		console.error(`✘ [ERROR] Config file not found: ${p}`);
		process.exit(1);
	}
	return { file: p, text: fs.readFileSync(p, "utf8") };
}
function needLogin() {
	if (!st.loggedIn) {
		console.error("✘ [ERROR] You are not authenticated. Please run `wrangler login`.");
		process.exit(1);
	}
}

(async () => {
	const [a, b, c] = pos;
	if (a === "secret" && b === "put") {
		requireConfig();
		needLogin();
		const v = await readLine(tty.stdin ? "✔ Enter a secret value: … " : "");
		st.secrets[c] = { len: v.length };
		save();
		log(`[value length ${v.length}]`);
		console.log(`🌀 Creating the secret for the Worker "ledger"\n✨ Success! Uploaded secret ${c}`);
		return;
	}
	log();
	if (argv[0] === "--version") return console.log("4.105.0 (FAKE)");
	if (a === "whoami") {
		if (!st.loggedIn) return console.log("You are not authenticated. Please run `wrangler login`.");
		return console.log("👋 You are logged in with an OAuth Token, associated with the email owner@example.invalid.");
	}
	if (a === "login") {
		st.loggedIn = true;
		save();
		return console.log("Attempting to login via OAuth...\n(FAKE: no browser opened)\nSuccessfully logged in.");
	}
	if (a === "logout") {
		st.loggedIn = false;
		save();
		return console.log("Successfully logged out.");
	}
	if (a === "d1") {
		needLogin();
		if (b === "list") return console.log(JSON.stringify(st.d1 ? [{ uuid: st.d1, name: "ledger-db", version: "production" }] : []));
		if (b === "create") {
			st.d1 = "0f1e2d3c-4b5a-6978-8a9b-fake00d1d1d1";
			save();
			return console.log(`✅ Successfully created DB '${c}'\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${c}"\ndatabase_id = "${st.d1}"`);
		}
		if (b === "migrations" && c === "apply") {
			const cfg = requireConfig();
			if (!has("--remote")) return console.error("(FAKE) refused: no --remote (real wrangler would use a LOCAL copy)"), process.exit(1);
			const id = /database_id = "([^"]+)"/.exec(cfg.text)[1];
			if (id !== st.d1) return console.error(`✘ [ERROR] database_id ${id} not found in your account`), process.exit(1);
			const dir = path.resolve(path.dirname(cfg.file), "migrations");
			const todo = fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && !st.applied.includes(f)).sort();
			if (!todo.length) return console.log("✅ No migrations to apply!");
			console.log(`Migrations to be applied:\n${todo.map((t) => "  " + t).join("\n")}`);
			if (tty.stdin && tty.stdout) {
				const ans = await readLine(`? About to apply ${todo.length} migration(s)\nYour database may not be available to serve requests during the migration, continue? › (Y/n) `);
				if (/^n/i.test(ans.trim())) return console.log("Aborted"), process.exit(1);
			}
			const d = db();
			for (const f of todo) {
				d.exec(fs.readFileSync(path.join(dir, f), "utf8"));
				st.applied.push(f);
				console.log(`  ${f} ✅`);
			}
			save();
			return;
		}
		if (b === "execute") {
			requireConfig();
			if (!has("--remote")) return console.error("(FAKE) refused: no --remote (real wrangler would use a LOCAL copy)"), process.exit(1);
			const d = db();
			if (flag("--file")) {
				d.exec(fs.readFileSync(path.resolve(flag("--file")), "utf8"));
				return console.log("🚣 Executed queries from file.");
			}
			if (flag("--command")) return console.log(JSON.stringify([{ results: d.prepare(flag("--command")).all(), success: true }], null, 2));
		}
	}
	if (a === "kv" && b === "namespace") {
		needLogin();
		if (c === "list") return console.log(JSON.stringify(st.kv ? [{ id: st.kv, title: "LEDGER_OAUTH" }] : []));
		if (c === "create") {
			st.kv = "fa4ec0de0000000000000000000a0001";
			save();
			return console.log(`🌀 Creating namespace with title "${pos[3]}"\n✨ Success!\n[[kv_namespaces]]\nbinding = "${pos[3]}"\nid = "${st.kv}"`);
		}
	}
	if (a === "deploy") {
		const cfg = requireConfig();
		needLogin();
		if (/REPLACE-WITH-YOUR/.test(cfg.text)) return console.error("✘ [ERROR] (FAKE) wrangler.toml still has REPLACE-WITH-YOUR-… values"), process.exit(1);
		if (process.env.FAKE_SUBDOMAIN_REGISTERED && !st.subdomain) {
			st.subdomain = process.env.FAKE_SUBDOMAIN_REGISTERED;
			save();
		}
		console.log("Total Upload: 5359.08 KiB / gzip: 1102.31 KiB\nUploaded ledger (4.21 sec)");
		if (!st.subdomain) {
			console.log("▲ [WARNING] You need to register a workers.dev subdomain before publishing to workers.dev");
			if (!(tty.stdin && tty.stdout)) {
				console.log("? Would you like to register a workers.dev subdomain now?\n🤖 Using fallback value in non-interactive context: no");
				console.error("✘ [ERROR] You can either deploy your worker to one or more routes by specifying them in your wrangler.toml file, or register a workers.dev subdomain here:\nhttps://dash.cloudflare.com/0000fake/workers/onboarding");
				process.exit(1);
			}
			const yes = (await readLine("? Would you like to register a workers.dev subdomain now? › (Y/n) ")).trim();
			if (/^n/i.test(yes)) {
				console.error("✘ [ERROR] You can either deploy your worker to one or more routes by specifying them in your wrangler.toml file, or register a workers.dev subdomain here:\nhttps://dash.cloudflare.com/0000fake/workers/onboarding");
				process.exit(1);
			}
			const name = (await readLine("? What would you like your workers.dev subdomain to be? It will be accessible at https://<subdomain>.workers.dev › ")).trim();
			if (!/^[a-z0-9-]+$/.test(name)) return console.error("✘ [ERROR] (FAKE) not a valid subdomain"), process.exit(1);
			st.subdomain = name;
			save();
			console.log("Success! It may take a few minutes for DNS records to update.");
		}
		st.deploys = (st.deploys || 0) + 1;
		save();
		const targets = [`https://ledger.${st.subdomain}.workers.dev`, "schedule: * * * * *"];
		console.log(`Deployed ledger triggers (0.53 sec)\n${targets.map((t) => "  " + t).join("\n")}\nCurrent Version ID: fake-version`);
		const out = process.env.WRANGLER_OUTPUT_FILE_PATH;
		if (out) fs.appendFileSync(out, JSON.stringify({ type: "deploy", version: 1, worker_name: "ledger", targets, timestamp: new Date().toISOString() }) + "\n");
		return;
	}
	if (a === "secret" && b === "list") {
		requireConfig();
		needLogin();
		const list = Object.keys(st.secrets).map((name) => ({ name, type: "secret_text" }));
		if (flag("--format") === "pretty") return list.forEach((x) => console.log(`Secret Name: ${x.name}`));
		return console.log(JSON.stringify(list, null, 2));
	}
	if (a === "secret" && b === "delete") {
		requireConfig();
		delete st.secrets[c];
		save();
		return console.log(`✨ Success! Deleted secret ${c}`);
	}
	console.error(`(FAKE wrangler) not emulated: ${argv.join(" ")}`);
	process.exit(2);
})();
