import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodexHost } from "../../lina-codex/src/host.ts";
import { acquireSessionLease } from "../../lina-core/src/index.ts";
import { appendContextEntry } from "../../lina-core/test/context-journal-fixture.ts";
import { CompanionMemory } from "../src/context/companion.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import {
	initializeSessionFile,
	type SdkSessionOptions,
	startTestApp as startPersistentApp,
} from "./fake-session-engine.ts";
import { ControlledSession } from "./runtime-fixture.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
function options() {
	const root = mkdtempSync(join(tmpdir(), "lina-app-test-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return {
		workspace: root,
		stateRoot: join(root, "state"),
		agentDir: join(root, "auth"),
		systemPrompt: "Lina",
		port: 0,
		createSession: async (options: SdkSessionOptions) => {
			const identity = initializeSessionFile(
				options.sessionFile,
				options.workspace,
			);
			return new ControlledSession(identity.sessionId, identity.sessionFile);
		},
	};
}

test("restart binds the same native session and restores uncertain requests without dispatch", async () => {
	const config = options();
	const first = await startPersistentApp(config);
	const id = first.binding.sessionId;
	first.runtime.submit("r1", "Keep this request");
	await first.stop();
	const second = await startPersistentApp(config);
	cleanups.push(second.stop);
	expect(second.binding.sessionId).toBe(id);
	expect(second.runtime.store.request("r1")?.status).toBe("interrupted");
	expect((second.runtime.native as ControlledSession).calls).toEqual([]);
});

test("working capsule survives restart and manual compaction fences durable submission", async () => {
	const config = {
		...options(),
		memoryBackend: "disabled" as const,
		enginePolicy: () => {
			const policy = defaultEnginePolicy();
			return { ...policy, context: { ...policy.context, freshTailEntries: 0 } };
		},
	};
	const pending = Promise.withResolvers<string>();
	const summarizing = Promise.withResolvers<void>();
	const create = config.createSession;
	config.createSession = async (options) => {
		const host = new CodexHost(config.workspace, () => ({ action: "allow" }));
		options.register?.(
			host.asLinaHost(),
			{
				estimateText: (text) => text.length,
				estimateMessages: (messages) => messages.length,
				systemTokens: 0,
				contextWindow: 96000,
				reserveTokens: 1000,
				summarize: async () => {
					summarizing.resolve();
					return pending.promise;
				},
				prepare: () => {
					throw Error("unused native preparation");
				},
			},
			() => ({ action: "allow" }),
		);
		return create(options);
	};
	const app = await startPersistentApp(config);
	const creatingRequest = appendContextEntry(
		app.runtime.store,
		app.binding.sessionId,
		{
			entryId: "decision",
			role: "user",
			text: "Use a dark interface",
			timestamp: "2026-09-05T00:00:00Z",
			raw: {},
		},
	);
	app.contextStore.updateWorking(
		0,
		{
			goal: "Keep the blue accent subtle",
			sourceEntryIds: ["decision"],
		},
		{ activeRequestId: creatingRequest },
	);
	app.contextStore.finalizeRequest(creatingRequest);
	const compact = app.context.compact();
	await summarizing.promise;
	expect(() =>
		app.runtime.submit("blocked", "Do not submit during compact"),
	).toThrow("compaction");
	expect(app.runtime.store.request("blocked")).toBeUndefined();
	pending.reject(new Error("Nothing to compact"));
	await expect(compact).rejects.toThrow("previous checkpoint");
	expect(app.context.snapshot().busy).toBe(false);
	await app.stop();
	const resumed = await startPersistentApp(config);
	cleanups.push(resumed.stop);
	expect(resumed.contextStore.working().goal).toBe(
		"Keep the blue accent subtle",
	);
	expect(resumed.context.snapshot().memory.service).toBe("disabled");
});

test("failed SDK startup preserves the fixed binding for a later retry", async () => {
	const config = options();
	await expect(
		startPersistentApp({
			...config,
			createSession: async () => {
				throw new Error("offline credentials");
			},
		}),
	).rejects.toThrow("offline credentials");
	const before = readFileSync(join(config.stateRoot, "binding.json"), "utf8");
	const app = await startPersistentApp(config);
	cleanups.push(app.stop);
	expect(readFileSync(join(config.stateRoot, "binding.json"), "utf8")).toBe(
		before,
	);
	expect(app.binding.sessionId).toBe(JSON.parse(before).sessionId);
});

test("legacy transcript import is rejected without changing data or creating a binding", async () => {
	const config = options();
	const original = join(config.workspace, "original.jsonl");
	initializeSessionFile(original, config.workspace);
	const bytes = readFileSync(original, "utf8");
	await expect(
		startPersistentApp({ ...config, importSession: original }),
	).rejects.toThrow("no longer supported");
	expect(readFileSync(original, "utf8")).toBe(bytes);
	expect(existsSync(config.stateRoot)).toBe(false);
	expect(existsSync(`${original}.lina-lease.sqlite`)).toBe(false);
});

test("a foreign transcript is rejected before creating an ownership sidecar", async () => {
	const config = options();
	const foreign = options();
	const file = join(foreign.workspace, "foreign.jsonl");
	initializeSessionFile(file, foreign.workspace);
	await expect(
		startPersistentApp({ ...config, importSession: file }),
	).rejects.toThrow();
	expect(existsSync(`${file}.lina-lease.sqlite`)).toBe(false);
});

test("failed native shutdown retains ownership until a successful retry", async () => {
	const config = options();
	let fail = true;
	const app = await startPersistentApp({
		...config,
		createSession: async (options) => {
			const native = await config.createSession(options);
			native.close = async () => {
				if (fail) throw new Error("close not confirmed");
			};
			return native;
		},
	});
	await expect(app.stop()).rejects.toThrow("close not confirmed");
	expect(() =>
		acquireSessionLease(config.stateRoot, "lina", config.workspace),
	).toThrow();
	fail = false;
	await app.stop();
	const lease = acquireSessionLease(config.stateRoot, "lina", config.workspace);
	lease.close();
});

test("image tools register in the Codex app with isolated state and no provider call at startup", async () => {
	const config = options();
	let host: CodexHost | undefined;
	let requests = 0;
	const create = config.createSession;
	config.createSession = async (sdkOptions) => {
		host = new CodexHost(config.workspace, () => ({ action: "allow" }));
		sdkOptions.register?.(
			host.asLinaHost(),
			{
				estimateText: (text) => text.length,
				estimateMessages: (messages) => messages.length,
				systemTokens: 0,
				contextWindow: 96000,
				reserveTokens: 1000,
				summarize: async () => "",
				prepare: () => {
					throw Error("unused");
				},
			},
			() => ({ action: "allow" }),
		);
		return create(sdkOptions);
	};
	const app = await startPersistentApp({
		...config,
		imageEngine: {
			baseUrl: "http://127.0.0.1:45678",
			fetch: async () => {
				requests++;
				throw Error("must not call on startup");
			},
		},
	});
	cleanups.push(app.stop);
	expect(host?.tools.has("lina_image_models")).toBe(true);
	expect(host?.tools.has("lina_image_generate")).toBe(true);
	expect(host?.tools.has("lina_image_edit")).toBe(true);
	expect(app.images?.list()).toEqual([]);
	expect(existsSync(join(config.stateRoot, "images/jobs.json"))).toBe(true);
	expect(requests).toBe(0);
});

for (const backend of [undefined, "disabled", "honcho"] as const) {
	test(`session memory backend ${backend ?? "default"} uses the owned retirement contract`, async () => {
		const config = options();
		const app = await startPersistentApp({
			...config,
			...(backend ? { memoryBackend: backend } : {}),
		});
		cleanups.push(app.stop);
		expect(app.memory instanceof CompanionMemory).toBe(backend !== "honcho");
		if (backend === "honcho") {
			expect(app.memory.status()).toMatchObject({
				service: "unavailable",
				migrationRequired: true,
			});
		} else if (backend === "disabled") {
			await app.memory.refresh();
			expect(app.memory.status().service).toBe("disabled");
		}
	});
}

test("legacy selection preserves existing outbox bytes through session restart", async () => {
	const config = options();
	const first = await startPersistentApp({
		...config,
		memoryBackend: "honcho",
		imageEngine: false,
	});
	const legacy = join(
		dirname(first.binding.sessionFile),
		"honcho-outbox.sqlite",
	);
	await first.stop();
	const bytes = Buffer.from("legacy outbox remains opaque to the owned engine");
	writeFileSync(legacy, bytes);
	const second = await startPersistentApp({
		...config,
		memoryBackend: "honcho",
		imageEngine: false,
	});
	cleanups.push(second.stop);
	await second.memory.refresh();
	expect(await second.memory.recall("legacy")).toBe("");
	expect(second.memory.status().migrationRequired).toBe(true);
	await second.stop();
	expect(readFileSync(legacy)).toEqual(bytes);
});

for (const backend of ["native", "disabled"] as const) {
	test(`${backend} session enforces learning policy before observation`, async () => {
		const config = options();
		let enabled = false,
			calls = 0;
		const app = await startPersistentApp({
			...config,
			memoryBackend: backend,
			imageEngine: false,
			enginePolicy: () => {
				const policy = defaultEnginePolicy();
				return { ...policy, memory: { ...policy.memory, enabled } };
			},
		});
		cleanups.push(app.stop);
		if (!(app.memory instanceof CompanionMemory))
			throw Error("missing native owner");
		app.memory.configure(async () => {
			calls++;
			return JSON.stringify({ observations: [], communicationPreferences: [] });
		});
		const append = (id: string) =>
			appendContextEntry(app.runtime.store, app.binding.sessionId, {
				entryId: id,
				role: "user",
				text: "I prefer tea",
				timestamp: "2026-09-09T00:00:00Z",
				raw: {},
			});
		append("before-enable");
		await app.memory.refresh();
		expect(calls).toBe(0);
		expect(app.memory.mind.state().records).toEqual([]);
		enabled = true;
		await app.memory.refresh();
		expect(calls).toBe(backend === "native" ? 1 : 0);
		enabled = false;
		append("after-disable");
		await app.memory.refresh();
		expect(calls).toBe(backend === "native" ? 1 : 0);
		expect(app.memory.mind.state().records).toEqual([]);
	});
}
