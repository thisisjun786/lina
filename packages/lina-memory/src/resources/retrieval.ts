import { z } from "zod";
import { canonical, counter, uuid } from "./codec.ts";
import { isResourceText, textPrefix } from "./extraction.ts";
import type { ResourceStore } from "./store.ts";
import type { ResourceScope } from "./types.ts";

const optionsSchema = z.strictObject({
	level: z.enum(["brief", "overview", "content"]).default("content"),
	versionId: uuid.optional(),
	offset: counter.default(0),
	limit: counter.min(2).max(8192).default(4096),
});
export type ResourceReadOptions = z.input<typeof optionsSchema>;
export function readResource(
	store: ResourceStore,
	scope: ResourceScope,
	id: string,
	input: ResourceReadOptions = {},
) {
	const options = optionsSchema.parse(input),
		resource = store.get(scope, id),
		ref = store.ref(scope, id);
	let text: string | null = null,
		stale = false,
		complete = true;
	let reason: "not_available" | "undecodable_text" = "not_available";
	let original: {
		hash: string;
		byteLength: number;
		mediaType: string;
		versionId: string;
	} | null = null;
	if (resource.kind === "document") {
		const source = store.read(scope, id, options.versionId);
		original = {
			hash: source.version.hash,
			byteLength: source.version.byteLength,
			mediaType: source.version.mediaType,
			versionId: source.version.id,
		};
		if (
			options.level === "content" &&
			isResourceText(source.version.mediaType)
		) {
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
				reason = "undecodable_text";
			}
		}
	}
	if (
		text === null &&
		(!options.versionId || options.versionId === resource.currentVersion)
	) {
		const derived = store.indexing.read(
			scope,
			id,
			options.level === "content" ? "extract" : options.level,
		);
		if (derived) {
			text = derived.text;
			stale = derived.stale;
			complete = derived.complete;
		}
	}
	if (options.offset > (text?.length ?? 0))
		throw Error("invalid resource text offset");
	if (
		text !== null &&
		options.offset > 0 &&
		/[\uDC00-\uDFFF]/.test(text[options.offset] ?? "") &&
		/[\uD800-\uDBFF]/.test(text[options.offset - 1] ?? "")
	)
		throw Error("invalid resource text boundary");
	const page =
		text === null
			? null
			: textPrefix(text.slice(options.offset), options.limit);
	const end = options.offset + (page?.length ?? 0);
	if (canonical(store.ref(scope, id)) !== canonical(ref))
		throw Error("resource changed during reading");
	return {
		resourceId: id,
		ref,
		level: options.level,
		original,
		status: text === null ? ("unavailable" as const) : ("ready" as const),
		reason: text === null ? reason : null,
		text: page,
		stale,
		complete: text !== null && complete,
		offset: options.offset,
		nextOffset: text !== null && end < text.length ? end : null,
	};
}
