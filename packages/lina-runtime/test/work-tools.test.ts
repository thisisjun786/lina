import { expect, test } from "bun:test";
import { workTools } from "../src/tools/work-memory.ts";

test("legacy work tools report retirement instead of returning empty external memory", async () => {
	const tools = workTools();
	expect(tools.map((t) => t.name)).toEqual([
		"lina_work_list",
		"lina_work_read",
		"lina_work_search",
		"lina_work_write",
	]);
	for (const tool of tools)
		await expect(
			Promise.resolve().then(() =>
				tool.execute("old", {}, new AbortController().signal),
			),
		).rejects.toThrow("retired");
});
