/// seed/accounts.json → seed/accounts.sql, the file INSTALL.md step 5 loads
/// into your database. Run from the repository root: `npm run seed:sql`.
/// Refuses (and changes nothing) when the accounts file has a problem.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { seedProblems, seedSql, type SeedFile } from "../src/seed";

const json = new URL("../seed/accounts.json", import.meta.url);
const sql = new URL("../seed/accounts.sql", import.meta.url);

if (!existsSync(json)) {
	console.error("seed/accounts.json does not exist yet. Copy seed/accounts.example.json to seed/accounts.json and put your own accounts in it (docs/accounts.md).");
	process.exit(1);
}
let seed: SeedFile;
try {
	seed = JSON.parse(readFileSync(json, "utf8")) as SeedFile;
} catch (e) {
	console.error(`seed/accounts.json is not valid JSON: ${(e as Error).message}`);
	process.exit(1);
}
// Your home currency, once scripts/setup.sh (or you) wrote it into wrangler.toml.
const toml = new URL("../wrangler.toml", import.meta.url);
const home = existsSync(toml) ? /^LEDGER_HOME_CURRENCY = "([A-Z]{3})"$/m.exec(readFileSync(toml, "utf8"))?.[1] ?? null : null;
const problems = seedProblems(seed, { homeCurrency: home });
if (problems.length) {
	console.error(`seed/accounts.json has ${problems.length} problem(s); nothing was written:\n- ${problems.join("\n- ")}`);
	process.exit(1);
}
writeFileSync(sql, seedSql(seed));
console.log(`Wrote seed/accounts.sql: ${seed.banks.length} bank(s), ${seed.accounts.length} account(s).`);
