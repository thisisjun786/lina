import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
	captureSourceProofs,
	isOrdinarySource,
	parseSourcePolicy,
	type SourceContextOptions,
	type SourceEntry,
	type SourceProof,
	sourcePolicyDigest,
	sourceProofsCurrent,
} from "../source-policy.ts";
import {
	type Artifact,
	type ArtifactRow,
	type Creation,
	decodeArtifact,
	type FinalRow,
	validateArtifact,
} from "./artifact-codec.ts";
import type {
	ArtifactStatus,
	ContextStoreOptions,
	LookupEntry,
	ManagedNote,
	NoteReceipt,
} from "./types.ts";
import {
	decodeProofs,
	sourceDeliveryGuard,
	unionProofs,
	validId,
} from "./validation.ts";

/** Durable pending creation associations. Only this protocol may resolve a later policy revision. */
export class ContextArtifacts {
	constructor(
		private readonly db: DatabaseSync,
		private readonly lookup: LookupEntry,
		private readonly sessionId: string,
		private readonly options: ContextStoreOptions,
	) {}

	validate(): void {
		for (const row of this.rows()) {
			const artifact = decodeArtifact(row);
			validateArtifact(artifact, this.final(artifact.id), this.sessionId);
		}
	}

	get(id: string): Artifact | undefined {
		const row = this.db
			.prepare("SELECT * FROM context_artifacts WHERE id = ?")
			.get(id) as ArtifactRow | undefined;
		return row && decodeArtifact(row);
	}

	create(
		id: string,
		kind: Artifact["kind"],
		content: string,
		cited: string[],
		options: SourceContextOptions,
		inherited?: { id: string; hasText: boolean },
	): Artifact {
		const requestId = options.activeRequestId;
		const source = requestId
			? this.options.lookupRequest?.(requestId)
			: undefined;
		if (
			!source?.sourcePolicy ||
			source.role !== "user" ||
			source.sourcePolicy.requestId !== requestId ||
			source.sourcePolicy.sessionId !== this.sessionId
		)
			throw Error("Current request provenance unavailable");
		const creation: Creation = {
			userEntryId: source.entryId,
			policy: parseSourcePolicy(source.sourcePolicy),
		};
		const canonical = this.lookup(source.entryId);
		if (
			!canonical?.sourcePolicy ||
			JSON.stringify(parseSourcePolicy(canonical.sourcePolicy)) !==
				JSON.stringify(creation.policy) ||
			canonical.requestStatus !== source.requestStatus
		)
			throw Error("Current request provenance unavailable");
		let reason = isOrdinarySource(source, options)
			? ""
			: "creating_request_ineligible";
		const creations: Creation[] = [creation];
		let dependencies: SourceProof[] = [];
		const previous = inherited?.hasText ? this.get(inherited.id) : undefined;
		if (inherited?.hasText) {
			if (!previous || !this.eligible(previous, options))
				reason = "retained_text_ineligible";
			if (previous) {
				creations.push(...previous.creations);
				dependencies = [...previous.dependencies];
				const final = this.final(previous.id);
				if (final?.status === "finalized")
					dependencies = unionProofs(
						dependencies,
						decodeProofs(JSON.parse(final.source_proofs)),
					);
			}
		}
		// Active citations are associations, not prematurely frozen final proofs.
		const settled = [...new Set(cited)].filter((id) => id !== source.entryId);
		if (source.requestStatus === "settled") settled.push(source.entryId);
		try {
			if (settled.length)
				dependencies = unionProofs(
					dependencies,
					captureSourceProofs(settled, this.lookup),
				);
		} catch {
			reason = "cited_source_ineligible";
		}
		const artifact: Artifact = {
			id,
			kind,
			content,
			creations: [
				...new Map(
					creations.map((value) => [JSON.stringify(value), value]),
				).values(),
			],
			dependencies,
			status: reason ? "withheld" : "pending",
			reason,
			createdAt: new Date().toISOString(),
		};
		this.db
			.prepare("INSERT INTO context_artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.run(
				id,
				kind,
				content,
				JSON.stringify(artifact.creations),
				JSON.stringify(dependencies),
				artifact.status,
				reason,
				artifact.createdAt,
			);
		return artifact;
	}

