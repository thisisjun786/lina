import { expect, test } from "bun:test";
import { createWorkManagementAuthority } from "../../lina-codex/src/task-work-authority.ts";
import { FakeCodexRpc } from "../../lina-codex/test/task-fake-rpc.test.ts";
import { parseLifeConfigInput } from "../../lina-core/src/world/authoring-request-validation.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test("installed fleet delivers task work before LIFE, survives reopen, and drains before source closes", async () => {
	const rpc = new FakeCodexRpc();
	const f = await fleetLifeFixture({
		createTaskRpc: async () => ({
			request: <T>(method: string, params?: unknown, signal?: AbortSignal) =>
				method === "initialize"
					? Promise.resolve({} as T)
					: rpc.request<T>(method, params, signal),
			notify() {},
			subscribe: (listener) =>
				rpc.subscribe(({ method, params }) => listener(method, params)),
			onRequest: () => () => {},
			close: async () => {},
			closed: false,
			pid: undefined,
		}),
	});
	try {
		f.setup();
		const store = () => {
			const current = f.app.fleet.life.store;
			if (!(current instanceof WorldStore)) throw Error("Missing world store");
			return current;
		};
		const { worldId, revision, ...config } =
			f.app.fleet.life.store.lifeConfig("test-world");
		f.app.fleet.life.setConfig(
			worldId,
			revision,
			parseLifeConfigInput({
				...config,
				version: 2,
				work: {
					rules: [
						{
							id: "research",
							familyId: "meet",
							categoryId: "research",
							outcomes: [],
							attribution: "owner",
							weight: 1,
							requiredMatch: false,
						},
					],
				},
			}),
		);
		const task = await f.app.tasks.create({
			ownerAgentId: "lina",
			title: "Task",
			cwd: f.root,
			prompt: "PRIVATE_WORK_CANARY",
			requestId: "work-task",
		});
		if (!task.threadId) throw Error("Missing task thread");
		const nativeSetup = JSON.stringify(rpc.calls("thread/start"));
		expect(nativeSetup).toContain('"lina_resource_read"');
		expect(nativeSetup).not.toContain('"lina_work_read"');
		expect(nativeSetup).not.toContain('"lina_work_write"');
		expect(nativeSetup).not.toContain('"lina_work_search"');
		expect(nativeSetup).not.toContain('"lina_work_list"');
		const ended = Promise.withResolvers<void>();
		const off = f.app.tasks.subscribeWork(() => ended.resolve());
		rpc.completeTurn(task.threadId);
		await ended.promise;
		off();
		const receipt = f.app.tasks.workReceipts(task.id)[0];
		if (!receipt) throw Error("Missing work receipt");
		await f.app.tasks.shareWork(
			task.id,
			{
				receiptId: receipt.id,
				expectedPolicyRevision: 0,
				requestId: "share",
				selection: {
					worldIds: [worldId],
					categoryId: "research",
					shareOutcome: true,
					shareParticipants: false,
					summary: null,
				},
			},
			createWorkManagementAuthority("management", "lina"),
		);
		expect(f.app.tasks.pendingWorkDeliveries()).toEqual([]);
		expect(store().workEvidence(worldId).records).toHaveLength(1);
		const result = await f.app.fleet.lifeRuntime.run(
			worldId,
			"shared-work",
			2,
			new AbortController().signal,
		);
		expect(result.status).toBe("accepted");
		expect(result.outcome?.kind).toBe("work");
		expect(f.models[0]?.requests).toHaveLength(0);
		await f.restart();
		const replay = await f.app.fleet.lifeRuntime.run(
			worldId,
			"shared-work",
			2,
			new AbortController().signal,
		);
		expect(replay.id).toBe(result.id);
		expect(store().workEvidence(worldId).records).toHaveLength(1);
		expect(f.app.tasks.pendingWorkDeliveries()).toEqual([]);
	} finally {
		await f.close();
	}
});
