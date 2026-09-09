import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createSessionContextPolicy } from "../../lina-runtime/src/context-policy.ts";
import {
	COMPANION_MODEL,
	createCompanionRpc,
} from "../../lina-runtime/test/helpers/companion-codex-rpc.ts";
import { worldServices } from "../../lina-runtime/test/world-fixture.ts";
import { readCodexSessionHeader } from "../src/identity.ts";
import { createCodexSession } from "../src/session.ts";
import { contextRpc } from "./context-policy-rpc.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-context-policy-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const rpc = createCompanionRpc(root);
	cleanup.push(() => rpc.close());
	const fields = {
		purpose: "conversation" as const,
		version: 1 as const,
		agentId: "mina",
		worldId: null,
		bindingRevision: 1,
		disclosureRevision: 1,
		sourcePolicyVersion: 1,
	};
	const scopeDigest = createHash("sha256")
		.update(JSON.stringify(fields))
		.digest("hex");
	const policy = { ...fields, scopeDigest };
	const options = {
		workspace: root,
		sessionFile: join(root, "session.jsonl"),
		agentDir: root,
		systemPrompt: "base",
		services: worldServices(),
		models: {
			catalog: () => [],
			state: () => ({
				provider: "synthetic",
				model: COMPANION_MODEL,
				settingsRevision: 1,
				error: null,
			}),
			test: async () => {
				throw Error("no provider");
			},
		},
		rpc: rpc.options,
	};
	return { root, rpc, options, policy };
}

test("explicit policy refuses missing trusted readers before any native RPC", async () => {
	const f = fixture();
	const opened = createCodexSession({ ...f.options, contextPolicy: f.policy });
	void opened.then(
		(s) => {
			cleanup.push(() => s.close());
		},
		() => {},
	);
	await expect(opened).rejects.toThrow(
		/context.*(reader|callback)|currentContextPolicy/i,
	);
	expect(f.rpc.requests).toHaveLength(0);
});

test("bootstrap uses pure registered compiler without executing recall or observer", async () => {
	const f = fixture();
	let registered = false;
	let hooks = 0;
	const session = await createCodexSession({
		...f.options,
		bootstrapInstructions: () => {
			expect(registered).toBe(true);
			return "authored identity";
		},
		register(host) {
			registered = true;
			host.on("before_agent_start", () => {
				hooks++;
			});
			host.on("context", () => {
				hooks++;
			});
			host.on("agent_settled", () => {
				hooks++;
			});
		},
	});
	cleanup.push(() => session.close());
	expect(hooks).toBe(0);
	expect(
		f.rpc.requests.find((r) => r.method === "thread/start")?.params[
			"developerInstructions"
		],
	).toBe("authored identity");
	expect(readFileSync(session.sessionFile, "utf8")).not.toContain(
		"authored identity",
	);
});

test("explicit policy initializes twice without replacing Lina identity and migrates legacy journal", async () => {
	const f = fixture();
	const { initializeCodexSessionFile, readCodexSessionHeader } = await import(
		"../src/identity.ts"
	);
	f.rpc.close();
	const originalRpc = contextRpc(f.root);
	cleanup.push(() => originalRpc.close());
	const first = await createCodexSession({
		...f.options,
		rpc: originalRpc.options,
	});
	const notice = await first.appendNotice(
		{ jobId: "old-job", terminalRevision: 1 },
		"old notice",
	);
	await first.close();
	const before = readFileSync(f.options.sessionFile, "utf8")
		.split("\n")
		.slice(1)
		.join("\n");
	const id1 = initializeCodexSessionFile(
		f.options.sessionFile,
		f.root,
		f.policy,
	);
	const id2 = initializeCodexSessionFile(
		f.options.sessionFile,
		f.root,
		f.policy,
	);
	expect(id1).toEqual(id2);
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	const next = await createCodexSession({
		...f.options,
		rpc: rpc.options,
		contextPolicy: f.policy,
		currentContextPolicy: () => f.policy,
		contextExposure: () => [],
	});
	cleanup.push(() => next.close());
	expect(next.sessionId).toBe(first.sessionId);
	expect(
		await next.appendNotice(
			{ jobId: "old-job", terminalRevision: 1 },
			"duplicate",
		),
	).toBe(notice);
	expect(readFileSync(next.sessionFile, "utf8")).toContain(before);
	expect(readCodexSessionHeader(next.sessionFile, f.root)).toMatchObject({
		version: 2,
		nativeEpoch: 1,
		contextPolicy: f.policy,
		contextTransition: null,
	});
	expect(rpc.frames.filter((r) => r.method === "thread/start")).toHaveLength(1);
	expect(rpc.frames.filter((r) => r.method === "thread/resume")).toHaveLength(
		0,
	);
});

