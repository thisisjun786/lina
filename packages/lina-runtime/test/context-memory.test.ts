import { expect, test } from "bun:test";
import { join } from "node:path";
import { HonchoClient } from "../../lina-memory/src/honcho/index.ts";
import { config, FakeHoncho } from "../../lina-memory/test/honcho-fixture.ts";
import { MemoryBridge } from "../src/context/memory.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("disabled memory and unavailable recall leave conversation state untouched", async () => {
	const f = createRuntimeFixture();
	const memory = new MemoryBridge({
		path: join(f.root, "memory.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
	});
	try {
		expect(await memory.recall("preference")).toBe("");
		await memory.refresh();
		expect(memory.status().service).toBe("disabled");
		expect(f.runtime.snapshot().state).toBe("idle");
	} finally {
		await memory.close();
		await f.close();
	}
});

test("configured memory checks scoped resources, captures settled text and exposes freshness as unknown", async () => {
	const f = createRuntimeFixture(),
		fake = new FakeHoncho();
	await new HonchoClient(config, { fetch: fake.fetch }).initialize();
	const memory = new MemoryBridge({
		path: join(f.root, "memory.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		config,
		clientOptions: { fetch: fake.fetch },
	});
	try {
		f.store.appendEntry({
			entryId: "user",
			role: "user",
			text: "Prefer dark mode",
			timestamp: "2026-09-05T00:00:00Z",
			raw: { type: "message", message: { role: "user" } },
		});
		f.store.createRequest("request", "Prefer dark mode");
		f.store.setRequest("request", "accepted", { entryId: "user" });
		f.store.setRequest("request", "settled");
		await memory.refresh();
		expect(memory.status()).toMatchObject({
			service: "ready",
			accepted: 1,
			freshness: "unknown",
		});
		fake.behavior = () => {
			throw new Error("offline");
		};
		expect(await memory.recall("preference")).toBe("");
		expect(memory.status().service).toBe("unavailable");
		expect(f.store.request("request")?.status).toBe("settled");
	} finally {
		await memory.close();
		await f.close();
	}
});

test("a turn settling during another refresh triggers a further capture scan", async () => {
	const f = createRuntimeFixture(),
		fake = new FakeHoncho();
	await new HonchoClient(config, { fetch: fake.fetch }).initialize();
	const memory = new MemoryBridge({
		path: join(f.root, "memory.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		config,
		clientOptions: { fetch: fake.fetch },
	});
	try {
		f.store.appendEntry({
			entryId: "user",
			role: "user",
			text: "Queued preference",
			timestamp: "2026-09-05T00:00:00Z",
			raw: {},
		});
		f.store.createRequest("request", "Queued preference");
		f.store.setRequest("request", "accepted", { entryId: "user" });
		const entered = Promise.withResolvers<void>(),
			reply = Promise.withResolvers<Response>();
		fake.behavior = () => {
			entered.resolve();
			return reply.promise;
		};
		const first = memory.refresh();
		await entered.promise;
		f.store.setRequest("request", "settled");
		const second = memory.refresh();
		fake.behavior = undefined;
		reply.resolve(
			Response.json({
				items: [{ id: config.userPeerId }, { id: config.observerPeerId }],
			}),
		);
		await Promise.all([first, second]);
		expect(memory.status().accepted).toBe(1);
	} finally {
		await memory.close();
		await f.close();
	}
});
