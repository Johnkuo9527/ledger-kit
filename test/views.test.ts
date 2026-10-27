import { describe, expect, it } from "vitest";
import { subscriptionView, tripView, type SubscriptionRow, type TripRow } from "../src/views";
import { line } from "./helpers/fixtures";

describe("views for the page and the connector", () => {
	it("a trip's total is the true cost, with what is still estimated and what is claimable", () => {
		const trip: TripRow = { id: "t", name: null, destination: "Tokyo, JP", countries_json: '["JP"]', start_date: "2026-04-10", end_date: "2026-04-17", status: "confirmed", evidence_ids_json: "[]", confirmed_at: null, created_at: "", updated_at: "" };
		const members = [
			line({ txn_date: "2026-04-11", home_minor: 13908, home_status: "confirmed" }),
			line({ txn_date: "2026-04-12", home_minor: 2763, home_status: "estimate", reimbursable_override: 0 }),
			line({ txn_date: "2026-03-01", home_minor: 68000 }),
		];
		// 139.08 + 27.63 + 680.00 = 846.71; estimated 27.63; claimable 139.08 (the range) + 0 (overridden) + 0 (before it).
		const v = tripView(trip, members, [{ id: "r", start_date: "2026-04-10", end_date: "2026-04-17", note: null }]);
		expect(v).toMatchObject({ countries: ["JP"], total_home: { minor: 84671, display: "SGD 846.71" }, unconfirmed_home: { minor: 2763 }, reimbursable_home: { minor: 13908 }, line_count: 3 });
	});

	it("a subscription shows the owner's word over detection, and its monthly cost", () => {
		const row: SubscriptionRow = { id: "s", merchant_key: "DOMAINCO", merchant_name: "Domainco", currency: "USD", cadence: "yearly", amount_minor: 2400, previous_amount_minor: null, price_changed_on: null, first_seen: "2025-04-01", last_charged: "2026-04-01", next_renewal: "2027-04-01", occurrences: 2, status: "active", owner_status: null, line_ids_json: "[]", updated_at: "" };
		expect(subscriptionView(row)).toMatchObject({ status: "active", amount: { display: "USD 24.00" }, monthly_equivalent: { minor: 200 } });
		expect(subscriptionView({ ...row, owner_status: "cancelled" }).status).toBe("cancelled");
	});
});