function revised(
	policy: import("../../lina-runtime/src/context-policy.ts").SessionContextPolicy,
	patch: Record<string, unknown>,
) {
	const { scopeDigest: _, ...fields } = policy;
	return createSessionContextPolicy({ ...fields, ...patch });
}
function setupNative() {
	const f = fixture();
	f.rpc.close();
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	const state = { policy: revised(f.policy, { worldId: "world-a" }) };
	const options = {
		...f.options,
		rpc: rpc.options,
		contextPolicy: state.policy,
		currentContextPolicy: () => state.policy,
		contextExposure: () => [],
		bootstrapInstructions: () => "clean authored identity",
	};
	return { ...f, rpc, state, options };
}
const admission = () => ({
	signal: new AbortController().signal,
	disposition() {},
	rejected() {},
});
async function finish(
	session: Awaited<ReturnType<typeof createCodexSession>>,
	rpc: ReturnType<typeof contextRpc>,
) {
	const pending = session.prompt("hi", admission());
	await rpc.next("turn/start");
	rpc.complete(session.threadId);
	await pending;
}

test("native context identities include originals already delivered in epoch zero", async () => {
	const f = setupNative();
	const seen: Array<readonly string[] | undefined> = [];
	const {
		contextPolicy: _policy,
		currentContextPolicy: _current,
		contextExposure: _exposure,
		...legacyOptions
	} = f.options;
	const session = await createCodexSession({
		...legacyOptions,
		register(host) {
			host.on("context", (event) => {
				seen.push(event.nativeEntryIds);
			});
		},
	});
	cleanup.push(() => session.close());
	await finish(session, f.rpc);
	const ids = session.history().map((entry) => (entry as { id: string }).id);
	await finish(session, f.rpc);
	expect(seen[0]).toEqual([]);
	expect(ids.length).toBe(2);
	expect(seen[1]).toEqual(ids);
});

test("ordinary settled notLoaded threads resume once before the idle audit", async () => {
	const f = setupNative();
	const first = await createCodexSession(f.options);
	await finish(first, f.rpc);
	const threadId = first.threadId;
	await first.close();
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	const thread = rpc.threads[0];
	if (!thread) throw Error("Missing persisted fixture thread");
	thread.status.type = "notLoaded";
	rpc.hook((frame) => {
		if (frame.method === "thread/resume") thread.status.type = "idle";
		return undefined;
	});
	const resumed = await createCodexSession({ ...f.options, rpc: rpc.options });
	cleanup.push(() => resumed.close());
	expect(resumed.threadId).toBe(threadId);
	expect(rpc.frames.filter((f) => f.method === "thread/resume")).toHaveLength(
		1,
	);
	expect(rpc.frames.filter((f) => f.method === "thread/start")).toHaveLength(0);
	await finish(resumed, rpc);
	expect(rpc.frames.filter((f) => f.method === "turn/start")).toHaveLength(1);
});

for (const status of ["inProgress", "unknown"]) {
	test(`ordinary notLoaded thread rejects ${status} history before resume`, async () => {
		const f = setupNative();
		const first = await createCodexSession(f.options);
		await finish(first, f.rpc);
		await first.close();
		const rpc = contextRpc(f.root);
		cleanup.push(() => rpc.close());
		const thread = rpc.threads[0];
		const turn = thread?.turns[0];
		if (!thread || !turn) throw Error("Missing persisted fixture history");
		thread.status.type = "notLoaded";
		turn.status = status;
		await expect(
			createCodexSession({ ...f.options, rpc: rpc.options }),
		).rejects.toThrow(/attention required/);
		expect(rpc.frames.filter((f) => f.method === "thread/resume")).toHaveLength(
			0,
		);
		expect(rpc.frames.filter((f) => f.method === "turn/start")).toHaveLength(0);
	});
}

