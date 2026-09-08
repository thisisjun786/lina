import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../../lina-core/src/store.ts";
import { createSessionContextPolicy } from "../../lina-runtime/src/context-policy.ts";
import type { SdkSessionOptions } from "../../lina-runtime/src/host.ts";
import { DurableRuntime } from "../../lina-runtime/src/runtime.ts";
import { worldServices } from "../../lina-runtime/test/world-fixture.ts";
import { initializeCodexSessionFile } from "../src/identity.ts";
import { createCodexSession } from "../src/session.ts";
import { contextRpc } from "./context-policy-rpc.ts";

export function sourceFixture() {
	const root = mkdtempSync(join(tmpdir(), "work-memory-transport-"));
	const identity = initializeCodexSessionFile(
		join(root, "session.jsonl"),
		root,
	);
	const binding = {
		...identity,
		version: 1 as const,
		botId: "mina",
		workspace: root,
	};
	let journal = new DurableStore(join(root, "state.sqlite"), binding);
	const state = {
		policy: createSessionContextPolicy({
			version: 1,
			purpose: "conversation",
			agentId: "mina",
			worldId: null,
			bindingRevision: 0,
			disclosureRevision: 0,
			sourcePolicyVersion: 1,
		}),
	};
	const sourcePolicy: NonNullable<SdkSessionOptions["sourcePolicy"]> = {
		recordSourceExposure: (receipt) => {
			journal.recordSourceExposure(receipt);
		},
		registerRequestSource: (origin) => {
			journal.registerRequestSource(origin);
		},
		extendRequestSource: (id, receipts) => {
			journal.extendRequestSource(id, receipts);
		},
		appendSourceEntry: (entry, id) => {
			journal.appendSourceEntry(entry, id);
		},
	};
	const options = {
		workspace: root,
		sessionFile: identity.sessionFile,
		agentDir: root,
		systemPrompt: "synthetic authored identity",
		bootstrapInstructions: () => "synthetic authored identity",
		services: worldServices(),
		models: {
			catalog: () => [],
			state: () => ({
				provider: "synthetic",
				model: "synthetic/companion-dialogue",
				settingsRevision: 1,
				error: null,
			}),
			test: async () => {
				throw Error("No live provider");
			},
		},
		currentContextPolicy: () => state.policy,
		contextExposure: () => [],
		sourcePolicy,
	};
	const cleanups: Array<() => void | Promise<void>> = [];
	return {
		root,
		binding,
		state,
		options,
		sourcePolicy,
		get journal() {
			return journal;
		},
		reopenJournal() {
			journal.close();
			journal = new DurableStore(join(root, "state.sqlite"), binding);
		},
		async open(extra: Partial<SdkSessionOptions> = {}) {
			const rpc = contextRpc(root);
			cleanups.push(() => rpc.close());
			const session = await createCodexSession({
				...options,
				contextPolicy: state.policy,
				...extra,
				rpc: rpc.options,
			});
			cleanups.push(() => session.close());
			return {
				rpc,
				session,
				tool(name: string, turnId: string | undefined, args: unknown = {}) {
					const id = `source-tool-${rpc.frames.length}`;
					rpc.options.stdio.output.write(
						JSON.stringify({
							id,
							method: "item/tool/call",
							params: {
								threadId: session.threadId,
								...(turnId ? { turnId } : {}),
								tool: name,
								callId: id,
								arguments: args,
							},
						}) + "\n",
					);
					return rpc.next(`response:${id}`);
				},
			};
		},
		runtime(session: Awaited<ReturnType<typeof createCodexSession>>) {
			const runtime = new DurableRuntime(session, journal, binding);
			cleanups.push(() => runtime.detach());
			return runtime;
		},
		async close() {
			for (const close of cleanups.reverse()) await close();
			journal.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function settled(runtime: DurableRuntime, requestId: string) {
	const done = Promise.withResolvers<void>();
	const off = runtime.subscribe(() => {
		if (
			["settled", "interrupted", "rejected"].includes(
				runtime.store.request(requestId)?.status ?? "",
			)
		) {
			off();
			done.resolve();
		}
	});
	return done.promise;
}

export function conversationV3(worldId: string | null = null) {
	return createSessionContextPolicy({
		version: 3,
		purpose: "conversation",
		agentId: "mina",
		worldId,
		bindingRevision: worldId ? 1 : 0,
		disclosureRevision: worldId ? 1 : 0,
		sourcePolicyVersion: 1,
		conversationRecipientId: worldId ? "reader" : null,
	});
}
