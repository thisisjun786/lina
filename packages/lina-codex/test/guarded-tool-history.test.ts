import { expect, test } from "bun:test";
import { Type } from "typebox";
import { CodexHost } from "../src/host.ts";

test.each(["before-event", "between-handlers"])(
	"revoked tool body cannot enter execution history at %s",
	async (stage) => {
		const host = new CodexHost(process.cwd(), () => ({ action: "allow" }));
		let current = stage !== "before-event";
		const published: unknown[] = [];
		host.registerTool({
			name: "read",
			label: "Read",
			description: "Synthetic",
			parameters: Type.Object({}),
			execute: () => ({
				content: [{ type: "text", text: "REVOKED_SOURCE_SENTINEL" }],
				details: {},
				beforeDeliver() {
					if (!current) throw Error("Source revoked");
				},
			}),
		});
		host.on("tool_execution_end", async () => {
			current = false;
		});
		host.on("tool_execution_end", (event) => {
			published.push(event);
		});
		const reply = await host.invokeTool(
			"read",
			"call",
			{},
			new AbortController().signal,
		);
		expect(JSON.stringify(published)).not.toContain("REVOKED_SOURCE_SENTINEL");
		expect(JSON.stringify(reply)).not.toContain("REVOKED_SOURCE_SENTINEL");
		expect(reply.success).toBe(false);
	},
);
