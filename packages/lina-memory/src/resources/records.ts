import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
	canonical,
	decode,
	hash,
	resourceSchema,
	savedInputSchema,
	versionSchema,
} from "./codec.ts";
import type { ResourceContent } from "./content.ts";
import type { Resource, ResourceScope, ResourceVersion } from "./types.ts";

export function permitted(
	scope: ResourceScope,
	record: Pick<Resource, "ownerId" | "visibility">,
): boolean {
	return (
		scope.allowedVisibilities.includes(record.visibility) &&
		(record.visibility === "shared" || record.ownerId === scope.principalId)
	);
}
export function resource(db: DatabaseSync, id: string): Resource | undefined {
	const row = db.prepare("SELECT * FROM resources WHERE id=?").get(id);
	if (!row) return undefined;
	const r = decode(resourceSchema, row["data"]);
	if (
		r.id !== row["id"] ||
		r.parentId !== row["parent_id"] ||
		r.ownerId !== row["owner_id"] ||
		r.visibility !== row["visibility"] ||
		r.revision !== row["revision"] ||
		Number(r.deleted) !== row["deleted"]
	)
		throw Error("corrupt resource projection");
	const memberships = db
		.prepare(
			"SELECT collection_id FROM resource_memberships WHERE resource_id=? ORDER BY collection_id",
		)
		.all(id)
		.map((v) => v["collection_id"]);
	if (!isDeepStrictEqual(memberships, [...r.collectionIds].sort()))
		throw Error("corrupt resource memberships");
	return r;
}
export function version(
	db: DatabaseSync,
	id: string,
): ResourceVersion | undefined {
	const row = db.prepare("SELECT * FROM resource_versions WHERE id=?").get(id);
	if (!row) return undefined;
	const v = decode(versionSchema, row["data"]);
	if (
		v.id !== row["id"] ||
		v.resourceId !== row["resource_id"] ||
		v.ownerId !== row["owner_id"] ||
		v.visibility !== row["visibility"]
	)
		throw Error("corrupt resource version projection");
	return v;
}
export function allResources(db: DatabaseSync): Resource[] {
	return db
		.prepare("SELECT id FROM resources ORDER BY id")
		.all()
		.map((row) => {
			const value = resource(db, String(row["id"]));
			if (!value) throw Error("resource disappeared");
			return value;
		});
}
export function validateGraph(records: Resource[]): void {
	const map = new Map(records.map((r) => [r.id, r]));
	for (const r of records) {
		if (r.deleted) continue;
		const parents = [...(r.parentId ? [r.parentId] : []), ...r.collectionIds];
		for (const id of parents) {
			const p = map.get(id);
			if (!p || p.deleted || p.kind !== "collection")
				throw Error("invalid resource containment");
			if (
				p.visibility === "private" &&
				(r.visibility !== "private" || r.ownerId !== p.ownerId)
			)
				throw Error("private resource containment conflict");
		}
		const seen = new Set([r.id]);
		let next = r.parentId;
		while (next) {
			if (seen.has(next)) throw Error("resource cycle");
			seen.add(next);
			if (seen.size > 64) throw Error("resource depth limit");
			next = map.get(next)?.parentId ?? null;
		}
	}
}
export const resultSchema = z.strictObject({
	resource: resourceSchema,
	version: versionSchema.nullable(),
	affectedResourceIds: z.array(z.uuid()).optional(),
});
export function writeResource(db: DatabaseSync, r: Resource): void {
	db.prepare(
		"INSERT INTO resources VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,owner_id=excluded.owner_id,visibility=excluded.visibility,revision=excluded.revision,deleted=excluded.deleted,data=excluded.data",
	).run(
		r.id,
		r.parentId,
		r.ownerId,
		r.visibility,
		r.revision,
		Number(r.deleted),
		canonical(r),
	);
	db.prepare("DELETE FROM resource_memberships WHERE resource_id=?").run(r.id);
	for (const id of r.collectionIds)
		db.prepare("INSERT INTO resource_memberships VALUES (?,?)").run(id, r.id);
}
export function writeVersion(db: DatabaseSync, v: ResourceVersion): void {
	db.prepare("INSERT INTO resource_versions VALUES (?,?,?,?,?)").run(
		v.id,
		v.resourceId,
		v.ownerId,
		v.visibility,
		canonical(v),
	);
}
export function auditResources(
	db: DatabaseSync,
	content: ResourceContent,
): void {
	const records = allResources(db);
	validateGraph(records);
	const knownVersions = new Set<string>();
	for (const r of records) {
		let previous: Resource | undefined;
		const receipts = db
			.prepare(
				"SELECT * FROM resource_operations WHERE resource_id=? ORDER BY revision",
			)
			.all(r.id);
		for (const row of receipts) {
			const result = decode(resultSchema, row["result"]),
				current = result.resource;
			const input = decode(savedInputSchema, row["input"]);
			if (
				input.principalId !== row["principal_id"] ||
				input.operationId !== row["id"]
			)
				throw Error("corrupt resource request identity");
			if (
				input.bytes !== (result.version?.hash ?? null) ||
				("id" in input
					? input.id !== current.id ||
						input.expectedRevision !== current.revision - 1
					: current.revision !== 1)
			)
				throw Error("corrupt resource request result");
			if (
				current.id !== r.id ||
				current.revision !== (previous?.revision ?? 0) + 1 ||
				row["revision"] !== current.revision ||
				hash(JSON.parse(String(row["input"]))) !== row["fingerprint"] ||
				(previous &&
					(current.ownerId !== previous.ownerId ||
						current.kind !== previous.kind ||
						current.createdAt !== previous.createdAt ||
						previous.deleted))
			)
				throw Error("corrupt resource operation chain");
			if (result.version) {
				const v = result.version;
				if (
					v.resourceId !== r.id ||
					v.id !== current.currentVersion ||
					v.resourceRevision !== current.revision ||
					v.ownerId !== current.ownerId ||
					v.visibility !== current.visibility ||
					!isDeepStrictEqual(version(db, v.id), v)
				)
					throw Error("corrupt resource version receipt");
				knownVersions.add(v.id);
			}
			if (
				!result.version &&
				current.currentVersion !== (previous?.currentVersion ?? null)
			)
				throw Error("corrupt resource version change");
			previous = current;
		}
		if (!isDeepStrictEqual(previous, r))
			throw Error("corrupt resource latest receipt");
		if (r.currentVersion && version(db, r.currentVersion)?.resourceId !== r.id)
			throw Error("corrupt resource current version");
	}
	const blobs = new Map<string, number>();
	for (const row of db.prepare("SELECT id FROM resource_versions").all()) {
		const v = version(db, String(row["id"]));
		if (!v) throw Error("resource version disappeared");
		if (!knownVersions.has(v.id))
			throw Error("corrupt orphan resource version");
		if (blobs.has(v.hash)) {
			if (blobs.get(v.hash) !== v.byteLength)
				throw Error("corrupt resource blob length");
		} else {
			content.read(v);
			blobs.set(v.hash, v.byteLength);
		}
	}
}
