/// Company-reimbursable spending. The owner states date ranges ("13–17 Oct, the
/// Tokyo work trip"); every spending line inside one is reimbursable. He can
/// override any single line either way, and his override always wins.

import { isIsoDate } from "./dates";
import { isSpending } from "./transfers";
import type { LineRow } from "./types";

export interface ReimburseRange {
	id: string;
	start_date: string;
	end_date: string;
	note: string | null;
}

export interface ReimbursableView {
	effective: boolean;
	source: "override" | "range" | null;
	range_id: string | null;
}

export function reimbursable(
	line: Pick<LineRow, "kind" | "state" | "txn_date" | "reimbursable_override">,
	ranges: readonly ReimburseRange[],
): ReimbursableView {
	// A wallet's offset line is the ledger's own counter-entry: the purchase it
	// offsets is what the owner paid and claims, never the offset.
	if (line.kind === "wallet_offset") return { effective: false, source: null, range_id: null };
	if (line.reimbursable_override === 1) return { effective: true, source: "override", range_id: null };
	if (line.reimbursable_override === 0) return { effective: false, source: "override", range_id: null };
	if (!isSpending(line)) return { effective: false, source: null, range_id: null };
	const hit = ranges.find((r) => line.txn_date >= r.start_date && line.txn_date <= r.end_date);
	return hit ? { effective: true, source: "range", range_id: hit.id } : { effective: false, source: null, range_id: null };
}

/// What to claim back, in SGD cents. Refunds inside the range reduce it.
export function reimbursableTotal(lines: readonly LineRow[], ranges: readonly ReimburseRange[]): number {
	return lines.filter((l) => l.state !== "void" && reimbursable(l, ranges).effective).reduce((sum, l) => sum + l.home_minor, 0);
}

export function rangeProblem(start: string, end: string): string | null {
	if (!isIsoDate(start) || !isIsoDate(end)) return "dates must be YYYY-MM-DD";
	if (start > end) return "the range ends before it starts";
	return null;
}
