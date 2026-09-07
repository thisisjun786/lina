import { afterEach, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { IsolatedHomeConnection } from "../../lina-opencodex/src/hub.ts";
import { createSessionContextPolicy } from "../../lina-runtime/src/context-policy.ts";
import type { ModelControl } from "../../lina-runtime/src/models/port.ts";
import { createWorldAuthorEngine } from "../src/author-capabilities.ts";
import { initializeCodexSessionFile } from "../src/identity.ts";
import * as rpcModule from "../src/rpc.ts";
import { authorRpcFixture } from "./author-rpc-fixture.ts";

// Explicit local native qualification; ordinary CI needs no Codex/Bubblewrap install.
const nativeTest =
	process.env["LINA_AUTHOR_NATIVE_TEST"] === "1" ? test : test.skip;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const metadata = {
	slug: "author-probe",
	display_name: "Synthetic author",
	description: "Local synthetic only",
	base_instructions: "Return the synthetic response.",
	supported_reasoning_levels: [],
	default_reasoning_level: null,
	shell_type: "unified_exec",
	priority: 0,
	support_verbosity: false,
	truncation_policy: { mode: "bytes", limit: 10000 },
	experimental_supported_tools: [],
	context_window: 32000,
	input_modalities: ["text"],
	visibility: "list",
	supported_in_api: true,
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-author-factory-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	let realCalls = 0;
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			realCalls++;
			return new Response("Unexpected configured provider call", {
				status: 500,
			});
		},
	});
	cleanup.push(() => provider.stop(true));
	const selected = {
		id: "synthetic",
		provider: "opencodex",
		model: metadata.slug,
		reasoning: "off" as const,
	};
	let connection: IsolatedHomeConnection = {
		origin: `http://127.0.0.1:${provider.port}`,
		baseUrl: `http://127.0.0.1:${provider.port}/v1`,
		catalogJson: JSON.stringify({ models: [metadata] }),
		catalogSource: "hub",
		requiresAdmissionToken: false,
		tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
		providerTable: "must not be trusted as config",
	};
	const models: ModelControl = {
		catalog: () => [],
		state: () => ({
			provider: selected.provider,
			model: selected.model,
			settingsRevision: 1,
			error: null,
		}),
		test: async () => {
			throw Error("No provider");
		},
	};
	const input = {
		nativeRoot: join(root, "native"),
		grantId: "grant-1",
		agentId: "mina",
		worldId: "island",
		connection,
		selected,
		models,
		currentSelection: () => ({ connection, selected }),
	};
	return {
		root,
		input,
		calls: () => realCalls,
		changeMetadata() {
			connection = {
				...connection,
				catalogJson: JSON.stringify({
					models: [{ ...metadata, shell_type: "shell_command" }],
				}),
			};
		},
	};
}

