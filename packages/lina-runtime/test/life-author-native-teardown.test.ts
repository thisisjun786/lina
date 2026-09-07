import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorldAuthorEngine } from "../../lina-codex/src/author-capabilities.ts";
import * as rpcModule from "../../lina-codex/src/rpc.ts";
import {
	acquireSessionLease,
	acquireTranscriptLease,
} from "../../lina-core/src/index.ts";
import type { WorldAuthorGrant } from "../../lina-core/src/world/authoring-types.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import {
	createWorldAuthorSession,
	type WorldAuthorSession,
} from "../src/life/author-session.ts";
import type { WorldAuthoring } from "../src/life/authoring.ts";

// Opt in to installed Codex + Bubblewrap. All provider responses are local synthetic data.
const nativeTest =
	process.env["LINA_AUTHOR_NATIVE_TEST"] === "1" ? test : test.skip;

function responseStream(item: Record<string, unknown>) {
	const response = {
		id: randomUUID(),
		object: "response",
		created_at: 1,
		status: "completed",
		output: [item],
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
	};
	const events = [
		{
			type: "response.created",
			response: { ...response, status: "in_progress", output: [] },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, content: [] },
		},
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response },
	];
	return new Response(
		events
			.map(
				(event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

nativeTest.each(["direct", "discovered"] as const)(
	"%s native tool approval: revoke closes owned process before releasing author stores and leases",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "lina-author-native-teardown-"));
		const clients: rpcModule.CodexRpc[] = [];
		const exited = new Set<rpcModule.CodexRpc>();
		let author: WorldAuthorSession | undefined;
		let ownershipAtExit:
			| {
					session: boolean;
					transcript: boolean;
					journal: boolean;
					controls: boolean;
			  }
			| undefined;
		const held = (acquire: () => { close(): void }) => {
			try {
				acquire().close();
				return false;
			} catch {
				return true;
			}
		};
		const createRpc = rpcModule.createCodexRpc;
		const observe = spyOn(rpcModule, "createCodexRpc").mockImplementation(
			async (options) => {
				const client = await createRpc(options);
				clients.push(client);
				const close = client.close.bind(client);
				client.close = async () => {
					await close();
					if (author && !exited.has(client)) {
						const current = author;
						ownershipAtExit = {
							session: held(() =>
								acquireSessionLease(
									join(
										root,
										"state",
										"life",
										"author-sessions",
										current.grant.id,
									),
									current.grant.agentId,
									current.binding.workspace,
								),
							),
							transcript: held(() =>
								acquireTranscriptLease(
									current.binding.sessionFile,
									current.grant.agentId,
									current.binding.workspace,
								),
							),
							journal: Array.isArray(current.runtime.store.history().messages),
							controls: Array.isArray(current.execution.snapshot().approvals),
						};
					}
					exited.add(client);
				};
				return client;
			},
		);
		let draftId = "";
		let providerCalls = 0;
		let discovered: ReturnType<WorldAuthoring["overview"]> | undefined;
		const providerFailure = Promise.withResolvers<Error>();
		const provider = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				providerCalls++;
				const callId = randomUUID();
				if (mode === "discovered" && providerCalls === 1)
					return responseStream({
						type: "function_call",
						id: callId,
						call_id: callId,
						name: "lina_world_draft_read",
						arguments: JSON.stringify({ query: "overview" }),
					});
				if (mode === "discovered") {
					try {
						const body = (await request.json()) as {
							input: Array<{ type: string; output?: unknown }>;
						};
						const output = body.input
							.filter((item) => item.type === "function_call_output")
							.at(-1)?.output;
						const text =
							typeof output === "string"
								? output
								: Array.isArray(output)
									? output.map((item) => item.text).join("")
									: "";
						discovered = JSON.parse(text) as ReturnType<
							WorldAuthoring["overview"]
						>;
						if (!discovered.drafts.items[0])
							throw Error("Missing native discovery result");
					} catch (error) {
						providerFailure.resolve(
							error instanceof Error ? error : Error(String(error)),
						);
						return new Response("Invalid synthetic tool result", {
							status: 400,
						});
					}
				}
				return responseStream({
					type: "function_call",
					id: callId,
					call_id: callId,
					name: "lina_world_draft_edit",
					arguments: JSON.stringify({
						draftId: discovered?.drafts.items[0]?.id ?? draftId,
						expectedRevision: discovered?.drafts.items[0]?.revision ?? 1,
						patch: { authoredText: "Must never be committed", pack: null },
					}),
				});
			},
		});
		const metadata = {
			slug: "author-teardown",
			display_name: "Synthetic author",
			description: "Local synthetic only",
			base_instructions: "Use the author tool.",
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
		const selected = {
			id: "synthetic",
			provider: "opencodex",
			model: metadata.slug,
			reasoning: "off" as const,
		};
		const origin = `http://127.0.0.1:${provider.port}`;
		const connection = {
			origin,
			baseUrl: `${origin}/v1`,
			catalogJson: JSON.stringify({ models: [metadata] }),
			catalogSource: "hub" as const,
			requiresAdmissionToken: false,
			tokenEnv: "OPENCODEX_API_AUTH_TOKEN" as const,
			providerTable: "unused",
		};
		const fleet = new AgentFleet({
			workspace: process.cwd(),
			stateRoot: join(root, "state"),
			agentDir: join(root, "ordinary"),
			systemPrompt: "Ordinary sessions forbidden",
			ownsInstallation: () => true,
			createApp: async () => {
				throw Error("Ordinary sessions forbidden");
			},
			createWorldAuthor: async (input) => {
				const ready = await createWorldAuthorEngine({
					nativeRoot: join(input.stateRoot, "native"),
					grantId: input.grant.id,
					agentId: input.grant.agentId,
					worldId: input.grant.worldId,
					connection,
					selected,
					currentSelection: () => {
						input.service.assertScope({
							grantId: input.grant.id,
							grantRevision: input.grant.revision,
						});
						return { connection, selected };
					},
					models: {
						catalog: () => [],
						state: () => ({
							provider: selected.provider,
							model: selected.model,
							settingsRevision: 1,
							error: null,
						}),
						test: async () => {
							throw Error("No provider test");
						},
					},
				});
				author = await createWorldAuthorSession({ ...input, ...ready });
				return author;
			},
		});
		const server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
			lazy: true,
		});
		const send = (path: string, body?: unknown) =>
			fetch(`http://127.0.0.1:${server.port}/api/life${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		try {
			const draft = fleet.life.create({
				worldId: "test-world",
				authoredText: "Original source",
			});
			draftId = draft.id;
			const opened = await send("/author-sessions", {
				worldId: draft.worldId,
				agentId: "lina",
			});
			expect(opened.status).toBe(201);
			const { grant } = (await opened.json()) as { grant: WorldAuthorGrant };
			if (!author) throw Error("Missing actual author session");
			const session = author;
			const nativeClient = clients.at(-1);
			if (!nativeClient?.pid) throw Error("Missing owned native process");
			const waiting = Promise.withResolvers<void>();
			const off = session.execution.subscribe((snapshot) => {
				if (snapshot.approvals.some((approval) => approval.state === "pending"))
					waiting.resolve();
			});
			expect(
				(
					await send(`/author-sessions/${grant.id}/input`, {
						requestId: "native-turn",
						text: "Change the draft",
					})
				).status,
			).toBe(202);
			await Promise.race([
				waiting.promise,
				providerFailure.promise.then((error) => {
					throw error;
				}),
			]);
			off();
			const pending = session
				.controls()
				.approvals.find((approval) => approval.state === "pending");
			if (!pending) throw Error("Missing actual native approval");
			expect(providerCalls).toBe(mode === "discovered" ? 2 : 1);
			if (mode === "discovered") {
				expect(discovered).toMatchObject({
					worldId: draft.worldId,
					modelSettingsRevision: fleet.modelSettings.snapshot().revision,
					drafts: { items: [{ id: draftId, revision: draft.revision }] },
				});
				expect(session.controls().approvals).toHaveLength(1);
			}
			// A native abort fence may reject, or the interrupted tool may settle first.
			// Both paths must finish disposal before the HTTP response returns.
			const revoked = await send(`/author-sessions/${grant.id}/revoke`, {
				expectedRevision: grant.revision,
			});
			expect([200, 403]).toContain(revoked.status);
			expect(fleet.life.store.worldAuthorGrant(grant.id).status).toBe(
				"revoked",
			);
			expect(exited.has(nativeClient)).toBe(true);
			expect(ownershipAtExit).toEqual({
				session: true,
				transcript: true,
				journal: true,
				controls: true,
			});
			expect(() => process.kill(nativeClient.pid as number, 0)).toThrow(
				"ESRCH",
			);
			expect(() => process.kill(-(nativeClient.pid as number), 0)).toThrow(
				"ESRCH",
			);
			expect(fleet.life.read(draftId).authoredText).toBe("Original source");
			expect(
				(
					await send(`/author-sessions/${grant.id}/approval`, {
						id: pending.id,
						inputDigest: pending.inputDigest,
						decision: "allow",
					})
				).status,
			).toBeGreaterThanOrEqual(400);
			expect(
				(await send(`/author-sessions/${grant.id}/history`)).status,
			).toBeGreaterThanOrEqual(400);
			expect(() => session.runtime.store.history()).toThrow();
			expect(() => session.execution.snapshot()).toThrow();
			const lease = acquireSessionLease(
				join(root, "state", "life", "author-sessions", grant.id),
				grant.agentId,
				session.binding.workspace,
			);
			const transcript = acquireTranscriptLease(
				session.binding.sessionFile,
				grant.agentId,
				session.binding.workspace,
			);
			transcript.close();
			lease.close();
			await fleet.close();
		} finally {
			// Emergency test cleanup also runs on RED, after all assertions: never strand a probe.
			for (const client of clients) await client.close();
			observe.mockRestore();
			if (author) {
				author.runtime.close = async () => {
					author?.runtime.detach();
				};
				await author.stop();
			}
			await server.stop();
			await provider.stop(true);
			rmSync(root, { recursive: true, force: true });
		}
	},
	120_000,
);
