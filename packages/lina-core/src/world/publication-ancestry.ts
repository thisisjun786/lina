import type { DatabaseSync } from "node:sqlite";
import type { LifeStep } from "./autonomy-types.ts";
import {
	array,
	canonicalLifeJson,
	enumeration,
	eventReference,
	identifier,
	jsonBoundary,
	keyed,
	lifeDigest,
	revision,
} from "./life-json.ts";
import type { PublicationChainRef } from "./publication-chains.ts";
import {
	parsePublicationEvidence,
	parsePublicationRoots,
} from "./publication-input.ts";
import { fields } from "./validation.ts";

export interface PublicationAncestryRecord {
	kind: "step" | "event" | "causal_event";
	id: string;
	lifeRevision: number;
	roots: PublicationChainRef[];
}
export const PUBLICATION_ANCESTRY_SCHEMA = `
CREATE TABLE life_publication_ancestry (
 world_id TEXT NOT NULL REFERENCES worlds(id), subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
 life_revision INTEGER NOT NULL CHECK(life_revision>0), record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,subject_kind,subject_id)
) STRICT;
`;
export function parsePublicationAncestry(
	value: unknown,
): PublicationAncestryRecord[] {
	jsonBoundary(value);
	return keyed(
		array(value, (row) => {
			fields(row, ["kind", "id", "lifeRevision", "roots"]);
			const kind = enumeration(row.kind, ["step", "event", "causal_event"]);
			return {
				kind,
				id: kind === "event" ? eventReference(row.id) : identifier(row.id),
				lifeRevision: revision(row.lifeRevision, 1),
				roots: parsePublicationRoots(row.roots),
			};
		}),
		(r) => `${r.kind}:${r.id}`,
	);
}
export function mergePublicationRoots(
	groups: readonly PublicationChainRef[][],
): PublicationChainRef[] {
	const roots = new Map<string, number>();
	for (const group of groups)
		for (const root of parsePublicationRoots(group))
			roots.set(root.rootId, Math.max(root.depth, roots.get(root.rootId) ?? 0));
	return [...roots]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([rootId, depth]) => ({ rootId, depth }));
}
function deeper(roots: PublicationChainRef[]) {
	return roots.map((root) => ({ ...root, depth: revision(root.depth + 1, 1) }));
}
/** Derive from consumed scoped input and the selected scheduled parent; an ordinary event cannot reset the chain. */
export function derivePublicationAncestry(
	step: LifeStep,
): PublicationAncestryRecord[] {
	if (!step.outcome)
		throw Error("Publication ancestry requires a completed step");
	let roots: PublicationChainRef[] = [];
	if (step.version === 3 || step.version === 4) {
		if (!step.source.publication || !step.source.publicationAncestry)
			throw Error("Missing frozen publication ancestry source");
		const publication = parsePublicationEvidence(step.source.publication),
			ancestry = parsePublicationAncestry(step.source.publicationAncestry);
		if (publication.worldId !== step.worldId)
			throw Error("Publication source world mismatch");
		const consumed = new Set(step.outcome.commit.consumedInputIds),
			sources = publication.records.filter((row) => consumed.has(row.inputId));
		for (const row of sources) {
			const input = step.source.inputs.find(
				(input) => input.id === row.inputId,
			);
			if (
				input?.version !== 3 ||
				input.consumedLifeRevision !== null ||
				lifeDigest(input.source) !== lifeDigest(row.source)
			)
				throw Error("Publication consumed observation source mismatch");
		}
		if (
			step.source.inputs.some(
				(input) =>
					input.version === 3 &&
					consumed.has(input.id) &&
					!sources.some((row) => row.inputId === input.id),
			)
		)
			throw Error("Missing permitted publication observation");
		const groups = sources.map((row) => row.source.roots),
			parent = step.decision.parent;
		if (parent) {
			const prior = ancestry.find(
				(row) => row.kind === "causal_event" && row.id === parent.id,
			);
			if (!prior || prior.lifeRevision > step.source.life.revision)
				throw Error("Missing scheduled publication ancestry");
			groups.push(prior.roots);
		}
		roots = deeper(mergePublicationRoots(groups));
	} else if (
		step.source.publication ||
		step.source.publicationAncestry ||
		step.source.inputs.some((input) => input.version === 3)
	)
		throw Error("Legacy step cannot carry publication input authority");
	const lifeRevision = revision(step.source.life.revision + 1, 1);
	return parsePublicationAncestry([
		{ kind: "step", id: step.id, lifeRevision, roots },
		{
			kind: "event",
			id: `${step.worldId}:${revision(step.source.world.revision + 1, 1)}`,
			lifeRevision,
			roots,
		},
		...step.outcome.nextState.pendingEvents
			.filter((event) => event.parentStepId === step.id)
			.map((event) => ({
				kind: "causal_event",
				id: event.id,
				lifeRevision,
				roots: deeper(roots),
			})),
	]);
}
type Row = {
	world_id: string;
	subject_kind: string;
	subject_id: string;
	life_revision: number;
	record_json: string;
	digest: string;
};
function decode(row: Row): PublicationAncestryRecord {
	const record = parsePublicationAncestry([JSON.parse(row.record_json)])[0];
	if (
		!record ||
		row.subject_kind !== record.kind ||
		row.subject_id !== record.id ||
		row.life_revision !== record.lifeRevision ||
		lifeDigest(record) !== row.digest ||
		(record.kind === "event" &&
			!record.id.startsWith(`${identifier(row.world_id)}:`))
	)
		throw Error("Corrupt publication ancestry row");
	identifier(row.world_id);
	return record;
}
/** Immutable sidecar for accepted steps; never registered on application/model input endpoints. */
export class PublicationAncestry {
	constructor(private readonly db: DatabaseSync) {}
	list(
		worldId: string,
		atLifeRevision = Number.MAX_SAFE_INTEGER,
	): PublicationAncestryRecord[] {
		identifier(worldId);
		revision(atLifeRevision);
		return (
			this.db
				.prepare(
					"SELECT * FROM life_publication_ancestry WHERE world_id=? AND life_revision<=? ORDER BY subject_kind,subject_id",
				)
				.all(worldId, atLifeRevision) as Row[]
		).map(decode);
	}
	record(worldId: string, input: PublicationAncestryRecord[]): void {
		identifier(worldId);
		for (const row of parsePublicationAncestry(input)) {
			if (row.kind === "event" && !row.id.startsWith(`${worldId}:`))
				throw Error("Publication ancestry world mismatch");
			const prior = this.db
				.prepare(
					"SELECT * FROM life_publication_ancestry WHERE world_id=? AND subject_kind=? AND subject_id=?",
				)
				.get(worldId, row.kind, row.id) as Row | undefined;
			if (prior) {
				if (lifeDigest(decode(prior)) !== lifeDigest(row))
					throw Error("Publication ancestry conflict");
				continue;
			}
			this.db
				.prepare(
					"INSERT INTO life_publication_ancestry(world_id,subject_kind,subject_id,life_revision,record_json,digest) VALUES(?,?,?,?,?,?)",
				)
				.run(
					worldId,
					row.kind,
					row.id,
					row.lifeRevision,
					canonicalLifeJson(row),
					lifeDigest(row),
				);
		}
	}
	validate(): void {
		for (const row of this.db
			.prepare("SELECT * FROM life_publication_ancestry")
			.iterate())
			decode(row as Row);
	}
}
