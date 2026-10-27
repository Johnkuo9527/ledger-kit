/// The categories a new ledger starts with (wrangler.toml LEDGER_CATEGORIES): English for an English
/// install, Traditional Chinese for a zh-Hant one — a category's name is the owner's data, shown as it
/// is and never translated, so the list must start in his language (scripts/setup.sh writes it at stage 3).
/// The lists are written out by hand here, not read from the code.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogue } from "../src/words";

const EN_LIST = "Food, Supermarket, Drinks, Transportation, Grab/Uber, Shopping, Clothes, Entertainment, Subscriptions, Healthcare, Insurance, Rent, Utilities, Gifts, Travel, Others";
const ZH_LIST = "餐飲, 超市, 飲料, 交通, Grab/Uber, 購物, 服飾, 娛樂, 訂閱, 醫療, 保險, 房租, 水電, 禮物, 旅行, 其他";

describe("the starting categories", () => {
	it("are the English list in English and the Traditional Chinese one in zh-Hant, one for one", () => {
		expect(catalogue("en")["categories.default"]).toBe(EN_LIST);
		expect(catalogue("zh-Hant")["categories.default"]).toBe(ZH_LIST);
		expect(ZH_LIST.split(", ")).toHaveLength(EN_LIST.split(", ").length);
	});
	it("wrangler.toml ships the English one, which setup.sh swaps for the owner's language", () => {
		const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
		expect(/^LEDGER_CATEGORIES = "(.*)"$/m.exec(toml)?.[1]).toBe(EN_LIST);
	});
	it("each has its own icon on the page, in both languages (page/app.js CAT_ICON, keyed by the lower-cased name)", () => {
		const app = readFileSync(new URL("../page/app.js", import.meta.url), "utf8");
		const body = /const CAT_ICON = \{([\s\S]*?)\n\t\};/.exec(app)?.[1] ?? "";
		const icons = new Function(`return {${body}}`)() as Record<string, string>;
		const missing = [...EN_LIST.split(", "), ...ZH_LIST.split(", ")].filter((c) => !icons[c.toLowerCase()]);
		expect(missing).toEqual([]);
	});
	it("ship no subject filter: one bank's subject must not hide another bank's mail", () => {
		const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
		expect(/^LEDGER_IGNORE_SUBJECTS = "(.*)"$/m.exec(toml)?.[1]).toBe("");
	});
});
