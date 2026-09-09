import { expect, test } from "bun:test";
import { LifeExecutionError } from "../src/life/actor.ts";
import { createLifeRunner } from "../src/life/runner.ts";
import { runtimeStoreFixture } from "./life-runtime-store-fixture.ts";

test("work inbox is drained before freezing even a model-free step", async () => {
	const f = runtimeStoreFixture();
	let prepared = false;
	const runner = createLifeRunner({
		...f.options,
		beforePrepare() {
			prepared = true;
		},
		assertSourceCurrent() {
			expect(prepared).toBe(true);
		},
	});
	try {
		const result = await runner.run(
			"test-world",
			"work-drain",
			1,
			new AbortController().signal,
		);
		expect(prepared).toBe(true);
		expect(result.status).toBe("accepted");
	} finally {
		await runner.close();
		await f.close();
	}
});

test.each([false, true])(
	"source authority fences dispatch and commit (changes after dispatch: %s)",
	async (afterDispatch) => {
		const f = runtimeStoreFixture(false);
		let current = afterDispatch;
		const complete = f.model.complete.bind(f.model);
		f.model.complete = async (...args) => {
			const result = await complete(...args);
			current = false;
			return result;
		};
		const runner = createLifeRunner({
			...f.options,
			assertSourceCurrent() {
				if (!current)
					throw new LifeExecutionError("stale", "Work source changed");
			},
		});
		try {
			const result = await runner.run(
				"test-world",
				"work-source",
				1,
				new AbortController().signal,
			);
			expect(result.status).toBe("stale");
			expect(result.receipt).toBeNull();
			expect(f.model.requests).toHaveLength(afterDispatch ? 1 : 0);
		} finally {
			await runner.close();
			await f.close();
		}
	},
);
