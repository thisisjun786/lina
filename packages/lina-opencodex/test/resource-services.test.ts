import { expect, test } from "bun:test";
import { conservativeEstimator } from "../../lina-runtime/src/context/budget.ts";
import type {
	ModelRole,
	ModelSettings,
} from "../../lina-runtime/src/models/types.ts";
import {
	RESOURCE_PLAN_PROMPT,
	RESOURCE_RANK_PROMPT,
	RESOURCE_SUMMARY_PROMPT,
	SUMMARY_PROMPT,
	TEST_PROMPT,
} from "../src/prompts.ts";
import {
	createOpenCodexContextServices,
	createOpenCodexModelControl,
	type OpenCodexRuntime,
} from "../src/services.ts";

function sse(text: string): Response {
	const body =
		"data: " +
		JSON.stringify({
			type: "response.completed",
			response: {
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text }],
					},
				],
				usage: { input_tokens: 8, output_tokens: 3 },
			},
		}) +
		"\n\n";
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function settings(): ModelSettings {
	return {
		revision: 3,
		profiles: [
			{
				id: "main",
				provider: "opencodex",
				model: "gpt-5.6-sol",
				reasoning: "off",
				maxOutputTokens: 1024,
			},
		],
		defaultProfileId: "main",
		roles: {},
		agentRoles: {},
		routes: {
			version: 1,
			tiers: {
				quick: { profileId: "main", reasoning: "off", maxOutputTokens: 128 },
				standard: { profileId: "main", reasoning: "low", maxOutputTokens: 256 },
				deep: { profileId: "main", reasoning: "medium", maxOutputTokens: 512 },
				intensive: {
					profileId: "main",
					reasoning: "high",
					maxOutputTokens: 1024,
				},
			},
			roleTiers: { summary: "deep", recall: "quick", vision: "standard" },
		},
	};
}

function catalog(extra: Record<string, unknown> = {}) {
	return {
		provider: "opencodex" as const,
		id: "gpt-5.6-sol",
		name: "test",
		contextWindow: 128000,
		maxOutputTokens: 8192,
		reasoning: true,
		reasoningEfforts: ["low", "medium", "high"],
		authenticated: true,
		endpoint: "responses" as const,
		imageInput: true,
		...extra,
	};
}

function runtime(
	onPost?: (body: Record<string, unknown>) => void,
	model = catalog(),
): { runtime: OpenCodexRuntime; calls: { n: number } } {
	const calls = { n: 0 };
	return {
		calls,
		runtime: {
			origin: () => "http://127.0.0.1:10100",
			token: () => null,
			models: () => [model],
			fetchImpl: async (_url, init) => {
				calls.n++;
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				onPost?.(body);
				return sse("ok");
			},
		},
	};
}

function frame(prompt: string, text: string) {
	return [
		{ role: "system", content: prompt },
		{ role: "user", content: text },
	];
}

test("resource callbacks reuse summary and recall routes with dedicated prompts", async () => {
	const posts: Record<string, unknown>[] = [];
	const fixture = runtime((body) => posts.push(body));
	const ocx = fixture.runtime;
	const services = createOpenCodexContextServices(ocx, () => settings());
	expect(typeof services.summarizeResource).toBe("function");
	expect(typeof services.planResources).toBe("function");
	expect(typeof services.rankResources).toBe("function");
	const summarize = services.summarizeResource;
	const plan = services.planResources;
	const rank = services.rankResources;
	if (!summarize || !plan || !rank) throw Error("missing resource callbacks");
	const signal = new AbortController().signal;
	expect(await summarize("permitted source", signal)).toBe("ok");
	expect(await plan('{"offered":["col-a"]}', signal)).toBe("ok");
	expect(await rank('{"offered":["id-1"]}', signal)).toBe("ok");
	expect(fixture.calls.n).toBe(3);
	expect(posts[0]?.["instructions"]).toBe(RESOURCE_SUMMARY_PROMPT);
	expect(posts[1]?.["instructions"]).toBe(RESOURCE_PLAN_PROMPT);
	expect(posts[2]?.["instructions"]).toBe(RESOURCE_RANK_PROMPT);
	expect(String(posts[0]?.["instructions"])).toContain("permitted source");
	expect(String(posts[1]?.["instructions"])).toContain("collectionIds");
	expect(String(posts[1]?.["instructions"])).toContain("terms");
	expect(String(posts[2]?.["instructions"])).toContain("{ids:string[]}");
	expect(posts[0]?.["reasoning"]).toEqual({ effort: "medium" });
	expect(posts[1]?.["reasoning"]).toBeUndefined();
	expect(posts[2]?.["reasoning"]).toBeUndefined();
	expect(posts[0]?.["max_output_tokens"]).toBe(512);
	expect(posts[1]?.["max_output_tokens"]).toBe(128);
	expect(JSON.stringify(posts)).not.toContain("beforeDispatch");
	expect(services.routeInfo?.("summary")).toMatchObject({
		mode: "tier",
		tier: "deep",
	});
	expect(services.routeInfo?.("recall")).toMatchObject({
		mode: "tier",
		tier: "quick",
	});
});

