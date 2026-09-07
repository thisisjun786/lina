import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DOCUMENT_MAX_CHARS,
	extractDocument,
	pageDocumentText,
} from "../src/attachments/document.ts";
import { AttachmentError, AttachmentStore } from "../src/attachments/store.ts";
import { inspectContent } from "../src/attachments/validation.ts";
import type { BotBinding } from "../src/protocol.ts";
import {
	docxBytes,
	docxDocumentXml,
	makeZip,
	pdfBytes,
	scannedPdfBytes,
	xlsxBytes,
} from "./attachment-document-fixtures.ts";

const DOCX =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const fixtures: string[] = [];
afterEach(() => {
	for (const root of fixtures.splice(0))
		rmSync(root, { force: true, recursive: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "lina-attachment-docs-"));
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

test("accepts PDF, DOCX, and XLSX containers by extension and sniffed structure", () => {
	const { dir, binding } = fixture();
	const store = new AttachmentStore(dir, binding);
	const pdf = store.put("report.pdf", pdfBytes(["Page one"]));
	const docx = store.put("memo.docx", docxBytes(["hello"]));
	const xlsx = store.put(
		"sheet.xlsx",
		xlsxBytes([{ name: "S", rows: [["a"]] }]),
	);
	expect(pdf.mime).toBe("application/pdf");
	expect(docx.mime).toBe(DOCX);
	expect(xlsx.mime).toBe(XLSX);
	expect(store.get(pdf.id)).toEqual(pdf);
	expect(() => store.read(docx.id)).toThrow(/UTF-8 text/);
	store.close();
	const reopened = new AttachmentStore(dir, binding);
	expect(reopened.get(docx.id)).toEqual(docx);
	expect(reopened.get(xlsx.id)).toEqual(xlsx);
	reopened.close();
});

test("rejects mismatched, encrypted, traversing, macro, external-link, and oversized document containers", () => {
	const plainZip = makeZip([{ name: "a.txt", data: "x" }]);
	const cases: [string, Uint8Array, RegExp][] = [
		["memo.docx", pdfBytes(["x"]), /does not match/],
		["report.pdf", docxBytes(["x"]), /does not match/],
		["memo.docx", plainZip, /document part/],
		["sheet.xlsx", plainZip, /workbook part/],
		["sheet.xlsx", docxBytes(["x"]), /does not match/],
		[
			"memo.docx",
			docxBytes(["x"], [{ name: "word/vbaProject.bin", data: "vba" }]),
			/macro/i,
		],
		[
			"memo.docx",
			docxBytes(["x"], [{ name: "word/media/run.exe", data: "MZ" }]),
			/executable/i,
		],
		[
			"memo.docx",
			docxBytes(["x"], [{ name: "../escape.xml", data: "<x/>" }]),
			/entry name/i,
		],
		[
			"memo.docx",
			docxBytes(["x"], [{ name: "word/x.xml", data: "<x/>", flags: 1 }]),
			/encrypted/i,
		],
		[
			"sheet.xlsx",
			xlsxBytes(
				[{ name: "S", rows: [["a"]] }],
				[{ name: "xl/externalLinks/externalLink1.xml", data: "<x/>" }],
			),
			/external/i,
		],
		[
			"memo.docx",
			docxBytes(
				["x"],
				[{ name: "word/big.xml", data: "<x/>", uncompressedSize: 1 << 30 }],
			),
			/uncompressed/i,
		],
		[
			"report.pdf",
			pdfBytes(["x"]).slice(0, 100),
			/PDF container is incomplete/,
		],
		["report.pdf", pdfBytes(["x"], { encrypted: true }), /PDF is encrypted/],
		["macro.docm", docxBytes(["x"]), /Unsupported attachment type/],
	];
	for (const [name, bytes, message] of cases)
		expect(() => inspectContent(name, bytes), name).toThrow(message);
});

test("extracts bounded text from PDF pages with stable page markers", async () => {
	const signal = new AbortController().signal;
	const result = await extractDocument(
		pdfBytes(["Page one", "Page two"]),
		"application/pdf",
		signal,
	);
	expect(result.text).toBe("Page one\n\n[page 2]\nPage two\n");
	expect(result).toMatchObject({ truncated: false, pages: 2, note: null });
	const scanned = await extractDocument(
		scannedPdfBytes(),
		"application/pdf",
		signal,
	);
	expect(scanned.text).toBe("");
	expect(scanned.pages).toBe(1);
	expect(scanned.note).toMatch(/no extractable text/i);
	expect(scanned.note).not.toMatch(/OCR performed/i);
	await expect(
		extractDocument(
			pdfBytes(["x"], { encrypted: true }),
			"application/pdf",
			signal,
		),
	).rejects.toThrow(
		new AttachmentError("unsupported-type", "PDF is encrypted"),
	);
});

test("extracts DOCX paragraphs and XLSX sheets through the stdlib child process", async () => {
	const signal = new AbortController().signal;
	const docx = await extractDocument(
		docxBytes(["hello\tworld", "second & <third>"]),
		DOCX,
		signal,
	);
	expect(docx.text).toBe("hello\tworld\nsecond & <third>\n");
	expect(docx).toMatchObject({ truncated: false, pages: 2, note: null });
	const xlsx = await extractDocument(
		xlsxBytes([
			{
				name: "Sales",
				rows: [
					["item", "qty"],
					["inline:pen", 3],
				],
			},
			{ name: "Empty", rows: [] },
		]),
		XLSX,
		signal,
	);
	expect(xlsx.text).toBe(
		"[sheet 1: Sales]\nitem\tqty\npen\t3\n\n[sheet 2: Empty]\n",
	);
	expect(xlsx.pages).toBe(2);
});

test("rejects DTDs and entities inside Office XML, and unsupported MIME types", async () => {
	const signal = new AbortController().signal;
	const hostile = docxBytes(
		[],
		[],
		'<?xml version="1.0"?><!DOCTYPE w [<!ENTITY x "y">]>' +
			docxDocumentXml(["&x;"]).replace(/^<\?xml[^>]*>/u, ""),
	);
	await expect(extractDocument(hostile, DOCX, signal)).rejects.toThrow(
		/DTD|entity/i,
	);
	await expect(
		extractDocument(new TextEncoder().encode("x"), "text/plain", signal),
	).rejects.toThrow(/not a document/i);
});

test("caps extraction at the character bound with an explicit truncation flag", async () => {
	const signal = new AbortController().signal;
	const long = "가".repeat(DOCUMENT_MAX_CHARS + 5000);
	const result = await extractDocument(docxBytes([long, "tail"]), DOCX, signal);
	expect(result.truncated).toBe(true);
	expect(result.text.length).toBeLessThanOrEqual(DOCUMENT_MAX_CHARS);
	expect(result.text.endsWith("tail\n")).toBe(false);
});

test("aborting the signal kills the extraction child and rejects", async () => {
	const controller = new AbortController();
	const pending = extractDocument(docxBytes(["x"]), DOCX, controller.signal);
	controller.abort(new Error("turn ended"));
	await expect(pending).rejects.toThrow("turn ended");
	await expect(
		extractDocument(docxBytes(["x"]), DOCX, AbortSignal.abort()),
	).rejects.toThrow();
});

test("pages extracted text deterministically without splitting surrogate pairs", () => {
	const text = `${"a".repeat(8191)}😀tail`;
	expect(pageDocumentText(text, 0)).toEqual({
		offset: 0,
		text: "a".repeat(8191),
		nextOffset: 8191,
	});
	expect(pageDocumentText(text, 8192)).toEqual({
		offset: 8191,
		text: "😀tail",
		nextOffset: null,
	});
	expect(() => pageDocumentText(text, text.length + 1)).toThrow(/offset/);
});
