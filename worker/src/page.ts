/// Design's page (../page/**), bundled into the worker by build-page.mjs and
/// served only after the cookie check in app.ts. Never Cloudflare static assets:
/// those are served at the edge before the worker runs, to anyone.

import { home } from "../../src/home";
import { language, pageWordsScript } from "../../src/words";
import { BASE_HEADERS, html } from "./http";
import { problemScreen } from "./screens";

export interface PageAsset {
	type: string;
	body: string;
	base64?: boolean;
}
export type PageAssets = Record<string, PageAsset>;

function bytes(asset: PageAsset): string | Uint8Array {
	if (!asset.base64) return asset.body;
	return Uint8Array.from(atob(asset.body), (c) => c.charCodeAt(0));
}

/// The owner's home (src/home.ts) and language (src/words.ts), told to the page
/// in a <meta> — no inline script, so the page's script policy stays as strict
/// as it is. The page reads it for the currency it shows totals in, the day
/// "today" is, and which of its words (words.js) to use.
export function homeMeta(): string {
	const h = home();
	const json = JSON.stringify({ currency: h.currency, time_zone: h.timeZone, country: h.country, language: language() });
	return `<meta name="ledger-home" content="${json.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}">`;
}

function withHome(page: string): string {
	const meta = homeMeta();
	page = page.replace(/<html lang="[^"]*">/i, `<html lang="${language()}">`);
	if (/<meta charset="utf-8">/i.test(page)) return page.replace(/<meta charset="utf-8">/i, (m) => `${m}\n${meta}`);
	return page.replace(/^(<!doctype html>)?/i, (m) => `${m}${meta}`);
}

/// `/` is index.html; `/app.js` is app.js. Anything not in the bundle is a 404.
export function servePage(assets: PageAssets, url: URL, method: string): Response {
	if (method !== "GET" && method !== "HEAD") return problemScreen("Not allowed", "This address only shows the page.", 405);
	let path: string;
	try {
		path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
	} catch {
		return problemScreen("Not found", "There is nothing at this address.", 404);
	}
	if (path === "") path = "index.html";
	// The page's words: made from the catalogues (src/words/*.ts) for the owner's language only.
	// page/words.js carries every language for the demo opened from disk; it is not what is served.
	if (path === "words.js") return new Response(method === "HEAD" ? null : pageWordsScript([language()]), { headers: { "Content-Type": "text/javascript; charset=utf-8", ...BASE_HEADERS } });
	const asset = assets[path];
	if (!asset) {
		if (path === "index.html") return problemScreen("Not built yet", "The ledger page has not been built into this worker yet.", 503);
		return problemScreen("Not found", "There is nothing at this address.", 404);
	}
	if (asset.type.startsWith("text/html")) return html(withHome(asset.body));
	return new Response(method === "HEAD" ? null : bytes(asset), { headers: { "Content-Type": asset.type, ...BASE_HEADERS } });
}
