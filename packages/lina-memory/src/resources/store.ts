import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openCheckedDatabase } from "../../../lina-core/src/session-binding.ts";
import {
	byteHash,
	canonical,
	counter,
	createSchema,
	decode,
	hash,
	resourceSchema,
	scopeSchema,
	updateSchema,
	uuid,
	versionSchema,
} from "./codec.ts";
import { ResourceContent, type ResourceContentLimits } from "./content.ts";
import {
	allResources,
	auditResources,
	permitted,
	resource,
	resultSchema,
	validateGraph,
	version,
	writeResource,
	writeVersion,
} from "./records.ts";
import { initializeResources, verifyResourceSchema } from "./schema.ts";
import type {
	Resource,
	ResourceCreate,
	ResourceScope,
	ResourceUpdate,
	ResourceVersion,
	ResourceVersionRef,
} from "./types.ts";

export class ResourceStore {
	private readonly db: DatabaseSync;
	private readonly content: ResourceContent;
	private closed = false;
	constructor(
		root: string,
		readonly limits: ResourceContentLimits,
	) {
		const { db, fresh } = openCheckedDatabase(join(root, "catalog.sqlite"));
		this.db = db;
		try {
			this.content = new ResourceContent(join(root, "blobs"), limits);
			db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
			initializeResources(db, fresh);
			auditResources(db, this.content);
			db.exec("COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
		} catch (error) {
			if (db.isTransaction) db.exec("ROLLBACK");
			db.close();
			throw error;
		}
	}
	close(): void {
		if (!this.closed) {
			this.db.close();
			this.closed = true;
		}
	}
	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			verifyResourceSchema(this.db);
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}
	get(rawScope: ResourceScope, id: string): Resource {
		const scope = scopeSchema.parse(rawScope),
			r = resource(this.db, uuid.parse(id));
		if (!r || r.deleted || !permitted(scope, r))
			throw Error("resource unavailable");
		return r;
	}
	ref(scope: ResourceScope, id: string): ResourceVersionRef {
		const r = this.get(scope, id);
		return {
			resourceId: r.id,
			resourceRevision: r.revision,
			versionId: r.currentVersion,
		};
	}
	current(scope: ResourceScope, refs: readonly ResourceVersionRef[]): boolean {
		try {
			return refs.every(
				(ref) => canonical(this.ref(scope, ref.resourceId)) === canonical(ref),
			);
		} catch {
			return false;
		}
	}
	read(
		scope: ResourceScope,
		id: string,
		versionId?: string,
	): { resource: Resource; version: ResourceVersion; bytes: Uint8Array } {
		const r = this.get(scope, id),
			v = version(
				this.db,
				versionId ? uuid.parse(versionId) : (r.currentVersion ?? ""),
			);
		if (!v || v.resourceId !== r.id || !permitted(scopeSchema.parse(scope), v))
			throw Error("resource version unavailable");
		return { resource: r, version: v, bytes: this.content.read(v) };
	}
	list(
		scope: ResourceScope,
		parentId: string | null = null,
		options: { cursor?: string; limit?: number } = {},
	): { items: Resource[]; nextCursor: string | null } {
		const parsed = scopeSchema.parse(scope);
		if (parentId) {
			const parent = this.get(parsed, parentId);
			if (parent.kind !== "collection") throw Error("invalid collection");
		}
		const limit = counter
				.min(1)
				.max(100)
				.parse(options.limit ?? 50),
			cursor = options.cursor ? uuid.parse(options.cursor) : null;
		const candidates = allResources(this.db).filter(
			(r) =>
				!r.deleted &&
				permitted(parsed, r) &&
				(r.parentId === parentId ||
					(parentId !== null && r.collectionIds.includes(parentId))) &&
				(!cursor || r.id > cursor),
		);
		const items = candidates.slice(0, limit);
		return {
			items,
			nextCursor: candidates.length > limit ? (items.at(-1)?.id ?? null) : null,
		};
	}
	private replay(
		scope: ResourceScope,
		operationId: string,
		fingerprint: string,
	): Resource | undefined {
		const row = this.db
			.prepare("SELECT * FROM resource_operations WHERE id=?")
			.get(operationId);
		if (!row) return;
		if (
			row["principal_id"] !== scope.principalId ||
			row["fingerprint"] !== fingerprint
		)
			throw Error("resource operation conflict");
		const result = decode(resultSchema, row["result"]),
			current = resource(this.db, result.resource.id);
		if (
			!current ||
			!permitted(scope, current) ||
			!permitted(scope, result.resource) ||
			(result.version && !permitted(scope, result.version)) ||
			(current.deleted && !result.resource.deleted)
		)
			throw Error("resource unavailable");
		return result.resource;
	}
	private record(
		scope: ResourceScope,
		input: unknown,
		r: Resource,
		v: ResourceVersion | null,
	): Resource {
		const value = input as { operationId: string };
		this.db
			.prepare("INSERT INTO resource_operations VALUES (?,?,?,?,?,?,?)")
			.run(
				value.operationId,
				scope.principalId,
				r.id,
				r.revision,
				hash(input),
				canonical(input),
				canonical({ resource: r, version: v }),
			);
		return r;
	}
	create(rawScope: ResourceScope, raw: ResourceCreate): Resource {
		const scope = scopeSchema.parse(rawScope),
			input = createSchema.parse(raw);
		if (!scope.allowedVisibilities.includes(input.visibility))
			throw Error("resource unavailable");
		if (
			(input.kind === "document" && (!input.bytes || !input.mediaType)) ||
			(input.kind === "collection" &&
				(input.bytes !== undefined || input.mediaType !== undefined))
		)
			throw Error("invalid resource content kind");
		const normalized = {
			principalId: scope.principalId,
			...input,
			bytes: input.bytes ? byteHash(input.bytes) : null,
		};
		return this.transaction(() => {
			const replay = this.replay(scope, input.operationId, hash(normalized));
			if (replay) return replay;
			if (input.parentId) this.get(scope, input.parentId);
			const now = counter.parse(Date.now()),
				id = randomUUID();
			const v = input.bytes
				? versionSchema.parse({
						id: randomUUID(),
						resourceId: id,
						resourceRevision: 1,
						ownerId: scope.principalId,
						visibility: input.visibility,
						mediaType: input.mediaType,
						...this.content.put(input.bytes),
						createdAt: now,
					})
				: null;
			const r = resourceSchema.parse({
				id,
				kind: input.kind,
				title: input.title,
				parentId: input.parentId,
				collectionIds: [],
				currentVersion: v?.id ?? null,
				revision: 1,
				mediaType: input.mediaType ?? null,
				ownerId: scope.principalId,
				visibility: input.visibility,
				deleted: false,
				createdAt: now,
				updatedAt: now,
			});
			validateGraph([...allResources(this.db), r]);
			writeResource(this.db, r);
			if (v) writeVersion(this.db, v);
			return this.record(scope, normalized, r, v);
		});
	}
	update(rawScope: ResourceScope, raw: ResourceUpdate): Resource {
		const scope = scopeSchema.parse(rawScope),
			input = updateSchema.parse(raw),
			normalized = {
				principalId: scope.principalId,
				...input,
				bytes: input.bytes ? byteHash(input.bytes) : null,
			};
		return this.transaction(() => {
			const replay = this.replay(scope, input.operationId, hash(normalized));
			if (replay) return replay;
			const previous = this.get(scope, input.id);
			if (previous.revision !== input.expectedRevision)
				throw Error("stale resource revision");
			if (
				(input.visibility !== undefined || input.deleted) &&
				previous.ownerId !== scope.principalId
			)
				throw Error("resource owner required");
			if (
				input.visibility &&
				!scope.allowedVisibilities.includes(input.visibility)
			)
				throw Error("resource unavailable");
			if (input.parentId && input.parentId !== previous.id)
				this.get(scope, input.parentId);
			if (input.collectionIds)
				for (const id of input.collectionIds) this.get(scope, id);
			if (
				previous.kind === "collection" &&
				(input.bytes !== undefined ||
					input.mediaType !== undefined ||
					input.collectionIds !== undefined)
			)
				throw Error("invalid collection content");
			if (input.mediaType !== undefined && !input.bytes)
				throw Error("media change needs content");
			const now = counter.parse(Date.now()),
				revision = counter.parse(previous.revision + 1);
			const v = input.bytes
				? versionSchema.parse({
						id: randomUUID(),
						resourceId: previous.id,
						resourceRevision: revision,
						ownerId: previous.ownerId,
						visibility: input.visibility ?? previous.visibility,
						mediaType: input.mediaType ?? previous.mediaType,
						...this.content.put(input.bytes),
						createdAt: now,
					})
				: null;
			const r = resourceSchema.parse({
				...previous,
				title: input.title ?? previous.title,
				parentId:
					input.parentId === undefined ? previous.parentId : input.parentId,
				collectionIds: input.collectionIds
					? [...new Set(input.collectionIds)].sort()
					: previous.collectionIds,
				visibility: input.visibility ?? previous.visibility,
				deleted: input.deleted ?? false,
				revision,
				updatedAt: Math.max(now, previous.updatedAt),
				currentVersion: v?.id ?? previous.currentVersion,
				mediaType: v?.mediaType ?? previous.mediaType,
			});
			const records = allResources(this.db).map((item) =>
				item.id === r.id ? r : item,
			);
			validateGraph(records);
			writeResource(this.db, r);
			if (v) writeVersion(this.db, v);
			return this.record(scope, normalized, r, v);
		});
	}
}
