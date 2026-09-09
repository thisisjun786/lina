import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonical, decode, hash, scopeSchema } from "./codec.ts";
import {
	derivationSchema,
	generationSchema,
	type IndexKind,
	type ResourceClaim,
	type ResourceDerivation,
	type ResourceGeneration,
	type ResourceJob,
} from "./job-codec.ts";
import {
	attempts,
	auditJobs,
	jobKey,
	readJob,
	writeJob,
} from "./job-records.ts";
import { allResources, permitted, resource, version } from "./records.ts";
import type { Resource, ResourceScope, ResourceVersionRef } from "./types.ts";

function collectionEdges(catalog: Resource[]): Map<string, Resource[]> {
	const edges = new Map<string, Resource[]>();
	for (const item of catalog) {
		for (const parent of new Set([item.parentId, ...item.collectionIds])) {
			if (parent === null) continue;
			const children = edges.get(parent);
			if (children) children.push(item);
			else edges.set(parent, [item]);
		}
	}
	return edges;
}

export class ResourceIndex {
	constructor(
		private readonly db: DatabaseSync,
		private readonly generation: (kind: IndexKind) => ResourceGeneration,
	) {
		auditJobs(db);
	}
	private tx<T>(fn: () => T): T {
		if (this.db.isTransaction) return fn();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const v = fn();
			this.db.exec("COMMIT");
			return v;
		} catch (e) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw e;
		}
	}
	private visible(scope: ResourceScope, id: string): Resource {
		const r = resource(this.db, id);
		if (!r || r.deleted || !permitted(scope, r))
			throw Error("resource unavailable");
		return r;
	}
	private sources(
		r: Resource,
		catalog?: Resource[],
		edges?: Map<string, Resource[]>,
	): {
		refs: ResourceVersionRef[];
		complete: boolean;
	} {
		if (r.kind !== "collection")
			return {
				refs: [
					{
						resourceId: r.id,
						resourceRevision: r.revision,
						versionId: r.currentVersion,
					},
				],
				complete: true,
			};
		const scope: ResourceScope = {
			principalId: r.ownerId,
			agentId: r.ownerId,
			allowedVisibilities: ["private", "shared"],
		};
		const children = edges ?? collectionEdges(catalog ?? allResources(this.db));
		const found = new Map<string, Resource>([[r.id, r]]),
			pending = [r.id];
		let complete = true;
		while (pending.length) {
			const id = pending.shift();
			for (const v of children.get(id ?? "") ?? []) {
				if (
					v.deleted ||
					!permitted(scope, v) ||
					(r.visibility === "shared" && v.visibility !== "shared")
				)
					continue;
				if (found.has(v.id)) continue;
				// A shared metadata shell must not publish an older private content version.
				if (
					v.currentVersion &&
					r.visibility === "shared" &&
					version(this.db, v.currentVersion)?.visibility !== "shared"
				)
					continue;
				if (found.size >= 64) {
					complete = false;
					continue;
				}
				found.set(v.id, v);
				if (v.kind === "collection") pending.push(v.id);
			}
		}
		return {
			refs: [...found.values()]
				.sort((a, b) => (a.id < b.id ? -1 : 1))
				.map((v) => ({
					resourceId: v.id,
					resourceRevision: v.revision,
					versionId: v.currentVersion,
				})),
			complete,
		};
	}
	refresh(): void {
		this.tx(() => this.changed());
	}
	matching(scope: ResourceScope, query: string): Set<string> {
		const parsed = scopeSchema.parse(scope),
			needle = query.toLocaleLowerCase();
		const rows =
			[...query].length >= 3
				? this.db
						.prepare(
							"SELECT DISTINCT resource_id FROM resource_fts WHERE resource_fts MATCH ?",
						)
						.all(`"${query.replaceAll('"', '""')}"`)
				: this.db
						.prepare("SELECT DISTINCT resource_id FROM resource_fts")
						.all();
		const result = new Set<string>();
		for (const row of rows) {
			const id = String(row["resource_id"]),
				r = resource(this.db, id);
			if (!r || r.deleted || !permitted(parsed, r)) continue;
			for (const kind of ["extract", "brief", "overview"] as const) {
				const output = this.read(parsed, id, kind);
				if (output?.text.toLocaleLowerCase().includes(needle)) {
					result.add(id);
					break;
				}
			}
		}
		return result;
	}
	changed(): string[] {
		if (!this.db.isTransaction)
			throw Error("resource indexing needs writer transaction");
		const catalog = allResources(this.db);
		const edges = collectionEdges(catalog);
		const affected = new Set<string>();
		for (const r of catalog) {
			if (r.deleted) continue;
			const source = this.sources(r, catalog, edges);
			for (const kind of r.kind === "collection"
				? (["overview"] as const)
				: (["extract", "brief"] as const)) {
				const generation = generationSchema.parse(this.generation(kind));
				const seed = {
					resourceId: r.id,
					sourceDigest: hash(source.refs),
					kind,
					generation,
				};
				const id = jobKey(seed);
				const existing = readJob(this.db, id);
				if (existing) {
					if (existing.complete !== source.complete) {
						writeJob(this.db, { ...existing, complete: source.complete });
						affected.add(r.id);
					}
					continue;
				}
				affected.add(r.id);
				writeJob(this.db, {
					...seed,
					id,
					ownerId: r.ownerId,
					visibility: r.visibility,
					...source,
					state: "pending",
					token: null,
					attempt: 0,
					inputHash: null,
					error: null,
					outputHash: null,
				});
			}
		}
		return [...affected];
	}
	get(rawScope: ResourceScope, id: string): ResourceJob {
		const scope = scopeSchema.parse(rawScope),
			job = readJob(this.db, id);
		if (!job || !permitted(scope, job)) throw Error("resource job unavailable");
		this.visible(scope, job.resourceId);
		return job;
	}
	list(scope: ResourceScope, id: string): ResourceJob[] {
		const current = this.visible(scopeSchema.parse(scope), id),
			source = this.sources(current),
			digest = hash(source.refs);
		return this.db
			.prepare("SELECT id FROM resource_jobs WHERE resource_id=? ORDER BY id")
			.all(id)
			.flatMap((row) => {
				try {
					const job = this.get(scope, String(row["id"]));
					return job.sourceDigest === digest
						? [{ ...job, complete: source.complete }]
						: [];
				} catch {
					return [];
				}
			});
	}
	valid(
		scope: ResourceScope,
		job: ResourceJob,
		checkGeneration = true,
	): boolean {
		try {
			const r = this.visible(scope, job.resourceId);
			if (
				(checkGeneration &&
					canonical(generationSchema.parse(this.generation(job.kind))) !==
						canonical(job.generation)) ||
				hash(this.sources(r).refs) !== job.sourceDigest
			)
				return false;
			return job.refs.every((ref) => {
				const source = this.visible(scope, ref.resourceId);
				if (
					source.revision !== ref.resourceRevision ||
					source.currentVersion !== ref.versionId
				)
					return false;
				const v = ref.versionId ? version(this.db, ref.versionId) : undefined;
				if (ref.versionId && !v) return false;
				return (
					(!v || permitted(scope, v)) &&
					(job.visibility !== "shared" ||
						(source.visibility === "shared" &&
							(!v || v.visibility === "shared")))
				);
			});
		} catch {
			return false;
		}
	}
	prepare(
		scope: ResourceScope,
		id: string,
		inputHash: string | null = null,
	): ResourceClaim {
		if (inputHash !== null && !/^[a-f0-9]{64}$/.test(inputHash))
			throw Error("invalid resource input hash");
		const result = this.tx(() => {
			const job = this.get(scope, id);
			if (job.state !== "pending") throw Error("resource job not pending");
			if (!this.valid(scope, job)) throw Error("stale resource input");
			const consumed = attempts(this.db, job);
			if (consumed >= job.generation.maxAttempts) {
				writeJob(this.db, {
					...job,
					state: "exhausted",
					error: "attempts_exhausted",
				});
				return null;
			}
			this.db
				.prepare(
					"INSERT INTO resource_job_attempts VALUES (?,?,?,?) ON CONFLICT(resource_id,source_digest,kind) DO UPDATE SET attempts=excluded.attempts",
				)
				.run(job.resourceId, job.sourceDigest, job.kind, consumed + 1);
			const token = randomUUID();
			writeJob(this.db, {
				...job,
				state: "prepared",
				complete: this.sources(this.visible(scope, job.resourceId)).complete,
				token,
				attempt: consumed + 1,
				inputHash,
				error: null,
			});
			return { id, token };
		});
		if (!result) throw Error("resource attempts exhausted");
		return result;
	}
	complete(
		scope: ResourceScope,
		claim: ResourceClaim,
		text: string,
		complete: boolean,
	): boolean {
		return this.tx(() => {
			const job = this.claimed(claim);
			if (!this.valid(scopeSchema.parse(scope), job)) {
				writeJob(this.db, {
					...job,
					state: "stale",
					token: null,
					error: "source_or_configuration_changed",
				});
				return false;
			}
			const coverage = this.sources(
				this.visible(scope, job.resourceId),
			).complete;
			const output = derivationSchema.parse({
				jobId: job.id,
				text,
				complete: complete && coverage,
			});
			this.db
				.prepare("INSERT INTO resource_derivations VALUES (?,?,?,?,?,?,?)")
				.run(
					job.resourceId,
					job.sourceDigest,
					job.generation.policyRevision,
					job.generation.modelSettingsRevision,
					job.kind,
					hash(job.generation),
					canonical(output),
				);
			this.db
				.prepare(
					"INSERT INTO resource_fts(resource_id,source_digest,text) VALUES (?,?,?)",
				)
				.run(job.resourceId, job.sourceDigest, text);
			writeJob(this.db, {
				...job,
				state: "ready",
				complete: coverage,
				token: null,
				error: null,
				outputHash: hash(output),
			});
			return true;
		});
	}
	private claimed(claim: ResourceClaim): ResourceJob {
		const job = readJob(this.db, claim.id);
		if (!job || job.state !== "prepared" || job.token !== claim.token)
			throw Error("resource claim mismatch");
		return job;
	}
	defer(
		scope: ResourceScope,
		id: string,
		error: string,
		state: "pending" | "unavailable" | "stale" = "unavailable",
	): void {
		if (!/^[a-z_]{1,64}$/.test(error)) throw Error("invalid resource error");
		this.tx(() => {
			const job = this.get(scope, id);
			if (job.state !== "pending") throw Error("resource job not pending");
			writeJob(this.db, { ...job, state, error });
		});
	}
	/** Owner-only outcome recording; no source text is accepted here. */
	fail(
		claim: ResourceClaim,
		error:
			| "provider_failed"
			| "cancelled"
			| "unsupported"
			| "input_limit"
			| "unsupported_type"
			| "vision_unavailable"
			| "undecodable_text"
			| "invalid_document"
			| "invalid_output"
			| "configuration_changed",
	): void {
		this.tx(() => {
			const job = this.claimed(claim);
			writeJob(this.db, {
				...job,
				state: [
					"unsupported",
					"input_limit",
					"unsupported_type",
					"vision_unavailable",
					"undecodable_text",
					"invalid_document",
				].includes(error)
					? "unavailable"
					: "failed",
				token: null,
				error,
			});
		});
	}
	/** Exclusive installation recovery owner only. Ordinary opens never invoke this. */
	recoverInterrupted(): number {
		return this.tx(() => {
			let count = 0;
			for (const row of this.db.prepare("SELECT id FROM resource_jobs").all()) {
				const job = readJob(this.db, String(row["id"]));
				if (job?.state === "prepared") {
					writeJob(this.db, {
						...job,
						state: "unknown",
						token: null,
						error: "interrupted_outcome_unknown",
					});
					count++;
				}
			}
			return count;
		});
	}
	retry(scope: ResourceScope, id: string): void {
		this.tx(() => {
			const job = this.get(scope, id);
			if (!["pending", "failed", "unknown", "unavailable"].includes(job.state))
				throw Error("resource job cannot retry");
			if (!this.valid(scope, job)) throw Error("stale resource input");
			if (attempts(this.db, job) >= job.generation.maxAttempts)
				throw Error("resource attempts exhausted");
			writeJob(this.db, {
				...job,
				state: "pending",
				complete: this.sources(this.visible(scope, job.resourceId)).complete,
				token: null,
				error: null,
			});
		});
	}
	read(
		scope: ResourceScope,
		id: string,
		kind: IndexKind,
	): (ResourceDerivation & { stale: boolean }) | undefined {
		let fallback: (ResourceDerivation & { stale: boolean }) | undefined;
		for (const job of this.list(scope, id)) {
			if (
				job.kind !== kind ||
				job.state !== "ready" ||
				!this.valid(scope, job, false)
			)
				continue;
			const row = this.db
				.prepare(
					"SELECT data FROM resource_derivations WHERE resource_id=? AND source_digest=? AND policy_revision=? AND model_settings_revision=? AND kind=? AND generation_key=?",
				)
				.get(
					job.resourceId,
					job.sourceDigest,
					job.generation.policyRevision,
					job.generation.modelSettingsRevision,
					kind,
					hash(job.generation),
				);
			if (row) {
				const output = decode(derivationSchema, row["data"]);
				if (hash(output) !== job.outputHash)
					throw Error("corrupt resource derivation");
				const current = {
					...output,
					complete: output.complete && job.complete,
				};
				if (this.valid(scope, job)) return { ...current, stale: false };
				fallback ??= { ...current, stale: true };
			}
		}
		return fallback;
	}
}
