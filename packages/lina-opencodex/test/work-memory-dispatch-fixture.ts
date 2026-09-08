import type { ModelSettings } from "../../lina-runtime/src/models/types.ts";
import type { CompletionEndpoint, HubModel } from "../src/catalog.ts";
import type { OpenCodexRuntime } from "../src/services.ts";

export function dispatchFixture(endpoint: CompletionEndpoint = "responses") {
	const requests: Array<{ path: string; body: string }> = [];
	let fetchCalls = 0;
	let status = 200;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push({
				path: new URL(request.url).pathname,
				body: await request.text(),
			});
			return Response.json({ output_text: "local fixture answer" }, { status });
		},
	});
	const model: HubModel = {
		id: "fixture-model",
		provider: "opencodex",
		name: "Local fixture",
		contextWindow: 128000,
		maxOutputTokens: 4096,
		reasoning: false,
		authenticated: true,
		endpoint,
	};
	const settings: ModelSettings = {
		revision: 3,
		profiles: [
			{
				id: "fixture",
				provider: "opencodex",
				model: model.id,
				reasoning: "off",
			},
		],
		defaultProfileId: "fixture",
		roles: {},
		agentRoles: {},
	};
	const runtime = {
		origin: () => server.url.origin,
		token: () => null,
		models: () => [model],
		fetchImpl: (input, init) => {
			if (!String(input).startsWith(`${server.url.origin}/`))
				throw new Error("Fixture refuses nonlocal dispatch");
			fetchCalls++;
			return fetch(input, init);
		},
	} satisfies OpenCodexRuntime;
	return {
		runtime,
		settings,
		requests,
		get fetchCalls() {
			return fetchCalls;
		},
		setStatus(value: number) {
			status = value;
		},
		close: () => server.stop(true),
	};
}
