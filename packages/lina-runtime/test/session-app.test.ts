import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost } from "../../lina-codex/src/host.ts";
import { acquireSessionLease } from "../../lina-core/src/index.ts";
import { appendContextEntry } from "../../lina-core/test/context-journal-fixture.ts";
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
	const config = options();
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