	eligible(artifact: Artifact, options: SourceContextOptions = {}): boolean {
		if (artifact.status === "withheld") return false;
		if (artifact.status === "finalized") {
			const final = this.final(artifact.id);
			return (
				!!final &&
				sourceProofsCurrent(
					decodeProofs(JSON.parse(final.source_proofs)),
					this.lookup,
				)
			);
		}
		if (artifact.kind !== "working" || !options.activeRequestId) return false;
		return (
			this.resolve(artifact, options).status !== "withheld" &&
			artifact.creations.every(
				(c) =>
					c.policy.requestId === options.activeRequestId ||
					this.lookup(c.userEntryId)?.requestStatus === "settled",
			)
		);
	}

	/** Capture the original finalized proof or the narrow pending creation association. */
	deliveryGuard(id: string, options: SourceContextOptions = {}): () => void {
		const original = this.get(id);
		if (!original || !this.eligible(original, options))
			throw Error("Context source provenance unavailable");
		const final = this.final(id);
		const checkProofs =
			original.status === "finalized" && final
				? sourceDeliveryGuard(
						decodeProofs(JSON.parse(final.source_proofs)),
						this.lookup,
					)
				: undefined;
		const pendingOptions = { ...options };
		return () => {
			const current = this.get(id);
			if (!current || current.status === "withheld")
				throw Error("Context source provenance withheld before delivery");
			if (checkProofs) checkProofs();
			else if (!this.eligible(current, pendingOptions))
				throw Error("Context source provenance changed before delivery");
		};
	}

	/** Caller owns the one ContextStore transaction, including final proof and state write. */
	finalizeRequest(requestId?: string): number {
		let count = 0;
		for (const row of this.rows("pending")) {
			const artifact = decodeArtifact(row);
			if (
				requestId &&
				!artifact.creations.some((c) => c.policy.requestId === requestId)
			)
				continue;
			const result = this.resolve(artifact);
			if (result.status === "pending") continue;
			this.db
				.prepare("INSERT INTO context_finalizations VALUES (?, ?, ?, ?)")
				.run(
					artifact.id,
					result.status,
					JSON.stringify(result.proofs),
					result.reason,
				);
			this.db
				.prepare(
					"UPDATE context_artifacts SET status = ?, reason = ? WHERE id = ? AND status = 'pending'",
				)
				.run(result.status, result.reason, artifact.id);
			count++;
		}
		return count;
	}

	appendNote(
		callId: string,
		text: string,
		options: SourceContextOptions,
	): NoteReceipt {
		validId(callId, "note call id");
		if (!options.activeRequestId)
			throw Error("Current request provenance unavailable");
		if (typeof text !== "string" || !text.trim() || text.length > 8192)
			throw Error("Invalid managed note text");
		const id = `note-${createHash("sha256")
			.update(JSON.stringify([this.sessionId, options.activeRequestId, callId]))
			.digest("hex")}`;
		const previous = this.get(id);
		if (previous) {
			if (previous.content !== text) throw Error("Managed note call conflict");
			return { id, status: previous.status };
		}
		const working = this.db
			.prepare(
				"SELECT revision, goal, decisions, open_items, next_steps FROM working_state WHERE id = 1",
			)
			.get();
		const inherited = working
			? {
					id: `working-${working["revision"]}`,
					hasText:
						!!working["goal"] ||
						["decisions", "open_items", "next_steps"].some(
							(key) => String(working[key]) !== "[]",
						),
				}
			: undefined;
		const prior = inherited ? this.get(inherited.id) : undefined;
		const created = this.create(
			id,
			"note",
			text,
			[],
			options,
			prior && this.eligible(prior, options) ? inherited : undefined,
		);
		return { id, status: created.status };
	}