test("same-purpose rebind, revoke and unbind rotate only native epochs and fence old callbacks", async () => {
	const f = setupNative();
	const session = await createCodexSession(f.options);
	cleanup.push(() => session.close());
	const stable = {
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
	};
	await finish(session, f.rpc);
	const firstIds = session.history().map((e) => (e as { id: string }).id);
	for (const patch of [
		{ worldId: "world-b", bindingRevision: 2 },
		{ disclosureRevision: 2 },
		{ worldId: null, bindingRevision: 3 },
	]) {
		const oldThread = session.threadId;
		f.state.policy = revised(f.state.policy, patch);
		await finish(session, f.rpc);
		expect({
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
		}).toEqual(stable);
		const count = session.history().length;
		f.rpc.emit("item/completed", {
			threadId: oldThread,
			turnId: "turn-1",
			item: { id: "late", type: "agentMessage", text: "old secret" },
		});
		expect(session.history()).toHaveLength(count);
	}
	expect(session.nativeEpoch).toBe(4);
	expect(
		new Set(session.history().map((e) => (e as { id: string }).id)).size,
	).toBe(8);
	expect(
		session
			.history()
			.slice(0, 2)
			.map((e) => (e as { id: string }).id),
	).toEqual(firstIds);
	expect(f.rpc.frames.filter((f) => f.method === "thread/start")).toHaveLength(
		4,
	);
	expect(f.rpc.frames.filter((f) => f.method === "thread/resume")).toHaveLength(
		0,
	);
});

test("lost thread acknowledgement retains pending on disk and never dispatches a second start", async () => {
	const f = setupNative();
	f.rpc.hook((frame) => {
		if (frame.method === "thread/start") {
			expect(
				readCodexSessionHeader(f.options.sessionFile, f.root).contextTransition
					?.phase,
			).toBe("pending");
			return "lose-ack";
		}
		return undefined;
	});
	await expect(createCodexSession(f.options)).rejects.toThrow(/EOF/);
	expect(f.rpc.threads).toHaveLength(1);
	const pending = readFileSync(f.options.sessionFile, "utf8");
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	await expect(
		createCodexSession({ ...f.options, rpc: rpc.options }),
	).rejects.toThrow(/Ambiguous/);
	expect(rpc.frames).toHaveLength(0);
	expect(readFileSync(f.options.sessionFile, "utf8")).toBe(pending);
});

test("exposure intent precedes transport and survives reopen and later turns without new material", async () => {
	const f = setupNative();
	let first = true;
	const options = {
		...f.options,
		contextExposure: (source: { kind: string }) =>
			source.kind === "turn" && first
				? [{ kind: "shared-growth" as const, sourceId: "growth-a" }]
				: [],
	};
	f.rpc.hook((frame) => {
		if (frame.method === "turn/start")
			expect(readFileSync(f.options.sessionFile, "utf8")).toContain(
				'"sourceId":"growth-a"',
			);
		return undefined;
	});
	const session = await createCodexSession(options);
	cleanup.push(() => session.close());
	await finish(session, f.rpc);
	first = false;
	await finish(session, f.rpc);
	expect(
		session
			.contextLineage()
			.some((r) => r.materials.some((m) => m.sourceId === "growth-a")),
	).toBe(true);
	const deliveredEntries: unknown[] = [];
	session.subscribe((event) => {
		if (
			typeof event === "object" &&
			event !== null &&
			"type" in event &&
			event.type === "entry_appended" &&
			"entry" in event
		)
			deliveredEntries.push(event.entry);
	});
	await finish(session, f.rpc);
	expect(deliveredEntries.at(-1)).toEqual(session.history().at(-1));
	const lineage = session.contextLineage();
	await session.close();
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	const reopened = await createCodexSession({ ...options, rpc: rpc.options });
	cleanup.push(() => reopened.close());
	expect(reopened.threadId).toBe(session.threadId);
	expect(reopened.contextLineage().slice(0, lineage.length)).toEqual([
		...lineage,
	]);
	expect(rpc.frames.filter((f) => f.method === "thread/start")).toHaveLength(0);
	expect(
		rpc.frames.filter((f) => f.method === "thread/inject_items"),
	).toHaveLength(1);
	const entries = reopened.history() as Array<{
		contextPolicy?: { exposureIds: string[] };
	}>;
	expect(entries.at(-1)?.contextPolicy?.exposureIds.length).toBeGreaterThan(0);
});

