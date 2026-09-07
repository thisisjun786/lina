import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ATTACHMENT_MAX_BYTES,
	AttachmentError,
	AttachmentStore,
} from "../src/attachments/store.ts";
import type { BotBinding } from "../src/protocol.ts";

const fixtures: string[] = [];
afterEach(() => {
	for (const root of fixtures.splice(0))
		rmSync(root, { force: true, recursive: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "lina-attachments-"));
	fixtures.push(dir);
	const binding: BotBinding = {
		version: 1,
		botId: "lina",
		sessionId: "session-1",
		sessionFile: join(dir, "session.jsonl"),
		workspace: join(dir, "workspace"),
	};
	writeFileSync(binding.sessionFile, "");
	mkdirSync(binding.workspace);
	return { dir, binding };
}

test("a stable artifact ID imports once across restart and rejects conflicting bytes", () => {
	const { dir, binding } = fixture();
	const id = "11111111-1111-4111-8111-111111111111";
	const bytes = new TextEncoder().encode("immutable result");
	const first = new AttachmentStore(dir, binding);
	const receipt = first.put("result.txt", bytes, id);
	expect(receipt.id).toBe(id);
	first.close();
	const second = new AttachmentStore(dir, binding);
	expect(second.put("result.txt", bytes, id)).toEqual(receipt);
	expect(readdirSync(join(dir, "attachments/files"))).toEqual([id]);
	expect(() =>
		second.put("result.txt", new TextEncoder().encode("changed"), id),
	).toThrow("conflict");
	expect(() => second.put("different.txt", bytes, id)).toThrow("conflict");
	expect(second.bytes(id)).toEqual(bytes);
	second.close();
});

test("stores immutable typed bytes and reads UTF-8 in surrogate-safe pages", () => {
	const { dir, binding } = fixture();
	const store = new AttachmentStore(dir, binding);
	const text = `${"a".repeat(8191)}😀tail`;
	const bytes = new TextEncoder().encode(text);
	const receipt = store.put("notes.md", bytes);

	expect(receipt).toMatchObject({
		name: "notes.md",
		mime: "text/plain",
		size: bytes.length,
	});
	expect(store.get(receipt.id)).toEqual(receipt);
	expect(new TextDecoder().decode(store.bytes(receipt.id))).toBe(text);
	expect(store.read(receipt.id)).toMatchObject({
		text: "a".repeat(8191),
		nextOffset: 8191,
	});
	expect(store.read(receipt.id, 8191)).toMatchObject({
		text: "😀tail",
		nextOffset: null,
	});
	store.close();
	const reopened = new AttachmentStore(dir, binding);
	expect(reopened.get(receipt.id)).toEqual(receipt);
	reopened.close();
});

test("accepts PNG/JPEG signatures and rejects unsafe names and mismatched content", () => {
	const { dir, binding } = fixture();
	const store = new AttachmentStore(dir, binding);
	const png = new Uint8Array(
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
			"base64",
		),
	);
	expect(store.put("pixel.png", png)).toMatchObject({
		mime: "image/png",
		size: png.length,
	});
	expect(() =>
		store.put("evil.svg", new TextEncoder().encode("<svg/>")),
	).toThrow(
		new AttachmentError("unsupported-type", "Unsupported attachment type"),
	);
	expect(() =>
		store.put("pixel.png", new TextEncoder().encode("not png")),
	).toThrow(/does not match its extension/);
	expect(() =>
		store.put("../escape.txt", new TextEncoder().encode("x")),
	).toThrow(/name/);
	store.close();
});

test("enforces per-file and count quotas", () => {
	const { dir, binding } = fixture();
	const store = new AttachmentStore(dir, binding);
	expect(() =>
		store.put("large.txt", new Uint8Array(ATTACHMENT_MAX_BYTES + 1)),
	).toThrow(/size/);
	for (let index = 0; index < 256; index++)
		store.put(`f-${index}.txt`, new Uint8Array());
	expect(() => store.put("too-many.txt", new Uint8Array())).toThrow(
		/file quota/,
	);
	store.close();
	const totalFixture = fixture();
	const totalStore = new AttachmentStore(
		totalFixture.dir,
		totalFixture.binding,
	);
	const fullFile = new Uint8Array(ATTACHMENT_MAX_BYTES).fill(97);
	for (let index = 0; index < 32; index++)
		totalStore.put(`q-${index}.txt`, fullFile);
	expect(() =>
		totalStore.put("quota.txt", new TextEncoder().encode("x")),
	).toThrow(/storage quota/);
	totalStore.close();
});

