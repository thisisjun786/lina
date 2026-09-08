import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
	canonical,
	counter,
	decode,
	hash,
	identity,
	refSchema,
	scopeSchema,
	uuid,
} from "./codec.ts";
import { generationSchema, type ResourceGeneration } from "./job-codec.ts";
import type { Resource, ResourceScope, ResourceVersionRef } from "./types.ts";

export const activityKind = z.enum([
	"development",
	"research",
	"writing",
	"organization",
	"search",
	"other",
]);
const intentSchema = z.strictObject({
	enabled: z.boolean(),
	activityKind,
	proposerId: identity,
	revision: counter.min(1),
});
const outputSchema = z
	.array(
		z.strictObject({
			kind: z.enum(["observation", "decision", "experience"]),
			text: z.string().min(1).max(8192),
			quote: z.string().min(1).max(8192),
		}),
	)
	.max(16);
const jobSchema = z.strictObject({
	id: z.string().length(64),
	resourceId: uuid,
	sourceDigest: z.string().length(64),
	kind: z.literal("capture"),
	intentRevision: counter.min(1),
	generation: generationSchema,
	ref: refSchema,
	proposerId: identity,
	activityKind,
	state: z.enum([
		"pending",
		"prepared",
		"ready",
		"failed",
		"unknown",
		"stale",
		"exhausted",
	]),
	attempt: counter.max(3),
	token: uuid.nullable(),
	input: z.string().max(262144).nullable(),
	inputHash: z.string().length(64).nullable(),
	outputHash: z.string().length(64).nullable(),
	memoryIds: z.array(uuid).max(16),
	error: z.string().max(256).nullable(),
});
export type ResourceMemoryJob = z.infer<typeof jobSchema>;
export interface ResourceMemoryClaim {
	id: string;
	token: string;
}
const evidenceSchema = z.strictObject({
	jobId: z.string().length(64),
	ref: refSchema,
	generation: generationSchema,
	inputHash: z.string().length(64),
	quote: z.string().min(1).max(8192),
	activityKind,
});
export interface ResourceMemory {
	id: string;
	resourceId: string;
	versionId: string;
	policyRevision: number;
	proposerId: string;
	visibility: "private" | "shared";
	kind: "observation" | "decision" | "experience";
	text: string;
	evidence: z.infer<typeof evidenceSchema>;
	state: "active";
	revision: number;
	fingerprint: string;
}
interface Owner {
	get(scope: ResourceScope, id: string): Resource;
	ref(scope: ResourceScope, id: string): ResourceVersionRef;
	current(scope: ResourceScope, refs: readonly ResourceVersionRef[]): boolean;
}
/** Separate ledger: ordinary reads never refresh jobs or create capture intent. */
export class ResourceMemories {
	constructor(
		private db: DatabaseSync,
		private owner: Owner,
		private generation: () => ResourceGeneration,
	) {
		this.audit();
	}
	private tx<T>(fn: () => T): T {
		if (this.db.isTransaction) return fn();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			this.db.exec("COMMIT");
			return value;
		} catch (e) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw e;
		}
	}
	private intent(id: string) {
		const row = this.db
			.prepare("SELECT * FROM resource_memory_intents WHERE resource_id=?")
			.get(id);
		if (!row) return undefined;
		const value = decode(intentSchema, row["data"]);
		if (row["revision"] !== value.revision)
			throw Error("corrupt memory intent");
		return value;
	}
	private job(id: string): ResourceMemoryJob {
		const r = this.db
			.prepare("SELECT * FROM resource_memory_jobs WHERE id=?")
			.get(id);
		if (!r) throw Error("memory job unavailable");
		const j = decode(jobSchema, r["data"]);
		if (
			j.id !== r["id"] ||
			j.resourceId !== r["resource_id"] ||
			j.sourceDigest !== r["source_digest"] ||
			j.kind !== r["kind"] ||
			j.intentRevision !== r["intent_revision"] ||
			hash(j.generation) !== r["generation_key"] ||
			(j.state === "prepared") !== (j.token !== null)
		)
			throw Error("corrupt memory job");
		return j;
	}
	private write(j: ResourceMemoryJob) {
		jobSchema.parse(j);
		this.db
			.prepare(
				"INSERT INTO resource_memory_jobs VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
			)
			.run(
				j.id,
				j.resourceId,
				j.sourceDigest,
				j.kind,
				j.intentRevision,
				hash(j.generation),
				canonical(j),
			);
	}
	private current(scope: ResourceScope, j: ResourceMemoryJob) {
		const i = this.intent(j.resourceId);
		return (
			!!i?.enabled &&
			i.revision === j.intentRevision &&
			this.owner.current(scope, [j.ref]) &&
			canonical(j.generation) === canonical(this.generation())
		);
	}
	/** Invoked by the resource operation transaction, never by retrieval. */
	changed(
		scope: ResourceScope,
		input: {
			deriveMemory?: boolean;
			activityKind?: z.infer<typeof activityKind>;
		},
		r: Resource,
	): void {
		if (!this.db.isTransaction)
			throw Error("capture requires resource transaction");
		const old = this.intent(r.id);
		if (input.deriveMemory === undefined && !old) return;
		if (r.kind !== "document") throw Error("capture needs document");
		const i = intentSchema.parse({
			enabled: !r.deleted && (input.deriveMemory ?? old?.enabled ?? false),
			activityKind: input.activityKind ?? old?.activityKind ?? "other",
			proposerId: scope.principalId,
			revision: r.revision,
		});
		this.db
			.prepare(
				"INSERT INTO resource_memory_intents VALUES (?,?,?) ON CONFLICT(resource_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
			)
			.run(r.id, i.revision, canonical(i));
		if (!i.enabled) return;
		const ref = this.owner.ref(scope, r.id),
			generation = generationSchema.parse(this.generation()),
			sourceDigest = hash({ resourceId: r.id, versionId: r.currentVersion });
		const id = hash({ ref, intentRevision: i.revision, generation });
		this.write({
			id,
			resourceId: r.id,
			sourceDigest,
			kind: "capture",
			intentRevision: i.revision,
			generation,
			ref,
			proposerId: i.proposerId,
			activityKind: i.activityKind,
			state: "pending",
			attempt: 0,
			token: null,
			input: null,
			inputHash: null,
			outputHash: null,
			memoryIds: [],
			error: null,
		});
	}
	jobs(rawScope: ResourceScope, id: string): ResourceMemoryJob[] {
		const scope = scopeSchema.parse(rawScope);
		this.owner.get(scope, id);
		return this.db
			.prepare(
				"SELECT id FROM resource_memory_jobs WHERE resource_id=? ORDER BY id",
			)
			.all(id)
			.map((r) => this.job(String(r["id"])));
	}
	prepare(
		scope: ResourceScope,
		id: string,
		input: string,
	): ResourceMemoryClaim {
		const text = z.string().min(1).max(262144).parse(input);
		let exhausted = false;
		const result = this.tx(() => {
			const j = this.job(id);
			if (j.state !== "pending" || !this.current(scope, j))
				throw Error("memory source or claim changed");
			const previous = this.db
				.prepare(
					"SELECT attempts FROM resource_memory_attempts WHERE resource_id=? AND source_digest=? AND kind='capture'",
				)
				.get(j.resourceId, j.sourceDigest);
			const attempts = counter.max(3).parse(previous?.["attempts"] ?? 0);
			if (attempts >= j.generation.maxAttempts) {
				j.state = "exhausted";
				this.write(j);
				exhausted = true;
				return null;
			}
			j.attempt = attempts + 1;
			j.state = "prepared";
			j.token = randomUUID();
			j.input = text;
			j.inputHash = hash(text);
			this.db
				.prepare(
					"INSERT INTO resource_memory_attempts VALUES (?,?,'capture',?) ON CONFLICT(resource_id,source_digest,kind) DO UPDATE SET attempts=excluded.attempts",
				)
				.run(j.resourceId, j.sourceDigest, j.attempt);
			this.write(j);
			return { id: j.id, token: j.token };
		});
		if (exhausted || !result) throw Error("memory attempts exhausted");
		return result;
	}
	complete(
		scope: ResourceScope,
		claim: ResourceMemoryClaim,
		raw: unknown,
	): ResourceMemory[] {
		const outputs = outputSchema.parse(raw);
		return this.tx(() => {
			const j = this.job(claim.id);
			if (!this.current(scope, j)) throw Error("memory source changed");
			const digest = hash({ token: claim.token, outputs });
			if (j.state === "ready") {
				if (j.outputHash !== digest) throw Error("memory completion conflict");
				return this.list(scope, j.resourceId).filter((m) =>
					j.memoryIds.includes(m.id),
				);
			}
			if (
				j.state !== "prepared" ||
				j.token !== claim.token ||
				!j.input ||
				!j.inputHash
			)
				throw Error("memory claim unavailable");
			const r = this.owner.get(scope, j.resourceId);
			if (!r.currentVersion) throw Error("memory needs version");
			const result: ResourceMemory[] = [];
			for (const output of outputs) {
				if (!j.input.includes(output.quote))
					throw Error("memory evidence not in input");
				const evidence = {
					jobId: j.id,
					ref: j.ref,
					generation: j.generation,
					inputHash: j.inputHash,
					quote: output.quote,
					activityKind: j.activityKind,
				};
				const fingerprint = hash({
					ref: j.ref,
					intentRevision: j.intentRevision,
					generation: j.generation,
					...output,
				});
				const memory: ResourceMemory = {
					id: randomUUID(),
					resourceId: r.id,
					versionId: r.currentVersion,
					policyRevision: j.generation.policyRevision,
					proposerId: j.proposerId,
					visibility: r.visibility,
					kind: output.kind,
					text: output.text,
					evidence,
					state: "active",
					revision: 1,
					fingerprint,
				};
				this.db
					.prepare(
						"INSERT INTO resource_memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
					)
					.run(
						memory.id,
						memory.resourceId,
						memory.versionId,
						memory.policyRevision,
						memory.proposerId,
						memory.visibility,
						memory.kind,
						memory.text,
						canonical(evidence),
						memory.state,
						memory.revision,
						memory.fingerprint,
					);
				result.push(memory);
			}
			j.memoryIds = result.map((m) => m.id);
			j.state = "ready";
			j.token = null;
			j.outputHash = digest;
			this.write(j);
			return result;
		});
	}
	private memory(row: Record<string, unknown>): ResourceMemory {
		return {
			id: uuid.parse(row["id"]),
			resourceId: uuid.parse(row["resource_id"]),
			versionId: uuid.parse(row["version_id"]),
			policyRevision: counter.parse(row["policy_revision"]),
			proposerId: identity.parse(row["proposer_id"]),
			visibility: z.enum(["private", "shared"]).parse(row["visibility"]),
			kind: z
				.enum(["observation", "decision", "experience"])
				.parse(row["kind"]),
			text: z.string().min(1).max(8192).parse(row["text"]),
			evidence: decode(evidenceSchema, row["evidence_json"]),
			state: z.literal("active").parse(row["state"]),
			revision: counter.min(1).parse(row["revision"]),
			fingerprint: z.string().length(64).parse(row["fingerprint"]),
		};
	}
	list(rawScope: ResourceScope, id: string): ResourceMemory[] {
		const scope = scopeSchema.parse(rawScope);
		this.owner.get(scope, id);
		return this.db
			.prepare(
				"SELECT * FROM resource_memories WHERE resource_id=? ORDER BY rowid",
			)
			.all(id)
			.map((r) => this.memory(r))
			.filter((m) => {
				const j = this.job(m.evidence.jobId);
				return (
					j.state === "ready" &&
					j.memoryIds.includes(m.id) &&
					this.current(scope, j)
				);
			});
	}
	recoverInterrupted(): number {
		return this.tx(() => {
			let count = 0;
			for (const r of this.db
				.prepare("SELECT id FROM resource_memory_jobs")
				.all()) {
				const j = this.job(String(r["id"]));
				if (j.state === "prepared") {
					j.state = "unknown";
					j.token = null;
					j.error = "interrupted";
					this.write(j);
					count++;
				}
			}
			return count;
		});
	}
	retry(scope: ResourceScope, id: string): void {
		this.tx(() => {
			const j = this.job(id);
			if (!["failed", "unknown"].includes(j.state) || !this.current(scope, j))
				throw Error("memory retry unavailable");
			j.state = "pending";
			j.error = null;
			j.input = null;
			j.inputHash = null;
			this.write(j);
		});
	}
	fail(scope: ResourceScope, claim: ResourceMemoryClaim, reason: string): void {
		this.tx(() => {
			const j = this.job(claim.id);
			this.owner.get(scope, j.resourceId);
			if (j.state !== "prepared" || j.token !== claim.token)
				throw Error("memory claim unavailable");
			j.state = "failed";
			j.token = null;
			j.error = z.string().max(256).parse(reason);
			this.write(j);
		});
	}
	audit(): void {
		for (const r of this.db
			.prepare("SELECT resource_id FROM resource_memory_intents")
			.all())
			this.intent(String(r["resource_id"]));
		for (const r of this.db
			.prepare("SELECT id FROM resource_memory_jobs")
			.all()) {
			const j = this.job(String(r["id"]));
			if (
				(j.input === null) !== (j.inputHash === null) ||
				(j.input !== null && hash(j.input) !== j.inputHash)
			)
				throw Error("corrupt memory input");
		}
		for (const r of this.db.prepare("SELECT * FROM resource_memories").all()) {
			const m = this.memory(r),
				j = this.job(m.evidence.jobId);
			if (
				j.state !== "ready" ||
				!j.memoryIds.includes(m.id) ||
				j.ref.resourceId !== m.resourceId ||
				j.ref.versionId !== m.versionId ||
				!j.input?.includes(m.evidence.quote) ||
				j.inputHash !== m.evidence.inputHash ||
				canonical(j.generation) !== canonical(m.evidence.generation)
			)
				throw Error("corrupt memory evidence");
		}
	}
}
