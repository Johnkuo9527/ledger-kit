/// The few screens the worker draws itself, before anyone is signed in: the
/// page's lock, the connector's sign-in, and the public privacy policy. Deliberately plain and small —
/// they are served to anyone, so they carry not one byte of the ledger (no
/// account, no amount, no merchant). Design's page is everything after the lock.

import { say } from "../../src/words";
import { esc, html } from "./http";

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: Canvas; color: CanvasText; }
main { width: 100%; max-width: 22rem; padding: 2rem 1.5rem; box-sizing: border-box; }
h1 { font-size: 1.25rem; font-weight: 650; margin: 0 0 0.375rem; }
p { font-size: 0.9375rem; line-height: 1.55; opacity: 0.75; margin: 0 0 1.25rem; }
p.bad { color: #d92b4b; opacity: 1; }
input, button { width: 100%; box-sizing: border-box; font-size: 1rem; min-height: 2.75rem; border-radius: 12px; }
input { padding: 0.75rem 1rem; border: 1px solid rgba(128,128,128,0.4); margin-bottom: 0.75rem; background: Field; color: FieldText; }
button { font-weight: 600; border: 0; color: #fff; background: #2b62ff; cursor: pointer; }
.fine { font-size: 0.8125rem; opacity: 0.6; margin-top: 1rem; }
.fine a { color: inherit; }
main.wide { max-width: 36rem; }
h2 { font-size: 1rem; font-weight: 650; margin: 1.5rem 0 0.375rem; }`;

function screen(title: string, body: string, status: number, wide = false): Response {
	return html(
		`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main${wide ? ' class="wide"' : ""}>${body}</main></body></html>`,
		status,
	);
}

/// The page's front door. 401, so nothing caches it as the page.
export function lockScreen(message: string, tone: "quiet" | "bad" = "quiet"): Response {
	return screen(
		"Ledger",
		`<h1>Ledger</h1>
<p class="${tone === "bad" ? "bad" : ""}">${esc(message)}</p>
<form method="post" action="/unlock">
  <input name="key" type="password" autocomplete="current-password" placeholder="Your key" autofocus>
  <button type="submit">Open my ledger</button>
</form>
<p class="fine"><a href="/privacy">Privacy policy</a></p>`,
		401,
	);
}

export function signInEmailScreen(state: string, clientName: string, error: string | null): Response {
	return screen(
		"Sign in to your ledger",
		`<h1>Connect your ledger</h1>
<p><strong>${esc(clientName)}</strong> is asking to read your ledger and add to it (cash, reimbursable dates, trips, subscriptions). Enter your email to get a code.</p>
${error ? `<p class="bad">${esc(error)}</p>` : ""}
<form method="post" action="/authorize/code">
  <input type="hidden" name="oauth" value="${esc(state)}">
  <input type="email" name="email" placeholder="you@example.com" required autofocus autocomplete="email">
  <button type="submit">Email me a code</button>
</form>
<p class="fine">Only the ledger's owner is sent a code.</p>`,
		200,
	);
}

export function signInCodeScreen(state: string, email: string, note: string | null, error: string | null): Response {
	return screen(
		"Enter your code",
		`<h1>Enter your code</h1>
<p>If ${esc(email)} is the ledger owner's address, a 6-digit code is on its way. It lasts 10 minutes.</p>
${note ? `<p>${esc(note)}</p>` : ""}
${error ? `<p class="bad">${esc(error)}</p>` : ""}
<form method="post" action="/authorize/verify">
  <input type="hidden" name="oauth" value="${esc(state)}">
  <input type="hidden" name="email" value="${esc(email)}">
  <input inputmode="numeric" pattern="[0-9]*" maxlength="6" name="code" placeholder="123456" required autofocus autocomplete="one-time-code">
  <button type="submit">Allow access</button>
</form>`,
		200,
	);
}

export function problemScreen(title: string, message: string, status: number): Response {
	return screen(title, `<h1>${esc(title)}</h1><p class="bad">${esc(message)}</p>`, status);
}

/// The privacy policy : public, because Google will not publish the
/// Gmail sign-in "In production" without one. Fixed text — it carries no
/// figure, no account, no address and no name, so it is safe to show anyone.
/// The owner's email is deliberately NOT here: no personal data in the repo.
export function privacyScreen(): Response {
	return screen(
		"Ledger — Privacy policy",
		`<h1>Privacy policy</h1>
<p>Ledger is a personal app, run by its owner for its owner alone. It has no other users and no sign-up.</p>
<h2>What it reads</h2>
<p>With the owner's permission, Ledger reads the owner's own Gmail with read-only access (the <code>gmail.readonly</code> scope) to find bank alerts, receipts and statements and record the owner's own spending. It can never send, change or delete an email.</p>
<h2>Where the data is kept</h2>
<p>Everything Ledger records is stored only in the owner's own Cloudflare account. The text of an email may be sent to Anthropic's API so it can be read; it is not stored anywhere beyond what the ledger records.</p>
<h2>Sharing</h2>
<p>No data is sold, shared or used for advertising. Ledger has no tracking and no analytics.</p>
<h2>Contact</h2>
<p>Questions about this policy go to the app's owner.</p>
${say("screen.privacy_extra")}`,
		200,
		true,
	);
}

// ------------------------------------------------- 「連接 Gmail」 (google.ts)
// Served only behind the page cookie, so the connected address may be shown.

// The words are the catalogue's (screen.*), HTML written by us; only the address is the owner's data.
const back = () => `<p class="fine"><a href="/">${say("screen.back")}</a></p>`;

export function gmailDoneScreen(email: string): Response {
	return screen(
		say("screen.gmail_done_title"),
		`<h1>${say("screen.gmail_done_h1")}</h1>
<p>Connected: <b>${esc(email)}</b></p>
${say("screen.gmail_done_body")}
<form method="get" action="/"><button type="submit">${say("screen.back")}</button></form>`,
		200,
	);
}

export function gmailProblemScreen(title: string, message: string, status: number): Response {
	return screen(title, `<h1>${esc(title)}</h1><p class="bad">${esc(message)}</p>${back()}`, status);
}
