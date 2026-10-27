/// `npx vite-node scripts/check-home.ts <currency> <time zone> <country> [language]`:
/// the same check the worker makes at every request (src/home.ts homeProblems,
/// src/words.ts languageProblem). Prints each problem on its own line and exits
/// 1, or prints nothing and exits 0. scripts/setup.sh runs it before writing your
/// home and language into wrangler.toml.

import { homeProblems } from "../src/home";
import { languageProblem } from "../src/words";

const [currency, timeZone, country, language] = process.argv.slice(2);
const problems = [...homeProblems(currency, timeZone, country), ...[languageProblem(language)].filter((p): p is string => p !== null)];
for (const p of problems) console.log(p);
process.exit(problems.length ? 1 : 0);
