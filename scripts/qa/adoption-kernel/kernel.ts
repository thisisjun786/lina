import { randomUUID } from "node:crypto";
import { RunReservations } from "./runs.ts";
import type { KernelStore } from "./store.ts";
import type {
	Adoption,
	DeliveryPort,
	KernelTrace,
	ModelPort,
	Proposal,
	ToolPort,
} from "./types.ts";
import { parseProposal } from "./validation.ts";

export type KernelOptions = {
	store: KernelStore;
	model: ModelPort;
	tools: ReadonlyMap<string, ToolPort>;
	delivery: DeliveryPort;
	beforeAdmit?: () => void;
	decisionId?: () => string;
};

export class AdoptionKernel {
	private readonly runs: RunReservations;
	constructor(private readonly options: KernelOptions) {
		this.runs = new RunReservations(options.store.db, options.decisionId);
	}
	async step(
		purposeId: string,
		requestId: string = randomUUID(),
	): Promise<KernelTrace> {
		const claim = this.runs.claim(purposeId, requestId);
		if (claim.replay) return claim.replay;
		try {
			const result = await this.execute(purposeId, claim.decisionId);
			return this.runs.finish(result);
		} catch (error) {
			this.runs.finish({
				status: "unknown",
				decisionId: claim.decisionId,
				detail: "interrupted judgment",
			});
			throw error;
		}
	}
	private async execute(
		purposeId: string,
		decisionId: string,
	): Promise<KernelTrace> {
		const frame = this.options.store.prepare(purposeId, decisionId);
		let response: unknown;
		try {
			response = await this.options.model.propose(structuredClone(frame));
		} catch {
			return {
				status: "unknown",
				decisionId,
				detail: "model request interrupted",
			};
		}
		let proposal: Proposal;
		try {
			proposal = parseProposal(response);
		} catch (error) {
			return {
				status: "rejected",
				decisionId,
				detail: error instanceof Error ? error.message : "invalid proposal",
			};
		}
		if (
			proposal.purposeRevision !== frame.purpose.revision ||
			!this.options.store.current(frame)
		)
			return { status: "rejected", decisionId, detail: "stale frame" };
		this.options.store.recordJudgment(
			decisionId,
			proposal.judgment ?? { method: null, expectation: { kind: "none" } },
		);
		if (proposal.kind === "noop")
			return { status: "noop", decisionId, detail: proposal.reason };
		if (proposal.kind === "defer") {
			this.options.store.defer(decisionId, proposal.condition, proposal.reason);
			return { status: "deferred", decisionId, detail: proposal.reason };
		}
		if (proposal.kind === "answer") {
			this.options.beforeAdmit?.();
			if (!this.options.store.current(frame))
				return { status: "rejected", decisionId, detail: "stale final fence" };
			const effectId = `${decisionId}:answer`;
			this.options.store.dispatch(
				effectId,
				"@delivery",
				{ bytes: proposal.text, audience: frame.purpose.audience },
				decisionId,
			);
			if (
				!this.options.store.admitCurrent(frame, () =>
					this.options.delivery.admit(
						effectId,
						proposal.text,
						frame.purpose.audience,
						decisionId,
					),
				)
			) {
				this.options.store.cancelUnadmitted(effectId);
				return { status: "rejected", decisionId, detail: "stale final fence" };
			}
			const receipt = await this.options.delivery.reconcile(effectId);
			if (!receipt || receipt.status === "unknown")
				return { status: "unknown", decisionId };
			if (receipt.effectId !== effectId)
				throw Error("delivery receipt identity mismatch");
			this.options.store.recordResult(receipt);
			return { status: "answered", decisionId };
		}
		if (proposal.kind === "adopt") {
			if (
				proposal.refs.some(
					(ref) =>
						!frame.evidence.some(
							(item) => item.id === ref.id && item.revision === ref.revision,
						) &&
						!frame.adoptions.some(
							(item) => item.id === ref.id && item.revision === ref.revision,
						),
				)
			)
				return {
					status: "rejected",
					decisionId,
					detail: "ineligible adoption reference",
				};
			const adoption: Adoption = {
				id: `${decisionId}:adoption`,
				revision: 1,
				subject: frame.purpose.subject,
				domain: [...frame.evidence, ...frame.adoptions].some(
					(item) => item.domain === "fiction",
				)
					? "fiction"
					: "real",
				visibility:
					frame.purpose.audience === "private" ||
					[...frame.evidence, ...frame.adoptions].some(
						(item) => item.visibility === "private",
					)
						? "private"
						: "public",
				kind: proposal.adoptionKind,
				text: proposal.text,
				refs: proposal.refs,
				condition: proposal.condition,
				status: "active",
				sourceDecisionId: decisionId,
			};
			this.options.store.adopt(decisionId, adoption);
			return { status: "adopted", decisionId };
		}
		const tool = this.options.tools.get(proposal.tool);
		if (!tool)
			return { status: "rejected", decisionId, detail: "tool is not allowed" };
		const effectId = `${decisionId}:tool`;
		if (
			!this.options.store.dispatch(
				effectId,
				proposal.tool,
				proposal.args,
				decisionId,
			)
		)
			return { status: "unknown", decisionId };
		this.options.beforeAdmit?.();
		if (
			this.options.tools.get(proposal.tool) !== tool ||
			!this.options.store.current(frame)
		) {
			this.options.store.cancelUnadmitted(effectId);
			return { status: "rejected", decisionId, detail: "stale final fence" };
		}
		if (
			!this.options.store.admitCurrent(frame, () =>
				tool.admit(effectId, proposal.args, decisionId),
			)
		) {
			this.options.store.cancelUnadmitted(effectId);
			return { status: "rejected", decisionId, detail: "stale final fence" };
		}
		const receipt = await tool.result(effectId);
		if (!receipt || receipt.status === "unknown")
			return { status: "unknown", decisionId };
		if (receipt.effectId !== effectId)
			throw Error("tool receipt identity mismatch");
		this.options.store.recordResult(receipt);
		return { status: "dispatched", decisionId };
	}
	async resume(): Promise<KernelTrace[]> {
		const traces: KernelTrace[] = this.options.store
			.deferred()
			.map((decisionId) => ({ status: "deferred", decisionId }));
		for (const deferred of this.options.store.readyDeferred()) {
			const result = await this.step(deferred.purposeId, `wake:${deferred.id}`);
			if (result.status !== "unknown")
				this.options.store.completeDeferred(deferred.id, result.decisionId);
			traces.push(result);
		}
		for (const effectId of this.options.store.pending()) {
			const effect = this.options.store.pendingEffect(effectId);
			if (!effect) throw Error("missing pending effect");
			if (effect.cancelled) {
				traces.push(
					this.runs.finish({
						status: "rejected",
						decisionId: effect.decisionId,
						detail: "cancelled before admission",
					}),
				);
				continue;
			}
			const owner = effectId.endsWith(":answer")
				? this.options.delivery
				: this.options.tools.get(effect.tool);
			const saved = this.options.store.consume(effectId);
			const receipt =
				saved && saved.status !== "unknown"
					? saved
					: await owner?.reconcile(effectId);
			if (!receipt || receipt.status === "unknown") {
				traces.push({ status: "unknown", decisionId: effect.decisionId });
				continue;
			}
			if (receipt.effectId !== effectId)
				throw Error("reconciliation receipt identity mismatch");
			this.options.store.recordResult(receipt);
			this.runs.finish({
				status: effectId.endsWith(":answer") ? "answered" : "dispatched",
				decisionId: effect.decisionId,
			});
			traces.push({
				status: effectId.endsWith(":answer") ? "answered" : "dispatched",
				decisionId: effect.decisionId,
			});
		}
		const reported = new Set(traces.map((trace) => trace.decisionId));
		for (const decisionId of this.runs.unresolved()) {
			if (!reported.has(decisionId))
				traces.push({ status: "unknown", decisionId });
		}
		return traces;
	}
}
