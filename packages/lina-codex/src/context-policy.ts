import { randomUUID } from "node:crypto";
import {
	parseSessionContextExposure,
	parseSessionContextMaterials,
	parseSessionContextPolicy,
	type SessionContextExposure,
	type SessionContextPolicy,
	type SessionContextSource,
} from "../../lina-runtime/src/context-policy.ts";
import type { SdkSessionOptions } from "../../lina-runtime/src/host.ts";
import {
	appendCodexJournal,
	type CodexNativeBinding,
	loadCodexJournal,
	readCodexContextBindings,
	readCodexSessionHeader,
} from "./identity.ts";

type ContextRun = {
	type: "context_run";
	version: 1;
	requestId: string;
	nativeEpoch: number;
	threadId: string;
	turnId: string | null;
	status: "pending" | "active" | "settled" | "attention";
};
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validateContextOptions(
	options: SdkSessionOptions,
): SessionContextPolicy | undefined {
	if (options.contextPolicy === undefined) return;
	const policy = parseSessionContextPolicy(options.contextPolicy);
	if (!options.currentContextPolicy || !options.contextExposure)
		throw new Error(
			"Explicit context policy requires currentContextPolicy and contextExposure callbacks",
		);
	if (
		parseSessionContextPolicy(options.currentContextPolicy()).scopeDigest !==
		policy.scopeDigest
	)
		throw new Error("Initial context policy does not match current scope");
	return policy;
}

