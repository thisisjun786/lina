import { expect, test } from "bun:test";
import { InactiveMemory } from "../src/context/memory.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

for (const reason of ["disabled", "migration_required"] as const) {
	test(`${reason} recall leaves conversation state untouched`, async () => {
		const f = createRuntimeFixture();
		const memory = new InactiveMemory(reason);
		try {
			const before = f.runtime.snapshot();
			expect(await memory.recall("preference")).toBe("");
			await memory.refresh();
			expect(memory.status().service).toBe(
				reason === "disabled" ? "disabled" : "unavailable",
			);
			expect(f.runtime.snapshot()).toEqual(before);
		} finally {
			await memory.close();
			await f.close();
		}
	});
}
