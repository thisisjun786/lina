#!/usr/bin/env python3
"""Bounded Office (DOCX/XLSX) text extractor for Lina attachments.

Reads the container from stdin, writes one JSON object to stdout:
  {"text": str, "truncated": bool, "pages": int, "note": str|null}
or {"error": str} with exit code 2. Stdlib only; no shell, no temp files.

argv: <format docx|xlsx> <max_chars> <max_pages> <max_input_bytes>
"""
import io
import json
import resource
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_ENTRY_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_XML_BYTES = 16 * 1024 * 1024
MAX_ENTRIES = 512

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
PR = "{http://schemas.openxmlformats.org/package/2006/relationships}"


class Bounded(Exception):
    pass


class Rejected(Exception):
    pass


def limits():
    for kind, value in ((resource.RLIMIT_AS, 512 * 1024 * 1024), (resource.RLIMIT_CPU, 20), (resource.RLIMIT_NPROC, 0), (resource.RLIMIT_FSIZE, 0)):
        try:
            soft, hard = resource.getrlimit(kind)
            cap = value if hard == resource.RLIM_INFINITY else min(value, hard)
            resource.setrlimit(kind, (cap, hard))
        except (ValueError, OSError):
            pass


class Sink:
    def __init__(self, max_chars):
        self.max_chars = max_chars
        self.parts = []
        self.length = 0
        self.truncated = False

    def write(self, piece):
        if not piece or self.truncated:
            return
        room = self.max_chars - self.length
        if len(piece) > room:
            piece = piece[:room]
            self.truncated = True
        # never end on a high surrogate (unpaired code unit is impossible in str, but keep prefix stable for JS)
        self.parts.append(piece)
        self.length += len(piece)
        if self.truncated:
            raise Bounded()

    def text(self):
        return "".join(self.parts)


def read_xml(archive, name):
    try:
        info = archive.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_XML_BYTES:
        raise Rejected("XML part exceeds the size bound")
    with archive.open(info) as handle:
        raw = handle.read(MAX_XML_BYTES + 1)
    if len(raw) > MAX_XML_BYTES:
        raise Rejected("XML part exceeds the size bound")
    head = raw[:4096].lower()
    if b"<!doctype" in head or b"<!entity" in raw.lower():
        raise Rejected("XML part declares a DTD or entity")
    parser = ET.XMLParser()
    try:
        return ET.fromstring(raw, parser=parser)
    except ET.ParseError as error:
        raise Rejected("XML part is malformed: %s" % error)


def check_archive(archive):
    infos = archive.infolist()
    if len(infos) > MAX_ENTRIES:
        raise Rejected("Zip container has too many entries")
    total = 0
    for info in infos:
        name = info.filename
        if name.startswith("/") or ".." in name.split("/") or "\\" in name:
            raise Rejected("Zip entry name is unsafe")
        if info.flag_bits & 0x1:
            raise Rejected("Zip entry is encrypted")
        if info.file_size > MAX_ENTRY_BYTES:
            raise Rejected("Zip entry uncompressed size exceeds the bound")
        total += info.file_size
        if total > MAX_TOTAL_BYTES:
            raise Rejected("Zip container uncompressed size exceeds the bound")
        lower = name.lower()
        if "vbaproject" in lower or "/externallinks/" in lower or lower.startswith("xl/externallinks"):
            raise Rejected("Office container carries macros or external links")


def docx_paragraph(paragraph, sink):
    for node in paragraph.iter():
        tag = node.tag
        if tag == W + "t":
            sink.write(node.text or "")
        elif tag == W + "tab":
            sink.write("\t")
        elif tag in (W + "br", W + "cr"):
            sink.write("\n")


def extract_docx(archive, sink, max_pages):
    root = read_xml(archive, "word/document.xml")
    if root is None:
        raise Rejected("DOCX container has no document part")
    body = root.find(W + "body")
    if body is None:
        raise Rejected("DOCX document has no body")
    count = 0
    for paragraph in body.iter(W + "p"):
        count += 1
        if count > max_pages:
            sink.truncated = True
            raise Bounded()
        docx_paragraph(paragraph, sink)
        sink.write("\n")
    return count