	notes(limit = 100): ManagedNote[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw Error("Invalid note limit");
		const result: ManagedNote[] = [];
		for (const row of this.rows()) {
			if (row.kind !== "note") continue;
			const artifact = decodeArtifact(row);
			if (!this.eligible(artifact)) continue;
			result.push({
				id: artifact.id,
				text: artifact.content,
				createdAt: artifact.createdAt,
			});
			if (result.length === limit) break;
		}
		return result;
	}

	private resolve(
		artifact: Artifact,
		options: SourceContextOptions = {},
	): { status: ArtifactStatus; proofs: SourceProof[]; reason: string } {
		const withheld = (reason: string) => ({
			status: "withheld" as const,
			proofs: [],
			reason,
		});
		if (
			artifact.dependencies.length &&
			!sourceProofsCurrent(artifact.dependencies, this.lookup)
		)
			return withheld("dependency_changed");
		let pending = false;
		for (const creation of artifact.creations) {
			const current = this.lookup(creation.userEntryId);
			const request = this.options.lookupRequest?.(creation.policy.requestId);
			if (
				!this.sameCreation(creation, current) ||
				request?.entryId !== creation.userEntryId ||
				!this.sameCreation(creation, request)
			)
				return withheld("creating_identity_changed");
			if (
				!current ||
				!isOrdinarySource(current, {
					activeRequestId: creation.policy.requestId,
				})
			)
				return withheld("creating_request_ineligible");
			if (current.requestStatus !== request.requestStatus)
				return withheld("creating_status_changed");
			if (current.requestStatus === "accepted") {
				pending = true;
				if (
					options.activeRequestId &&
					options.activeRequestId !== creation.policy.requestId
				)
					return withheld("other_pending_request");
			}
		}
		if (pending)
			return { status: "pending", proofs: [], reason: "awaiting_settlement" };
		try {
			const proofs = unionProofs(
				artifact.dependencies,
				captureSourceProofs(
					[...new Set(artifact.creations.map((c) => c.userEntryId))],
					this.lookup,
				),
			);
			return { status: "finalized", proofs, reason: "" };
		} catch {
			return withheld("creating_source_changed");
		}
	}
	private sameCreation(
		creation: Creation,
		source: SourceEntry | undefined,
	): boolean {
		try {
			if (
				source?.entryId !== creation.userEntryId ||
				source.role !== "user" ||
				!source.sourcePolicy
			)
				return false;
			const current = parseSourcePolicy(source.sourcePolicy),
				prior = creation.policy;
			return (
				prior.scope === "ordinary" &&
				current.scope === "ordinary" &&
				current.requestId === prior.requestId &&
				current.sessionId === prior.sessionId &&
				current.nativeEpoch === prior.nativeEpoch &&
				current.scopeDigest === prior.scopeDigest &&
				current.policyRevision >= prior.policyRevision &&
				(current.policyRevision !== prior.policyRevision ||
					sourcePolicyDigest(current) === sourcePolicyDigest(prior)) &&
				prior.contextReceiptIds.every((id) =>
					current.contextReceiptIds.includes(id),
				) &&
				prior.materialKinds.every((kind) =>
					current.materialKinds.includes(kind),
				)
			);
		} catch {
			return false;
		}
	}
	private final(id: string): FinalRow | undefined {
		return this.db
			.prepare("SELECT * FROM context_finalizations WHERE artifact_id = ?")
			.get(id) as FinalRow | undefined;
	}
	private rows(status?: ArtifactStatus): ArtifactRow[] {
		return (status
			? this.db
					.prepare(
						"SELECT * FROM context_artifacts WHERE status = ? ORDER BY rowid",
					)
					.all(status)
			: this.db
					.prepare("SELECT * FROM context_artifacts ORDER BY rowid")
					.all()) as unknown as ArtifactRow[];
	}
}
