import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson } from "../src/attachments/filesystem.ts";
import {
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_MAX_FILES,
	ATTACHMENT_MAX_TOTAL_BYTES,
	AttachmentStore,
} from "../src/attachments/store.ts";
import type { AttachmentManifest } from "../src/attachments/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test.each(["files", "bytes"] as const)(
	"stable orphan adoption and replay do not double-charge the full %s quota",
	(quota) => {
		const root = mkdtempSync(join(tmpdir(), "lina-image-attachment-quota-"));
		roots.push(root);
		const binding = {
			version: 1 as const,
			botId: "lina",
			sessionId: "image-quota",
			sessionFile: join(root, "session.jsonl"),
			workspace: join(root, "workspace"),
		};
		writeFileSync(binding.sessionFile, "");
		mkdirSync(binding.workspace);
		const bytes = new Uint8Array(
			quota === "bytes" ? ATTACHMENT_MAX_BYTES : 1,
		).fill(97);
		const limit =
			quota === "bytes"
				? ATTACHMENT_MAX_TOTAL_BYTES / bytes.length
				: ATTACHMENT_MAX_FILES;
		const store = new AttachmentStore(root, binding);
		const seed = store.put("saved-0.txt", bytes);
		store.close();
		// Persist the inert population once, using a real upload's metadata.
		// Reopen still validates every file; adoption and replay use the real store.
		const files = [seed];
		for (let index = 1; index < limit - 1; index++) {
			const saved = {
				...seed,
				id: randomUUID(),
				name: `saved-${index}.txt`,
			};
			writeFileSync(join(root, "attachments/files", saved.id), bytes);
			files.push(saved);
		}
		atomicJson(join(root, "attachments/manifest.json"), {
			version: 1,
			binding,
			files,
			totalBytes: bytes.length * files.length,
		} satisfies AttachmentManifest);
		const id = "33333333-3333-4333-8333-333333333333";
		writeFileSync(join(root, "attachments/files", id), bytes);
		const recovered = new AttachmentStore(root, binding);
		expect(() => recovered.get(id)).toThrow(/not found/);
		expect(() => recovered.preflight(1)).toThrow(/quota/);
		expect(() =>
			recovered.put("overflow.txt", new TextEncoder().encode("x")),
		).toThrow(/quota/);
		const receipt = recovered.put("result.txt", bytes, id);
		expect(receipt.id).toBe(id);
		expect(recovered.put("result.txt", bytes, id)).toEqual(receipt);
		expect(() =>
			recovered.put("overflow.txt", new TextEncoder().encode("x")),
		).toThrow(/quota/);
		recovered.close();
		const reopened = new AttachmentStore(root, binding);
		expect(() => reopened.preflight(1)).toThrow(/quota/);
		expect(reopened.put("result.txt", bytes, id)).toEqual(receipt);
		expect(reopened.bytes(id)).toEqual(bytes);
		expect(() =>
			reopened.put("overflow.txt", new TextEncoder().encode("x")),
		).toThrow(/quota/);
		const manifest = JSON.parse(
			readFileSync(join(root, "attachments/manifest.json"), "utf8"),
		);
		expect(manifest.files).toHaveLength(limit);
		expect(manifest.files).toEqual([...files, receipt]);
		expect(manifest.totalBytes).toBe(bytes.length * limit);
		reopened.close();
	},
);

test("image admission checks bounded capacity without creating an attachment", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-image-attachment-preflight-"));
	roots.push(root);
	const binding = {
		version: 1 as const,
		botId: "lina",
		sessionId: "image-preflight",
		sessionFile: join(root, "session.jsonl"),
		workspace: join(root, "workspace"),
	};
	writeFileSync(binding.sessionFile, "");
	mkdirSync(binding.workspace);
	const store = new AttachmentStore(root, binding);
	const path = join(root, "attachments/manifest.json");
	const before = readFileSync(path);
	expect(store.preflight(ATTACHMENT_MAX_BYTES)).toBeUndefined();
	for (const size of [
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		ATTACHMENT_MAX_BYTES + 1,
	])
		expect(() => store.preflight(size)).toThrow(/size/);
	expect(readFileSync(path)).toEqual(before);
	store.close();
	expect(() => store.preflight(0)).toThrow(/closed/);
});
