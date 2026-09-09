import { Ima2Client } from "../src/images/client.ts";
import { catalog, requestId } from "./ima2-client-fixture.ts";

const cleanup: (() => void | Promise<void>)[] = [];
export async function closeSubmissionServers() {
	for (const close of cleanup.splice(0)) await close();
}

/** Owned loopback server; the catalog barrier exposes async connection preparation. */
export function submissionServer(
	options: {
		holdCatalog?: boolean;
		generate?: (request: Request) => Response | Promise<Response>;
	} = {},
) {
	const preparing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const bodies: string[] = [];
	const calls: { url: string; init: RequestInit }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/api/health")
				return Response.json({ ok: true, version: "3.14.0" });
			if (path === "/api/models") {
				preparing.resolve();
				if (options.holdCatalog) await release.promise;
				return Response.json(catalog);
			}
			if (path === "/api/generate" && request.method === "POST") {
				bodies.push(await request.clone().text());
				return (
					options.generate?.(request) ??
					Response.json({ requestId, async: true }, { status: 202 })
				);
			}
			return new Response(null, { status: 404 });
		},
	});
	cleanup.push(async () => {
		release.resolve();
		await server.stop(true);
	});
	const baseUrl = server.url.origin;
	const client = new Ima2Client({
		baseUrl,
		fetch: (url, init) => {
			calls.push({ url, init });
			return fetch(url, init);
		},
	});
	return { client, baseUrl, bodies, calls, preparing, release };
}
