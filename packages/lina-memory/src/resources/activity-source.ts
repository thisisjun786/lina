import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type { ResourceActivityOutcome } from "../../../lina-core/src/world/work-types.ts";
import { hash } from "./codec.ts";
import { isResourceText } from "./extraction.ts";
import type { ResourceStore } from "./store.ts";
import type { ResourceScope } from "./types.ts";

export interface ActivityQuote {
	quote: string;
	quoteHash: string;
	memoryId: string | null;
}
export interface ActivitySnapshot {
	resourceId: string;
	resourceRevision: number;
	versionId: string;
	blobHash: string;
	mediaType: string;
	visibility: "private" | "shared";
	ownerId: string;
	memoryId: string | null;
	quotes: ActivityQuote[];
}

function sourceText(
	store: ResourceStore,
	scope: ResourceScope,
	resourceId: string,
	_versionId: string,
	bytes: Uint8Array,
	mediaType: string,
): string | null {
	if (isResourceText(mediaType)) {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			if (error instanceof TypeError) return null;
			throw error;
		}
	}
	const extracted = store.indexing.read(scope, resourceId, "extract");
	if (!extracted || extracted.stale) return null;
	return extracted.text;
}

export function captureActivitySource(
	store: ResourceStore,
	scope: ResourceScope,
	input: {
		resourceId: string;
		versionId: string | null;
		memoryId: string | null;
		quotes: string[];
		outcome: ResourceActivityOutcome;
		hostConfirmed: boolean;
	},
): { snapshot: ActivitySnapshot; evidenceDigest: string } {
	const read = store.read(
		scope,
		input.resourceId,
		input.versionId ?? undefined,
	);
	if (read.resource.kind !== "document" || !read.resource.currentVersion)
		throw Error("resource activity needs document");
	if (read.resource.currentVersion !== read.version.id)
		throw Error("stale resource activity source");
	if (
		!store.current(scope, [
			{
				resourceId: read.resource.id,
				resourceRevision: read.resource.revision,
				versionId: read.version.id,
			},
		])
	)
		throw Error("stale resource activity source");
	const text = sourceText(
		store,
		scope,
		read.resource.id,
		read.version.id,
		read.bytes,
		read.version.mediaType,
	);
	if (input.outcome === "verified_result") {
		if (!input.hostConfirmed)
			throw Error("resource activity verification requires host confirmation");
		if (!input.quotes.length || !text)
			throw Error("resource activity quote not in source");
	}
	if (input.memoryId) {
		const memory = store.memories
			.list(scope, read.resource.id)
			.find((item) => item.id === input.memoryId);
		if (!memory || memory.versionId !== read.version.id || memory.stale)
			throw Error("resource activity memory unavailable");
	}
	for (const quote of input.quotes) {
		if (!text?.includes(quote))
			throw Error("resource activity quote not in source");
	}
	const quotes = input.quotes.map((quote) => ({
		quote,
		quoteHash: hash(quote),
		memoryId: input.memoryId,
	}));
	const snapshot: ActivitySnapshot = {
		resourceId: read.resource.id,
		resourceRevision: read.resource.revision,
		versionId: read.version.id,
		blobHash: read.version.hash,
		mediaType: read.version.mediaType,
		visibility: read.version.visibility,
		ownerId: read.resource.ownerId,
		memoryId: input.memoryId,
		quotes,
	};
	const evidenceDigest = lifeDigest(
		quotes.map((item) => ({
			resourceId: snapshot.resourceId,
			resourceRevision: snapshot.resourceRevision,
			versionId: snapshot.versionId,
			blobHash: snapshot.blobHash,
			quote: item.quote,
			quoteHash: item.quoteHash,
			memoryId: item.memoryId,
		})),
	);
	if (input.outcome === "verified_result" && evidenceDigest === lifeDigest([]))
		throw Error("resource activity quote not in source");
	return { snapshot, evidenceDigest };
}

export function activitySourceCurrent(
	store: ResourceStore,
	scope: ResourceScope,
	snapshot: ActivitySnapshot,
): boolean {
	try {
		if (
			!store.current(scope, [
				{
					resourceId: snapshot.resourceId,
					resourceRevision: snapshot.resourceRevision,
					versionId: snapshot.versionId,
				},
			])
		)
			return false;
		const read = store.read(scope, snapshot.resourceId, snapshot.versionId);
		if (read.version.hash !== snapshot.blobHash) return false;
		if (snapshot.memoryId) {
			const memory = store.memories
				.list(scope, snapshot.resourceId)
				.find((item) => item.id === snapshot.memoryId);
			if (!memory || memory.stale || memory.versionId !== snapshot.versionId)
				return false;
		}
		const text = sourceText(
			store,
			scope,
			snapshot.resourceId,
			snapshot.versionId,
			read.bytes,
			read.version.mediaType,
		);
		return snapshot.quotes.every((item) => !!text && text.includes(item.quote));
	} catch {
		return false;
	}
}
