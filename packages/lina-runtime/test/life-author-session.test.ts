import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost } from "../../lina-codex/src/host.ts";
import { createCodexRpc } from "../../lina-codex/src/rpc.ts";
import { contextRpc } from "../../lina-codex/test/context-policy-rpc.ts";
import type { ControlSnapshot } from "../../lina-core/src/control/index.ts";
import {
	acquireSessionLease,
	acquireTranscriptLease,
} from "../../lina-core/src/index.ts";
import type { WorldAuthorGrant } from "../../lina-core/src/world/authoring-types.ts";
import type { ContextServices } from "../src/context/port.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import type { SdkSessionOptions } from "../src/host.ts";
import {
	createWorldAuthorSession,
	type WorldAuthorFactoryOptions,
	type WorldAuthorSession,
} from "../src/life/author-session.ts";
import { testSessionEngine } from "./fake-session-engine.ts";
import { ControlledSession } from "./runtime-fixture.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
type Runner = {
	host: CodexHost;
	native: ControlledSession;
	options: SdkSessionOptions;
	started: Promise<void>;
	transport: ReturnType<typeof contextRpc>;
	threadId: string;
};
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-author-session-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const runners = new Map<string, Runner>();
	let forbiddenCalls = 0;
	const fail = () => {
		forbiddenCalls++;
		throw Error("Memory and ordinary sessions are forbidden");
	};
	const services: ContextServices = {
		estimateText: (text) => text.length,
		estimateMessages: (messages) => messages.length,
		systemTokens: 0,
		contextWindow: 32000,
		reserveTokens: 1000,
		summarize: fail,
		prepare: fail,
	};
	const createWorldAuthor = async (input: WorldAuthorFactoryOptions) => {
		const workspace = join(input.stateRoot, "native", "workspace");
		mkdirSync(workspace, { recursive: true });
		const engine = testSessionEngine();
		engine.create = async (options) => {
			const identity = await engine.initialize(
				options.sessionFile,
				workspace,
				options.contextPolicy,
			);
			const native = new ControlledSession(
				identity.sessionId,
				identity.sessionFile,
			);
			const host = new CodexHost(workspace, () => ({ action: "allow" }));
			options.register?.(host.asLinaHost(), services, host.permissions);
			// Explicit test engine; real RPC serialization still crosses the process boundary fixture.
			const transport = contextRpc(workspace);
			const rpc = await createCodexRpc(transport.options);
			const previous = transport.threads[0];
			const { thread } = await rpc.request<{ thread: { id: string } }>(
				previous ? "thread/resume" : "thread/start",
				{
					...(previous ? { threadId: previous.id } : {}),
					developerInstructions: options.bootstrapInstructions?.(),
					dynamicTools: [...host.tools.keys()],
				},
			);
			const turnController = new AbortController();
			const guard = () => {
				const current = options.currentContextPolicy?.();
				if (current?.scopeDigest !== options.contextPolicy?.scopeDigest)
					throw Error("Author context changed");
			};
			rpc.onRequest(async (method, raw, beforeSend) => {
				beforeSend(guard);
				guard();
				if (
					method !== "item/tool/call" ||
					!raw ||
					typeof raw !== "object" ||
					!("tool" in raw) ||
					!("callId" in raw) ||
					!("arguments" in raw) ||
					typeof raw.tool !== "string" ||
					typeof raw.callId !== "string"
				)
					throw Error("Unexpected fixture tool");
				return host.invokeTool(
					raw.tool,
					raw.callId,
					raw.arguments,
					turnController.signal,
					guard,
				);
			});
			const abort = native.abort.bind(native);
			native.abort = async () => {
				turnController.abort();
				await abort();
			};
			native.close = async () => {
				await rpc.close();
				transport.close();
			};
			const started = Promise.withResolvers<void>();
			native.onPrompt = async (text, admission) => {
				guard();
				await rpc.request(
					"turn/start",
					{ threadId: thread.id, input: [{ type: "text", text }] },
					admission.signal,
				);
				admission.disposition("started");
				native.emit({ type: "agent_start" });
				native.user("author-input", text);
				started.resolve();
			};
			runners.set(input.grant.id, {
				host,
				native,
				options,
				started: started.promise,
				transport,
				threadId: thread.id,
			});
			return native;
		};
		return createWorldAuthorSession({
			...input,
			engine,
			workspace,
			capabilityPolicyDigest: "a".repeat(64),
		});
	};
	const open = () =>
		new AgentFleet({
			workspace: process.cwd(),
			stateRoot: root,
			agentDir: join(root, "ordinary-auth"),
			systemPrompt: "ordinary-secret-marker",
			ownsInstallation: () => true,
			createApp: fail,
			createWorldAuthor,
		});
	let fleet = open();
	let server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
		lazy: true,
	});
	cleanup.push(() => server.stop());
	const send = (path: string, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${server.port}/api/life${path}`, {
			method,
			headers: { "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const draft = fleet.life.create({
		worldId: "test-world",
		authoredText: "Private author source",
	});
	return {
		root,
		draft,
		send,
		runners,
		fleet: () => fleet,
		forbiddenCalls: () => forbiddenCalls,
		async reopen() {
			await server.stop();
			fleet = open();
			server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
				lazy: true,
			});
		},
	};
}
function assessed(author: WorldAuthorSession): Promise<ControlSnapshot> {
	return new Promise((resolve) => {
		const off = author.execution.subscribe((state) => {
			if (state.approvals.some((approval) => approval.state === "pending")) {
				off();
				resolve(state);
			}
		});
	});
}

test("dedicated HTTP grant/input/read/approval uses real runtime and isolated author history", async () => {
	const f = await fixture();
	const created = await f.send("/author-sessions", "POST", {
		worldId: "test-world",
		agentId: "lina",
	});
	expect(created.status).toBe(201);
	const { grant } = (await created.json()) as { grant: WorldAuthorGrant };
	const author = await f.fleet().openWorldAuthor(grant.id);
	const runner = f.runners.get(grant.id);
	if (!runner) throw Error("Missing trusted author runner");
	expect(author.binding.sessionFile).toStartWith(
		join(f.root, "life", "author-sessions", grant.id),
	);
	expect(runner.options.systemPrompt).not.toContain("ordinary-secret-marker");
	expect([...runner.host.tools.keys()]).toHaveLength(8);
	expect(runner.options.contextPolicy).toMatchObject({
		purpose: "world-author",
		version: 2,
		authorGrantId: grant.id,
		capabilityPolicyDigest: "a".repeat(64),
	});
	expect(
		(
			await f.send(`/author-sessions/${grant.id}/input`, "POST", {
				requestId: "author-turn",
				text: "Keep this author-only history",
			})
		).status,
	).toBe(202);
	await runner.started;
	const controller = new AbortController();
	const read = await runner.host.invokeTool(
		"lina_world_draft_read",
		"read-1",
		{ draftId: f.draft.id },
		controller.signal,
	);
	expect(read.success).toBe(true);
	expect(author.controls().approvals).toHaveLength(0);
	const pendingApproval = assessed(author);
	const mutation = runner.host.invokeTool(
		"lina_world_draft_edit",
		"edit-1",
		{
			draftId: f.draft.id,
			expectedRevision: f.draft.revision,
			patch: { authoredText: "Explicitly changed", pack: null },
		},
		controller.signal,
	);
	const approval = (await pendingApproval).approvals.find(
		(item) => item.state === "pending",
	);
	if (!approval) throw Error("Missing actual approval");
	expect(f.fleet().life.read(f.draft.id).authoredText).toBe(
		"Private author source",
	);
	expect(
		(
			await f.send(`/author-sessions/${grant.id}/approval`, "POST", {
				id: approval.id,
				inputDigest: approval.inputDigest,
				decision: "allow",
			})
		).status,
	).toBe(200);
	expect((await mutation).success).toBe(true);
	expect(f.fleet().life.read(f.draft.id).authoredText).toBe(
		"Explicitly changed",
	);
	const sessionId = author.binding.sessionId;
	await f.reopen();
	expect(
		(await f.send(`/author-sessions/${grant.id}/open`, "POST", {})).status,
	).toBe(200);
	const reopened = await f.fleet().openWorldAuthor(grant.id);
	expect(reopened.binding.sessionId).toBe(sessionId);
	expect(
		JSON.stringify(
			await (await f.send(`/author-sessions/${grant.id}/history`)).json(),
		),
	).toContain("Keep this author-only history");
	expect(f.fleet().opened("lina")).toBeUndefined();
	expect(f.forbiddenCalls()).toBe(0);
	for (const name of [
		"mind.sqlite",
		"honcho-outbox.sqlite",
		"context.sqlite",
		"tasks.sqlite",
	])
		expect(
			existsSync(join(f.root, "life", "author-sessions", grant.id, name)),
		).toBe(false);
});

test("HTTP input and approval drive serialized author RPC with real coordinator and bound draft tools", async () => {
	const f = await fixture();
	const created = await f.send("/author-sessions", "POST", {
		worldId: "test-world",
		agentId: "lina",
	});
	expect(created.status).toBe(201);
	const { grant } = (await created.json()) as { grant: WorldAuthorGrant };
	const author = await f.fleet().openWorldAuthor(grant.id);
	const runner = f.runners.get(grant.id);
	if (!runner) throw Error("Missing author runner");
	await f.send(`/author-sessions/${grant.id}/input`, "POST", {
		requestId: "rpc-turn",
		text: "Inspect and edit my world",
	});
	await runner.started;
	const sent = await runner.transport.next("turn/start");
	expect(sent.params["input"]).toEqual([
		{ type: "text", text: "Inspect and edit my world" },
	]);
	const read = await runner.transport.tool(
		runner.threadId,
		"lina_world_draft_read",
		{ draftId: f.draft.id },
	);
	expect(read.result).toMatchObject({ success: true });
	expect(JSON.stringify(read.result)).toContain("Private author source");
	expect(author.controls().approvals).toHaveLength(0);
	const waiting = assessed(author);
	const mutation = runner.transport.tool(
		runner.threadId,
		"lina_world_draft_edit",
		{
			draftId: f.draft.id,
			expectedRevision: f.draft.revision,
			patch: { authoredText: "RPC approved source", pack: null },
		},
	);
	const approval = (await waiting).approvals.find(
		(item) => item.state === "pending",
	);
	if (!approval) throw Error("Missing actual approval");
	expect(f.fleet().life.read(f.draft.id).authoredText).toBe(
		"Private author source",
	);
	await f.send(`/author-sessions/${grant.id}/approval`, "POST", {
		id: approval.id,
		inputDigest: approval.inputDigest,
		decision: "allow",
	});
	expect((await mutation).result).toMatchObject({ success: true });
	expect(f.fleet().life.read(f.draft.id).authoredText).toBe(
		"RPC approved source",
	);
	expect(f.forbiddenCalls()).toBe(0);
});

test("dedicated author factory holds both leases and releases them on close", async () => {
	const f = await fixture();
	const grant = f.fleet().grantWorldAuthor("test-world", "lina");
	const author = await f.fleet().openWorldAuthor(grant.id);
	const stateRoot = join(f.root, "life", "author-sessions", grant.id);
	expect(() =>
		acquireSessionLease(stateRoot, grant.agentId, author.binding.workspace),
	).toThrow();
	expect(() =>
		acquireTranscriptLease(
			author.binding.sessionFile,
			grant.agentId,
			author.binding.workspace,
		),
	).toThrow();
	await author.stop();
	const lease = acquireSessionLease(
		stateRoot,
		grant.agentId,
		author.binding.workspace,
	);
	const transcript = acquireTranscriptLease(
		author.binding.sessionFile,
		grant.agentId,
		author.binding.workspace,
	);
	expect(lease.readBinding()?.sessionId).toBe(author.binding.sessionId);
	transcript.close();
	lease.close();
});

test("persisted revocation invalidates pending approval, tools, history and reopen before cancellation", async () => {
	const f = await fixture();
	const created = await f.send("/author-sessions", "POST", {
		worldId: "test-world",
		agentId: "lina",
	});
	const { grant } = (await created.json()) as { grant: WorldAuthorGrant };
	const author = await f.fleet().openWorldAuthor(grant.id);
	const runner = f.runners.get(grant.id);
	if (!runner) throw Error("Missing author runner");
	author.submit("pending-turn", "edit the draft");
	await runner.started;
	const pendingApproval = assessed(author);
	const mutation = runner.host.invokeTool(
		"lina_world_draft_edit",
		"edit-revoked",
		{
			draftId: f.draft.id,
			expectedRevision: f.draft.revision,
			patch: { authoredText: "Forbidden late edit", pack: null },
		},
		new AbortController().signal,
	);
	const approval = (await pendingApproval).approvals.find(
		(item) => item.state === "pending",
	);
	if (!approval) throw Error("Missing approval");
	const originalAbort = runner.native.abort.bind(runner.native);
	runner.native.abort = async () => {
		expect(f.fleet().life.store.worldAuthorGrant(grant.id).status).toBe(
			"revoked",
		);
		await originalAbort();
	};
	expect(
		(
			await f.send(`/author-sessions/${grant.id}/revoke`, "POST", {
				expectedRevision: grant.revision,
			})
		).status,
	).toBe(200);
	expect((await mutation).success).toBe(false);
	expect(
		(
			await f.send(`/author-sessions/${grant.id}/approval`, "POST", {
				id: approval.id,
				inputDigest: approval.inputDigest,
				decision: "allow",
			})
		).status,
	).toBe(403);
	expect((await f.send(`/author-sessions/${grant.id}/history`)).status).toBe(
		403,
	);
	expect(
		(await f.send(`/author-sessions/${grant.id}/open`, "POST", {})).status,
	).toBe(403);
	expect(f.fleet().life.read(f.draft.id).authoredText).toBe(
		"Private author source",
	);
	expect(
		(
			await runner.host.invokeTool(
				"lina_world_draft_read",
				"late-read",
				{ draftId: f.draft.id },
				new AbortController().signal,
			)
		).success,
	).toBe(false);
	const second = (await (
		await f.send("/author-sessions", "POST", {
			worldId: "test-world",
			agentId: "lina",
		})
	).json()) as { grant: WorldAuthorGrant };
	expect(second.grant.id).not.toBe(grant.id);
	expect(
		(await f.fleet().openWorldAuthor(second.grant.id)).history().messages,
	).toHaveLength(0);
	expect(readdirSync(join(f.root, "life", "author-sessions"))).toHaveLength(2);
});
