const LIMIT = 2_097_152;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FILE = new RegExp(`^/api/attachments/${UUID}(?:/preview|/meta)?$`, "i");
export async function bounded(
	body: ReadableStream<Uint8Array> | null,
	signal: AbortSignal,
	limit = LIMIT,
): Promise<Uint8Array<ArrayBuffer>> {
	if (!body) return new Uint8Array();
	const reader = body.getReader(),
		chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => void reader.cancel().catch(() => {});
	signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			size += value.length;
			if (size > limit) throw new RangeError("Body too large");
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return bytes;
	} finally {
		signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
export async function proxyAttachment(
	request: Request,
	upstream: string,
	allowsOrigin: (host: string | null, origin: string | null) => boolean,
	security: Record<string, string>,
): Promise<Response | undefined> {
	const url = new URL(request.url),
		upload = url.pathname === "/api/attachments",
		file = FILE.test(url.pathname);
	if (!upload && !file) return;
	const fail = (status: number, text: string) =>
		new Response(text, { status, headers: security });
	if (upload) {
		if (
			!allowsOrigin(request.headers.get("host"), request.headers.get("origin"))
		)
			return fail(403, "Forbidden");
		if (request.method !== "POST" || url.search)
			return fail(405, "Method not allowed");
	} else {
		if (
			request.headers.get("Sec-Fetch-Site") !== "same-origin" &&
			!allowsOrigin(request.headers.get("host"), request.headers.get("origin"))
		)
			return fail(403, "Forbidden");
		if (request.method !== "GET") return fail(405, "Method not allowed");
		if (
			url.searchParams.size !== 1 ||
			!new RegExp(`^${UUID}$`, "i").test(
				url.searchParams.get("sessionId") ?? "",
			)
		)
			return fail(400, "Invalid attachment scope");
	}
	const length = request.headers.get("content-length");
	if (length && (!/^\d+$/.test(length) || Number(length) > LIMIT))
		return fail(413, "File too large");
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
	try {
		const headers = new Headers();
		if (upload)
			for (const name of ["X-Lina-Session", "X-Lina-Filename"]) {
				const value = request.headers.get(name);
				if (!value || value.length > 1024)
					return fail(400, "Missing attachment metadata");
				headers.set(name, value);
			}
		headers.set("Content-Type", "application/octet-stream");
		const bytes = upload ? await bounded(request.body, signal) : undefined;
		const target = new URL(upstream);
		target.protocol = "http:";
		target.pathname = url.pathname;
		target.search = url.search;
		const response = await fetch(target, {
			method: request.method,
			headers,
			body: bytes,
			signal,
			redirect: "error",
		});
		const body = await bounded(response.body, signal, LIMIT + 65536);
		const outgoing = new Headers(security);
		for (const key of ["Content-Type", "Content-Disposition"]) {
			const value = response.headers.get(key);
			if (value) outgoing.set(key, value);
		}
		return new Response(body, { status: response.status, headers: outgoing });
	} catch (error) {
		return fail(
			error instanceof RangeError ? 413 : 502,
			error instanceof RangeError
				? "File too large"
				: "Attachment service unavailable",
		);
	}
}
