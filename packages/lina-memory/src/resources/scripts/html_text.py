#!/usr/bin/env python3
"""Bounded HTML text extractor for Lina resources.

Reads UTF-8 HTML from stdin, writes one JSON object to stdout:
  {"text": str, "truncated": bool, "pages": int, "note": str|null}
or {"error": str} with exit code 2. Stdlib HTMLParser only; no network, no JS.

argv: <max_chars> <max_input_bytes>
"""
import json
import re
import resource
import sys
from html.parser import HTMLParser

SKIP_TAGS = frozenset(("script", "style", "template"))
RAWTEXT_TAGS = frozenset(("script", "style"))
VOID_TAGS = frozenset(
    (
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    )
)
BLOCK_TAGS = frozenset(
    (
        "address",
        "article",
        "aside",
        "blockquote",
        "br",
        "dd",
        "div",
        "dl",
        "dt",
        "figcaption",
        "figure",
        "footer",
        "form",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "li",
        "main",
        "nav",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "title",
        "tr",
        "ul",
    )
)


class Bounded(Exception):
    pass


class Rejected(Exception):
    pass


def limits():
    for kind, value in (
        (resource.RLIMIT_AS, 512 * 1024 * 1024),
        (resource.RLIMIT_CPU, 20),
        (resource.RLIMIT_NPROC, 0),
        (resource.RLIMIT_FSIZE, 0),
    ):
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
        self.parts.append(piece)
        self.length += len(piece)
        if self.truncated:
            raise Bounded()

    def text(self):
        return "".join(self.parts)


def hidden(tag, attrs):
    values = {name.lower(): "" if value is None else value for name, value in attrs}
    if "hidden" in values:
        return True
    if values.get("aria-hidden", "").strip().lower() == "true":
        return True
    if tag == "input" and values.get("type", "").strip().lower() == "hidden":
        return True
    compact = re.sub(r"\s+", "", values.get("style", "")).lower()
    return "display:none" in compact or "visibility:hidden" in compact


class Extractor(HTMLParser):
    def __init__(self, sink):
        super().__init__(convert_charrefs=True)
        self.sink = sink
        self.ignore = 0
        self.open_tags = []
        self.need_space = False
        self.at_line_start = True

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        if self.skipping_cdata():
            return
        self.handle_starttag(tag, attrs)

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self.skipping_cdata():
            return
        start_ignore = tag in SKIP_TAGS or hidden(tag, attrs)
        if tag in VOID_TAGS:
            if self.ignore or start_ignore:
                return
            if tag in ("br", "hr"):
                self.newline()
            return
        self.open_tags.append((tag, start_ignore))
        if start_ignore:
            self.ignore += 1
        if self.ignore:
            return
        if tag in BLOCK_TAGS:
            self.newline()

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in VOID_TAGS:
            return
        if self.skipping_cdata():
            innermost = None
            for index in range(len(self.open_tags) - 1, -1, -1):
                name, started = self.open_tags[index]
                if started and name in RAWTEXT_TAGS:
                    innermost = (index, name)
                    break
            if innermost is None or tag != innermost[1]:
                return
            match = innermost[0]
            closed = self.open_tags[match:]
            del self.open_tags[match:]
            for _name, started_ignore in reversed(closed):
                if started_ignore and self.ignore:
                    self.ignore -= 1
            return
        match = None
        barrier = None
        for index in range(len(self.open_tags) - 1, -1, -1):
            name, started = self.open_tags[index]
            if started and name == "template":
                barrier = index
                break
        start = 0
        if barrier is not None:
            start = barrier if tag == "template" else barrier + 1
        for index in range(len(self.open_tags) - 1, start - 1, -1):
            if self.open_tags[index][0] == tag:
                match = index
                break
        if match is None:
            return
        closed = self.open_tags[match:]
        del self.open_tags[match:]
        for _name, started_ignore in reversed(closed):
            if started_ignore and self.ignore:
                self.ignore -= 1
        if self.ignore:
            return
        if tag in BLOCK_TAGS:
            self.newline()

    def skipping_cdata(self):
        for name, started in reversed(self.open_tags):
            if started and name in RAWTEXT_TAGS:
                return True
        return False

    def handle_data(self, data):
        if self.ignore or not data:
            return
        self.emit(data.replace("\xa0", " "))

    def handle_comment(self, _data):
        return

    def emit(self, data):
        piece = re.sub(r"[ \t\f\r\n]+", " ", data)
        if piece == "":
            return
        if piece == " ":
            self.need_space = True
            return
        if piece.startswith(" "):
            self.need_space = True
            piece = piece.lstrip()
        trailing = piece.endswith(" ")
        piece = piece.strip()
        if not piece:
            self.need_space = True
            return
        if self.need_space and not self.at_line_start:
            self.sink.write(" ")
        self.sink.write(piece)
        self.at_line_start = False
        self.need_space = trailing

    def newline(self):
        if self.ignore or self.at_line_start:
            self.need_space = False
            return
        self.sink.write("\n")
        self.at_line_start = True
        self.need_space = False


def main():
    limits()
    if len(sys.argv) != 3:
        raise Rejected("usage: max_chars max_input_bytes")
    max_chars = int(sys.argv[1])
    max_input = int(sys.argv[2])
    data = sys.stdin.buffer.read(max_input + 1)
    if len(data) > max_input:
        raise Rejected("Document exceeds the input bound")
    if b"\x00" in data:
        raise Rejected("HTML contains a NUL byte")
    try:
        html = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Rejected("HTML is not valid UTF-8")
    sink = Sink(max_chars)
    parser = Extractor(sink)
    try:
        parser.feed(html)
        parser.close()
    except Bounded:
        pass
    except Exception as error:
        raise Rejected("HTML is malformed: %s" % error)
    text = sink.text().strip()
    note = None if text else "HTML contains no extractable text"
    sys.stdout.write(
        json.dumps(
            {"text": text, "truncated": sink.truncated, "pages": 1, "note": note},
            ensure_ascii=False,
        )
    )
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
