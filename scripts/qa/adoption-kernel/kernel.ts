import { randomUUID } from "node:crypto";
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
};

export class AdoptionKernel {
	constructor(private readonly options: KernelOptions) {}
	async step(purposeId: string): Promise<KernelTrace> {
		const decisionId = randomUUID();
		const frame = this.options.store.prepare(purposeId, decisionId);
		let proposal: Proposal;
		try {
			proposal = parseProposal(await this.options.model.propose(frame));
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
			this.options.delivery.admit(
				effectId,
				proposal.text,
				frame.purpose.audience,
				decisionId,
			);
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
				domain: frame.evidence.some((item) => item.domain === "fiction")
					? "fiction"
					: "real",
				visibility: frame.evidence.some((item) => item.visibility === "private")
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
		if (!this.options.store.current(frame))
			return { status: "rejected", decisionId, detail: "stale final fence" };
		tool.admit(effectId, proposal.args, decisionId);
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
		for (const effectId of this.options.store.pending()) {
			const effect = this.options.store.pendingEffect(effectId);
			if (!effect) throw Error("missing pending effect");
			const owner = effectId.endsWith(":answer")
				? this.options.delivery
				: this.options.tools.get(effect.tool);
			const receipt = await owner?.reconcile(effectId);
			if (!receipt || receipt.status === "unknown") {
				traces.push({ status: "unknown", decisionId: effect.decisionId });
				continue;
			}
			if (receipt.effectId !== effectId)
				throw Error("reconciliation receipt identity mismatch");
			this.options.store.recordResult(receipt);
			traces.push({
				status: effectId.endsWith(":answer") ? "answered" : "dispatched",
				decisionId: effect.decisionId,
			});
		}
		return traces;
	}
}
