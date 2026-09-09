import { z } from "zod";
import type { SourceProof } from "../../../lina-core/src/source-policy.ts";
import {
	eligibleRecord,
	mergeProofs,
	requireCurrentProofs,
} from "./provenance.ts";
import { mergeSources } from "./records.ts";
import {
	type ConclusionProposal,
	ENGINE_BATCH_MAX,
	ENGINE_SOURCES_MAX,
	type EngineRecord,
	type LookupEntry,
	type RecordReasoning,
} from "./types.ts";
import {
	engineIdSchema,
	hash,
	parseObservations,
	recordId,
	revisionSchema,
} from "./validation.ts";

const proposalSchema = z.strictObject({
	subject: z.enum(["user", "self", "relationship"]),
	kind: z.enum([
		"fact",
		"interest",
		"preference",
		"concern",
		"mood",
		"attitude",
	]),
	key: z.string(),
	text: z.string(),
	reasoningKind: z.enum(["deduction", "induction"]),
	premises: z
		.array(
			z.strictObject({ recordId: engineIdSchema, revision: revisionSchema }),
		)
		.min(1)
		.max(ENGINE_SOURCES_MAX),
});

/** Model output contains references only; provenance and confidence belong to storage. */
export function parseConclusions(value: unknown): ConclusionProposal[] {
	const proposals = z.array(proposalSchema).max(ENGINE_BATCH_MAX).parse(value);
	const slots = new Set<string>();
	for (const proposal of proposals) {
		// Reuse the existing facet/text/key boundary without accepting model sources.
		parseObservations([
			{
				subject: proposal.subject,
				kind: proposal.kind,
				key: proposal.key,
				text: proposal.text,
				evidence: "inferred",
				sources: [{ entryId: "validation", quote: "validation" }],
			},
		]);
		const slot = recordId("validation", proposal);
		if (slots.has(slot)) throw Error("duplicate conclusion slot");
		slots.add(slot);
		const refs = new Set(proposal.premises.map((p) => p.recordId));
		if (refs.size !== proposal.premises.length)
			throw Error("duplicate conclusion premise");
	}
	return proposals;
}

/** Corroboration can add sources without changing what the premise says. */
export function contentHash(record: EngineRecord): string {
	return hash([
		record.subject,
		record.kind,
		record.key,
		record.text,
		record.evidence,
		record.status,
		record.generation,
	]);
}

export interface PreparedConclusion {
	proposal: ConclusionProposal;
	reasoning: RecordReasoning;
	sources: EngineRecord["sources"];
	sourceProofs: SourceProof[];
	support: EngineRecord["support"];
}

/** The complete evidence remains in premise history and proofs; excerpts stay bounded. */
export function conclusionSources(
	premises: readonly EngineRecord[],
): EngineRecord["sources"] {
	return mergeSources(premises.flatMap((p) => p.sources.slice(0, 1)));
}

/** Called by the checked store owner using receipt-validated bound records. No writes. */
export function prepareConclusions(input: {
	agentId: string;
	proposals: unknown;
	resolve: (id: string) => EngineRecord | undefined;
	resolveAncestor?: (id: string) => EngineRecord | undefined;
	promptProofs: SourceProof[];
	lookup: LookupEntry;
	now: number;
}): PreparedConclusion[] {
	const proposals = parseConclusions(input.proposals);
	const targets = new Set(proposals.map((p) => recordId(input.agentId, p)));
	if (
		proposals.some((p) =>
			p.premises.some(
				(ref) =>
					targets.has(ref.recordId) &&
					ref.recordId !== recordId(input.agentId, p),
			),
		)
	)
		throw Error("conclusion batch replaces a premise");
	requireCurrentProofs(input.promptProofs, input.lookup);
	const eligible = (record: EngineRecord | undefined): record is EngineRecord =>
		!!record &&
		record.agentId === input.agentId &&
		record.status === "active" &&
		(record.expiresAt === null || record.expiresAt > input.now) &&
		eligibleRecord(record, input.lookup);
	const walk = (id: string, target: string, visiting: Set<string>): void => {
		if (id === target || visiting.has(id))
			throw Error("conclusion premise cycle");
		if (targets.has(id)) throw Error("conclusion batch replaces a premise");
		const record = (input.resolveAncestor ?? input.resolve)(id);
		if (!eligible(record)) throw Error("ineligible conclusion premise");
		visiting.add(id);
		for (const ref of record.reasoning?.premises ?? []) {
			const current = (input.resolveAncestor ?? input.resolve)(ref.recordId);
			if (!eligible(current) || contentHash(current) !== ref.contentHash)
				throw Error("stale conclusion premise content");
			walk(ref.recordId, target, visiting);
		}
		visiting.delete(id);
	};
	return proposals.map((proposal) => {
		const target = recordId(input.agentId, proposal);
		const premises = proposal.premises.map((ref) => {
			const record = input.resolve(ref.recordId);
			if (!eligible(record)) throw Error("ineligible conclusion premise");
			if (record.revision !== ref.revision)
				throw Error("stale conclusion premise revision");
			walk(record.id, target, new Set());
			return record;
		});
		const proofs = mergeProofs(
			input.promptProofs,
			...premises.map((p) => p.sourceProofs),
		);
		requireCurrentProofs(proofs, input.lookup);
		return {
			proposal,
			reasoning: {
				kind: proposal.reasoningKind,
				premises: premises.map((p) => ({
					recordId: p.id,
					revision: p.revision,
					contentHash: contentHash(p),
				})),
			},
			sources: conclusionSources(premises),
			sourceProofs: proofs,
			support:
				proposal.reasoningKind === "deduction" &&
				premises.every(
					(p) =>
						p.support === "supported" &&
						(p.evidence === "explicit" || p.reasoning?.kind === "deduction"),
				)
					? "supported"
					: "provisional",
		};
	});
}