test("revocation during an in-flight tool blocks its serialized body and late completion", async () => {
	const f = setupNative();
	const running = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const session = await createCodexSession({
		...f.options,
		register(host) {
			host.registerTool({
				name: "fixture_read",
				label: "read",
				description: "synthetic",
				parameters: Type.Object({}),
				async execute() {
					running.resolve();
					await release.promise;
					return {
						content: [{ type: "text", text: "private body" }],
						details: { sourceId: "model-forged" },
					};
				},
			});
		},
	});
	cleanup.push(() => session.close());
	const pending = session.prompt("hi", admission());
	void pending.catch(() => {});
	await f.rpc.next("turn/start");
	const result = f.rpc.tool(session.threadId, "fixture_read", {});
	await running.promise;
	f.state.policy = revised(f.state.policy, { disclosureRevision: 2 });
	release.resolve();
	const response = await result;
	expect(JSON.stringify(response)).not.toContain("private body");
	expect(response.error).toBeDefined();
	await expect(pending).rejects.toThrow(/scope/);
	f.rpc.complete(session.threadId, "late private body");
	expect(JSON.stringify(session.history())).not.toContain("private body");
	expect(
		session
			.contextLineage()
			.some((r) => r.materials.some((m) => m.sourceId === "model-forged")),
	).toBe(false);
});

test("unknown turn acknowledgement blocks same-process retry and rebind after reopen", async () => {
	const f = setupNative();
	const session = await createCodexSession(f.options);
	cleanup.push(() => session.close());
	f.rpc.hook((frame) => {
		if (frame.method === "turn/start") {
			f.rpc.disconnect();
			return "drop";
		}
		return undefined;
	});
	await expect(session.prompt("hi", admission())).rejects.toThrow(/EOF/);
	await expect(session.prompt("again", admission())).rejects.toThrow();
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	f.state.policy = revised(f.state.policy, { bindingRevision: 2 });
	await expect(
		createCodexSession({
			...f.options,
			contextPolicy: f.state.policy,
			rpc: rpc.options,
		}),
	).rejects.toThrow(/uncertain/);
	expect(
		rpc.frames.some(
			(f) => f.method === "thread/start" || f.method === "thread/resume",
		),
	).toBe(false);
});

test("malformed v2 header fails before RPC and preserves file", async () => {
	const f = setupNative();
	const session = await createCodexSession(f.options);
	await session.close();
	const text = readFileSync(f.options.sessionFile, "utf8");
	const [line, ...rest] = text.split("\n");
	const header = JSON.parse(line ?? "");
	for (const patch of [
		{ nativeEpoch: -1 },
		{ nativeEpoch: 1.2 },
		{ version: 3 },
		{ contextPolicy: null },
		{
			contextTransition: {
				id: "bad",
				target: f.state.policy,
				phase: "pending",
			},
		},
		{ nativeThreadId: 4 },
		{ dynamicToolsResume: "maybe" },
		{ extra: true },
	]) {
		const malformed =
			JSON.stringify({ ...header, ...patch }) + "\n" + rest.join("\n");
		writeFileSync(f.options.sessionFile, malformed);
		const rpc = contextRpc(f.root);
		cleanup.push(() => rpc.close());
		await expect(
			createCodexSession({ ...f.options, rpc: rpc.options }),
		).rejects.toThrow();
		expect(rpc.frames).toHaveLength(0);
		expect(readFileSync(f.options.sessionFile, "utf8")).toBe(malformed);
	}
});

test("trusted exposure callbacks are mandatory and initial policy must match", async () => {
	const f = setupNative();
	const { contextExposure: _exposure, ...withoutExposure } = f.options;
	const { currentContextPolicy: _current, ...withoutCurrent } = f.options;
	for (const options of [
		withoutExposure,
		withoutCurrent,
		{
			...f.options,
			currentContextPolicy: () =>
				revised(f.state.policy, { disclosureRevision: 4 }),
		},
	]) {
		await expect(createCodexSession(options)).rejects.toThrow(/context|scope/i);
	}

	expect(f.rpc.frames).toHaveLength(0);
});

