import { Ima2Client, type Ima2ClientOptions } from "../src/images/client.ts";

// Contract fixtures: ima2-gen 36aa6fc (v3.14.0), routes/health.ts,
// routes/models.ts, lib/generatePipeline.ts and lib/inflight.ts.
export const origin = "http://127.0.0.1:43127";
export const requestId = "lina-image-001";
export const input = {
	requestId,
	provider: "api",
	model: "image-model",
	prompt: "A tree",
};
export const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
	"base64",
);
export const lane = {
	status: "ready",
	defaults: { image: "different-default" },
	models: {
		image: [
			{
				id: "image-model",
				label: "Image",
				capabilities: {
					source: "verified-contract",
					inputRoles: ["text", "image_references"],
					parameters: [],
					aspectRatios: [],
				},
			},
		],
		video: [],
	},
	surfaces: {
		generate: {
			supported: true,
			references: true,
			mask: false,
			streaming: false,
			catalogAccess: "static",
		},
	},
};
export const catalog = { ok: true, lanes: { api: lane } };
export function terminal(
	status = "completed",
	meta: Record<string, unknown> = { filenames: ["image.png"], imageCount: 1 },
) {
	return {
		requestId,
		kind: "classic",
		status,
		startedAt: 1,
		finishedAt: 2,
		durationMs: 1,
		phase: "streaming",
		phaseAt: 1,
		meta,
	};
}
export function fixture(
	handler: (request: Request) => Response | Promise<Response> = () =>
		Response.json({ requestId, async: true }, { status: 202 }),
	options: Omit<Ima2ClientOptions, "fetch"> = {},
) {
	const requests: Request[] = [];
	const fetch = async (url: string, init: RequestInit) => {
		const request = new Request(url, init);
		requests.push(new Request(url, init));
		if (new URL(url).pathname === "/api/health")
			return Response.json({ ok: true, version: "3.14.0" });
		if (new URL(url).pathname === "/api/models") return Response.json(catalog);
		return handler(request);
	};
	return {
		client: new Ima2Client({ baseUrl: origin, ...options, fetch }),
		fetch,
		requests,
	};
}
