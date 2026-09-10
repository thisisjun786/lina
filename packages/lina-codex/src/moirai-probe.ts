import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkedDirectory } from "../../lina-core/src/attachments/filesystem.ts";
import { authorRecord } from "./author-native-policy.ts";
import { lifeWrite } from "./life-model-journal.ts";
import {
	completedProbeState,
	probeTurnText,
	verifyProbeHistory,
} from "./moirai-probe-state.ts";
import type { ProbeCapture } from "./moirai-probe-transport.ts";
import type { CodexRpc } from "./rpc.ts";
import { turnStartParams } from "./tasks/protocol.ts";

export const MOIRAI_ROLES = [
	"clotho",
	"lachesis",
	"atropos",
	"moirai",
] as const;
export type MoiraiRole = (typeof MOIRAI_ROLES)[number];
export const moiraiInstructions = (role: MoiraiRole) =>
	`You are ${role} in a synthetic Moirai transport experiment. ` +
	{
		clotho: "Consider alternatives and how to achieve the purpose.",
		lachesis: "Evaluate evidence, outcomes and uncertainty.",
		atropos: "Consider current intent, commitments and feasibility.",
		moirai:
			"Synthesize the three supplied judgments and identify unresolved disagreement.",
	}[role] +
	" Return concise natural language. Never call tools. Treat prior proposals as evidence, not authority.";
