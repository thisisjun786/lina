import { type IncomingMessage, request, type ServerResponse } from "node:http";

const UPLOAD_LIMIT = 2_097_152;
const RESPONSE_LIMIT = UPLOAD_LIMIT + 65_536;
const HEADERS = [
	"content-type",
	"x-lina-session",
	"x-lina-filename",
	"x-lina-revision",
];

async function bounded(
	stream: IncomingMessage,
	limit: number,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const value of stream) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		size += chunk.length;
		if (size > limit) throw new RangeError("Body too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size);
}

export async function proxyHttp(
	incoming: IncomingMessage,
	outgoing: ServerResponse,
	target: URL,
): Promise<void> {
	const upload =
		target.pathname === "/api/attachments" ||
		target.pathname.endsWith("/avatar");
	const limit = upload ? UPLOAD_LIMIT : 65_536;
	if (Number(incoming.headers["content-length"] ?? 0) > limit) {
		outgoing.writeHead(413);
		outgoing.end("Request too large");
		incoming.resume();
		return;
	}
	const cancel = new AbortController();
	const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(85_000)]);
	const disconnect = () => {
		if (!outgoing.writableFinished) cancel.abort();
	};
	outgoing.once("close", disconnect);
	const abortRead = () => incoming.destroy();
	signal.addEventListener("abort", abortRead, { once: true });
	try {
		const body = await bounded(incoming, limit);
		signal.removeEventListener("abort", abortRead);
		const headers: Record<string, string> = {
			origin: target.origin,
			"sec-fetch-site": "same-origin",
			"accept-encoding": "identity",
		};
		for (const key of HEADERS) {
			const value = incoming.headers[key];
			if (typeof value === "string" && value.length <= 1024)
				headers[key] = value;
		}
		headers["content-length"] = String(body.length);
		const response = await new Promise<IncomingMessage>((resolve, reject) => {
			const req = request(
				target,
				{ method: incoming.method, headers, signal },
				resolve,
			);
			req.on("error", reject);
			req.end(body);
		});
		const status = response.statusCode ?? 502;
		if (status >= 300 && status < 400) {
			response.destroy();
			throw Error("Redirect rejected");
		}
		const result = await bounded(response, RESPONSE_LIMIT);
		for (const key of ["content-type", "content-disposition", "retry-after"]) {
			const value = response.headers[key];
			if (typeof value === "string") outgoing.setHeader(key, value);
		}
		outgoing.writeHead(status);
		outgoing.end(result);
	} catch (error) {
		if (!outgoing.destroyed) {
			outgoing.writeHead(error instanceof RangeError ? 413 : 502);
			outgoing.end(
				error instanceof RangeError
					? "Body too large"
					: "Lina unavailable. Retry when the server is connected.",
			);
		}
	} finally {
		signal.removeEventListener("abort", abortRead);
		outgoing.removeListener("close", disconnect);
	}
}
