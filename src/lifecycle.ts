/// The life of a ledger line. Every state change goes through transition(), so
/// an illegal jump (a void line suddenly reconciled) throws instead of quietly
/// corrupting a month.
///
///            attach_statement           reconcile
///   open ─────────────────────► posted ───────────► reconciled
///    ▲ │                         ▲ │  ◄─────────────    │
///    │ │ flag_review             │ │   unreconcile      │ flag_review
///    │ ▼                         │ ▼                    ▼
///    └─ review ◄─────────────────┘ review ◄─────────────┘
///         │ resolve → open (no statement yet) / posted (has one)
///   any ──void──► void ──restore──► open / posted
///
/// The amount has its own, separate status (bill_status / home_status):
///   estimate ──statement posts──► confirmed       (foreign charge, SGD card)
///   exact                                          (no currency conversion)
///   reference ──the owner corrects──► confirmed         (TWD account, foreign cash)

import type { LineState } from "./types";

export const LINE_EVENTS = ["attach_statement", "reconcile", "unreconcile", "flag_review", "resolve", "void", "restore"] as const;
export type LineEvent = (typeof LINE_EVENTS)[number];

export class IllegalTransition extends Error {
	constructor(
		readonly from: LineState,
		readonly event: LineEvent,
	) {
		super(`a line in state '${from}' cannot '${event}'`);
	}
}

/// `hasStatement` = the line carries a statement_id (decides where 'resolve'
/// and 'restore' land).
export function transition(from: LineState, event: LineEvent, hasStatement: boolean): LineState {
	const settled: LineState = hasStatement ? "posted" : "open";
	switch (event) {
		case "attach_statement":
			if (from === "open") return "posted";
			if (from === "review") return "review"; // still under review; resolve() lands it on 'posted'

			break;
		case "reconcile":
			if (from === "posted") return "reconciled";
			if (from === "reconciled") return "reconciled";
			break;
		case "unreconcile":
			if (from === "reconciled") return "posted";
			if (from === "posted" || from === "review") return from;
			break;
		case "flag_review":
			if (from === "open" || from === "posted" || from === "reconciled" || from === "review") return "review";
			break;
		case "resolve":
			if (from === "review") return settled;
			break;
		case "void":
			if (from !== "void") return "void";
			break;
		case "restore":
			if (from === "void") return settled;
			break;
	}
	throw new IllegalTransition(from, event);
}
