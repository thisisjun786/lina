import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../lina-core/src/attachments/store.ts";
import type { BotBinding } from "../../lina-core/src/protocol.ts";
import {
	docxBytes,
	pdfBytes,
	scannedPdfBytes,
} from "../../lina-core/test/attachment-document-fixtures.ts";
import { handleAttachmentRequest } from "../src/attachment-http.ts";

const fixtures: string[] = [];
afterEach(() => {
	for (const dir of fixtures.splice(0))
		rmSync(dir, { force: true, recursive: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "lina-attachment-http-"));
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
	const store = new AttachmentStore(dir, binding);
	return { binding, store };
}

async function json(
	response: Response,
): Promise<{ id?: string; code?: string; name?: string }> {
	return (await response.json()) as {
		id?: string;
		code?: string;
		name?: string;
	};
}

test("uploads raw bytes and serves download, preview, and metadata with typed headers", async () => {
	const { binding, store } = fixture();
	const uploaded = await handleAttachmentRequest(
		new Request("http://localhost/api/attachments", {
			method: "POST",
			headers: {
				"X-Lina-Session": binding.sessionId,
				"X-Lina-Filename": encodeURIComponent("hello.txt"),
			},
			body: "hello",
		}),
		store,
		binding,
	);
	expect(uploaded?.status).toBe(201);
	expect(uploaded?.headers.get("Cache-Control")).toBe("no-store");
	expect(uploaded?.headers.get("X-Content-Type-Options")).toBe("nosniff");
	const receipt = await json(uploaded as Response);
	const id = String(receipt.id);

	const download = await handleAttachmentRequest(
		new Request(
			`http://localhost/api/attachments/${id}?sessionId=${binding.sessionId}`,
		),
		store,
		binding,
	);
	expect(download?.status).toBe(200);
	expect(download?.headers.get("Content-Disposition")).toContain("attachment");
	expect(await download?.text()).toBe("hello");

	const preview = await handleAttachmentRequest(
		new Request(
			`http://localhost/api/attachments/${id}/preview?sessionId=${binding.sessionId}`,
		),
		store,
		binding,
	);
	expect(preview?.headers.get("Content-Type")).toContain("text/plain");
	expect(await preview?.text()).toBe("hello");

	const meta = await handleAttachmentRequest(
		new Request(
			`http://localhost/api/attachments/${id}/meta?sessionId=${binding.sessionId}`,
		),
		store,
		binding,
	);
	expect(meta?.status).toBe(200);
	expect(await json(meta as Response)).toMatchObject({ id, name: "hello.txt" });
	store.close();
});

test("enforces session ownership, route shape, type, and streamed size limits", async () => {
	const { binding, store } = fixture();
	const foreign = await handleAttachmentRequest(
		new Request("http://localhost/api/attachments", {
			method: "POST",
			headers: { "X-Lina-Session": "other", "X-Lina-Filename": "x.txt" },
			body: "x",
		}),
		store,
		binding,
	);
	expect(foreign?.status).toBe(403);
	expect((await json(foreign as Response)).code).toBe("foreign-session");

	expect(
		await handleAttachmentRequest(
			new Request("http://localhost/other"),
			store,
			binding,
		),
	).toBeUndefined();
	const bad = await handleAttachmentRequest(
		new Request("http://localhost/api/attachments", {
			method: "POST",
			headers: {
				"X-Lina-Session": binding.sessionId,
				"X-Lina-Filename": "bad.svg",
			},
			body: "<svg>",
		}),
		store,
		binding,
	);
	expect(bad?.status).toBe(415);
	expect((await json(bad as Response)).code).toBe("unsupported-type");
	for (const filename of ["a%2Fb.txt", "a%00b.txt"]) {
		const unsafeName = await handleAttachmentRequest(
			new Request("http://localhost/api/attachments", {
				method: "POST",
				headers: {
					"X-Lina-Session": binding.sessionId,
					"X-Lina-Filename": filename,
				},
				body: "x",
			}),
			store,
			binding,
		);
		expect(unsafeName?.status).toBe(400);
		expect((await json(unsafeName as Response)).code).toBe("invalid-name");
	}

	const oversized = await handleAttachmentRequest(
		new Request("http://localhost/api/attachments", {
			method: "POST",
			headers: {
				"X-Lina-Session": binding.sessionId,
				"X-Lina-Filename": "big.txt",
			},
			body: new Uint8Array(2 * 1024 * 1024 + 1),
		}),
		store,
		binding,
	);
	expect(oversized?.status).toBe(413);
	expect((await json(oversized as Response)).code).toBe("size-limit");
	store.close();
});

test("serves document preview as inert text and downloads the original bytes", async () => {
	const { binding, store } = fixture();
	const pdf = store.put("report.pdf", pdfBytes(["Page one"]));
	const docx = store.put("memo.docx", docxBytes(["hello docx"]));
	const scanned = store.put("scan.pdf", scannedPdfBytes());
	for (const [item, expected] of [
		[pdf, "Page one"],
		[docx, "hello docx"],
	] as const) {
		const preview = await handleAttachmentRequest(
			new Request(
				"http://localhost/api/attachments/" +
					item.id +
					"/preview?sessionId=" +
					binding.sessionId,
			),
			store,
			binding,
		);
		expect(preview?.status).toBe(200);
		expect(preview?.headers.get("Content-Type")).toBe(
			"text/plain; charset=utf-8",
		);
		expect(preview?.headers.get("Content-Disposition")).toBe("inline");
		expect(preview?.headers.get("X-Content-Type-Options")).toBe("nosniff");
		const body = await preview?.text();
		expect(body).toContain(expected);
		expect(body?.length ?? 0).toBeLessThanOrEqual(16384);
	}
	const scannedPreview = await handleAttachmentRequest(
		new Request(
			"http://localhost/api/attachments/" +
				scanned.id +
				"/preview?sessionId=" +
				binding.sessionId,
		),
		store,
		binding,
	);
	expect(await scannedPreview?.text()).toMatch(/no extractable text/i);
	const download = await handleAttachmentRequest(
		new Request(
			"http://localhost/api/attachments/" +
				docx.id +
				"?sessionId=" +
				binding.sessionId,
		),
		store,
		binding,
	);
	expect(download?.headers.get("Content-Type")).toBe(docx.mime);
	expect(download?.headers.get("Content-Disposition")).toContain("attachment");
	expect(
		Buffer.from(await (download as Response).arrayBuffer()).equals(
			store.bytes(docx.id),
		),
	).toBe(true);
	store.close();
});

test("document preview is capped at 16384 characters and marks truncation", async () => {
	const { binding, store } = fixture();
	const docx = store.put("long.docx", docxBytes(["b".repeat(40000)]));
	const preview = await handleAttachmentRequest(
		new Request(
			"http://localhost/api/attachments/" +
				docx.id +
				"/preview?sessionId=" +
				binding.sessionId,
		),
		store,
		binding,
	);
	const body = (await preview?.text()) ?? "";
	expect(body.length).toBeLessThanOrEqual(16384);
	expect(body).toMatch(/truncated/i);
	store.close();
});
