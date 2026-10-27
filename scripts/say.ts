/// `npx vite-node scripts/say.ts <key>`: one line per language, "<language><TAB><words>", from the
/// catalogues (src/words.ts) — so scripts/setup.sh, which is English, can still write the owner's
/// starting categories and name the page's buttons in his language without a copy of the words.

import { catalogue, LANGUAGES, type Key } from "../src/words";

const key = process.argv[2] as Key;
for (const l of LANGUAGES) {
	const entry = catalogue(l)[key];
	if (typeof entry !== "string") {
		console.error(`no plain sentence under "${key}" in ${l}`);
		process.exit(1);
	}
	console.log(`${l}\t${entry}`);
}
