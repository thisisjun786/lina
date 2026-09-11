import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { bounded } from "./protocol.ts";

export type CapturedRequest = {
	readonly request: unknown;
	readonly status: number;
	readonly response: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly elapsedMs: number;
};

export type CaptureOptions = {
	readonly upstreamBaseUrl: string;
	readonly credential?: string;
	readonly evidenceDir: string;
	readonly outputLimit?: "provider-default";
};

export type LiveCapture = {
	readonly baseUrl: string;
	readonly records: CapturedRequest[];
	close(): Promise<{ port: number; closed: boolean }>;
};

async function closedPort(port: number): Promise<boolean> {
	const socket = createConnection({ host: "127.0.0.1", port });
	try {
		return await bounded(
			new Promise<boolean>((resolve, reject) => {
				socket.once("connect", () => resolve(false));
				socket.once("error", (error: NodeJS.ErrnoException) => {
					if (error.code === "ECONNREFUSED") resolve(true);
					else reject(error);
				});
			}),
			"capture port closure",
		);
	} finally {
		socket.destroy();
	}
}

export function startLiveCapture(options: CaptureOptions): LiveCapture {
	const records: CapturedRequest[] = [];
	const pending = new Set<Promise<Response>>();
	const shutdown = new AbortController();
	let dispatched = 0;
	const redact = (value: string) => {
		if (!options.credential) return value;
		return value.replaceAll(options.credential, "[REDACTED]");
	};
	async function forward(request: Request): Promise<Response> {
		if (
			request.method !== "POST" ||
			new URL(request.url).pathname !== "/v1/responses"
		)
			return new Response("Unsupported capture route", { status: 404 });
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return new Response("Invalid request JSON", { status: 400 });
		}
		const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
		if (
			!parsed.success ||
			parsed.data["model"] !== "ollama-cloud/glm-5.3-flash"
		)
			return new Response("Unsupported request model", { status: 400 });
		if (shutdown.signal.aborted || dispatched >= 6)
			return new Response("Episode dispatch unavailable", { status: 429 });
		const forwarded: Record<string, unknown> = {
			...parsed.data,
			max_output_tokens:
				options.outputLimit === "provider-default" ? undefined : 4096,
			stream: true,
		};
		const sequence = ++dispatched;
		const started = performance.now();
		let status = 0;
		let responseText = "";
		const headers: Record<string, string> = {};
		try {
			const outgoingHeaders: Record<string, string> = {
				"content-type": "application/json",
			};
			if (options.credential)
				outgoingHeaders["authorization"] = `Bearer ${options.credential}`;
			const upstream = await fetch(
				`${options.upstreamBaseUrl.replace(/\/$/, "")}/responses`,
				{
					method: "POST",
					headers: outgoingHeaders,
					body: JSON.stringify(forwarded),
					redirect: "error",
					signal: AbortSignal.any([
						request.signal,
						shutdown.signal,
						AbortSignal.timeout(120_000),
					]),
				},
			);
			status = upstream.status;
			responseText = await upstream.text();
			for (const name of ["content-type", "x-request-id"]) {
				const value = upstream.headers.get(name);
				if (value !== null) headers[name] = redact(value);
			}
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			status = 0;
			responseText = `${error.name}: ${redact(error.message)}`;
		}
		const record: CapturedRequest = {
			request: JSON.parse(redact(JSON.stringify(forwarded))),
			status,
			response: redact(responseText),
			headers,
			elapsedMs: performance.now() - started,
		};
		records.push(record);
		writeFileSync(
			join(options.evidenceDir, `wire-${sequence}.json`),
			`${JSON.stringify(record, null, 2)}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		if (status === 0)
			return new Response("Upstream request failed", { status: 502 });
		return new Response(responseText, { status, headers });
	}
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const operation = forward(request);
			pending.add(operation);
			try {
				return await operation;
			} finally {
				pending.delete(operation);
			}
		},
	});
	const port = server.port;
	if (port === undefined) throw new Error("Capture listener has no TCP port");
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		records,
		async close() {
			shutdown.abort();
			await server.stop(true);
			for (const result of await Promise.allSettled([...pending])) {
				if (result.status === "rejected") throw result.reason;
			}
			return { port, closed: await closedPort(port) };
		},
	};
}
