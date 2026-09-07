/**
 * Deterministic document fixtures for attachment tests. The zip writer emits
 * stored (uncompressed) entries so tests never depend on a compression library.
 */

export interface ZipEntry {
	name: string;
	data: Uint8Array | string;
	/** General purpose flag bits; bit 0 marks a traditionally encrypted entry. */
	flags?: number;
	/** Override the recorded uncompressed size (central directory only). */
	uncompressedSize?: number;
}

const encoder = new TextEncoder();

function bytesOf(value: Uint8Array | string): Uint8Array {
	return typeof value === "string" ? encoder.encode(value) : value;
}

export function makeZip(entries: ZipEntry[]): Uint8Array {
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		const data = bytesOf(entry.data);
		const crc = Bun.hash.crc32(data);
		const local = new Uint8Array(30 + name.length + data.length);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(4, 20, true);
		localView.setUint16(6, entry.flags ?? 0, true);
		localView.setUint16(8, 0, true);
		localView.setUint32(14, crc, true);
		localView.setUint32(18, data.length, true);
		localView.setUint32(22, data.length, true);
		localView.setUint16(26, name.length, true);
		local.set(name, 30);
		local.set(data, 30 + name.length);
		locals.push(local);
		const central = new Uint8Array(46 + name.length);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(4, 20, true);
		centralView.setUint16(6, 20, true);
		centralView.setUint16(8, entry.flags ?? 0, true);
		centralView.setUint16(10, 0, true);
		centralView.setUint32(16, crc, true);
		centralView.setUint32(20, data.length, true);
		centralView.setUint32(24, entry.uncompressedSize ?? data.length, true);
		centralView.setUint16(28, name.length, true);
		centralView.setUint32(42, offset, true);
		central.set(name, 46);
		centrals.push(central);
		offset += local.length;
	}
	const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
	const eocd = new Uint8Array(22);
	const eocdView = new DataView(eocd.buffer);
	eocdView.setUint32(0, 0x06054b50, true);
	eocdView.setUint16(8, entries.length, true);
	eocdView.setUint16(10, entries.length, true);
	eocdView.setUint32(12, centralSize, true);
	eocdView.setUint32(16, offset, true);
	const result = new Uint8Array(offset + centralSize + eocd.length);
	let cursor = 0;
	for (const part of [...locals, ...centrals, eocd]) {
		result.set(part, cursor);
		cursor += part.length;
	}
	return result;
}

const CONTENT_TYPES =
	'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function docxDocumentXml(paragraphs: string[]): string {
	const body = paragraphs
		.map((paragraph) => {
			const runs = paragraph
				.split("\t")
				.map(
					(part) =>
						'<w:r><w:t xml:space="preserve">' +
						escapeXml(part) +
						"</w:t></w:r>",
				)
				.join("<w:r><w:tab/></w:r>");
			return `<w:p>${runs}</w:p>`;
		})
		.join("");
	return (
		'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="' +
		W +
		'"><w:body>' +
		body +
		"</w:body></w:document>"
	);
}

export function docxBytes(
	paragraphs: string[],
	extra: ZipEntry[] = [],
	documentXml = docxDocumentXml(paragraphs),
): Uint8Array {
	return makeZip([
		{ name: "[Content_Types].xml", data: CONTENT_TYPES },
		{ name: "word/document.xml", data: documentXml },
		...extra,
	]);
}

export interface XlsxSheet {
	name: string;
	rows: (string | number)[][];
}

