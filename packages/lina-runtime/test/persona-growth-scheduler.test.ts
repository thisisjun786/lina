import { expect, test } from "bun:test";
import { join } from "node:path";
import { CompanionMemory } from "../src/context/companion.ts";
import { nativeEpisode } from "./helpers/native-memory-source.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("growth failure is isolated from observation retry scheduling", async () => {
	const f = createRuntimeFixture();
	const wakes: number[] = [];
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		schedule: (_callback, delay) => {
			wakes.push(delay);
			return () => {};
		},
	});
	memory.configure(async () => {
		throw Error("temporary observation");
	});
	memory.configurePersonaGrowth(async () => {
		throw Error("persona route unavailable");
	});
	try {
		nativeEpisode(f.store, f.runtime.binding, "r");
		await memory.refresh();
		expect(wakes.length).toBeGreaterThan(0);
		expect(memory.detail().processing.error).not.toBe(
			"Companion scan or queue failed; progress preserved",
		);
		expect(memory.status().personaGrowth?.error).toBe(
			"persona_processing_failed",
		);
	} finally {
		await memory.close();
		await f.close();
	}
});