nativeTest(
	"real author factory qualifies fresh/restart forced native calls with zero configured-provider traffic",
	async () => {
		const f = fixture();
		const ready = await createWorldAuthorEngine(f.input);
		expect(ready.capabilityPolicyDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(f.calls()).toBe(0);
		const receipts = readdirSync(join(f.input.nativeRoot, "qualification"));
		expect(receipts.length).toBeGreaterThan(0);
		const receipt = JSON.parse(
			readFileSync(
				join(f.input.nativeRoot, "qualification", receipts[0] as string),
				"utf8",
			),
		);
		expect(receipt.allowedAuthorCalls).toBe(2);
		expect(receipt.forbiddenCallsRejected).toBe(4);
		expect(receipt.networkTraps).toBe(0);
		expect(receipt.canaryUnchanged).toBe(true);
		expect(receipt.canaryLeaked).toBe(false);
		expect(receipt.openChecks).toBe(2);
		const policy = createSessionContextPolicy({
			purpose: "world-author",
			version: 2,
			agentId: f.input.agentId,
			worldId: f.input.worldId,
			bindingRevision: 1,
			disclosureRevision: 1,
			sourcePolicyVersion: 1,
			authorGrantId: f.input.grantId,
			capabilityPolicyDigest: ready.capabilityPolicyDigest,
		});
		const options = {
			workspace: ready.workspace,
			agentDir: f.root,
			sessionFile: join(f.root, "session.jsonl"),
			agentId: "mina",
			systemPrompt: "Synthetic author only",
			contextPolicy: policy,
			currentContextPolicy: () => policy,
			contextExposure: () => [],
			register(host: import("../../lina-runtime/src/host.ts").LinaHost) {
				host.registerTool({
					name: "lina_world_draft_read",
					label: "Read",
					description: "Read the bound synthetic draft",
					parameters: Type.Object({}),
					execute: () => ({
						content: [{ type: "text", text: "draft" }],
						details: {},
					}),
				});
			},
		};
		const initialized = await ready.engine.initialize(
			options.sessionFile,
			options.workspace,
			policy,
		);
		const first = await ready.engine.create(options);
		expect(first.sessionId).toBe(initialized.sessionId);
		await first.close();
		const second = await ready.engine.create(options);
		cleanup.push(() => second.close());
		expect(second.sessionId).toBe(first.sessionId);
		expect(f.calls()).toBe(0);
		f.changeMetadata();
		await expect(
			second.prompt("must not reach transport", {
				signal: new AbortController().signal,
				disposition() {},
				rejected() {},
			}),
		).rejects.toThrow(/fingerprint|selection|capability/i);
		expect(f.calls()).toBe(0);
	},
	60000,
);

test("factory fails closed on absent isolation executable and never falls back", async () => {
	const f = fixture();
	await expect(
		createWorldAuthorEngine({
			...f.input,
			wrapperCommand: "/missing/lina-synthetic-bwrap",
		}),
	).rejects.toThrow();
	expect(f.calls()).toBe(0);
	expect(existsSync(join(f.root, "session.jsonl"))).toBe(false);
});

nativeTest(
	"native policy drift cannot reuse a qualified factory",
	async () => {
		const f = fixture();
		const ready = await createWorldAuthorEngine(f.input);
		writeFileSync(
			join(f.input.nativeRoot, "codex-home", "config.toml"),
			'approval_policy = "on-request"',
		);
		await expect(
			ready.engine.create({
				workspace: ready.workspace,
				sessionFile: join(f.root, "session.jsonl"),
				agentDir: f.root,
				systemPrompt: "base",
			}),
		).rejects.toThrow(/capability|fingerprint|config/i);
		expect(f.calls()).toBe(0);
	},
	60000,
);

nativeTest(
	"qualified session RPC denies native approvals, rejects unbound tools, and guards the serialized reply",
	async () => {
		const f = fixture();
		const ready = await createWorldAuthorEngine(f.input);
		const rpc = authorRpcFixture(
			f.root,
			ready.workspace,
			readFileSync(join(f.input.nativeRoot, "codex-home/config.toml"), "utf8"),
			metadata.slug,
		);
		cleanup.push(() => rpc.close());
		const original = rpcModule.createCodexRpc;
		const replacement = spyOn(rpcModule, "createCodexRpc").mockImplementation(
			() => original(rpc.options),
		);
		cleanup.push(() => replacement.mockRestore());
		const policy = createSessionContextPolicy({
			purpose: "world-author",
			version: 2,
			agentId: "mina",
			worldId: "island",
			bindingRevision: 1,
			disclosureRevision: 1,
			sourcePolicyVersion: 1,
			authorGrantId: "grant-1",
			capabilityPolicyDigest: ready.capabilityPolicyDigest,
		});
		let revoked = false,
			executed = 0,
			ask = 0;
		const toolEntered = Promise.withResolvers<void>(),
			toolReleased = Promise.withResolvers<void>();
		const session = await ready.engine.create({
			...{ permissions: () => ({ action: "allow" as const }) },
			workspace: ready.workspace,
			sessionFile: join(f.root, "session.jsonl"),
			agentDir: f.root,
			systemPrompt: "base",
			contextPolicy: policy,
			currentContextPolicy: () => {
				if (revoked) throw Error("Revoked synthetic grant");
				return policy;
			},
			contextExposure: () => [{ kind: "author-world", sourceId: "draft:1" }],
			register(host) {
				host.on("tool_call", () => {
					ask++;
				});
				host.registerTool({
					name: "lina_world_draft_read",
					label: "Read",
					description: "Read",
					parameters: Type.Object({ late: Type.Optional(Type.Boolean()) }),
					async execute(_id, args) {
						executed++;
						if (args.late) {
							toolEntered.resolve();
							await toolReleased.promise;
						}
						return {
							content: [
								{ type: "text", text: "SYNTHETIC_AUTHOR_PRIVATE_RESULT" },
							],
							details: {},
						};
					},
				});
			},
		});
		cleanup.push(() => session.close());
		const start = rpc.frames.find((frame) => frame.method === "thread/start");
		expect(start?.params["permissions"]).toBe("author");
		expect(start?.params["approvalPolicy"]).toBe("never");
		expect(start?.params["sandbox"]).toBeUndefined();
		expect(start?.params["environments"]).toEqual([]);
		expect(start?.params["selectedCapabilityRoots"]).toEqual([]);
		const running = session.prompt("read the draft", {
			signal: new AbortController().signal,
			disposition() {},
			rejected() {},
		});
		void running.catch(() => undefined);
		await rpc.next("turn/start");
		const threadId = rpc.threads[0]?.id as string;
		for (const method of [
			"item/commandExecution/requestApproval",
			"item/fileChange/requestApproval",
		])
			expect((await rpc.request(method, threadId)).result).toEqual({
				decision: "decline",
			});
		expect(
			(await rpc.request("item/permissions/requestApproval", threadId)).result,
		).toEqual({ permissions: {}, scope: "turn" });
		expect(
			(
				await rpc.request("item/tool/call", threadId, {
					tool: "bash",
					arguments: {},
				})
			).error,
		).toBeDefined();
		expect(
			(
				await rpc.request("item/tool/call", threadId, {
					tool: "lina_world_draft_edit",
					arguments: {},
				})
			).error,
		).toBeDefined();
		expect(ask).toBe(0);
		expect(executed).toBe(0);
		expect(
			(await rpc.tool(threadId, "lina_world_draft_read", {})).result,
		).toMatchObject({ success: true });
		expect(executed).toBe(1);
		const late = rpc.tool(threadId, "lina_world_draft_read", { late: true });
		await toolEntered.promise;
		revoked = true;
		toolReleased.resolve();
		const reply = await late;
		expect(reply.result).toBeUndefined();
		expect(JSON.stringify(reply)).not.toContain(
			"SYNTHETIC_AUTHOR_PRIVATE_RESULT",
		);
		expect(reply.error).toBeDefined();
		await expect(running).rejects.toThrow(/scope|attention/);
		expect(
			rpc.frames.filter((frame) => frame.method === "model/list"),
		).toHaveLength(1);
		expect(f.calls()).toBe(0);
	},
	60000,
);

nativeTest(
	"author initialization cannot adopt an unrestricted legacy journal",
	async () => {
		const f = fixture();
		const ready = await createWorldAuthorEngine(f.input);
		const file = join(f.root, "legacy.jsonl");
		initializeCodexSessionFile(file, ready.workspace);
		const before = readFileSync(file, "utf8");
		const policy = createSessionContextPolicy({
			purpose: "world-author",
			version: 2,
			agentId: "mina",
			worldId: "island",
			authorGrantId: "grant-1",
			capabilityPolicyDigest: ready.capabilityPolicyDigest,
			bindingRevision: 1,
			disclosureRevision: 1,
			sourcePolicyVersion: 1,
		});
		expect(() =>
			ready.engine.initialize(file, ready.workspace, policy),
		).toThrow(/weaker|author.*context/i);
		expect(readFileSync(file, "utf8")).toBe(before);
	},
	60000,
);

for (const bad of ["skills", "mcp", "profile", "provider"] as const)
	nativeTest(
		`qualified author refuses ${bad} drift on native open`,
		async () => {
			const f = fixture();
			const ready = await createWorldAuthorEngine(f.input);
			const rpc = authorRpcFixture(
				f.root,
				ready.workspace,
				readFileSync(
					join(f.input.nativeRoot, "codex-home/config.toml"),
					"utf8",
				),
				metadata.slug,
			);
			rpc.state(bad);
			cleanup.push(() => rpc.close());
			const original = rpcModule.createCodexRpc;
			const replacement = spyOn(rpcModule, "createCodexRpc").mockImplementation(
				() => original(rpc.options),
			);
			cleanup.push(() => replacement.mockRestore());
			const policy = createSessionContextPolicy({
				purpose: "world-author",
				version: 2,
				agentId: "mina",
				worldId: "island",
				bindingRevision: 1,
				disclosureRevision: 1,
				sourcePolicyVersion: 1,
				authorGrantId: "grant-1",
				capabilityPolicyDigest: ready.capabilityPolicyDigest,
			});
			await expect(
				ready.engine.create({
					workspace: ready.workspace,
					sessionFile: join(f.root, "session.jsonl"),
					agentDir: f.root,
					systemPrompt: "base",
					contextPolicy: policy,
					currentContextPolicy: () => policy,
					contextExposure: () => [],
				}),
			).rejects.toThrow(/author.*(skills|MCP|capability)/i);
			expect(rpc.frames.some((frame) => frame.method === "turn/start")).toBe(
				false,
			);
			expect(f.calls()).toBe(0);
		},
		60000,
	);
