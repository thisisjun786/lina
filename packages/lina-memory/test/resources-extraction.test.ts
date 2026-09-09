import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	docxBytes,
	pdfBytes,
	xlsxBytes,
} from "../../lina-core/test/attachment-document-fixtures.ts";
import {
	extractResource,
	isResourceText,
} from "../src/resources/extraction.ts";
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
const htmlBytes = (value: string) => new TextEncoder().encode(value);
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
		const oversizedHtml = htmlBytes("<p>too-large-html</p>");
		const html = store.create(scope, {
			operationId: "large-html",
			kind: "document",
			title: "큰 HTML",
			visibility: "private",
			mediaType: "text/html",
			bytes: oversizedHtml,
		});
		expect(
			await extractResource(
				store,
				() => scope,
				html.id,
				new AbortController().signal,
			),
		).toMatchObject({ status: "unavailable", reason: "input_limit" });
		expect(store.read(scope, html.id).bytes).toEqual(oversizedHtml);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("unmatched closing tags inside hidden HTML never leak hidden text", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-html-hidden-"));
	const store = new ResourceStore(root, limits);
	const original = htmlBytes(
		"<p>Visible</p><div hidden>secret</span>LEAK</div><p>After</p>",
	);
	try {
		const doc = store.create(scope, {
			operationId: "html-hidden",
			kind: "document",
			title: "숨김 HTML",
			visibility: "private",
			mediaType: "text/html",
			bytes: original,
		});
		const result = await extractResource(
			store,
			() => scope,
			doc.id,
			new AbortController().signal,
		);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw Error("html extract unavailable");
		expect(result.text).toContain("Visible");
		expect(result.text).toContain("After");
		expect(result.text).not.toContain("secret");
		expect(result.text).not.toContain("LEAK");
		expect(store.read(scope, doc.id).bytes).toEqual(original);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("malformed, undecodable and aborted HTML remain stored with explicit reasons", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-html-fail-"));
	const store = new ResourceStore(root, limits);
	try {
		const malformed = htmlBytes("<html><body><p>broken\0markup");
		const bad = store.create(scope, {
			operationId: "nul",
			kind: "document",
			title: "깨진 HTML",
			visibility: "private",
			mediaType: "text/html",
			bytes: malformed,
		});
		expect(
			await extractResource(
				store,
				() => scope,
				bad.id,
				new AbortController().signal,
			),
		).toMatchObject({ status: "unavailable", reason: "invalid_document" });
		expect(store.read(scope, bad.id).bytes).toEqual(malformed);
		const encoded = new Uint8Array([0xff, 0xfe, 0xfd]);
		const undecodable = store.create(scope, {
			operationId: "bad-html",
			kind: "document",
			title: "인코딩 HTML",
			visibility: "private",
			mediaType: "text/html",
			bytes: encoded,
		});
		expect(
			await extractResource(
				store,
				() => scope,
				undecodable.id,
				new AbortController().signal,
			),
		).toMatchObject({ status: "unavailable", reason: "undecodable_text" });
		expect(store.read(scope, undecodable.id).bytes).toEqual(encoded);
		await expect(
			extractResource(
				store,
				() => scope,
				undecodable.id,
				AbortSignal.abort(new Error("cancelled")),
			),
		).rejects.toThrow(/cancelled/);
		const helper = fileURLToPath(
			new URL("../src/resources/scripts/html_text.py", import.meta.url),
		);
		expect(existsSync(helper)).toBe(true);
		expect(helper.replaceAll("\\", "/")).toContain(
			"/packages/lina-memory/src/resources/scripts/html_text.py",
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("self-closing skip tags and hidden divs keep following markup out of extract", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-html-selfclose-"));
	const store = new ResourceStore(root, limits);
	const original = htmlBytes(`<p>Visible</p>
<script/>secret("B")</script>
<style/>.x{color:red}</style>
<template/>template secret</template>
<SCRIPT/>UPPER</SCRIPT>
<div hidden/>hidden leak</div>
<script></div>nested-close</script>
<p>After</p>`);
	try {
		const doc = store.create(scope, {
			operationId: "html-selfclose",
			kind: "document",
			title: "셀프클로징 HTML",
			visibility: "private",
			mediaType: "text/html",
			bytes: original,
		});
		const result = await extractResource(
			store,
			() => scope,
			doc.id,
			new AbortController().signal,
		);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw Error("html extract unavailable");
		expect(result.text).toContain("Visible");
		expect(result.text).toContain("After");
		expect(result.text).not.toContain('secret("B")');
		expect(result.text).not.toContain("color: red");
		expect(result.text).not.toContain("template secret");
		expect(result.text).not.toContain("UPPER");
		expect(result.text).not.toContain("hidden leak");
		expect(result.text).not.toContain("nested-close");
		expect(store.read(scope, doc.id).bytes).toEqual(original);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("nested templates keep outer template text out of extract", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-html-template-"));
	const store = new ResourceStore(root, limits);
	const original = htmlBytes(
		"<p>before</p><template><template>inner</template>SECRET_OUTER</template><p>after</p>",
	);
	try {
		const doc = store.create(scope, {
			operationId: "html-template",
			kind: "document",
			title: "중첩 템플릿",
			visibility: "private",
			mediaType: "text/html",
			bytes: original,
		});
		const result = await extractResource(
			store,
			() => scope,
			doc.id,
			new AbortController().signal,
		);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw Error("html extract unavailable");
		expect(result.text).toContain("before");
		expect(result.text).toContain("after");
		expect(result.text).not.toContain("inner");
		expect(result.text).not.toContain("SECRET_OUTER");
		expect(store.read(scope, doc.id).bytes).toEqual(original);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("end tags inside a template cannot close ancestors before that template", async () => {
	const root = mkdtempSync(
		join(tmpdir(), "lina-resource-html-template-scope-"),
	);
	const store = new ResourceStore(root, limits);
	const original = htmlBytes(
		"<div><template></div>SECRET_TEMPLATE</template><p>after</p>",
	);
	try {
		const doc = store.create(scope, {
			operationId: "html-template-scope",
			kind: "document",
			title: "템플릿 스코프",
			visibility: "private",
			mediaType: "text/html",
			bytes: original,
		});
		const result = await extractResource(
			store,
			() => scope,
			doc.id,
			new AbortController().signal,
		);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw Error("html extract unavailable");
		expect(result.text).toContain("after");
		expect(result.text).not.toContain("SECRET_TEMPLATE");
		expect(store.read(scope, doc.id).bytes).toEqual(original);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("template scope, hidden, and rawtext keep skip and visible text distinct", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-html-scope-matrix-"));
	const store = new ResourceStore(root, limits);
	const cases = [
		[
			"nested-template-ancestor",
			"<div><template><template></div>S2</template>S3</template><p>after</p>",
			["after"],
			["S2", "S3"],
		],
		[
			"inner-div-close-in-template",
			"<template><div>inner</div>SECRET_INNER</template><p>after</p>",
			["after"],
			["inner", "SECRET_INNER"],
		],
		[
			"template-close-pops-children",
			"<div><template><span>inner</span></template>VISIBLE</div>",
			["VISIBLE"],
			["inner"],
		],
		[
			"hidden-is-not-barrier",
			"<div><span hidden>x</div>VISIBLE_OK<p>after</p>",
			["VISIBLE_OK", "after"],
			[],
		],
		[
			"hidden-own-close",
			"<div hidden>secret</div><p>after</p>",
			["after"],
			["secret"],
		],
		[
			"raw-script-fake-ancestor",
			'<div><script></div>secret("B")</script><p>after</p>',
			["after"],
			['secret("B")'],
		],
	] as const;
	try {
		for (const [operationId, markup, visible, hiddenText] of cases) {
			const original = htmlBytes(markup);
			const doc = store.create(scope, {
				operationId,
				kind: "document",
				title: operationId,
				visibility: "private",
				mediaType: "text/html",
				bytes: original,
			});
			const result = await extractResource(
				store,
				() => scope,
				doc.id,
				new AbortController().signal,
			);
			expect(result.status).toBe("ready");
			if (result.status !== "ready")
				throw Error(`html extract unavailable: ${operationId}`);
			for (const piece of visible) expect(result.text).toContain(piece);
			for (const piece of hiddenText) expect(result.text).not.toContain(piece);
			expect(store.read(scope, doc.id).bytes).toEqual(original);
		}
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("public HTML extraction yields readable text without raw markup evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-html-"));
	const store = new ResourceStore(root, limits);
	const original = htmlBytes(`<!doctype html>
<html>
<head>
<title>Visible title</title>
<style>.secret { color: red }</style>
<script>window.secret = "from-script"</script>
</head>
<body>
<p>Hello &amp; welcome</p>
<!-- comment secret -->
<template>template secret</template>
<div hidden>hidden secret</div>
<p hidden="hidden">also hidden</p>
<div style="display:none">inline hidden</div>
<div>Second block</div>
</body>
</html>`);
	try {
		expect(isResourceText("text/html")).toBe(false);
		const doc = store.create(scope, {
			operationId: "html",
			kind: "document",
			title: "HTML 자료",
			visibility: "private",
			mediaType: "text/html",
			bytes: original,
		});
		const result = await extractResource(
			store,
			() => scope,
			doc.id,
			new AbortController().signal,
		);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw Error("html extract unavailable");
		expect(result.text).toContain("Hello & welcome");
		expect(result.text).toContain("Visible title");
		expect(result.text).toContain("Second block");
		expect(result.text).toMatch(
			/Hello & welcome\s+Second block|Hello & welcome[\n\r]+Second block/,
		);
		expect(result.text).not.toContain("from-script");
		expect(result.text).not.toContain("window.secret");
		expect(result.text).not.toContain("color: red");
		expect(result.text).not.toContain("comment secret");
		expect(result.text).not.toContain("template secret");
		expect(result.text).not.toContain("hidden secret");
		expect(result.text).not.toContain("also hidden");
		expect(result.text).not.toContain("inline hidden");
		expect(result.text).not.toContain("<script");
		expect(store.read(scope, doc.id).bytes).toEqual(original);
		expect(result.refs).toEqual([
			{
				resourceId: doc.id,
				resourceRevision: 1,
				versionId: doc.currentVersion,
			},
		]);
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
