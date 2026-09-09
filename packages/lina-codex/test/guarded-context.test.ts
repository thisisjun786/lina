import { afterEach, expect, test } from "bun:test";
import {
	activity,
	installTestWorldContext,
	limits,
	worldAccess,
	worldFixture,
} from "../../lina-runtime/test/world-fixture.ts";
import { settled, sourceFixture } from "./source-provenance-fixture.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const reference = (text: string) => ({
	role: "custom",
	customType: "lina-context-reference",
	content: text,
});

test("all persona and context hook guards compose privately, including guard-only hooks", async () => {
	const f = sourceFixture();
	cleanup.push(() => f.close());
	const checked: string[] = [];
	const opened = await f.open({
		register(host) {
			host.on("before_agent_start", () => ({
				systemPrompt: "COMPOSED_PERSONA",
				beforeDeliver() {
					checked.push("persona-1");
				},
			}));
			host.on("before_agent_start", async () => ({
				beforeDeliver() {
					checked.push("persona-2");
				},
			}));
			host.on("context", (event) => ({
				messages: [...event.messages, reference("CONTEXT_ONE")],
				beforeDeliver() {
					checked.push("context-1");
				},
			}));
			host.on("context", async (event) => {
				await Promise.resolve();
				expect(event.messages).toContainEqual(reference("CONTEXT_ONE"));
				expect(event).not.toHaveProperty("beforeDeliver");
				return {
					messages: [...event.messages, reference("CONTEXT_TWO")],
					beforeDeliver() {
						checked.push("context-2");
					},
				};
			});
			host.on("context", () => ({
				beforeDeliver() {
					checked.push("context-3");
				},
			}));
		},
	});
	const runtime = f.runtime(opened.session);
	const done = settled(runtime, "composed");
	runtime.submit("composed", "hi");
	const turn = await opened.rpc.next("turn/start");
	opened.rpc.complete(opened.session.threadId);
	await done;
	expect(checked).toEqual([
		"persona-1",
		"persona-2",
		"context-1",
		"context-2",
		"context-3",
		"persona-1",
		"persona-2",
		"context-1",
		"context-2",
		"context-3",
	]);
	expect(JSON.stringify(turn.params["additionalContext"])).toContain(
		"CONTEXT_ONE",
	);
	expect(JSON.stringify(turn.params["additionalContext"])).toContain(
		"CONTEXT_TWO",
	);
	expect(JSON.stringify(opened.rpc.frames)).toContain("COMPOSED_PERSONA");
	expect(JSON.stringify(opened.rpc.frames)).not.toMatch(
		/beforeDeliver|sourceProofs|policyDigest/,
	);
});

for (const stale of ["persona-1", "context-1", "context-2"] as const) {
	test(`${stale} cannot be overwritten by another hook's valid guard after context await`, async () => {
		const f = sourceFixture();
		cleanup.push(() => f.close());
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		let current = true;
		const guard = (id: string) => () => {
			if (id === stale && !current) throw Error("PRIVATE_GUARD_PROOF");
		};
		const opened = await f.open({
			register(host) {
				host.on("before_agent_start", () => ({
					systemPrompt: "SECRET_PERSONA",
					beforeDeliver: guard("persona-1"),
				}));
				host.on("before_agent_start", async () => ({
					systemPrompt: "SECRET_PERSONA",
					beforeDeliver: guard("persona-2"),
				}));
				host.on("context", (event) => ({
					messages: [...event.messages, reference("SECRET_CONTEXT")],
					beforeDeliver: guard("context-1"),
				}));
				host.on("context", async (event) => {
					const beforeDeliver = guard("context-2");
					entered.resolve();
					await release.promise;
					return { messages: event.messages, beforeDeliver };
				});
			},
		});
		opened.rpc.hook((frame) => {
			if (frame.method === "turn/start")
				queueMicrotask(() => opened.rpc.complete(opened.session.threadId));
			return undefined;
		});
		const runtime = f.runtime(opened.session);
		const before = opened.rpc.frames.length;
		const done = settled(runtime, "stale");
		runtime.submit("stale", "hi");
		await entered.promise;
		current = false;
		release.resolve();
		await done;
		expect(
			opened.rpc.frames
				.slice(before)
				.filter((frame) => frame.method === "turn/start"),
		).toEqual([]);
		expect(JSON.stringify(opened.rpc.frames.slice(before))).not.toContain(
			"SECRET_",
		);
		expect(f.journal.request("stale")?.status).toBe("rejected");
		expect(JSON.stringify(runtime.snapshot())).not.toContain(
			"PRIVATE_GUARD_PROOF",
		);
	});
}

test("actual world context frozen view rejects a world change during a later context hook", async () => {
	const world = worldFixture();
	cleanup.push(() => world.close());
	const f = sourceFixture();
	cleanup.push(() => f.close());
	f.state.policy = worldAccess("mina").currentContextPolicy();
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const opened = await f.open({
		register(host) {
			installTestWorldContext(host, {
				store: world.store,
				worldId: "island",
				agentId: "mina",
				limits,
			});
			host.on("context", async (event) => {
				expect(JSON.stringify(event.messages)).toContain(
					"Mina hides a blue key",
				);
				entered.resolve();
				await release.promise;
				return { messages: event.messages, beforeDeliver() {} };
			});
		},
	});
	opened.rpc.hook((frame) => {
		if (frame.method === "turn/start")
			queueMicrotask(() => opened.rpc.complete(opened.session.threadId));
		return undefined;
	});
	const runtime = f.runtime(opened.session);
	const before = opened.rpc.frames.length;
	const done = settled(runtime, "world");
	runtime.submit("world", "hi");
	await entered.promise;
	world.store.accept(activity());
	release.resolve();
	await done;
	expect(
		opened.rpc.frames
			.slice(before)
			.filter((frame) => frame.method === "turn/start"),
	).toEqual([]);
	expect(JSON.stringify(opened.rpc.frames.slice(before))).not.toContain(
		"blue key",
	);
	expect(f.journal.request("world")?.status).toBe("rejected");
});
