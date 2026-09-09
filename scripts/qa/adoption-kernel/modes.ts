import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DeliveryOwner } from "./delivery.ts";
import { Environment } from "./environment.ts";
import type {
	EpisodeTrace,
	ModelTransport,
	PublicCase,
	RawItem,
	RunMode,
} from "./harness-types.ts";
import { AdoptionKernel } from "./kernel.ts";
import { receiptText, serializeInput } from "./serialize.ts";
import { KernelStore } from "./store.ts";
import type {
	Evidence,
	Frame,
	KernelTrace,
	Proposal,
	Purpose,
	Ref,
} from "./types.ts";
import { parseProposal } from "./validation.ts";

type Bridge = { id: string; revision: number; event: string; adoptions: Ref[] };
export class ModeSession {
	readonly trace: EpisodeTrace;
	private readonly store: KernelStore;
	private readonly owner: DeliveryOwner;
	private readonly environment: Environment;
	private readonly kernel: AdoptionKernel;
	private readonly raw: RawItem[] = [];
	private readonly sequence = new Map<string, number>();
	private readonly bridges = new Map<string, Bridge>();
	private stage = 0;
	private purpose: Purpose;
	private captured: Frame | null = null;
	private seq = 0;
	constructor(
		private readonly mode: RunMode,
		private readonly input: PublicCase,
		private readonly transport: ModelTransport,
		root?: string,
	) {
		const first = input.stages[0];
		if (!first) throw Error("missing stage");
		this.purpose = first.purpose;
		this.store = new KernelStore(
			root ? join(root, "kernel.sqlite") : ":memory:",
		);
		this.owner = new DeliveryOwner(
			root ? join(root, "delivery.sqlite") : ":memory:",
		);
		this.environment = new Environment(
			input,
			root ? join(root, "owner.sqlite") : ":memory:",
		);
		this.trace = {
			version: 1,
			episodeId: input.episodeId,
			mode,
			status: "incomplete",
			requests: [],
			steps: [],
			effects: [],
			adoptions: [],
			delivered: [],
			stages: [],
			bridges: [],
		};
		this.kernel = new AdoptionKernel({
			store: this.store,
			delivery: this.owner,
			tools: this.environment.tools(),
			model: { propose: (frame) => this.propose(frame) },
		});
	}
	close(): void {
		this.store.close();
		this.owner.close();
		this.environment.close();
	}
	applyStage(index: number): void {
		const stage = this.input.stages[index];
		if (!stage) throw Error("unknown stage");
		this.stage = index;
		this.purpose = stage.purpose;
		this.store.setPurpose(stage.purpose);
		for (const event of stage.events) {
			if (event.kind === "retract") {
				if (this.mode !== "baseline")
					this.store.retract(event.actor, {
						id: event.id,
						revision: event.revision,
					});
				const prior = this.raw.find((item) => item.ref.id === event.id);
				if (this.mode === "baseline" && prior)
					this.raw.push({
						...prior,
						seq: ++this.seq,
						kind: "retraction",
						text: JSON.stringify(event),
						ref: { id: event.id, revision: event.revision },
					});
			} else {
				const evidence = event.evidence;
				if (this.mode !== "baseline")
					this.store.observe(evidence.sourceOwner, evidence);
				this.sequence.set(
					evidence.id,
					this.sequence.get(evidence.id) ?? ++this.seq,
				);
				if (
					evidence.subject === this.purpose.subject &&
					(this.purpose.audience === "private" ||
						evidence.visibility === "public")
				)
					this.raw.push(this.rawItem(evidence, ++this.seq));
			}
		}
		if (index === 0) {
			for (const [index, prelude] of this.input.prelude.entries()) {
				const id = `${this.input.episodeId}:prelude:${index}`;
				const tool = this.environment.tools().get(prelude.tool);
				if (!tool) throw Error("unlisted prelude");
				tool.admit(id, prelude.args, id);
			}
			this.bridgeEvents(null);
		}
	}
	private rawItem(e: Evidence, seq: number): RawItem {
		return {
			seq,
			sourceId: e.sourceId,
			owner: e.sourceOwner,
			kind: e.sourceOwner.startsWith("tool:") ? "receipt" : "source",
			text: e.text,
			domain: e.domain,
			role: e.participantRole,
			ref: { id: e.id, revision: e.revision },
		};
	}
	private async propose(frame: Frame): Promise<unknown> {
		this.captured = structuredClone(frame);
		const raw =
			this.mode === "baseline"
				? this.raw
				: frame.evidence.map((e) =>
						this.rawItem(e, this.sequence.get(e.id) ?? 0),
					);
		if (this.mode !== "baseline") {
			for (const receipt of frame.receipts) {
				if (!this.bridges.has(receipt.effectId))
					throw Error("unbridged receipt");
			}
			for (const bridge of this.bridges.values())
				if (
					frame.evidence.some((e) => e.id === bridge.id) &&
					bridge.adoptions.some(
						(ref) =>
							!frame.adoptions.some(
								(a) => a.id === ref.id && a.revision === ref.revision,
							),
					)
				)
					throw Error("bridge adoption provenance mismatch");
		}
		const derived =
			this.mode === "baseline"
				? []
				: frame.adoptions.filter(
						(a) => this.mode !== "ablation" || a.kind !== "understanding",
					);
		const input = serializeInput({
			purpose: this.purpose,
			raw,
			derived,
			tools: this.input.tools,
			attempt: this.trace.requests.length + 1,
		});
		const result = await this.transport.complete(input.messages);
		let proposal: unknown = null;
		if (result.kind === "ok") {
			try {
				proposal = JSON.parse(result.content);
			} catch {
				proposal = null;
			}
		}
		this.trace.requests.push({
			stage: this.stage,
			input,
			transport: result,
			proposal,
		});
		if (result.kind !== "ok") throw Error("model transport failure");
		return proposal;
	}
	private bridgeEvents(frame: Frame | null): void {
		const events = [
			...this.environment.events(),
			...this.trace.effects.filter((e) => e.tool === "@delivery"),
		];
		for (const event of events) {
			const encoded = JSON.stringify(event);
			const old = this.bridges.get(event.effectId);
			if (old?.event === encoded) continue;
			const id = old?.id ?? `${String(++this.seq).padStart(8, "0")}-receipt`;
			const revision = (old?.revision ?? 0) + 1;
			const evidence: Evidence = {
				id,
				revision,
				subject: (frame?.purpose ?? this.purpose).subject,
				domain:
					frame &&
					[...frame.evidence, ...frame.adoptions].some(
						(e) => e.domain === "fiction",
					)
						? "fiction"
						: "real",
				visibility: (frame?.purpose ?? this.purpose).audience,
				active: true,
				text: receiptText(event),
				sourceOwner: `tool:${event.tool}`,
				sourceId: event.effectId,
				parents:
					frame?.evidence.map((e) => ({ id: e.id, revision: e.revision })) ??
					[],
				participantRole: "performer",
				quality: event.receipt.quality,
			};
			if (this.mode !== "baseline")
				this.store.observe(evidence.sourceOwner, evidence);
			this.sequence.set(id, this.sequence.get(id) ?? ++this.seq);
			this.raw.push(this.rawItem(evidence, this.sequence.get(id) ?? 0));
			this.bridges.set(event.effectId, {
				id,
				revision,
				event: encoded,
				adoptions:
					frame?.adoptions.map((a) => ({ id: a.id, revision: a.revision })) ??
					[],
			});
			this.trace.bridges.push({
				evidenceId: id,
				effectId: event.effectId,
				owner: event.tool,
				revision,
			});
		}
		this.trace.effects = [
			...this.environment.events(),
			...this.trace.effects.filter((e) => e.tool === "@delivery"),
		];
	}
	private async baselineStep(): Promise<KernelTrace> {
		const decisionId = randomUUID();
		let proposal: Proposal;
		try {
			const response = await this.propose({
				purpose: this.purpose,
				evidence: [],
				adoptions: [],
				receipts: [],
				version: 1,
			});
			try {
				proposal = parseProposal(response);
			} catch {
				return { status: "rejected", decisionId };
			}
		} catch {
			return { status: "unknown", decisionId };
		}
		if (proposal.purposeRevision !== this.purpose.revision)
			return { status: "rejected", decisionId };
		if (proposal.kind === "adopt") return { status: "adopted", decisionId };
		if (proposal.kind === "noop") return { status: "noop", decisionId };
		if (proposal.kind === "defer") return { status: "deferred", decisionId };
		if (proposal.kind === "answer") {
			this.owner.admit(
				`${decisionId}:answer`,
				proposal.text,
				this.purpose.audience,
				decisionId,
			);
			return { status: "answered", decisionId };
		}
		const tool = this.environment.tools().get(proposal.tool);
		if (!tool) return { status: "rejected", decisionId };
		const id = `${decisionId}:tool`;
		tool.admit(id, proposal.args, decisionId);
		const receipt = await tool.result(id);
		return {
			status:
				!receipt || receipt.status === "unknown" ? "unknown" : "dispatched",
			decisionId,
		};
	}
	async step(): Promise<KernelTrace> {
		if (this.trace.requests.length >= 6)
			throw Error("episode model budget exhausted");
		const before = this.trace.requests.length;
		this.captured = null;
		const result =
			this.mode === "baseline"
				? await this.baselineStep()
				: await this.kernel.step(this.purpose.id);
		if (result.status === "answered") {
			const id = `${result.decisionId}:answer`;
			const receipt = await this.owner.reconcile(id);
			if (!receipt) throw Error("missing delivery");
			const output = receipt.output as {
				bytes: string;
				audience: Purpose["audience"];
			};
			this.trace.delivered.push({
				effectId: id,
				bytes: output.bytes,
				audience: output.audience,
				stage: this.stage,
			});
			this.trace.effects.push({
				effectId: id,
				tool: "@delivery",
				args: { bytes: output.bytes, audience: output.audience },
				receipt,
			});
		}
		this.bridgeEvents(this.mode === "baseline" ? null : this.captured);
		if (this.mode !== "baseline") {
			const current = this.store.frame(this.purpose.id);
			for (const adoption of current.adoptions)
				if (!this.trace.adoptions.some((a) => a.id === adoption.id))
					this.trace.adoptions.push(adoption);
		}
		this.trace.steps.push({
			stage: this.stage,
			kernel: result,
			requestIndex: this.trace.requests.length > before ? before : null,
		});
		return result;
	}
}
export function createSession(
	mode: RunMode,
	input: PublicCase,
	transport: ModelTransport,
	root?: string,
): ModeSession {
	return new ModeSession(mode, input, transport, root);
}
