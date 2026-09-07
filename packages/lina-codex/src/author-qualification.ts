import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	verifyAuthorNative,
	verifyAuthorThread,
} from "./author-native-checks.ts";
import {
	AUTHOR_PROFILE,
	type AuthorNativePlan,
	authorConfig,
	authorRecord,
	authorRpcOptions,
} from "./author-native-policy.ts";
import { type CodexRpc, createCodexRpc } from "./rpc.ts";

export type AuthorQualificationReceipt = Readonly<{
	version: 1;
	fingerprint: string;
	qualifiedAt: string;
	root: string;
	provider: "synthetic-localhost";
	paidProviderCalls: 0;
	allowedAuthorCalls: number;
	forbiddenCallsRejected: number;
	openChecks: number;
	modelRequests: number;
	networkTraps: number;
	canaryUnchanged: boolean;
	canaryLeaked: boolean;
	threadId: string;
	catalogDigests: string[];
}>;
const qualified = new Map<string, Promise<AuthorQualificationReceipt>>();
const READ_TOOL = "lina_author_read";
const READ_RESULT = "SYNTHETIC_ALLOWED_AUTHOR_RESULT";

function inspectCatalog(value: unknown): void {
	if (!Array.isArray(value))
		throw Error("Author qualification model tool catalog is missing");
	let read = false;
	for (const raw of value) {
		const tool = authorRecord(raw);
		if (tool["type"] === "function" && tool["name"] === READ_TOOL) {
			read = true;
			continue;
		}
		// Codex may retain this empty discovery namespace; packages are independently checked.
		if (
			tool["type"] === "namespace" &&
			tool["name"] === "skills" &&
			Array.isArray(tool["tools"]) &&
			tool["tools"].every((raw: unknown) => {
				const t = authorRecord(raw);
				return (
					t["type"] === "function" &&
					(t["name"] === "list" || t["name"] === "read")
				);
			})
		)
			continue;
		throw Error("Forbidden native capability in author model catalog");
	}
	if (!read)
		throw Error("Allowed author RPC is missing from the model catalog");
}
function responseStream(item: Record<string, unknown>): Response {
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
			.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

/** Cache authority is process-private. Persisted receipts are evidence, never admission input. */
export async function qualifyAuthorNative(
	plan: AuthorNativePlan,
): Promise<AuthorQualificationReceipt> {
	let pending = qualified.get(plan.fingerprint);
	if (!pending) {
		pending = runQualification(plan);
		qualified.set(plan.fingerprint, pending);
		try {
			return await pending;
		} catch (error) {
			qualified.delete(plan.fingerprint);
			throw error;
		}
	}
	return pending;
}

async function runQualification(
	original: AuthorNativePlan,
): Promise<AuthorQualificationReceipt> {
	const base = mkdtempSync(join(tmpdir(), "lina-author-qualification-"));
	const root = join(base, "native"),
		home = join(root, "codex-home"),
		workspace = join(root, "workspace");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	mkdirSync(workspace, { mode: 0o700 });
	const plan = { ...original, root, home, workspace };
	const canary = join(base, "outside.txt"),
		marker = `SYNTHETIC_OUTSIDE_${randomUUID()}`;
	writeFileSync(canary, marker, { mode: 0o600 });
	let rpc: CodexRpc | undefined;
	let failure: Error | undefined;
	let done: PromiseWithResolvers<void> | undefined;
	let attack = "",
		callId = "",
		sendAttack = false;
	let traps = 0,
		requests = 0,
		allowed = 0,
		forbidden = 0,
		openChecks = 0;
	let leaked = false,
		threadId = "";
	const catalogDigests = new Set<string>();
	const outputs = new Map<string, string>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			try {
				const path = new URL(req.url).pathname;
				if (path === "/trap") {
					traps++;
					return new Response("network trap");
				}
				if (req.method !== "POST" || path !== "/v1/responses")
					throw Error("Unexpected synthetic qualification endpoint");
				const data = authorRecord(await req.json());
				requests++;
				const body = JSON.stringify(data);
				leaked ||= body.includes(marker);
				inspectCatalog(data["tools"]);
				catalogDigests.add(
					new Bun.CryptoHasher("sha256")
						.update(JSON.stringify(data["tools"]))
						.digest("hex"),
				);
				if (Array.isArray(data["input"]))
					for (const raw of data["input"]) {
						const item = authorRecord(raw);
						if (
							typeof item["call_id"] === "string" &&
							typeof item["output"] === "string"
						)
							outputs.set(item["call_id"], item["output"]);
					}
				let item: Record<string, unknown> = {
					id: randomUUID(),
					type: "message",
					role: "assistant",
					status: "completed",
					phase: "final_answer",
					content: [
						{
							type: "output_text",
							text: "Synthetic complete",
							annotations: [],
						},
					],
				};
				if (sendAttack) {
					sendAttack = false;
					item =
						attack === "apply_patch"
							? {
									type: "custom_tool_call",
									id: callId,
									call_id: callId,
									name: attack,
									input: `*** Begin Patch\n*** Delete File: ${canary}\n*** End Patch`,
								}
							: {
									type: "function_call",
									id: callId,
									call_id: callId,
									name: attack,
									arguments: JSON.stringify(
										attack === "exec_command"
											? {
													cmd: `cat '${canary}'; printf changed >> '${canary}'; curl -s http://127.0.0.1:${server.port}/trap`,
													yield_time_ms: 1000,
													max_output_tokens: 1000,
												}
											: {},
									),
								};
				}
				return responseStream(item);
			} catch (error) {
				failure =
					error instanceof Error ? error : Error("Qualification failed");
				done?.reject(failure);
				return new Response("Qualification rejected", { status: 500 });
			}
		},
	});
	plan.selection = {
		...original.selection,
		connection: {
			...original.selection.connection,
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
			requiresAdmissionToken: false,
		},
	};
	writeFileSync(
		join(home, "models.json"),
		JSON.stringify({ models: [plan.metadata] }),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(home, "config.toml"),
		authorConfig(plan, `http://127.0.0.1:${server.port}/v1`, true),
		{ mode: 0o600 },
	);
	try {
		for (let open = 0; open < 2; open++) {
			rpc = await createCodexRpc(authorRpcOptions(plan));
			rpc.onRequest(async (method, params) => {
				if (
					method === "item/tool/call" &&
					authorRecord(params)["tool"] === READ_TOOL
				) {
					allowed++;
					return {
						contentItems: [{ type: "inputText", text: READ_RESULT }],
						success: true,
					};
				}
				failure = Error("Unexpected native RPC during author qualification");
				done?.reject(failure);
				throw failure;
			});
			rpc.subscribe((method, params) => {
				if (method === "turn/completed") {
					if (
						authorRecord(authorRecord(params)["turn"])["status"] !== "completed"
					)
						done?.reject(Error("Synthetic author turn failed"));
					else done?.resolve();
				}
				if (method === "eof")
					done?.reject(Error("Author qualification native EOF"));
			});
			await rpc.request("initialize", {
				clientInfo: { name: "lina-author-qualification", version: "1" },
				capabilities: { experimentalApi: true },
			});
			rpc.notify("initialized");
			await verifyAuthorNative(rpc, plan);
			openChecks++;
			const bound = await rpc.request(
				open === 0 ? "thread/start" : "thread/resume",
				{
					...(open === 0
						? {
								dynamicTools: [
									{
										name: READ_TOOL,
										description: "Read synthetic author data",
										inputSchema: {
											type: "object",
											properties: {},
											additionalProperties: false,
										},
									},
								],
							}
						: { threadId }),
					...AUTHOR_PROFILE,
					cwd: workspace,
					model: plan.selection.selected.model,
					modelProvider: "opencodex",
				},
			);
			verifyAuthorThread(bound, plan);
			const id = authorRecord(authorRecord(bound)["thread"])["id"];
			if (typeof id !== "string" || (threadId && threadId !== id))
				throw Error("Author qualification resume changed native identity");
			threadId = id;
			for (const scenario of ["exec_command", "apply_patch", READ_TOOL]) {
				attack = scenario;
				callId = randomUUID();
				sendAttack = true;
				done = Promise.withResolvers();
				void done.promise.catch(() => undefined);
				const timeout = setTimeout(
					() => done?.reject(Error("Author synthetic qualification timed out")),
					15000,
				);
				try {
					await rpc.request("turn/start", {
						threadId,
						input: [
							{
								type: "text",
								text: "Run the synthetic qualification response.",
							},
						],
					});
					await done.promise;
					if (failure) throw failure;
					const output = outputs.get(callId) ?? "";
					if (scenario === READ_TOOL) {
						if (!output.includes(READ_RESULT))
							throw Error("Allowed author RPC failed its positive control");
					} else {
						if (!/unsupported.*(call|tool)|unknown.*tool/i.test(output))
							throw Error("Forced native call was not explicitly rejected");
						forbidden++;
					}
				} finally {
					clearTimeout(timeout);
					done = undefined;
				}
			}
			await rpc.close();
			rpc = undefined;
		}
		const unchanged = readFileSync(canary, "utf8") === marker;
		if (traps || leaked || !unchanged || allowed !== 2 || forbidden !== 4)
			throw Error("Author isolation failed native qualification");
		const receipt: AuthorQualificationReceipt = {
			version: 1,
			fingerprint: original.fingerprint,
			qualifiedAt: new Date().toISOString(),
			root: base,
			provider: "synthetic-localhost",
			paidProviderCalls: 0,
			allowedAuthorCalls: allowed,
			forbiddenCallsRejected: forbidden,
			openChecks,
			modelRequests: requests,
			networkTraps: traps,
			canaryUnchanged: unchanged,
			canaryLeaked: leaked,
			threadId,
			catalogDigests: [...catalogDigests],
		};
		writeFileSync(
			join(base, "receipt.json"),
			JSON.stringify(receipt, null, 2),
			{ mode: 0o600 },
		);
		return Object.freeze(receipt);
	} catch (error) {
		writeFileSync(
			join(base, "failure.json"),
			JSON.stringify({
				fingerprint: original.fingerprint,
				error: error instanceof Error ? error.message : "Qualification failed",
				paidProviderCalls: 0,
			}),
			{ mode: 0o600 },
		);
		throw error;
	} finally {
		await rpc?.close();
		server.stop(true);
	}
}