test("resume bootstrap injection failure blocks dispatch without calling observers", async () => {
	const f = setupNative();
	const first = await createCodexSession(f.options);
	await first.close();
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	let observed = 0;
	rpc.hook((frame) =>
		frame.method === "thread/inject_items" ? "fail" : undefined,
	);
	await expect(
		createCodexSession({
			...f.options,
			rpc: rpc.options,
			bootstrapInstructions: () => "new authored profile",
			register(host) {
				host.on("context", () => {
					observed++;
				});
				host.on("agent_settled", () => {
					observed++;
				});
			},
		}),
	).rejects.toThrow(/synthetic/);
	expect(observed).toBe(0);
	expect(rpc.frames.filter((f) => f.method === "thread/resume")).toHaveLength(
		1,
	);
	expect(
		rpc.frames.some(
			(f) => f.method === "turn/start" || f.method === "thread/start",
		),
	).toBe(false);
	const retained = readFileSync(f.options.sessionFile, "utf8");
	expect(retained).toContain('"outcome":"planned"');
});

test("a successful LIFE tool result persists trusted intent before its serialized response", async () => {
	const f = setupNative();
	f.state.policy = revised(f.state.policy, { purpose: "life" });
	const options = {
		...f.options,
		contextPolicy: f.state.policy,
		contextExposure: (source: { kind: string }) =>
			source.kind === "tool"
				? [{ kind: "disclosed-life" as const, sourceId: "trusted-material" }]
				: [],
		register(host: import("../../lina-runtime/src/host.ts").LinaHost) {
			host.registerTool({
				name: "fixture_read",
				label: "read",
				description: "read",
				parameters: Type.Object({}),
				execute() {
					return {
						content: [{ type: "text", text: "permitted LIFE body" }],
						details: { sourceId: "forged" },
					};
				},
			});
		},
	};
	const session = await createCodexSession(options);
	cleanup.push(() => session.close());
	const pending = session.prompt("hi", admission());
	await f.rpc.next("turn/start");
	const response = await f.rpc.tool(session.threadId, "fixture_read", {});
	expect(response.result).toEqual({
		contentItems: [{ type: "inputText", text: "permitted LIFE body" }],
		success: true,
	});
	const receipt = session
		.contextLineage()
		.find((r) => r.source.kind === "tool");
	expect(receipt).toMatchObject({
		outcome: "planned",
		materials: [{ kind: "disclosed-life", sourceId: "trusted-material" }],
	});
	expect(readFileSync(f.options.sessionFile, "utf8")).toContain(
		'"sourceId":"trusted-material"',
	);
	expect(JSON.stringify(response)).not.toContain("trusted-material");
	expect(JSON.stringify(session.contextLineage())).not.toContain("forged");
	f.rpc.complete(session.threadId);
	await pending;
});

test("revocation after a tool handler returns blocks its actual serialized RPC delivery", async () => {
	const f = setupNative();
	f.state.policy = revised(f.state.policy, { purpose: "life" });
	const session = await createCodexSession({
		...f.options,
		contextPolicy: f.state.policy,
		contextExposure(source) {
			if (source.kind !== "tool") return [];
			queueMicrotask(() => {
				f.state.policy = revised(f.state.policy, { disclosureRevision: 2 });
			});
			return [{ kind: "disclosed-life", sourceId: "private-1" }];
		},
		register(host) {
			host.registerTool({
				name: "fixture_read",
				label: "read",
				description: "read",
				parameters: Type.Object({}),
				execute: () => ({
					content: [{ type: "text", text: "PRIVATE BODY" }],
					details: {},
				}),
			});
		},
	});
	cleanup.push(() => session.close());
	const pending = session.prompt("hi", admission());
	void pending.catch(() => {});
	await f.rpc.next("turn/start");
	const response = await f.rpc.tool(session.threadId, "fixture_read", {});
	expect(f.state.policy.disclosureRevision).toBe(2);
	expect(JSON.stringify(response)).not.toContain("PRIVATE BODY");
	expect(response.error).toBeDefined();
	expect(
		session.contextLineage().find((r) => r.source.kind === "tool"),
	).toMatchObject({ outcome: "planned" });
	await expect(pending).rejects.toThrow(/scope changed/i);
});

