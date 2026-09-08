import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	docxBytes,
	pdfBytes,
	xlsxBytes,
} from "../../lina-core/test/attachment-document-fixtures.ts";
import { extractResource } from "../src/resources/extraction.ts";
import { ResourceStore } from "../src/resources/store.ts";

const scope = {
	principalId: "agent:a",
	agentId: "a",
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
};
const limits = {
	maxFileBytes: 8192,
	maxCatalogBytes: 32768,
	maxExtractionBytes: 8192,
};
for (const [mime, bytes] of [
	["application/pdf", pdfBytes(["Resource evidence"])],
	[
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		docxBytes(["Resource evidence"]),
	],
	[
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		xlsxBytes([{ name: "Sheet", rows: [["Resource evidence"]] }]),
	],
] as const)
	test(`resource ingest uses existing ${mime} extractor`, async () => {
		const root = mkdtempSync(join(tmpdir(), "lina-resource-parser-"));
		const store = new ResourceStore(root, limits);
		try {
			const doc = store.create(scope, {
				operationId: "doc",
				kind: "document",
				title: "자료",
				visibility: "private",
				mediaType: mime,
				bytes,
			});
			const result = await extractResource(
				store,
				() => scope,
				doc.id,
				new AbortController().signal,
			);
			expect(result.status).toBe("ready");
			if (result.status !== "ready") throw Error("parser unavailable");
			expect(result.text).toContain("Resource evidence");
			expect(store.read(scope, doc.id).bytes).toEqual(bytes);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

test("unsupported vision and oversized extraction retain original bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-extract-limits-"));
	const store = new ResourceStore(root, { ...limits, maxExtractionBytes: 4 });
	try {
		const image = store.create(scope, {
			operationId: "image",
			kind: "document",
			title: "이미지",
			visibility: "private",
			mediaType: "image/png",
			bytes: new Uint8Array([1]),
		});
		expect(
			await extractResource(
				store,
				() => scope,
				image.id,
				new AbortController().signal,
			),
		).toMatchObject({ status: "unavailable", reason: "vision_unavailable" });
		const doc = store.create(scope, {
			operationId: "large",
			kind: "document",
			title: "긴 원문",
			visibility: "private",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("larger"),
		});
		expect(
			await extractResource(
				store,
				() => scope,
				doc.id,
				new AbortController().signal,
			),
		).toMatchObject({ status: "unavailable", reason: "input_limit" });
		expect(store.read(scope, doc.id).bytes).toHaveLength(6);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("scope changes during vision never return private version text", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-vision-scope-"));
	const store = new ResourceStore(root, limits);
	let current = scope;
	try {
		const image = store.create(scope, {
			operationId: "image",
			kind: "document",
			title: "이미지",
			visibility: "private",
			mediaType: "image/png",
			bytes: new Uint8Array([1]),
		});
		store.update(scope, {
			operationId: "share-metadata",
			id: image.id,
			expectedRevision: 1,
			visibility: "shared",
		});
		await expect(
			extractResource(
				store,
				() => current,
				image.id,
				new AbortController().signal,
				{
					visionOutputTokens: 37,
					vision: async () => {
						current = { ...scope, principalId: "agent:b", agentId: "b" };
						return "PRIVATE CONTENT";
					},
				},
			),
		).rejects.toThrow(/changed/);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("undecodable text remains stored with an explicit terminal input reason", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-encoding-"));
	const store = new ResourceStore(root, limits);
	try {
		const doc = store.create(scope, {
			operationId: "bad",
			kind: "document",
			title: "인코딩",
			visibility: "private",
			mediaType: "text/csv",
			bytes: new Uint8Array([0xff, 0xfe, 0xfd]),
		});
		expect(
			await extractResource(
				store,
				() => scope,
				doc.id,
				new AbortController().signal,
			),
		).toMatchObject({ status: "unavailable", reason: "undecodable_text" });
		expect(store.read(scope, doc.id).bytes).toHaveLength(3);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("vision receives a request ceiling and checks current source at dispatch", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-vision-dispatch-"));
	const store = new ResourceStore(root, limits);
	try {
		const doc = store.create(scope, {
			operationId: "image",
			kind: "document",
			title: "이미지",
			visibility: "private",
			mediaType: "image/png",
			bytes: new Uint8Array([1]),
		});
		let cap: number | undefined,
			dispatches = 0;
		const result = await extractResource(
			store,
			() => scope,
			doc.id,
			new AbortController().signal,
			{
				visionOutputTokens: 37,
				beforeDispatch: () => {
					dispatches++;
				},
				vision: async (_i, _s, guard, maxTokens) => {
					cap = maxTokens;
					guard();
					return "image";
				},
			},
		);
		expect(cap).toBe(37);
		expect(dispatches).toBe(1);
		expect(result.status).toBe("ready");
		await expect(
			extractResource(
				store,
				() => scope,
				doc.id,
				new AbortController().signal,
				{
					visionOutputTokens: 37,
					vision: async (_i, _s, guard) => {
						store.update(scope, {
							operationId: "change",
							id: doc.id,
							expectedRevision: 1,
							title: "changed",
						});
						guard();
						return "must not dispatch";
					},
				},
			),
		).rejects.toThrow(/changed/);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid containers and aborted calls are distinguished", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-invalid-container-"));
	const store = new ResourceStore(root, limits);
	try {
		const doc = store.create(scope, {
			operationId: "pdf",
			kind: "document",
			title: "깨진 파일",
			visibility: "private",
			mediaType: "application/pdf",
			bytes: new TextEncoder().encode("not a pdf"),
		});
		expect(
			await extractResource(
				store,
				() => scope,
				doc.id,
				new AbortController().signal,
			),
		).toMatchObject({ status: "unavailable", reason: "invalid_document" });
		await expect(
			extractResource(
				store,
				() => scope,
				doc.id,
				AbortSignal.abort(new Error("cancelled")),
			),
		).rejects.toThrow(/cancelled/);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
