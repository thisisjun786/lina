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
			this.options.delivery.admit(
				`${decisionId}:answer`,
				proposal.text,
				frame.purpose.audience,
				decisionId,
			);
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
		if (!receipt) return { status: "unknown", decisionId };
		this.options.store.recordResult(receipt);
		return { status: "dispatched", decisionId };
	}
	async resume(): Promise<KernelTrace[]> {
		return [
			...this.options.store
				.deferred()
				.map((decisionId) => ({ status: "deferred" as const, decisionId })),
			...this.options.store.pending().map((effectId) => ({
				status: "unknown" as const,
				decisionId: effectId,
			})),
		];
	}
}
