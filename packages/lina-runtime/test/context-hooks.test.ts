import { expect, test } from "bun:test";
import type { ContextCoordinator } from "../src/context/coordinator.ts";
import { installContextHooks } from "../src/context/hooks.ts";
import type { LinaHost } from "../src/host.ts";

test("Codex hooks refresh external context and preserve current messages as source input", async () => {
	const handlers = new Map<
		string,
		(event: unknown, context: unknown) => unknown
	>();
	const host = {
		on(name: string, handler: (event: unknown, context: unknown) => unknown) {
			handlers.set(name, handler);
		},
	} as unknown as LinaHost;
	let refreshed = 0;
	const coordinator = {
		refreshExternal: async () => {
			refreshed += 1;
		},
		setRecall: () => {},
		readInjection: () => ({
			content: "UNTRUSTED_REFERENCE",
			beforeDeliver: () => {},
		}),
	} as unknown as ContextCoordinator;
	installContextHooks(host, coordinator, async () => "");
	expect(handlers.has("session_before_compact")).toBe(false);
	await expect(
		handlers.get("before_agent_start")?.({ prompt: "hello" }, {}),
	).rejects.toThrow("signal");
	await handlers.get("before_agent_start")?.(
		{ prompt: "hello" },
		{ signal: new AbortController().signal },
	);
	expect(refreshed).toBe(1);
	const original = [{ role: "user", content: "current instruction" }];
	const projected = handlers.get("context")?.({ messages: original }, {}) as {
		messages: unknown[];
	};
	expect(projected.messages.at(-1)).toBe(original[0]);
	expect(projected.messages[0]).toMatchObject({
		role: "custom",
		display: false,
	});
	expect(original).toHaveLength(1);
});
