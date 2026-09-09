import { expect, test } from "bun:test";
import { RunReservations } from "./runs.ts";
import { KernelStore } from "./store.ts";

test("restored run rejects a forged terminal trace", () => {
	const store = new KernelStore();
	try {
		const runs = new RunReservations(store.db);
		const claim = runs.claim("p", "request");
		store.db
			.prepare(
				"UPDATE kernel_runs SET status='done',trace=? WHERE request_id=?",
			)
			.run(
				JSON.stringify({ status: "answered", decisionId: "another-decision" }),
				"request",
			);
		expect(() => runs.claim("p", "request")).toThrow("invalid stored run");
		expect(claim.replay).toBeNull();
	} finally {
		store.close();
	}
});

test("restored run rejects a status inconsistent with its trace", () => {
	const store = new KernelStore();
	try {
		const runs = new RunReservations(store.db);
		const claim = runs.claim("p", "request");
		store.db
			.prepare(
				"UPDATE kernel_runs SET status='done',trace=? WHERE request_id=?",
			)
			.run(
				JSON.stringify({ status: "unknown", decisionId: claim.decisionId }),
				"request",
			);
		expect(() => runs.claim("p", "request")).toThrow("invalid stored run");
	} finally {
		store.close();
	}
});