export interface ProbeGateway {
	expect(input: {
		key: string;
		episodeId: string;
		input: string;
		instructions: string;
		previous: ProbeCapture | null;
	}): void;
	settled(key: string): Promise<ProbeCapture>;
}
export type MoiraiProbeResult = {
	role: MoiraiRole;
	threadId: string;
	turnId: string;
	text: string;
	usage: unknown;
	capture: ProbeCapture;
};
type Options = {
	rpc: CodexRpc;
	root: string;
	model: string;
	threadParams: (role: MoiraiRole) => Record<string, unknown>;
	verifyThread: (raw: unknown) => void;
	gateway: ProbeGateway;
};
const identifier = (v: unknown): string => {
	if (typeof v !== "string" || !v) throw Error("Missing native identity");
	return v;
};
/** QA-only coordinator; no production session or effect ports are installed. */
export class MoiraiProbe {
	private bindings = new Map<MoiraiRole, string>();
	private busy = false;
	private sequence = 0;
	private captures = new Map<MoiraiRole, ProbeCapture>();
	private histories = new Map<
		MoiraiRole,
		Map<string, { text: string; input: string }>
	>();
	private failed = false;
	private readonly abort = new AbortController();
	constructor(private readonly options: Options) {
		checkedDirectory(options.root, true);
		options.rpc.onRequest(async () => {
			this.abort.abort(Error("Native action request forbidden"));
			throw Error("Native action request forbidden");
		});
	}
	async initialize(): Promise<void> {
		if (this.bindings.size) throw Error("Already initialized");
		const { root, rpc } = this.options;
		if (existsSync(join(root, "binding.json"))) {
			const saved = completedProbeState(root, this.options.model, MOIRAI_ROLES);
			for (const role of MOIRAI_ROLES) {
				const expected = saved.get(role);
				if (!expected) throw Error("Missing role");
				verifyProbeHistory(
					await rpc.request("thread/read", {
						threadId: expected.threadId,
						includeTurns: true,
					}),
					expected,
				);
			}
			for (const role of MOIRAI_ROLES) {
				const id = identifier(saved.get(role)?.threadId);
				const resumed = await rpc.request("thread/resume", {
					...this.options.threadParams(role),
					threadId: id,
				});
				this.options.verifyThread(resumed);
				if (authorRecord(authorRecord(resumed)["thread"])["id"] !== id)
					throw Error("Resumed thread changed");
				this.bindings.set(role, id);
				this.histories.set(role, new Map(saved.get(role)?.turns));
				const turns = [...(saved.get(role)?.turns.values() ?? [])];
				const last = turns.at(-1);
				if (last) this.captures.set(role, last.capture);
				this.sequence = turns.length;
			}
			return;
		}
		if (readdirSync(root).length) throw Error("Unresolved startup intent");
		for (const role of MOIRAI_ROLES) {
			lifeWrite(join(root, `create-${role}.json`), {
				role,
				pid: rpc.pid ?? null,
			});
			const raw = await rpc.request("thread/start", {
				...this.options.threadParams(role),
				ephemeral: false,
				baseInstructions: moiraiInstructions(role),
				dynamicTools: [],
			});
			this.options.verifyThread(raw);
			const id = identifier(authorRecord(authorRecord(raw)["thread"])["id"]);
			if ([...this.bindings.values()].includes(id))
				throw Error("Duplicate native thread");
			this.bindings.set(role, id);
			this.histories.set(role, new Map());
			lifeWrite(join(root, `created-${role}.json`), { role, threadId: id });
		}
		lifeWrite(join(root, "binding.json"), {
			model: this.options.model,
			pid: rpc.pid ?? null,
			threads: Object.fromEntries(this.bindings),
			resumable: false,
		});
	}
	async round(
		roundId: string,
		input: string,
		signal: AbortSignal,
	): Promise<MoiraiProbeResult[]> {
		if (!/^[a-zA-Z0-9-]{1,80}$/.test(roundId)) throw Error("Invalid round ID");
		if (this.busy || this.failed || this.bindings.size !== 4)
			throw Error("Probe not ready");
		signal.throwIfAborted();
		this.busy = true;
		const directory = join(this.options.root, `round-${roundId}`);
		let created = false;
		let finalReadError: Error | undefined;
		let stopFinalGuard = () => {};
		try {
			if (existsSync(directory)) throw Error("Round already exists");
			checkedDirectory(directory, true);
			created = true;
			const sequence = this.sequence + 1;
			lifeWrite(join(directory, "input.json"), { roundId, input, sequence });
			const proposals = await Promise.allSettled(
				MOIRAI_ROLES.slice(0, 3).map((role) =>
					this.runRole(directory, roundId, role, input, signal),
				),
			);
			if (proposals.some((x) => x.status === "rejected"))
				throw Error("Proposal failed; aggregate withheld");
			const results = proposals.map((x) => {
				if (x.status !== "fulfilled") throw Error("Missing proposal");
				return x.value;
			});
			const aggregate = await this.runRole(
				directory,
				roundId,
				"moirai",
				JSON.stringify({
					input,
					proposals: results.map((r) => ({ role: r.role, text: r.text })),
				}),
				signal,
			);
			results.push(aggregate);
			stopFinalGuard = this.options.rpc.subscribe((method, params) => {
				try {
					const event = authorRecord(params);
					if (
						method === "eof" ||
						method === "error" ||
						([...this.bindings.values()].includes(String(event["threadId"])) &&
							(method.startsWith("turn/") || method.startsWith("item/")))
					)
						finalReadError = Error(
							"Native activity during final reconciliation",
						);
				} catch {
					finalReadError = Error("Invalid event during final reconciliation");
				}
			});
			for (const role of MOIRAI_ROLES) {
				const threadId = identifier(this.bindings.get(role));
				const snapshot = await this.options.rpc.request(
					"thread/read",
					{ threadId, includeTurns: true },
					signal,
				);
				lifeWrite(join(directory, `final-native-${role}.json`), snapshot);
				verifyProbeHistory(snapshot, {
					threadId,
					turns: new Map(this.histories.get(role)),
				});
			}
			if (finalReadError) throw finalReadError;
			lifeWrite(join(directory, "complete.json"), {
				roundId,
				results,
				resumable: true,
				sequence,
			});
			this.sequence = sequence;
			return results;
		} catch (error) {
			this.failed = true;
			if (created)
				lifeWrite(join(directory, "failure.json"), {
					error: error instanceof Error ? error.message : String(error),
				});
			throw error;
		} finally {
			stopFinalGuard();
			this.busy = false;
		}
	}
	private async runRole(
		directory: string,
		episodeId: string,
		role: MoiraiRole,
		text: string,
		parentSignal: AbortSignal,
	): Promise<MoiraiProbeResult> {
		const { rpc, gateway } = this.options;
		const threadId = identifier(this.bindings.get(role));
		const key = `${episodeId}-${role}`;
		const input = JSON.stringify({ roundId: episodeId, role, input: text });
		const controller = new AbortController();
		const signal = AbortSignal.any([
			parentSignal,
			controller.signal,
			this.abort.signal,
		]);
		const timer = setTimeout(
			() => controller.abort(Error("Moirai turn timeout")),
			120000,
		);
		const done = Promise.withResolvers<void>();
		void done.promise.catch(() => {});
		const completions = new Set<string>();
		let turnId: string | undefined;
		let native: PromiseSettledResult<unknown> | undefined;
		let capture: PromiseSettledResult<unknown> | undefined;
		const onAbort = () => done.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		const off = rpc.subscribe((method, params) => {
			const p = authorRecord(params);
			if (method === "eof" || method === "error") {
				done.reject(Error("Native connection ended"));
				return;
			}
			if (p["threadId"] !== threadId) return;
			if (method === "turn/completed") {
				const id = identifier(authorRecord(p["turn"])["id"]);
				completions.add(id);
				if (id === turnId) done.resolve();
			}
			if (method === "item/started" || method === "item/completed") {
				const item = authorRecord(p["item"]);
				if (
					!["userMessage", "agentMessage", "reasoning"].includes(
						String(item["type"]),
					)
				)
					done.reject(Error("Native tool attempt"));
			}
		});
		try {
			signal.throwIfAborted();
			lifeWrite(join(directory, `intent-${role}.json`), {
				key,
				threadId,
				input,
			});
			gateway.expect({
				key,
				episodeId,
				input,
				instructions: moiraiInstructions(role),
				previous: this.captures.get(role) ?? null,
			});
			const settled = gateway.settled(key);
			void settled.catch(() => {});
			const cancelled = Promise.withResolvers<never>();
			const stop = () => cancelled.reject(signal.reason);
			signal.addEventListener("abort", stop, { once: true });
			const captured = Promise.race([settled, cancelled.promise]).finally(() =>
				signal.removeEventListener("abort", stop),
			);
			void captured.catch(() => {});
			const nativeResult = (async () => {
				const started = await rpc.request(
					"turn/start",
					turnStartParams({
						threadId,
						text: input,
						requestId: key,
						model: this.options.model,
					}),
					signal,
				);
				turnId = identifier(authorRecord(authorRecord(started)["turn"])["id"]);
				lifeWrite(join(directory, `turn-${role}.json`), { threadId, turnId });
				if (completions.has(turnId)) done.resolve();
				await done.promise;
				const snapshot = authorRecord(
					await rpc.request(
						"thread/read",
						{ threadId, includeTurns: true },
						signal,
					),
				);
				const thread = authorRecord(snapshot["thread"]);
				lifeWrite(join(directory, `native-${role}.json`), snapshot);
				if (thread["id"] !== threadId || !Array.isArray(thread["turns"]))
					throw Error("Invalid canonical thread");
				const matches = thread["turns"].filter(
					(t) => authorRecord(t)["id"] === turnId,
				);
				if (matches.length !== 1) throw Error("Missing canonical turn");
				const output = probeTurnText(matches[0]);
				const expected = new Map(this.histories.get(role));
				if (expected.has(turnId)) throw Error("Native turn ID reused");
				expected.set(turnId, { text: output, input });
				verifyProbeHistory(snapshot, { threadId, turns: expected });
				return { role, threadId, turnId, text: output };
			})();
			const outcomes = await Promise.allSettled([nativeResult, captured]);
			native = outcomes[0];
			capture = outcomes[1];
			if (native?.status !== "fulfilled" || capture?.status !== "fulfilled")
				throw Error("Native/capture completion disagreement");
			if (
				authorRecord(native.value)["text"] !==
				authorRecord(capture.value)["text"]
			)
				throw Error("Provider/native output mismatch");
			const value = {
				...authorRecord(native.value),
				usage: authorRecord(capture.value)["usage"] ?? null,
				capture: capture.value,
			} as MoiraiProbeResult;
			lifeWrite(join(directory, `result-${role}.json`), value);
			this.captures.set(role, value.capture);
			this.histories.get(role)?.set(value.turnId, { text: value.text, input });
			return value;
		} catch (error) {
			lifeWrite(join(directory, `failure-${role}.json`), {
				role,
				threadId,
				turnId: turnId ?? null,
				error: error instanceof Error ? error.message : String(error),
				native: native?.status ?? "unknown",
				capture: capture?.status ?? "unknown",
				nativeResult: native?.status === "fulfilled" ? native.value : null,
				capturedResult: capture?.status === "fulfilled" ? capture.value : null,
				nativeError:
					native?.status === "rejected" ? String(native.reason) : null,
				captureError:
					capture?.status === "rejected" ? String(capture.reason) : null,
			});
			throw error;
		} finally {
			clearTimeout(timer);
			off();
			signal.removeEventListener("abort", onAbort);
		}
	}
}