/** Native transport lineage. All receipts originate here, never in model text. */
export class CodexContextPolicy {
	private readonly exposures = new Map<string, SessionContextExposure>();
	private readonly runs = new Map<string, ContextRun>();
	private policy: SessionContextPolicy | undefined;
	private readonly bindings = new Map<number, CodexNativeBinding>();
	nativeEpoch = 0;
	requestId: string | undefined;
	constructor(
		private readonly options: SdkSessionOptions,
		private readonly file: string,
		private readonly workspace: string,
	) {
		this.policy = validateContextOptions(options);
		for (const binding of readCodexContextBindings(file, workspace))
			this.bindings.set(binding.nativeEpoch, binding);
		for (const item of loadCodexJournal(file)) {
			if (!object(item)) continue;
			if (item["type"] === "context_exposure") {
				const receipt = parseSessionContextExposure(item);
				if (
					this.bindings.get(receipt.nativeEpoch)?.contextPolicy?.scopeDigest !==
					receipt.scopeDigest
				)
					throw new Error("Invalid context exposure binding");
				const previous = this.exposures.get(receipt.id);
				if (!previous && receipt.outcome !== "planned")
					throw new Error("Context exposure is missing its delivery intent");
				if (
					previous &&
					(previous.outcome !== "planned" ||
						receipt.outcome !== "delivered" ||
						JSON.stringify({ ...previous, outcome: "delivered" }) !==
							JSON.stringify(receipt))
				)
					throw new Error("Invalid context exposure lineage");
				this.exposures.set(receipt.id, receipt);
			}
			if (item["type"] === "context_run") {
				if (
					Object.keys(item).length !== 7 ||
					item["version"] !== 1 ||
					typeof item["requestId"] !== "string" ||
					!item["requestId"] ||
					typeof item["nativeEpoch"] !== "number" ||
					!Number.isSafeInteger(item["nativeEpoch"]) ||
					item["nativeEpoch"] < 1 ||
					typeof item["threadId"] !== "string" ||
					!item["threadId"] ||
					typeof item["status"] !== "string" ||
					(item["turnId"] !== null && typeof item["turnId"] !== "string") ||
					!["pending", "active", "settled", "attention"].includes(
						String(item["status"]),
					)
				)
					throw new Error("Invalid context run metadata");
				const run = item as ContextRun;
				if (
					this.bindings.get(run.nativeEpoch)?.nativeThreadId !== run.threadId ||
					(run.status === "pending" && run.turnId !== null) ||
					(run.status === "active" && !run.turnId)
				)
					throw new Error("Invalid context run binding");
				const prior = this.runs.get(run.requestId);
				if (
					prior &&
					(prior.nativeEpoch !== run.nativeEpoch ||
						prior.threadId !== run.threadId ||
						prior.status === "settled")
				)
					throw new Error("Invalid context run lineage");
				this.runs.set(run.requestId, run);
			}
			if (
				item["type"] === "context_attention" &&
				(Object.keys(item).length !== 5 ||
					item["version"] !== 1 ||
					item["reason"] !== "unresolved-native-run" ||
					typeof item["nativeThreadId"] !== "string" ||
					typeof item["nativeEpoch"] !== "number" ||
					!Number.isSafeInteger(item["nativeEpoch"]) ||
					item["nativeEpoch"] < 0)
			)
				throw new Error("Invalid context attention metadata");
		}
	}
	get uncertain(): boolean {
		return [...this.runs.values()].some((run) => run.status !== "settled");
	}
	get explicit(): boolean {
		return this.policy !== undefined;
	}
	current(): SessionContextPolicy | undefined {
		if (!this.policy) return;
		try {
			return parseSessionContextPolicy(this.options.currentContextPolicy?.());
		} catch {
			throw new Error("Current context policy is unavailable");
		}
	}
	adopt(policy: SessionContextPolicy | undefined, epoch: number): void {
		this.policy = policy;
		this.nativeEpoch = epoch;
		if (policy)
			this.bindings.set(epoch, {
				nativeEpoch: epoch,
				nativeThreadId: null,
				contextPolicy: policy,
			});
		for (const receipt of this.exposures.values()) {
			if (
				receipt.nativeEpoch === epoch &&
				receipt.scopeDigest !== policy?.scopeDigest
			)
				throw new Error(
					"Retained context exposure is incompatible; attention required",
				);
		}
	}
	assertCurrent(): void {
		if (!this.policy) return;
		if (this.current()?.scopeDigest !== this.policy.scopeDigest)
			throw new Error(
				"Context scope changed; native context requires reconciliation",
			);
		const header = readCodexSessionHeader(this.file, this.workspace);
		if (
			(header.nativeEpoch ?? 0) !== this.nativeEpoch ||
			header.contextTransition ||
			header.contextPolicy?.scopeDigest !== this.policy.scopeDigest
		)
			throw new Error("Native context epoch changed; attention required");
	}
	entryLineage(epoch: number) {
		const receipts = [...this.exposures.values()].filter(
			(receipt) => receipt.nativeEpoch === epoch,
		);
		const digest = receipts[0]?.scopeDigest;
		if (!digest) return;
		const policy = this.bindings.get(epoch)?.contextPolicy;
		if (!policy || policy.scopeDigest !== digest)
			throw new Error("Unknown context exposure binding");
		return Object.freeze({
			nativeEpoch: epoch,
			scopeDigest: digest,
			sourcePolicyVersion: policy.sourcePolicyVersion,
			exposureIds: Object.freeze(receipts.map((receipt) => receipt.id)),
		});
	}
	lineage(): readonly SessionContextExposure[] {
		return Object.freeze([...this.exposures.values()]);
	}
	plan(
		source: SessionContextSource,
		policy = this.policy,
		epoch = this.nativeEpoch,
	): SessionContextExposure | undefined {
		if (!policy) return;
		let materials: ReturnType<typeof parseSessionContextMaterials>;
		try {
			materials = parseSessionContextMaterials(
				this.options.contextExposure?.(Object.freeze(source)),
			);
		} catch {
			throw new Error("Context exposure selection failed");
		}
		if (this.current()?.scopeDigest !== policy.scopeDigest)
			throw new Error("Context scope changed before delivery");
		if (
			policy.purpose === "conversation" &&
			materials.some((m) => m.kind === "disclosed-life")
		)
			throw new Error("Context material is not allowed for conversation");
		const receipt = parseSessionContextExposure({
			type: "context_exposure",
			version: 1,
			id: randomUUID(),
			nativeEpoch: epoch,
			scopeDigest: policy.scopeDigest,
			source,
			materials,
			outcome: "planned",
		});
		appendCodexJournal(this.file, receipt);
		this.exposures.set(receipt.id, receipt);
		return receipt;
	}
	delivered(receipt: SessionContextExposure | undefined): void {
		if (!receipt) return;
		const delivered = parseSessionContextExposure({
			...receipt,
			outcome: "delivered",
		});
		appendCodexJournal(this.file, delivered);
		this.exposures.set(receipt.id, delivered);
	}
	begin(threadId: string, requestId: string): void {
		this.requestId = requestId;
		if (!this.policy) return;
		this.record({
			type: "context_run",
			version: 1,
			requestId: this.requestId,
			nativeEpoch: this.nativeEpoch,
			threadId,
			turnId: null,
			status: "pending",
		});
	}
	note(turnId: string): void {
		const run = this.requestId ? this.runs.get(this.requestId) : undefined;
		if (run && run.status !== "settled" && run.status !== "attention")
			this.record({ ...run, turnId, status: "active" });
	}
	settle(): void {
		const run = this.requestId ? this.runs.get(this.requestId) : undefined;
		if (run && run.status !== "settled")
			this.record({ ...run, status: "settled" });
	}
	attention(): void {
		const run = this.requestId ? this.runs.get(this.requestId) : undefined;
		if (run && run.status !== "settled")
			this.record({ ...run, status: "attention" });
	}
	reconcile(thread: unknown, threadId: string): void {
		const blocked: () => never = () => {
			appendCodexJournal(this.file, {
				type: "context_attention",
				version: 1,
				nativeEpoch:
					readCodexSessionHeader(this.file, this.workspace).nativeEpoch ?? 0,
				nativeThreadId: threadId,
				reason: "unresolved-native-run",
			});
			throw new Error(
				"Old native run or request is active or uncertain; attention required",
			);
		};
		if (
			!object(thread) ||
			thread["id"] !== threadId ||
			!object(thread["status"]) ||
			thread["status"]["type"] !== "idle" ||
			!Array.isArray(thread["turns"]) ||
			thread["turns"].some((t) => object(t) && t["status"] === "inProgress")
		)
			blocked();
		for (const run of this.runs.values()) {
			if (run.status === "settled") continue;
			if (
				run.threadId !== threadId ||
				!run.turnId ||
				!thread["turns"].some(
					(t) =>
						object(t) &&
						t["id"] === run.turnId &&
						["completed", "failed", "interrupted"].includes(
							String(t["status"]),
						),
				)
			)
				blocked();
			this.record({ ...run, status: "settled" });
		}
	}
	private record(run: ContextRun): void {
		appendCodexJournal(this.file, run);
		this.runs.set(run.requestId, run);
	}
}
