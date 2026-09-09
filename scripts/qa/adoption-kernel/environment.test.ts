import { expect, test } from "bun:test";
import { Environment } from "./environment.ts";
import type { PublicCase } from "./harness-types.ts";

const sample: PublicCase = {
	version: 1,
	episodeId: "sample",
	stages: [],
	prelude: [],
	tools: [
		{ name: "submit", description: "submit", arguments: {} },
		{ name: "check", description: "check", arguments: {} },
		{ name: "lookup", description: "lookup", arguments: {} },
	],
	environment: {
		lookups: { a: 7 },
		tasks: { t: { required: ["a", "b"], condition: "C", methods: {} } },
		unavailableKeys: [],
		unknownTasks: [],
	},
};
test("environment checks actual submission and rejects conflicting replay", async () => {
	const env = new Environment(sample);
	try {
		const submit = env.tools().get("submit");
		const check = env.tools().get("check");
		if (!submit || !check) throw Error("missing tool");
		submit.admit("one", { taskKey: "t", items: ["a"] }, "d");
		expect(() =>
			submit.admit("one", { taskKey: "t", items: ["a", "b"] }, "d"),
		).toThrow();
		check.admit("two", { submissionId: "one" }, "d2");
		expect((await check.result("two"))?.quality.status).toBe("fail");
		expect((await check.result("two"))?.output).toEqual({
			submissionId: "one",
			missing: ["b"],
			extra: [],
			pass: false,
		});
		expect(env.events()).toHaveLength(2);
	} finally {
		env.close();
	}
});
