import {
	parseSourcePolicy,
	type SourcePolicy,
	type SourceProof,
} from "../source-policy.ts";
import type { ArtifactStatus } from "./types.ts";
import { decodeProofs, validId } from "./validation.ts";
export interface Creation {
	userEntryId: string;
	policy: SourcePolicy;
}
export interface Artifact {
	id: string;
	kind: "working" | "note";
	content: string;
	creations: Creation[];
	dependencies: SourceProof[];
	status: ArtifactStatus;
	reason: string;
	createdAt: string;
}
export interface ArtifactRow {
	id: string;
	kind: Artifact["kind"];
	content: string;
	creations: string;
	dependencies: string;
	status: ArtifactStatus;
	reason: string;
	created_at: string;
}
export interface FinalRow {
	status: "finalized" | "withheld";
	source_proofs: string;
	reason: string;
}

export function decodeArtifact(row: ArtifactRow): Artifact {
	const raw: unknown = JSON.parse(row.creations);
	if (!Array.isArray(raw) || !raw.length || raw.length > 65536)
		throw Error("Invalid context creations");
	const creations = raw.map((value: unknown): Creation => {
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).sort().join() !== "policy,userEntryId" ||
			!("policy" in value) ||
			!("userEntryId" in value)
		)
			throw Error("Invalid context creation");
		return {
			userEntryId: validId(value.userEntryId, "creation entry"),
			policy: parseSourcePolicy(value.policy),
		};
	});
	return {
		id: row.id,
		kind: row.kind,
		content: row.content,
		creations,
		dependencies: decodeProofs(JSON.parse(row.dependencies)),
		status: row.status,
		reason: row.reason,
		createdAt: row.created_at,
	};
}

export function validateArtifact(
	artifact: Artifact,
	final: FinalRow | undefined,
	sessionId: string,
): void {
	if (artifact.creations.some((c) => c.policy.sessionId !== sessionId))
		throw Error("Foreign context creation");
	if (
		(artifact.status === "finalized" && !final) ||
		(final && final.status !== artifact.status)
	)
		throw Error("Invalid context finalization");
	if (final) {
		const proofs = decodeProofs(JSON.parse(final.source_proofs));
		if (final.status === "finalized" && !proofs.length)
			throw Error("Missing context final proof");
		if (final.status === "finalized") {
			const expectedIds = [
				...new Set([
					...artifact.dependencies.map((p) => p.entryId),
					...artifact.creations.map((c) => c.userEntryId),
				]),
			].sort();
			if (
				JSON.stringify(proofs.map((p) => p.entryId).sort()) !==
				JSON.stringify(expectedIds)
			)
				throw Error("Incomplete context final proof");
			for (const dependency of artifact.dependencies)
				if (
					!proofs.some(
						(p) =>
							p.entryId === dependency.entryId &&
							p.policyRevision === dependency.policyRevision &&
							p.policyDigest === dependency.policyDigest,
					)
				)
					throw Error("Changed context dependency proof");
		}
	}
	if (
		artifact.kind === "note" &&
		(!artifact.content.trim() || artifact.content.length > 8192)
	)
		throw Error("Invalid stored managed note");
}