test("archive summary and conversation trial stay on their existing prompts", async () => {
	const posts: Record<string, unknown>[] = [];
	const { runtime: ocx } = runtime((body) => posts.push(body));
	const getter = () => settings();
	const services = createOpenCodexContextServices(ocx, getter);
	const control = createOpenCodexModelControl(ocx, getter);
	await services.summarize("archive text", 64, new AbortController().signal);
	const profile = getter().profiles[0];
	if (!profile) throw Error("missing profile");
	await control.test(profile, "ping", new AbortController().signal);
	expect(posts[0]?.["instructions"]).toBe(SUMMARY_PROMPT);
	expect(posts[1]?.["instructions"]).toBe(TEST_PROMPT);
	expect(posts[0]?.["instructions"]).not.toBe(RESOURCE_SUMMARY_PROMPT);
});

test("resource input overhead and actual-request cap use the shared estimator frame", async () => {
	const fixture = runtime();
	const ocx = fixture.runtime;
	const services = createOpenCodexContextServices(ocx, () => settings());
	const summarize = services.summarizeResource;
	const overhead = services.resourceInputOverhead;
	if (!summarize || !overhead) throw Error("missing resource input helpers");
	expect(overhead("summary")).toBe(
		conservativeEstimator.messages(frame(RESOURCE_SUMMARY_PROMPT, "")),
	);
	expect(overhead("plan")).toBe(
		conservativeEstimator.messages(frame(RESOURCE_PLAN_PROMPT, "")),
	);
	expect(overhead("rank")).toBe(
		conservativeEstimator.messages(frame(RESOURCE_RANK_PROMPT, "")),
	);
	const payload = "permitted source text";
	const used = conservativeEstimator.messages(
		frame(RESOURCE_SUMMARY_PROMPT, payload),
	);
	const signal = new AbortController().signal;
	const guard = () => {
		throw Error("dispatch ran");
	};
	await expect(
		summarize(payload, signal, guard, undefined, undefined, 0),
	).rejects.toMatchObject({ code: "invalid_input" });
	await expect(
		summarize(payload, signal, guard, undefined, undefined, -1),
	).rejects.toMatchObject({ code: "invalid_input" });
	await expect(
		summarize(payload, signal, guard, undefined, undefined, used - 1),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(fixture.calls.n).toBe(0);
	expect(
		await summarize(payload, signal, undefined, undefined, undefined, used),
	).toBe("ok");
	expect(fixture.calls.n).toBe(1);
});

test("resource output budget is clamped into the actual request", async () => {
	const posts: Record<string, unknown>[] = [];
	const { runtime: ocx } = runtime((body) => posts.push(body));
	const services = createOpenCodexContextServices(ocx, () => settings());
	const rank = services.rankResources;
	if (!rank) throw Error("missing rankResources");
	await rank(
		"ids",
		new AbortController().signal,
		undefined,
		{ tier: "intensive" },
		8,
	);
	expect(posts[0]?.["max_output_tokens"]).toBe(8);
	expect(posts[0]?.["reasoning"]).toEqual({ effort: "high" });
	expect(posts[0]?.["instructions"]).toBe(RESOURCE_RANK_PROMPT);
});

test("resource beforeDispatch rejects without a provider call", async () => {
	const fixture = runtime();
	const ocx = fixture.runtime;
	const services = createOpenCodexContextServices(ocx, () => settings());
	const plan = services.planResources;
	if (!plan) throw Error("missing planResources");
	await expect(
		plan("payload", new AbortController().signal, () => {
			throw Error("stale resources");
		}),
	).rejects.toThrow("stale resources");
	expect(fixture.calls.n).toBe(0);
});

test("conversation-only catalog cannot serve resource roles", async () => {
	const fixture = runtime(
		undefined,
		catalog({
			supportedRoles: ["conversation"] as ModelRole[],
			imageInput: false,
		}),
	);
	const ocx = fixture.runtime;
	const getter = () => settings();
	const services = createOpenCodexContextServices(ocx, getter);
	const control = createOpenCodexModelControl(ocx, getter);
	const summarize = services.summarizeResource;
	if (!summarize) throw Error("missing summarizeResource");
	await expect(
		summarize("payload", new AbortController().signal),
	).rejects.toMatchObject({ code: "model_unavailable" });
	const profile = getter().profiles[0];
	if (!profile) throw Error("missing profile");
	await expect(
		control.test(profile, "ping", new AbortController().signal),
	).resolves.toMatchObject({ text: "ok", model: "gpt-5.6-sol" });
	expect(fixture.calls.n).toBe(1);
});

test("analyzeImage optional args reach completeOptions and keep vision guards", async () => {
	const posts: Record<string, unknown>[] = [];
	const fixture = runtime((body) => posts.push(body));
	const ocx = fixture.runtime;
	const services = createOpenCodexContextServices(ocx, () => settings());
	const analyze = services.analyzeImage;
	if (!analyze) throw Error("missing analyzeImage");
	const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	const twoArg = await analyze(
		{ bytes, mimeType: "image/png" },
		new AbortController().signal,
	);
	expect(twoArg).toMatchObject({ provider: "opencodex", text: "ok" });
	await analyze(
		{ bytes, mimeType: "image/png", question: "color?" },
		new AbortController().signal,
		undefined,
		32,
	);
	expect(posts[1]?.["max_output_tokens"]).toBe(32);
	await expect(
		analyze(
			{ bytes, mimeType: "image/png" },
			new AbortController().signal,
			() => {
				throw Error("vision blocked");
			},
		),
	).rejects.toThrow("vision blocked");
	expect(fixture.calls.n).toBe(2);
	const textOnly = createOpenCodexContextServices(
		runtime(undefined, catalog({ imageInput: false })).runtime,
		() => settings(),
	).analyzeImage;
	if (!textOnly) throw Error("missing text-only analyzeImage");
	await expect(
		textOnly(
			{ bytes, mimeType: "image/png" },
			new AbortController().signal,
			() => {
				throw Error("should not dispatch");
			},
			16,
		),
	).rejects.toMatchObject({ code: "vision_unavailable" });
});

test("resource memory uses standard route, exact prompt overhead, and actual output cap", async () => {
	const { RESOURCE_MEMORY_PROMPT } = await import("../src/prompts.ts");
	const posts: Record<string, unknown>[] = [];
	const f = runtime((body) => posts.push(body)),
		s = createOpenCodexContextServices(f.runtime, () => settings());
	if (!s.deriveResourceMemory) throw Error("missing memory callback");
	let dispatched = 0;
	expect(s.memoryInputOverhead?.()).toBe(
		conservativeEstimator.messages(frame(RESOURCE_MEMORY_PROMPT, "")),
	);
	await s.deriveResourceMemory(
		"source",
		new AbortController().signal,
		() => {
			dispatched++;
		},
		undefined,
		77,
		4096,
	);
	expect(dispatched).toBe(1);
	expect(posts[0]?.["instructions"]).toBe(RESOURCE_MEMORY_PROMPT);
	expect(posts[0]?.["reasoning"]).toEqual({ effort: "low" });
	expect(posts[0]?.["max_output_tokens"]).toBe(77);
	await expect(
		s.deriveResourceMemory(
			"source",
			new AbortController().signal,
			() => {
				throw Error("revoked");
			},
			undefined,
			77,
			4096,
		),
	).rejects.toThrow("revoked");
	expect(posts).toHaveLength(1);
});

test("actual memory worker uses OpenCodex fake fetch and persists source attributed output", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs"),
		{ tmpdir } = await import("node:os"),
		{ join } = await import("node:path");
	const { ResourceStore } = await import(
			"../../lina-memory/src/resources/store.ts"
		),
		{ ResourceMemoryWorker, memoryGeneration } = await import(
			"../../lina-runtime/src/resources/memory-worker.ts"
		),
		{ defaultEnginePolicy } = await import(
			"../../lina-runtime/src/context/policy-settings.ts"
		);
	const root = mkdtempSync(join(tmpdir(), "lina-memory-provider-")),
		policy = defaultEnginePolicy();
	const posts: Record<string, unknown>[] = [];
	const fixture = runtime();
	fixture.runtime.fetchImpl = async (_url, init) => {
		posts.push(JSON.parse(String(init?.body)));
		return sse(
			JSON.stringify([
				{ kind: "decision", text: "Paper selected", quote: "paper" },
			]),
		);
	};
	const svc = createOpenCodexContextServices(fixture.runtime, () => settings()),
		scope = {
			principalId: "a",
			agentId: "a",
			allowedVisibilities: ["shared"] as "shared"[],
		};
	const store = new ResourceStore(
		root,
		{ maxFileBytes: 4096, maxCatalogBytes: 8192, maxExtractionBytes: 4096 },
		undefined,
		() => memoryGeneration(svc, policy),
	);
	try {
		const r = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "Notes",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("We selected paper."),
			deriveMemory: true,
			activityKind: "writing",
		});
		const worker = new ResourceMemoryWorker({
			store,
			scope: () => scope,
			services: () => svc,
			policy: () => policy,
		});
		expect((await worker.run(r.id, new AbortController().signal)).state).toBe(
			"ready",
		);
		expect(posts).toHaveLength(1);
		expect(posts[0]?.["max_output_tokens"]).toBe(256);
		expect(store.memories.list(scope, r.id)[0]?.evidence.activityKind).toBe(
			"writing",
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
