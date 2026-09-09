import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryOwner } from "./delivery.ts";

test("delivery survives owner reopen and rejects conflicting replay", async () => {
	const root = mkdtempSync(join(tmpdir(), "kernel-delivery-"));
	try {
		const path = join(root, "owner.sqlite");
		const first = new DeliveryOwner(path);
		first.admit("effect-1", "original", "private", "decision-1");
		first.close();
		const second = new DeliveryOwner(path);
		try {
			expect((await second.reconcile("effect-1"))?.output).toEqual({
				bytes: "original",
				audience: "private",
				fence: "decision-1",
			});
			second.admit("effect-1", "original", "private", "decision-1");
			expect(() =>
				second.admit("effect-1", "replacement", "public", "decision-1"),
			).toThrow();
			expect((await second.reconcile("effect-1"))?.output).toEqual({
				bytes: "original",
				audience: "private",
				fence: "decision-1",
			});
		} finally {
			second.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