test("unresolved active native run prevents scope migration before start or resume", async () => {
	const f = setupNative();
	const session = await createCodexSession(f.options);
	cleanup.push(() => session.close());
	const pending = session.prompt("hi", admission());
	void pending.catch(() => {});
	await f.rpc.next("turn/start");
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	f.state.policy = revised(f.state.policy, {
		worldId: "world-b",
		bindingRevision: 2,
	});
	const header = readFileSync(f.options.sessionFile, "utf8").split("\n")[0];
	await expect(
		createCodexSession({
			...f.options,
			rpc: rpc.options,
			contextPolicy: f.state.policy,
		}),
	).rejects.toThrow(/active|uncertain/);
	expect(
		rpc.frames.some(
			(f) => f.method === "thread/start" || f.method === "thread/resume",
		),
	).toBe(false);
	expect(readFileSync(f.options.sessionFile, "utf8").split("\n")[0]).toBe(
		header,
	);
	f.rpc.disconnect();
	await expect(pending).rejects.toThrow();
});

test("malformed exposure metadata is rejected before native resume", async () => {
	const f = setupNative();
	const session = await createCodexSession(f.options);
	await session.close();
	const lines = readFileSync(f.options.sessionFile, "utf8")
		.trimEnd()
		.split("\n");
	const index = lines.findIndex((line) =>
		line.includes('"type":"context_exposure"'),
	);
	const receipt = JSON.parse(lines[index] ?? "");
	lines[index] = JSON.stringify({
		...receipt,
		source: { ...receipt.source, modelAuthored: true },
	});
	writeFileSync(f.options.sessionFile, lines.join("\n") + "\n");
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	await expect(
		createCodexSession({ ...f.options, rpc: rpc.options }),
	).rejects.toThrow(/context policy/);
	expect(rpc.frames).toHaveLength(0);
});

test("malformed transition metadata cannot silently authorize resume", async () => {
	const f = setupNative();
	const session = await createCodexSession(f.options);
	await session.close();
	const lines = readFileSync(f.options.sessionFile, "utf8")
		.trimEnd()
		.split("\n");
	const index = lines.findIndex((line) =>
		line.includes('"type":"context_transition"'),
	);
	const transition = JSON.parse(lines[index] ?? "");
	lines[index] = JSON.stringify({
		...transition,
		prior: { ...transition.prior, nativeEpoch: -1 },
	});
	writeFileSync(f.options.sessionFile, lines.join("\n") + "\n");
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	const open = createCodexSession({ ...f.options, rpc: rpc.options });
	void open.then(
		(s) => {
			cleanup.push(() => s.close());
		},
		() => {},
	);
	await expect(open).rejects.toThrow(/transition|binding/i);
	expect(rpc.frames).toHaveLength(0);
});

