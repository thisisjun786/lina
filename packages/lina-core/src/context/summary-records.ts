import type { DatabaseSync } from "node:sqlite";
import type { SourceProof } from "../source-policy.ts";
import { parseSummaryGeneration } from "./generation.ts";
import {
	type SourceRef,
	SUMMARY_SOURCES_MAX,
	SUMMARY_TEXT_MAX_CHARS,
	type SummaryNode,
} from "./types.ts";
import { decodeProofs, fingerprintOf, validRef } from "./validation.ts";

interface SummaryRow {
	id: string;
	text: string;
	kind: SummaryNode["kind"];
	depth: number;
	fingerprint: string;
}

interface SourceRow {
	source_kind: SourceRef["kind"];
	source_id: string;
}

export class SummaryRecords {
	constructor(private readonly db: DatabaseSync) {}
	inspect(id: string): SummaryNode | undefined {
		if (typeof id !== "string") return undefined;
		const row = this.row(id);
		if (!row) return undefined;
		const generation = this.db
			.prepare(
				"SELECT generation_json FROM summary_generations WHERE summary_id=?",
			)
			.get(row.id);
		return {
			...(generation
				? {
						generation: parseSummaryGeneration(
							JSON.parse(String(generation["generation_json"])),
						),
					}
				: {}),
			id: row.id,
			text: row.text,
			kind: row.kind,
			depth: row.depth,
			sources: this.sourcesOf(id),
			fingerprint: row.fingerprint,
			sourceProofs: this.savedProofs(id),
		};
	}

	private savedProofs(id: string): SourceProof[] {
		const row = this.db
			.prepare(
				"SELECT source_proofs FROM summary_provenance WHERE summary_id = ?",
			)
			.get(id);
		return row ? decodeProofs(JSON.parse(String(row["source_proofs"]))) : [];
	}

	validate(): void {
		for (const row of this.db.prepare("SELECT id FROM summaries").all()) {
			const node = this.inspect(String(row["id"]));
			if (
				!node ||
				!node.text.trim() ||
				node.text.length > SUMMARY_TEXT_MAX_CHARS ||
				!node.sources.length ||
				node.sources.length > SUMMARY_SOURCES_MAX
			)
				throw Error("Invalid stored context summary");
			const refs = node.sources.map(validRef);
			if (
				new Set(refs.map((ref) => `${ref.kind}:${ref.id}`)).size !== refs.length
			)
				throw Error("Invalid stored context sources");
			let depth = 0;
			for (const ref of refs) {
				if (ref.kind !== "summary") continue;
				const parent = this.row(ref.id);
				if (!parent || parent.depth >= node.depth)
					throw Error("Invalid context summary ancestry");
				depth = Math.max(depth, parent.depth + 1);
			}
			if (node.depth !== depth) throw Error("Invalid context summary depth");
			const saved = this.db
				.prepare("SELECT 1 FROM summary_provenance WHERE summary_id = ?")
				.get(node.id);
			if (
				saved &&
				(!node.sourceProofs.length ||
					fingerprintOf(node, node.sourceProofs) !== node.fingerprint ||
					node.id !== `summary-${node.fingerprint.slice(0, 32)}`)
			)
				throw Error("Invalid context summary proof fingerprint");
		}
	}

	row(id: string): SummaryRow | undefined {
		return this.db
			.prepare(
				"SELECT id, text, kind, depth, fingerprint FROM summaries WHERE id = ?",
			)
			.get(id) as SummaryRow | undefined;
	}

	private sourcesOf(id: string): SourceRef[] {
		return (
			this.db
				.prepare(
					"SELECT source_kind, source_id FROM summary_sources WHERE summary_id = ? ORDER BY ordinal",
				)
				.all(id) as unknown as SourceRow[]
		).map((row) => ({ kind: row.source_kind, id: row.source_id }));
	}
}
