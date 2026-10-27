/// Writes page/words.js from the catalogues (src/words/*.ts): the page's words in
/// every language, for the demo opened from disk. The worker serves the owner's
/// language from the same catalogues (worker/src/page.ts). test/words.test.ts
/// fails when this file is behind the catalogues.
///
///   npm run words

import { writeFileSync } from "node:fs";
import { pageWordsScript } from "../src/words";

writeFileSync(new URL("../page/words.js", import.meta.url), pageWordsScript());
console.log("wrote page/words.js");
