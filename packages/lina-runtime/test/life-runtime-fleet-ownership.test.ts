import { expect, test } from "bun:test";
import { FakeCodexRpc } from "../../lina-codex/test/task-fake-rpc.test.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { proposePack } from "../../lina-core/test/life-autonomy-migration-fixture.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test("confirmed v3 pack migration cancels in-flight LIFE after the durable fence and preserves authored cadence", async () => {
	const f = await fleetLifeFixture(),
		returned = Promise.withResolvers<void>();
	try {
		const { pack } = f.setup(false);
		const store = f.app.fleet.life.store;
		if (!(store instanceof WorldStore)) throw Error("Missing store");
		const model = f.models[0];
		if (!model) throw Error("Missing model");
		const dispatched = Promise.withResolvers<AbortSignal>();
		model.onComplete = async (prepared, signal) => {
			dispatched.resolve(signal);
			await returned.promise;
			return model.result(prepared);
		};
		const pending = f.app.fleet.lifeRuntime
			.run("test-world", "migration-in-flight", 1, new AbortController().signal)
			.catch(() => null);
		const signal = await dispatched.promise;
		const before = store.lifeConfig("test-world");
		pack.version++;
		pack.world.version++;
		pack.life.revision++;
		const proposal = proposePack(store, pack);
		f.app.fleet.life.confirm(proposal.confirmation);
		expect(signal.aborted).toBe(true);
		expect(store.lifeConfig("test-world")).toEqual(before);
		returned.resolve();
		const result = await pending;
		expect(result?.status).not.toBe("accepted");
		expect(model.requests).toHaveLength(1);
	} finally {
		returned.resolve();
		await f.close();
	}
});

test("work task admission interrupts LIFE before a new turn request and resumes after completion", async () => {
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
	const returned = Promise.withResolvers<void>();
	try {
		f.setup(false);
		const task = await f.app.tasks.create({
			ownerAgentId: "lina",
			title: "Task",
			cwd: f.root,
			prompt: "Start",
			requestId: "work-one",
		});
		const thread = rpc.threads.get(task.threadId ?? "");
		if (!thread) throw Error("Missing task thread");
		thread.status = { type: "idle" };
		for (const turn of thread.turns) turn.status = "completed";
		await f.app.tasks.read(task.id);
		expect(f.app.fleet.lifeForeground.active()).toBe(false);
		const model = f.models[0];
		if (!model) throw Error("Missing model");
		const dispatched = Promise.withResolvers<AbortSignal>();
		model.onComplete = async (prepared, signal) => {
			dispatched.resolve(signal);
			await returned.promise;
			return model.result(prepared);
		};
		const pending = f.app.fleet.lifeRuntime
			.run("test-world", "work-preemption", 1, new AbortController().signal)
			.catch(() => null);
		const signal = await dispatched.promise;
		rpc.before("turn/start", () => {
			expect(signal.aborted).toBe(true);
			expect(f.app.fleet.lifeForeground.active()).toBe(true);
		});
		const current = f.app.tasks.list()[0];
		if (!current) throw Error("Missing task");
		await f.app.tasks.message(task.id, {
			text: "Continue",
			requestId: "work-two",
			expectedRevision: current.revision,
		});
		returned.resolve();
		await pending;
		thread.status = { type: "idle" };
		for (const turn of thread.turns) turn.status = "completed";
		await f.app.tasks.read(task.id);
		expect(f.app.fleet.lifeForeground.active()).toBe(false);
		rpc.before("thread/read", () => {
			thread.status = { type: "notLoaded" };
		});
		await f.app.tasks.read(task.id);
		expect(f.app.tasks.list()[0]?.status).toBe("needs_attention");
		expect(f.app.fleet.lifeForeground.active()).toBe(true);
	} finally {
		returned.resolve();
		await f.close();
	}
});

test("failed native teardown retains ownership and a later fleet stop retries it", async () => {
	const f = await fleetLifeFixture();
	try {
		f.setup();
		const model = f.models[0];
		if (!model) throw Error("Missing model");
		const close = model.close.bind(model);
		let attempts = 0;
		model.close = async () => {
			if (++attempts === 1) throw Error("Synthetic owned child still live");
			await close();
		};
		await expect(f.app.stop()).rejects.toThrow();
		expect(model.closed).toBe(false);
		await f.app.stop();
		expect(model.closed).toBe(true);
		expect(attempts).toBe(2);
	} finally {
		await f.close();
	}
});
