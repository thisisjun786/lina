const SCHEME = "viking://";
const RESOURCES = "viking://resources";

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		throw new Error("unsafe openviking uri");
	}
}

function rejectEncodedPathEscape(path: string): void {
	for (const segment of path.split("/")) {
		if (segment.length === 0) continue;
		const decoded = decodeSegment(segment);
		if (
			decoded !== segment &&
			(decoded === "." ||
				decoded === ".." ||
				decoded.includes("/") ||
				decoded.includes("\\"))
		)
			throw new Error("unsafe openviking uri");
	}
}

function assertSafePath(path: string, label: string): string[] {
	if (path.includes("\0") || path.includes("?") || path.includes("#"))
		throw new Error(`unsafe openviking ${label}`);
	if (path.includes("\\")) throw new Error(`unsafe openviking ${label}`);
	const parts = path.split("/");
	if (parts.some((part, index) => part === "" && index !== parts.length - 1))
		throw new Error(`unsafe openviking ${label}`);
	const stripped =
		parts.length > 0 && parts[parts.length - 1] === ""
			? parts.slice(0, -1)
			: parts;
	if (stripped.some((part) => part === "" || part === "." || part === ".."))
		throw new Error(`unsafe openviking ${label}`);
	rejectEncodedPathEscape(stripped.join("/"));
	return stripped;
}

export function canonicalizeVikingUri(uri: string): string {
	if (typeof uri !== "string" || uri.includes("\0"))
		throw new Error("unsafe openviking uri");
	const trimmed = uri.trim();
	if (!trimmed.startsWith(SCHEME)) throw new Error("unsafe openviking uri");
	const path = trimmed.slice(SCHEME.length);
	const parts = assertSafePath(path, "uri");
	if (parts.length === 0) throw new Error("unsafe openviking uri");
	return `${SCHEME}${parts.join("/")}`;
}

export function assertResourcesRoot(uri: string): string {
	const canonical = canonicalizeVikingUri(uri);
	if (canonical !== RESOURCES && !canonical.startsWith(`${RESOURCES}/`))
		throw new Error("invalid openviking rootUri");
	return canonical;
}

export function isUnderRoot(rootUri: string, uri: string): boolean {
	return uri === rootUri || uri.startsWith(`${rootUri}/`);
}

export function resolveWorkUri(rootUri: string, uri?: string): string {
	const root = assertResourcesRoot(rootUri);
	if (uri === undefined) return root;
	const raw = uri.trim();
	if (raw.length === 0) return root;
	if (
		raw.startsWith(SCHEME) ||
		raw.startsWith("file:") ||
		raw.startsWith("/") ||
		raw.startsWith("\\")
	) {
		if (!raw.startsWith(SCHEME)) throw new Error("unsafe openviking uri");
		const canonical = canonicalizeVikingUri(raw);
		if (!isUnderRoot(root, canonical))
			throw new Error("openviking uri is outside the configured root");
		return canonical;
	}
	if (/^[A-Za-z]:/.test(raw)) throw new Error("unsafe openviking uri");
	const relative = assertSafePath(raw, "uri").join("/");
	const joined = canonicalizeVikingUri(`${root}/${relative}`);
	if (!isUnderRoot(root, joined))
		throw new Error("openviking uri is outside the configured root");
	return joined;
}