test("a new process resumes the committed epoch with retained exposure and the same BotBinding and notice", async () => {
	const f = setupNative();
	const { acquireSessionLease, acquireTranscriptLease } = await import(
		"../../lina-core/src/session-binding.ts"
	);
	const { initializeCodexSessionFile } = await import("../src/identity.ts");
	const identity = initializeCodexSessionFile(
		f.options.sessionFile,
		f.root,
		f.state.policy,
	);
	const lease = acquireSessionLease(join(f.root, "state"), "mina", f.root);
	cleanup.push(() => lease.close());
	const transcript = acquireTranscriptLease(
		identity.sessionFile,
		"mina",
		f.root,
	);
	cleanup.push(() => transcript.close());
	const binding = {
		version: 1 as const,
		botId: "mina",
		workspace: f.root,
		...identity,
	};
	lease.bind(binding);
	const session = await createCodexSession(f.options);
	cleanup.push(() => session.close());
	const notice = await session.appendNotice(
		{ jobId: "retained-job", terminalRevision: 7 },
		"retained notice",
	);
	await finish(session, f.rpc);
	f.state.policy = revised(f.state.policy, {
		bindingRevision: 2,
		worldId: "world-b",
	});
	await finish(session, f.rpc);
	expect(lease.readBinding()).toEqual(binding);
	expect(
		await session.appendNotice(
			{ jobId: "retained-job", terminalRevision: 7 },
			"duplicate",
		),
	).toBe(notice);
	const ids = session.history().map((e) => (e as { id: string }).id);
	await session.close();
	transcript.close();
	lease.close();
	const script = `
 import {readCodexSessionHeader} from "./packages/lina-codex/src/identity.ts";
 import {createCodexSession} from "./packages/lina-codex/src/session.ts";
 import {contextRpc} from "./packages/lina-codex/test/context-policy-rpc.ts";
 import {worldServices} from "./packages/lina-runtime/test/world-fixture.ts";
 import {acquireSessionLease,acquireTranscriptLease} from "./packages/lina-core/src/session-binding.ts";
 import {join} from "node:path";
 const root=process.argv[1], file=join(root,"session.jsonl");
 const policy=readCodexSessionHeader(file,root).contextPolicy;
 const owner=acquireSessionLease(join(root,"state"),"mina",root), transcript=acquireTranscriptLease(file,"mina",root);
 const rpc=contextRpc(root);
 const session=await createCodexSession({workspace:root,sessionFile:file,agentDir:root,systemPrompt:"base",bootstrapInstructions:()=>"refreshed identity",services:worldServices(),models:{catalog:()=>[],state:()=>({provider:"synthetic",model:"synthetic/companion-dialogue",settingsRevision:1,error:null}),test:async()=>{throw Error("no provider")}},rpc:rpc.options,contextPolicy:policy,currentContextPolicy:()=>policy,contextExposure:()=>[]});
 console.log(JSON.stringify({id:session.sessionId,epoch:session.nativeEpoch,thread:session.threadId,ids:session.history().map(e=>e.id),binding:owner.readBinding(),notice:await session.appendNotice({jobId:"retained-job",terminalRevision:7},"duplicate"),starts:rpc.frames.filter(f=>f.method==="thread/start").length,resumes:rpc.frames.filter(f=>f.method==="thread/resume").length,lineage:session.contextLineage().length}));
 await session.close();rpc.close();transcript.close();owner.close();
 `;
	const result = Bun.spawnSync([process.execPath, "-e", script, f.root], {
		cwd: process.cwd(),
	});
	expect(result.exitCode).toBe(0);
	const restored = JSON.parse(result.stdout.toString());
	expect(restored).toMatchObject({
		id: session.sessionId,
		epoch: 2,
		thread: session.threadId,
		ids,
		binding,
		notice,
		starts: 0,
		resumes: 1,
	});
	expect(restored.lineage).toBeGreaterThan(0);
});

test("disclosure selection failure cannot send private identifiers in a tool error", async () => {
	const f = setupNative();
	const session = await createCodexSession({
		...f.options,
		contextExposure(source) {
			if (source.kind === "tool") throw Error("private-source-id");
			return [];
		},
		register(host) {
			host.registerTool({
				name: "fixture_read",
				label: "read",
				description: "fixture",
				parameters: Type.Object({}),
				execute() {
					return {
						content: [{ type: "text", text: "private body" }],
						details: {},
					};
				},
			});
		},
	});
	cleanup.push(() => session.close());
	const pending = session.prompt("hi", admission());
	await f.rpc.next("turn/start");
	const response = await f.rpc.tool(session.threadId, "fixture_read", {});
	expect(response.error).toBeDefined();
	expect(JSON.stringify(response)).not.toContain("private-source-id");
	expect(JSON.stringify(response)).not.toContain("private body");
	f.rpc.complete(session.threadId);
	await pending;
});

test("prepared context resumes once after bootstrap failure without changing stable identity", async () => {
	const f = setupNative();
	await expect(
		createCodexSession({
			...f.options,
			bootstrapInstructions() {
				throw Error("compiler unavailable");
			},
		}),
	).rejects.toThrow(/compiler/);
	const prepared = readCodexSessionHeader(f.options.sessionFile, f.root);
	expect(prepared.contextTransition?.phase).toBe("prepared");
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	const session = await createCodexSession({ ...f.options, rpc: rpc.options });
	cleanup.push(() => session.close());
	expect(session.sessionId).toBe(prepared.id);
	expect(session.nativeEpoch).toBe(1);
	expect(rpc.frames.filter((f) => f.method === "thread/start")).toHaveLength(1);
});

