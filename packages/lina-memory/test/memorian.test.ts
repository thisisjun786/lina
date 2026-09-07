import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorian } from "../src/memorian.ts";
import { MemoryFs } from "../src/memory-fs.ts";

describe("Memorian", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "lina-memorian-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("ranks the matching block first when recall is given a lexical query", async () => {
		const fs = new MemoryFs(dir);
		await fs.write("misc.md", { description: "misc", body: "random errands" });
		await fs.write("journal/garden.md", {
			description: "garden journal",
			body: "planted tomatoes",
		});
		const memorian = createMemorian(fs);
		const recalled = await memorian.recall("Tomatoes");
		const first = recalled[0];
		if (first === undefined) {
			throw new Error("expected at least one recalled block");
		}
		expect(String(first.path)).toBe("journal/garden.md");
		expect(first.body).toContain("planted tomatoes");
	});

	it("persists the observation so it is recalled when a fresh MemoryFs instance is used", async () => {
		const memorian = createMemorian(new MemoryFs(dir));
		await memorian.record({
			path: "pets.md",
			description: "pets",
			body: "A user has a cat named Pepper",
		});
		const recalled = await createMemorian(new MemoryFs(dir)).recall("pepper");
		const first = recalled[0];
		if (first === undefined) {
			throw new Error("expected the recorded block to be recalled");
		}
		expect(String(first.path)).toBe("pets.md");
		expect(first.description).toBe("pets");
		expect(first.body).toBe("A user has a cat named Pepper");
	});
});
