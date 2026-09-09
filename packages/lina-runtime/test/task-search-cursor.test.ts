import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskToolContext } from "../../lina-codex/src/task-rpc.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { FleetResources } from "../src/fleet/resource-runtime.ts";
import { worldServices } from "./world-fixture.ts";

const limits = {
	maxFileBytes: 8192,
	maxCatalogBytes: 32768,
	maxExtractionBytes: 8192,
};

function parseSearch(result: {
	success: boolean;
	contentItems: Array<{ type: string; text: string }>;
}) {
	const text = result.contentItems.find(
		(item) => item.type === "inputText",
	)?.text;
	if (!text) throw Error("missing search text");
	return {
		text,
		page: JSON.parse(text.slice(text.indexOf("\n") + 1)) as {
			items: Array<{ id: string; title: string }>;
			nextCursor: string | null;
		},
	};
}

function fleet(
	root: string,
	validAgent: (id: string) => boolean = (id) => id === "a",
) {
	return new FleetResources({
		root,
		limits,
		services: () => worldServices(),
		policy: defaultEnginePolicy,
		validAgent,
		assertInstallation() {},
	});
}

function seedReports(owner: FleetResources, agentId: string, count: number) {
	for (let i = 0; i < count; i++)
		owner.engine.store.create(owner.scope(agentId), {
			operationId: `doc${i}`,
			kind: "document",
			title: `report ${i}`,
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("report body"),
		});
}

test("task search nextCursor survives a later executeTool call", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-task-search-cursor-"));
	const owner = fleet(root);
	try {
		seedReports(owner, "a", 3);
		const context: TaskToolContext = {
			taskId: "task",
			agentId: "a",
			revision: 1,
			assertCurrent: () => {},
		};
		const signal = new AbortController().signal;
		const first = await owner.executeTool(
			"lina_resource_search",
			"page1",
			{ query: "report", limit: 1 },
			signal,
			context,
		);
		expect(first.success).toBe(true);
		const { page } = parseSearch(first);
		expect(page.items).toHaveLength(1);
		expect(page.nextCursor).toBeString();
		const second = await owner.executeTool(
			"lina_resource_search",
			"page2",
			{ query: "report", limit: 1, cursor: page.nextCursor },
			signal,
			{
				taskId: "task",
				agentId: "a",
				revision: 1,
				assertCurrent: () => {},
			},
		);
		expect(second.success).toBe(true);
		const next = parseSearch(second);
		expect(next.page.items).toHaveLength(1);
		expect(next.page.items[0]?.id).not.toBe(page.items[0]?.id);
	} finally {
		await owner.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("task cursors check fresh call authority and reject other task, revision, persona and cancellation", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-task-cursor-scope-"));
	const owner = fleet(root, () => true);
	try {
		seedReports(owner, "a", 3);
		const controller = new AbortController();
		let oldValid = true;
		const context: TaskToolContext = {
			taskId: "one",
			agentId: "a",
			revision: 1,
			assertCurrent() {
				if (!oldValid) throw Error("stale call");
			},
		};
		const first = await owner.executeTool(
			"lina_resource_search",
			"first",
			{ query: "report", limit: 1 },
			controller.signal,
			context,
		);
		const cursor = parseSearch(first).page.nextCursor;
		expect(cursor).toBeString();
		oldValid = false;
		const current = { ...context, assertCurrent() {} };
		const args = { query: "report", limit: 1, cursor };
		const second = await owner.executeTool(
			"lina_resource_search",
			"second",
			args,
			controller.signal,
			current,
		);
		expect(second.success).toBe(true);
		for (const change of [
			{ taskId: "two" },
			{ agentId: "b" },
			{ revision: 2 },
		]) {
			expect(
				(
					await owner.executeTool(
						"lina_resource_search",
						"foreign",
						args,
						controller.signal,
						{ ...current, ...change },
					)
				).success,
			).toBe(false);
		}
		controller.abort();
		expect(
			(
				await owner.executeTool(
					"lina_resource_search",
					"cancelled",
					args,
					new AbortController().signal,
					current,
				)
			).success,
		).toBe(false);
	} finally {
		await owner.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("cursor page rechecks resource visibility after publication is revoked", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-task-cursor-revoke-"));
	const owner = fleet(root);
	try {
		seedReports(owner, "a", 3);
		const signal = new AbortController().signal;
		const first = await owner.executeTool(
			"lina_resource_search",
			"first",
			{ query: "report", limit: 1 },
			signal,
		);
		const cursor = parseSearch(first).page.nextCursor;
		const docs = owner.engine.store.list(owner.scope("a")).items;
		for (const doc of docs)
			owner.engine.store.update(owner.scope("a"), {
				id: doc.id,
				operationId: "private-" + doc.id,
				expectedRevision: doc.revision,
				visibility: "private",
			});
		expect(
			(
				await owner.executeTool(
					"lina_resource_search",
					"revoked",
					{ query: "report", limit: 1, cursor },
					signal,
				)
			).success,
		).toBe(false);
	} finally {
		await owner.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("overlapping calls retain their own authority guard", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-task-cursor-overlap-"));
	const owner = fleet(root);
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	try {
		seedReports(owner, "a", 3);
		const original = owner.engine.consumer.bind(owner.engine);
		let calls = 0;
		let firstSearchError: unknown;
		owner.engine.consumer = (...args) => {
			const client = original(...args),
				search = client.search.search.bind(client.search);
			client.search.search = async (...input) => {
				const call = calls++;
				if (call === 0) {
					entered.resolve();
					await release.promise;
				}
				try {
					return await search(...input);
				} catch (error) {
					if (call === 0) firstSearchError = error;
					throw error;
				}
			};
			return client;
		};
		let firstValid = true;
		const signal = new AbortController().signal;
		const context: TaskToolContext = {
			taskId: "same",
			agentId: "a",
			revision: 1,
			assertCurrent() {
				if (!firstValid) throw Error("first revoked");
			},
		};
		const first = owner.executeTool(
			"lina_resource_search",
			"first",
			{ query: "report", limit: 1 },
			signal,
			context,
		);
		void first.catch(() => {});
		await entered.promise;
		const second = await owner.executeTool(
			"lina_resource_search",
			"second",
			{ query: "report", limit: 1 },
			signal,
			{ ...context, assertCurrent() {} },
		);
		expect(second.success).toBe(true);
		firstValid = false;
		release.resolve();
		await expect(first).rejects.toThrow("first revoked");
		expect(firstSearchError).toBeInstanceOf(Error);
		expect((firstSearchError as Error).message).toBe("first revoked");
	} finally {
		release.resolve();
		await owner.close();
		rmSync(root, { recursive: true, force: true });
	}
});