test("native start acknowledgement cannot bind a reused old thread ID", async () => {
	const f = setupNative();
	const session = await createCodexSession(f.options);
	cleanup.push(() => session.close());
	f.state.policy = revised(f.state.policy, { bindingRevision: 2 });
	f.rpc.hook((frame) => {
		if (frame.method === "thread/start") f.rpc.threads.splice(0);
		return undefined;
	});
	await expect(session.prompt("hi", admission())).rejects.toThrow(
		/prior thread/,
	);
	expect(
		readCodexSessionHeader(f.options.sessionFile, f.root).contextTransition
			?.phase,
	).toBe("pending");
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	await expect(
		createCodexSession({
			...f.options,
			contextPolicy: f.state.policy,
			rpc: rpc.options,
		}),
	).rejects.toThrow(/Ambiguous/);
	expect(rpc.frames).toHaveLength(0);
});

test("compaction retains exposure and fences epoch while waiting for completion", async () => {
	const f = setupNative();
	const session = await createCodexSession({
		...f.options,
		notificationTimeoutMs: 100,
	});
	cleanup.push(() => session.close());
	const lineage = session.contextLineage();
	await session.compact();
	expect(session.contextLineage()).toEqual(lineage);
});

test("acknowledged native start with failed atomic commit stays pending across reopen", async () => {
	const f = setupNative();
	const fs = await import("node:fs");
	const { spyOn } = await import("bun:test");
	let fault: ReturnType<typeof spyOn<typeof fs, "renameSync">> | undefined;
	f.rpc.hook((frame) => {
		if (frame.method === "thread/start")
			fault = spyOn(fs, "renameSync").mockImplementation(() => {
				throw Error("synthetic commit failure");
			});
		return undefined;
	});
	try {
		await expect(createCodexSession(f.options)).rejects.toThrow(
			/commit failure/,
		);
	} finally {
		fault?.mockRestore();
	}
	expect(f.rpc.threads).toHaveLength(1);
	expect(
		readCodexSessionHeader(f.options.sessionFile, f.root).contextTransition
			?.phase,
	).toBe("pending");
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	await expect(
		createCodexSession({ ...f.options, rpc: rpc.options }),
	).rejects.toThrow(/Ambiguous/);
	expect(rpc.frames).toHaveLength(0);
});

test("legacy journal without a final newline is preserved and never forwarded into the clean epoch", async () => {
	const f = setupNative();
	const { contextPolicy: _policy, ...ordinary } = f.options;
	const legacy = await createCodexSession(ordinary);
	cleanup.push(() => legacy.close());
	const pending = legacy.prompt("hi", admission());
	await f.rpc.next("turn/start");
	f.rpc.complete(legacy.threadId, "legacy private summary");
	await pending;
	await legacy.close();
	const old = readFileSync(f.options.sessionFile, "utf8").trimEnd();
	writeFileSync(f.options.sessionFile, old);
	const rpc = contextRpc(f.root);
	cleanup.push(() => rpc.close());
	const clean = await createCodexSession({ ...f.options, rpc: rpc.options });
	cleanup.push(() => clean.close());
	const journal = old.slice(old.indexOf("\n") + 1);
	expect(readFileSync(f.options.sessionFile, "utf8")).toContain(journal);
	await finish(clean, rpc);
	expect(JSON.stringify(rpc.frames)).not.toContain("legacy private summary");
	expect(clean.sessionId).toBe(legacy.sessionId);
	expect(clean.history()).toHaveLength(4);
});

test("SessionEngine forwards the same explicit policy through initialization and construction", async () => {
	const f = setupNative();
	const { createCodexEngine } = await import("../src/session.ts");
	const engine = createCodexEngine({
		services: f.options.services,
		models: f.options.models,
		rpc: f.rpc.options,
	});
	const first = await engine.initialize(
		f.options.sessionFile,
		f.root,
		f.state.policy,
	);
	const session = await engine.create(f.options);
	cleanup.push(() => session.close());
	expect(session.sessionId).toBe(first.sessionId);
	expect(readCodexSessionHeader(first.sessionFile, f.root)).toMatchObject({
		version: 2,
		nativeEpoch: 1,
		contextPolicy: f.state.policy,
	});
	expect(
		f.rpc.frames.filter((frame) => frame.method === "thread/start"),
	).toHaveLength(1);
});
