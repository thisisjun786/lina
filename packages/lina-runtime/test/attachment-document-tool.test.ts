import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../lina-core/src/attachments/store.ts";
import type { BotBinding } from "../../lina-core/src/protocol.ts";
import {
	docxBytes,
	pdfBytes,
	scannedPdfBytes,
	xlsxBytes,
} from "../../lina-core/test/attachment-document-fixtures.ts";
import { createAttachmentTool } from "../src/tools/attachments.ts";

const PNG = new Uint8Array(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
		"base64",
	),
);
// Smallest valid baseline JPEG (1x1 gray) accepted by validateJpeg.
const JPEG = new Uint8Array(
	Buffer.from(
		"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
		"base64",
	),
);

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-doc-tool-"));
	const binding: BotBinding = {
		version: 1,
		botId: "lina",
		workspace: join(root, "workspace"),
		sessionFile: join(root, "native.jsonl"),
		sessionId: "12345678-1234-4234-8234-123456789012",
	};
	writeFileSync(binding.sessionFile, "");
	mkdirSync(binding.workspace);
	const store = new AttachmentStore(join(root, "files"), binding);
	return { root, store };
}

type Part =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

test("image read returns the owned bytes as an image part plus untrusted metadata, at most two per request", async () => {
	const { root, store } = fixture();
	try {
		const png = store.put("pixel.png", PNG);
		const jpeg = store.put("photo.jpg", JPEG);
		const third = store.put("again.png", PNG);
		let owner: string | undefined = "request-1";
		const tool = createAttachmentTool(store, () => owner);
		const signal = new AbortController().signal;
		const first = await tool.execute("img", { id: png.id }, signal);
		const parts = first.content as Part[];
		expect(parts).toHaveLength(2);
		expect(parts[0]?.type).toBe("text");
		expect((parts[0] as { text: string }).text).toContain("Untrusted");
		expect((parts[0] as { text: string }).text).toContain(png.sha256);
		expect(parts[1]).toEqual({
			type: "image",
			data: Buffer.from(PNG).toString("base64"),
			mimeType: "image/png",
		});
		expect(first.details).toMatchObject({ id: png.id, image: true });
		const second = await tool.execute("img2", { id: jpeg.id }, signal);
		expect((second.content as Part[])[1]).toMatchObject({
			type: "image",
			mimeType: "image/jpeg",
		});
		// Re-reading an already emitted image does not spend the image budget.
		const repeat = await tool.execute("img-again", { id: png.id }, signal);
		expect((repeat.content as Part[])[1]?.type).toBe("image");
		await expect(
			tool.execute("img3", { id: third.id }, signal),
		).rejects.toThrow(/image budget/i);
		owner = "request-2";
		expect(
			(
				(await tool.execute("img4", { id: third.id }, signal)).content as Part[]
			)[1]?.type,
		).toBe("image");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("text-only image analysis returns bounded untrusted evidence with provenance", async () => {
	const { root, store } = fixture();
	try {
		const png = store.put("pixel.png", PNG);
		let calls = 0;
		const tool = createAttachmentTool(
			store,
			() => "request-vision",
			async ({ bytes, mimeType, question }, signal) => {
				signal.throwIfAborted();
				calls++;
				expect(bytes).toEqual(PNG);
				expect(mimeType).toBe("image/png");
				expect(question).toBe("Read the small label in detail.");
				return {
					provider: "vision-provider",
					model: "vision-model",
					text: "A bounded visual observation.",
				};
			},
		);
		const result = await tool.execute(
			"vision",
			{ id: png.id, question: "Read the small label in detail." },
			new AbortController().signal,
		);
		expect(calls).toBe(1);
		expect(result.content).toHaveLength(1);
		const evidence = result.content[0];
		expect(evidence?.type).toBe("text");
		if (evidence?.type !== "text") throw Error("expected text evidence");
		expect(evidence.text).toContain("vision-provider/vision-model");
		expect(evidence.text).toContain("Untrusted visual evidence");
		expect(result.content[0]).not.toMatchObject({ type: "image" });
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("image-capable conversations preserve the original image result", async () => {
	const { root, store } = fixture();
	try {
		const png = store.put("pixel.png", PNG);
		const tool = createAttachmentTool(
			store,
			() => "request-native-image",
			async () => null,
		);
		const result = await tool.execute(
			"native-image",
			{ id: png.id },
			new AbortController().signal,
		);
		expect(result.content).toHaveLength(2);
		expect(result.content[1]).toMatchObject({ type: "image" });
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("vision evidence keeps the text budget and propagates provider failure or abort", async () => {
	const { root, store } = fixture();
	try {
		const png = store.put("pixel.png", PNG);
		const bounded = createAttachmentTool(
			store,
			() => "request-bounded-vision",
			async () => ({
				provider: "vision-provider",
				model: "vision-model",
				text: "detail ".repeat(4000),
			}),
		);
		const result = await bounded.execute(
			"bounded",
			{ id: png.id },
			new AbortController().signal,
		);
		const evidence = result.content[0];
		if (evidence?.type !== "text") throw Error("expected text evidence");
		expect(evidence.text.length).toBeLessThanOrEqual(16384);
		expect(evidence.text).toContain("[visual evidence clipped]");
		expect(result.details.truncated).toBe(true);

		const failed = createAttachmentTool(
			store,
			() => "request-failed-vision",
			async () => {
				throw new Error("provider failure");
			},
		);
		await expect(
			failed.execute("failed", { id: png.id }, new AbortController().signal),
		).rejects.toThrow("provider failure");

		const aborted = createAttachmentTool(
			store,
			() => "request-aborted-vision",
			async (_input, signal) => {
				signal.throwIfAborted();
				return null;
			},
		);
		await expect(
			aborted.execute("aborted", { id: png.id }, AbortSignal.abort()),
		).rejects.toThrow();
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("failed vision analysis releases only its newly reserved image slot", async () => {
	const { root, store } = fixture();
	try {
		const first = store.put("first.png", PNG);
		const second = store.put("second.png", PNG);
		const third = store.put("third.png", PNG);
		let calls = 0;
		const tool = createAttachmentTool(
			store,
			() => "request-slot-release",
			async () => {
				calls++;
				if (calls === 1) throw new Error("vision provider failed");
				return null;
			},
		);
		await expect(
			tool.execute("first", { id: first.id }, new AbortController().signal),
		).rejects.toThrow("vision provider failed");
		await tool.execute(
			"second",
			{ id: second.id },
			new AbortController().signal,
		);
		await expect(
			tool.execute("third", { id: third.id }, new AbortController().signal),
		).resolves.toBeDefined();
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("visual evidence checks remaining provenance room before calling vision", async () => {
	const { root, store } = fixture();
	try {
		const note = store.put(
			"note.txt",
			new TextEncoder().encode("a".repeat(16000)),
		);
		const png = store.put("pixel.png", PNG);
		let calls = 0;
		const tool = createAttachmentTool(
			store,
			() => "request-prefix-room",
			async () => {
				calls++;
				return null;
			},
		);
		const first = await tool.execute(
			"note-1",
			{ id: note.id },
			new AbortController().signal,
		);
		await tool.execute(
			"note-2",
			{ id: note.id, offset: first.details.nextOffset ?? 0 },
			new AbortController().signal,
		);
		await expect(
			tool.execute("vision", { id: png.id }, new AbortController().signal),
		).rejects.toThrow("visual evidence provenance");
		expect(calls).toBe(0);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("an old awaited image failure cannot release a new owner's reservation", async () => {
	const { root, store } = fixture();
	try {
		const first = store.put("first.png", PNG);
		const second = store.put("second.png", PNG);
		const third = store.put("third.png", PNG);
		let owner: string | undefined = "old-request";
		let calls = 0;
		const started = Promise.withResolvers<void>();
		const oldFailure = Promise.withResolvers<never>();
		const tool = createAttachmentTool(
			store,
			() => owner,
			async () => {
				calls++;
				if (calls === 1) {
					started.resolve();
					return oldFailure.promise;
				}
				return null;
			},
		);
		const oldRead = tool.execute(
			"old",
			{ id: first.id },
			new AbortController().signal,
		);
		await started.promise;
		owner = "new-request";
		await tool.execute(
			"new-same",
			{ id: first.id },
			new AbortController().signal,
		);
		await tool.execute(
			"new-second",
			{ id: second.id },
			new AbortController().signal,
		);
		oldFailure.reject(new Error("old vision failure"));
		await expect(oldRead).rejects.toThrow("old vision failure");
		await expect(
			tool.execute("new-third", { id: third.id }, new AbortController().signal),
		).rejects.toThrow(/image budget/i);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("document read extracts bounded text with continuation offsets and reports scanned PDFs honestly", async () => {
	const { root, store } = fixture();
	try {
		const pdf = store.put("report.pdf", pdfBytes(["Page one", "Page two"]));
		const docx = store.put("memo.docx", docxBytes(["가".repeat(9000)]));
		const xlsx = store.put(
			"sheet.xlsx",
			xlsxBytes([{ name: "S", rows: [["a", 1]] }]),
		);
		const scanned = store.put("scan.pdf", scannedPdfBytes());
		const tool = createAttachmentTool(store, () => "request-1");
		const signal = new AbortController().signal;

		const pdfRead = await tool.execute("pdf", { id: pdf.id }, signal);
		const pdfText = (pdfRead.content[0] as { text: string }).text;
		expect(pdfText).toContain("Untrusted attachment reference data");
		expect(pdfText).toContain("Page one\n\n[page 2]\nPage two");
		expect(pdfRead.details).toMatchObject({
			id: pdf.id,
			nextOffset: null,
			truncated: false,
			pages: 2,
		});

		const docxFirst = await tool.execute("docx", { id: docx.id }, signal);
		const nextOffset = docxFirst.details.nextOffset;
		expect(nextOffset).toBeGreaterThan(0);
		const docxSecond = await tool.execute(
			"docx2",
			{ id: docx.id, offset: nextOffset ?? 0 },
			signal,
		);
		expect(docxSecond.details.nextOffset).toBeNull();
		expect(
			(docxFirst.content[0] as { text: string }).text.split("\n")[1]?.length ??
				0,
		).toBeGreaterThan(7000);

		const xlsxRead = await tool.execute("xlsx", { id: xlsx.id }, signal);
		expect((xlsxRead.content[0] as { text: string }).text).toContain(
			"[sheet 1: S]\na\t1",
		);

		const scannedRead = await tool.execute("scan", { id: scanned.id }, signal);
		const scannedText = (scannedRead.content[0] as { text: string }).text;
		expect(scannedText).toMatch(/no extractable text/i);
		expect(scannedText).not.toMatch(/OCR performed/i);
		expect(scannedRead.content).toHaveLength(1);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("document read shares the per-request text budget and honours abort", async () => {
	const { root, store } = fixture();
	try {
		const docx = store.put("long.docx", docxBytes(["a".repeat(30000)]));
		const tool = createAttachmentTool(store, () => "request-1");
		const signal = new AbortController().signal;
		let total = 0,
			offset = 0;
		for (let i = 0; i < 6; i++) {
			try {
				const response = await tool.execute(
					"d",
					{ id: docx.id, offset },
					signal,
				);
				total += (response.content[0] as { text: string }).text.length;
				const next = response.details.nextOffset;
				if (next === null) break;
				offset = next;
			} catch {
				break;
			}
		}
		expect(total).toBeGreaterThan(10000);
		expect(total).toBeLessThanOrEqual(16384);
		await expect(
			tool.execute("over", { id: docx.id, offset }, signal),
		).rejects.toThrow(/budget/);
		await expect(
			tool.execute("abort", { id: docx.id }, AbortSignal.abort()),
		).rejects.toThrow();
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
