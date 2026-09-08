import {
	DOCUMENT_MAX_CHARS,
	extractDocument,
} from "../../../lina-core/src/attachments/document.ts";
import {
	AttachmentError,
	isDocumentMime,
	isImageMime,
} from "../../../lina-core/src/attachments/types.ts";
import { counter } from "./codec.ts";
import type { ResourceStore } from "./store.ts";
import type { ResourceScope, ResourceVersionRef } from "./types.ts";
export type ResourceVision = (
	input: { bytes: Uint8Array; mimeType: string },
	signal: AbortSignal,
	beforeDispatch: () => void,
	maxTokens: number,
) => Promise<string | null>;
export type ResourceExtraction =
	| {
			status: "ready";
			text: string;
			complete: boolean;
			refs: ResourceVersionRef[];
	  }
	| {
			status: "unavailable";
			reason:
				| "input_limit"
				| "unsupported_type"
				| "vision_unavailable"
				| "undecodable_text"
				| "invalid_document";
			refs: ResourceVersionRef[];
	  };
export function isResourceText(mime: string): boolean {
	return [
		"text/plain",
		"text/markdown",
		"text/csv",
		"application/json",
		"application/ld+json",
	].includes(mime);
}
export function textPrefix(text: string, maxChars: number): string {
	let end = Math.min(text.length, maxChars);
	if (
		end > 0 &&
		end < text.length &&
		/[\uD800-\uDBFF]/.test(text[end - 1] ?? "") &&
		/[\uDC00-\uDFFF]/.test(text[end] ?? "")
	)
		end--;
	return text.slice(0, end);
}
/** Source validity is checked both immediately before vision dispatch and after async extraction. */
export async function extractResource(
	store: ResourceStore,
	currentScope: () => ResourceScope,
	id: string,
	signal: AbortSignal,
	options: {
		vision?: ResourceVision;
		visionOutputTokens?: number;
		beforeDispatch?: () => void;
	} = {},
): Promise<ResourceExtraction> {
	signal.throwIfAborted();
	const source = store.read(currentScope(), id),
		refs = [
			{
				resourceId: source.resource.id,
				resourceRevision: source.resource.revision,
				versionId: source.resource.currentVersion,
			},
		];
	const guard = () => {
		signal.throwIfAborted();
		if (!store.current(currentScope(), refs))
			throw Error("resource extraction source changed");
	};
	if (source.bytes.length > store.limits.maxExtractionBytes)
		return { status: "unavailable", reason: "input_limit", refs };
	let text: string,
		complete = true;
	if (isResourceText(source.version.mediaType)) {
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
		} catch (error) {
			if (error instanceof TypeError)
				return { status: "unavailable", reason: "undecodable_text", refs };
			throw error;
		}
		const prefix = textPrefix(text, DOCUMENT_MAX_CHARS);
		complete = prefix.length === text.length;
		text = prefix;
	} else if (isDocumentMime(source.version.mediaType)) {
		try {
			const extracted = await extractDocument(
				source.bytes,
				source.version.mediaType,
				signal,
			);
			text = extracted.text;
			complete = !extracted.truncated;
		} catch (error) {
			guard();
			if (error instanceof AttachmentError && error.code === "unsupported-type")
				return { status: "unavailable", reason: "invalid_document", refs };
			throw error;
		}
	} else if (isImageMime(source.version.mediaType)) {
		if (!options.vision)
			return { status: "unavailable", reason: "vision_unavailable", refs };
		const maxTokens = counter
			.min(1)
			.max(8192)
			.parse(options.visionOutputTokens);
		guard();
		const result = await options.vision(
			{ bytes: source.bytes, mimeType: source.version.mediaType },
			signal,
			() => {
				guard();
				options.beforeDispatch?.();
			},
			maxTokens,
		);
		guard();
		if (result === null)
			return { status: "unavailable", reason: "vision_unavailable", refs };
		text = textPrefix(result, DOCUMENT_MAX_CHARS);
		complete = text.length === result.length;
	} else return { status: "unavailable", reason: "unsupported_type", refs };
	signal.throwIfAborted();
	if (!store.current(currentScope(), refs))
		throw Error("resource extraction source changed");
	return { status: "ready", text, complete, refs };
}
