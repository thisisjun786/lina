import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceContent } from "../src/resources/content.ts";

test("resource bytes reuse immutable hashes across reopen and reject tampering", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-bytes-"));
	const limits = {
		maxFileBytes: 32,
		maxCatalogBytes: 64,
		maxExtractionBytes: 16,
	};
	try {
		const content = new ResourceContent(root, limits);
		const bytes = new TextEncoder().encode("자료 원문😀");
		const saved = content.put(bytes);
		expect(content.put(bytes)).toEqual(saved);
		expect(content.usage().bytes).toBe(bytes.length);
		expect(new ResourceContent(root, limits).read(saved)).toEqual(bytes);
		writeFileSync(join(root, saved.hash), new Uint8Array(bytes.length));
		expect(() => content.read(saved)).toThrow(/corrupt/);
		expect(() => new ResourceContent(root, limits)).toThrow(/corrupt/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("per-file and aggregate limits include retained unreferenced complete blobs", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-limits-"));
	try {
		const limits = {
			maxFileBytes: 8,
			maxCatalogBytes: 12,
			maxExtractionBytes: 8,
		};
		const content = new ResourceContent(root, limits);
		expect(() => content.put(new Uint8Array(9))).toThrow(/limit/);
		const first = content.put(new Uint8Array(8).fill(1));
		expect(content.put(new Uint8Array(8).fill(1))).toEqual(first);
		expect(() => content.put(new Uint8Array(5).fill(2))).toThrow(/limit/);
		expect(new ResourceContent(root, limits).usage()).toEqual({
			bytes: 8,
			blobs: 1,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing owner limits are rejected before creating content storage", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-owner-"));
	try {
		// Exercise the JS boundary where TypeScript cannot enforce supplied settings.
		expect(
			() => new ResourceContent(join(root, "invalid"), {} as never),
		).toThrow(/limit/);
		expect(existsSync(join(root, "invalid"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a symlink at a hash path is rejected without reading another file", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-link-"));
	try {
		const folder = join(root, "blobs");
		const content = new ResourceContent(folder, {
			maxFileBytes: 16,
			maxCatalogBytes: 32,
			maxExtractionBytes: 16,
		});
		const saved = content.put(new Uint8Array([1, 2, 3]));
		rmSync(join(folder, saved.hash));
		writeFileSync(join(root, "outside"), new Uint8Array([1, 2, 3]));
		symlinkSync(join(root, "outside"), join(folder, saved.hash));
		expect(() => content.put(new Uint8Array([1, 2, 3]))).toThrow();
		expect(() => content.read(saved)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lower write limits preserve existing content reads and reject new growth", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-shrink-"));
	try {
		const blob = new ResourceContent(root, {
			maxFileBytes: 16,
			maxCatalogBytes: 32,
			maxExtractionBytes: 16,
		}).put(new Uint8Array(12));
		const shrunk = new ResourceContent(root, {
			maxFileBytes: 4,
			maxCatalogBytes: 8,
			maxExtractionBytes: 4,
		});
		expect(shrunk.read(blob)).toHaveLength(12);
		expect(() => shrunk.put(new Uint8Array([1]))).toThrow(/limit/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("exclusive owner recovery reclaims interrupted stages but preserves complete blobs", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-stage-"));
	try {
		const content = new ResourceContent(root, {
			maxFileBytes: 16,
			maxCatalogBytes: 32,
			maxExtractionBytes: 16,
		});
		const blob = content.put(new Uint8Array([1]));
		writeFileSync(
			join(root, ".stage-00000000-0000-4000-8000-000000000001"),
			new Uint8Array(12),
		);
		expect(content.usage().bytes).toBe(13);
		expect(content.recoverStaging()).toBe(1);
		expect(content.read(blob)).toEqual(new Uint8Array([1]));
		expect(content.usage()).toEqual({ bytes: 1, blobs: 1 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
