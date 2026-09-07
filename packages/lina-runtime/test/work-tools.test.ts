import { expect, test } from "bun:test";
import { OpenVikingClient } from "../../lina-memory/src/openviking/index.ts";
import { workTools } from "../src/tools/work-memory.ts";

test("work tools keep native schemas and expose missing service without fabricated empty memory", async () => {
	const tools = workTools(new OpenVikingClient());
	expect(tools.map((t) => t.name)).toEqual([
		"lina_work_list",
		"lina_work_read",
		"lina_work_search",
		"lina_work_write",
	]);
	const list = tools[0];
	if (!list) throw Error("missing list tool");
	const result = await list.execute("probe", {}, new AbortController().signal);
	expect(result.details["service"]).toBe("disabled");
	expect(result.content[0]?.text).toContain("disabled");
	const write = tools[3];
	if (!write) throw Error("missing write tool");
	expect(
		(write.parameters as unknown as { required: string[] }).required,
	).toEqual(["uri", "content", "mode"]);
});