test("refuses foreign binding, orphaned files, symlinks, and altered bytes without adoption", () => {
	const { dir, binding } = fixture();
	const store = new AttachmentStore(dir, binding);
	const receipt = store.put("safe.txt", new TextEncoder().encode("safe"));
	store.close();
	expect(
		() => new AttachmentStore(dir, { ...binding, botId: "other" }),
	).toThrow(/foreign|binding/);
	const filesDir = join(dir, "attachments", "files");
	const path = join(filesDir, receipt.id);
	const sentinel = join(dir, "sentinel");
	writeFileSync(sentinel, "preserve");
	rmSync(path);
	symlinkSync(sentinel, path);
	expect(() => new AttachmentStore(dir, binding)).toThrow(
		/regular file|symlink|Unsafe/,
	);
	expect(readFileSync(sentinel, "utf8")).toBe("preserve");
	rmSync(path);
	writeFileSync(path, "changed");
	expect(() => new AttachmentStore(dir, binding)).toThrow(
		/integrity|sha|corrupt/,
	);
	rmSync(join(dir, "attachments", "manifest.json"));
	expect(() => new AttachmentStore(dir, binding)).toThrow(/orphan|manifest/);
});

test("rejects incomplete image containers and names that cannot round-trip in reference links", () => {
	const { dir, binding } = fixture();
	const store = new AttachmentStore(dir, binding);
	const truncated = new Uint8Array([
		137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0,
		0, 0, 2, 8, 6, 0, 0, 0,
	]);
	expect(() => store.put("broken.png", truncated)).toThrow();
	expect(() =>
		store.put("a[b].txt", new TextEncoder().encode("valid")),
	).toThrow();
	store.close();
});

test("detects attachment directory substitution after the store was opened", () => {
	const { dir, binding } = fixture();
	const store = new AttachmentStore(dir, binding);
	const files = join(dir, "attachments", "files");
	rmSync(files, { recursive: true });
	const outside = join(dir, "outside");
	mkdirSync(outside);
	symlinkSync(outside, files);
	expect(() =>
		store.put("escape.txt", new TextEncoder().encode("not written")),
	).toThrow();
	expect(readdirSync(outside)).toEqual([]);
	store.close();
});

test("retains unreferenced crash files without adopting them or blocking committed attachments", () => {
	const { dir, binding } = fixture();
	const store = new AttachmentStore(dir, binding);
	const saved = store.put("saved.txt", new TextEncoder().encode("committed"));
	store.close();
	const orphan = "11111111-1111-4111-8111-111111111111";
	writeFileSync(join(dir, "attachments", "files", orphan), "uncommitted");
	const reopened = new AttachmentStore(dir, binding);
	expect(reopened.read(saved.id).text).toBe("committed");
	expect(() => reopened.get(orphan)).toThrow(/not found/);
	expect(reopened.put("next.txt", new TextEncoder().encode("next")).name).toBe(
		"next.txt",
	);
	expect(readFileSync(join(dir, "attachments", "files", orphan), "utf8")).toBe(
		"uncommitted",
	);
	reopened.close();
});

test("stable import recovers its own pre-manifest crash file without overwriting a conflict", () => {
	const { dir, binding } = fixture();
	const store = new AttachmentStore(dir, binding);
	const id = "22222222-2222-4222-8222-222222222222";
	const bytes = new TextEncoder().encode("retained result");
	writeFileSync(join(dir, "attachments/files", id), bytes);
	store.close();
	const recovered = new AttachmentStore(dir, binding);
	expect(() =>
		recovered.put("result.txt", new TextEncoder().encode("different"), id),
	).toThrow("conflict");
	expect(readFileSync(join(dir, "attachments/files", id))).toEqual(
		Buffer.from(bytes),
	);
	expect(recovered.put("result.txt", bytes, id).id).toBe(id);
	recovered.close();
	const reopened = new AttachmentStore(dir, binding);
	expect(reopened.bytes(id)).toEqual(bytes);
	reopened.close();
});