export function xlsxBytes(
	sheets: XlsxSheet[],
	extra: ZipEntry[] = [],
): Uint8Array {
	const shared: string[] = [];
	const sharedIndex = (value: string): number => {
		const found = shared.indexOf(value);
		if (found >= 0) return found;
		shared.push(value);
		return shared.length - 1;
	};
	const worksheets = sheets.map((sheet, index) => {
		const rows = sheet.rows
			.map((row, rowIndex) => {
				const cells = row
					.map((cell, columnIndex) => {
						const reference =
							String.fromCharCode(65 + columnIndex) + String(rowIndex + 1);
						if (typeof cell === "number")
							return `<c r="${reference}"><v>${cell}</v></c>`;
						if (cell.startsWith("inline:"))
							return (
								'<c r="' +
								reference +
								'" t="inlineStr"><is><t>' +
								escapeXml(cell.slice(7)) +
								"</t></is></c>"
							);
						return (
							'<c r="' +
							reference +
							'" t="s"><v>' +
							sharedIndex(cell) +
							"</v></c>"
						);
					})
					.join("");
				return `<row r="${rowIndex + 1}">${cells}</row>`;
			})
			.join("");
		return {
			name: `xl/worksheets/sheet${index + 1}.xml`,
			data:
				'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="' +
				S +
				'"><sheetData>' +
				rows +
				"</sheetData></worksheet>",
		};
	});
	const workbook =
		'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="' +
		S +
		'" xmlns:r="' +
		R +
		'"><sheets>' +
		sheets
			.map(
				(sheet, index) =>
					'<sheet name="' +
					escapeXml(sheet.name) +
					'" sheetId="' +
					(index + 1) +
					'" r:id="rId' +
					(index + 1) +
					'"/>',
			)
			.join("") +
		"</sheets></workbook>";
	const rels =
		'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
		sheets
			.map(
				(_sheet, index) =>
					'<Relationship Id="rId' +
					(index + 1) +
					'" Type="' +
					R +
					'/worksheet" Target="worksheets/sheet' +
					(index + 1) +
					'.xml"/>',
			)
			.join("") +
		"</Relationships>";
	const sharedStrings =
		'<?xml version="1.0" encoding="UTF-8"?><sst xmlns="' +
		S +
		'">' +
		shared
			.map(
				(value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`,
			)
			.join("") +
		"</sst>";
	return makeZip([
		{ name: "[Content_Types].xml", data: CONTENT_TYPES },
		{ name: "xl/workbook.xml", data: workbook },
		{ name: "xl/_rels/workbook.xml.rels", data: rels },
		{ name: "xl/sharedStrings.xml", data: sharedStrings },
		...worksheets,
		...extra,
	]);
}

function pdfEscape(text: string): string {
	return text
		.replaceAll("\\", "\\\\")
		.replaceAll("(", "\\(")
		.replaceAll(")", "\\)");
}

/** Minimal PDF with one Helvetica text line per page; pdftotext reads it. */
export function pdfBytes(
	pages: string[],
	options: { encrypted?: boolean } = {},
): Uint8Array {
	const objects: string[] = [
		"<</Type/Catalog/Pages 2 0 R>>",
		"<</Type/Pages/Kids[" +
			pages.map((_page, index) => `${4 + index * 2} 0 R`).join(" ") +
			"]/Count " +
			pages.length +
			">>",
		"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
	];
	for (const page of pages) {
		const stream = `BT /F1 12 Tf 10 50 Td (${pdfEscape(page)}) Tj ET`;
		objects.push(
			"<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents " +
				(objects.length + 2) +
				" 0 R/Resources<</Font<</F1 3 0 R>>>>>>",
		);
		objects.push(`<</Length ${stream.length}>>stream\n${stream}\nendstream\n`);
	}
	const trailer = options.encrypted
		? "trailer<</Root 1 0 R/Encrypt<</Filter/Standard/V 1/R 2/O(x)/U(y)/P -1>>>>"
		: "trailer<</Root 1 0 R>>";
	return encoder.encode(
		[
			"%PDF-1.4",
			...objects.map((body, index) => `${index + 1} 0 obj${body}endobj`),
			trailer,
			"%%EOF",
			"",
		].join("\n"),
	);
}

/** A PDF whose only page carries no text operators (image-only or scanned). */
export function scannedPdfBytes(): Uint8Array {
	return encoder.encode(
		[
			"%PDF-1.4",
			"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
			"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
			"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj",
			"trailer<</Root 1 0 R>>",
			"%%EOF",
			"",
		].join("\n"),
	);
}