def column_index(reference):
    value = 0
    for char in reference:
        if char.isalpha():
            value = value * 26 + (ord(char.upper()) - 64)
        else:
            break
    return value


def shared_strings(archive):
    root = read_xml(archive, "xl/sharedStrings.xml")
    if root is None:
        return []
    values = []
    for item in root.iter(S + "si"):
        values.append("".join(t.text or "" for t in item.iter(S + "t")))
    return values


def sheet_targets(archive):
    workbook = read_xml(archive, "xl/workbook.xml")
    if workbook is None:
        raise Rejected("XLSX container has no workbook part")
    rels = read_xml(archive, "xl/_rels/workbook.xml.rels")
    targets = {}
    if rels is not None:
        for rel in rels.iter(PR + "Relationship"):
            target = rel.get("Target", "")
            if target.startswith("/"):
                target = target[1:]
            else:
                target = "xl/" + target
            if ".." in target.split("/"):
                raise Rejected("Workbook relationship target is unsafe")
            targets[rel.get("Id")] = target
    sheets = []
    rid_key = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    for index, sheet in enumerate(workbook.iter(S + "sheet")):
        name = sheet.get("name") or "Sheet%d" % (index + 1)
        target = targets.get(sheet.get(rid_key), "xl/worksheets/sheet%d.xml" % (index + 1))
        sheets.append((name, target))
    return sheets


def extract_xlsx(archive, sink, max_pages):
    strings = shared_strings(archive)
    sheets = sheet_targets(archive)
    count = 0
    for index, (name, target) in enumerate(sheets):
        count += 1
        if count > max_pages:
            sink.truncated = True
            raise Bounded()
        if index:
            sink.write("\n")
        sink.write("[sheet %d: %s]\n" % (index + 1, name))
        root = read_xml(archive, target)
        if root is None:
            continue
        for row in root.iter(S + "row"):
            cells = []
            for cell in row.iter(S + "c"):
                kind = cell.get("t")
                value = cell.find(S + "v")
                if kind == "s" and value is not None:
                    try:
                        text = strings[int(value.text or "-1")]
                    except (ValueError, IndexError):
                        text = ""
                elif kind == "inlineStr":
                    text = "".join(t.text or "" for t in cell.iter(S + "t"))
                elif value is not None:
                    text = value.text or ""
                else:
                    text = ""
                position = column_index(cell.get("r", ""))
                while position > len(cells) + 1 and position <= 16384:
                    cells.append("")
                cells.append(text.replace("\t", " ").replace("\n", " "))
            sink.write("\t".join(cells) + "\n")
    return count


def main():
    limits()
    if len(sys.argv) != 5:
        raise Rejected("usage: format max_chars max_pages max_input_bytes")
    kind = sys.argv[1]
    max_chars = int(sys.argv[2])
    max_pages = int(sys.argv[3])
    max_input = int(sys.argv[4])
    data = sys.stdin.buffer.read(max_input + 1)
    if len(data) > max_input:
        raise Rejected("Document exceeds the input bound")
    sink = Sink(max_chars)
    pages = 0
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            check_archive(archive)
            if kind == "docx":
                pages = extract_docx(archive, sink, max_pages)
            elif kind == "xlsx":
                pages = extract_xlsx(archive, sink, max_pages)
            else:
                raise Rejected("Unsupported document format")
    except Bounded:
        pages = max(pages, 1)
    except zipfile.BadZipFile:
        raise Rejected("Office container is not a valid zip")
    text = sink.text()
    note = None if text.strip() else "Document contains no extractable text"
    sys.stdout.write(json.dumps({"text": text, "truncated": sink.truncated, "pages": pages, "note": note}, ensure_ascii=False))
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Rejected as error:
        sys.stdout.write(json.dumps({"error": str(error)}) + "\n")
        sys.exit(2)
    except MemoryError:
        sys.stdout.write(json.dumps({"error": "Document extraction exceeded its memory bound"}) + "\n")
        sys.exit(2)
