import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelSettings } from "../../lina-runtime/src/models/types.ts";
import { OpenCodexHub } from "../src/index.ts";

const SECRET = "ocx_admin_do_not_use_9f3a";

const sol = {
	id: "gpt-5.6-sol",
	object: "model",
	api_types: ["chat_completions", "responses"],
	capabilities: {
		context_length: 372000,
		max_output_tokens: 128000,
		input_modalities: ["text", "image"],
		supports_reasoning: true,
		supports_vision: true,
	},
};

function settings(): ModelSettings {
	return {
		revision: 1,
		profiles: [
			{
				id: "sol",
				provider: "opencodex",
				model: "gpt-5.6-sol",
				reasoning: "off",
			},
			{
				id: "missing",
				provider: "opencodex",
				model: "no-such-model",
				reasoning: "off",
			},
		],
		defaultProfileId: "sol",
		roles: {},
		agentRoles: {},
	};
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("model control is constructible while the hub is offline", () => {
	const hub = new OpenCodexHub({
		env: {},
		homeDir: mkdtempSync(join(tmpdir(), "lina-ocx-off-")),
	});
	const control = hub.createModelControl(() => settings());
	expect(hub.status()).toMatchObject({
		configured: false,
		connected: false,
		modelCount: 0,
	});
	expect(control.catalog()).toEqual([]);
	expect(control.state().error).toBeTruthy();
	expect(JSON.stringify(hub.status())).not.toContain(SECRET);
});

test("models 200 and catalog 404 still connect, and refresh picks up a new origin", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lina-ocx-hub-"));
	mkdirSync(join(dir, ".opencodex"), { recursive: true });
	writeFileSync(
		join(dir, ".opencodex", "config.json"),
		JSON.stringify({
			hub: {
				managementPublicOrigin: "https://hub.example.ts.net:10100",
			},
			unauthenticatedLoopbackListener: { enabled: true, port: 10100 },
			providers: { openai: { apiKey: SECRET } },
		}),
	);
	writeFileSync(join(dir, ".opencodex", "admin-api-token"), SECRET);
	const calls: string[] = [];
	const env: Record<string, string> = {};
	const hub = new OpenCodexHub({
		env,
		homeDir: dir,
		fetchImpl: async (input, init) => {
			const url = String(input);
			calls.push(url);
			expect(init?.redirect).toBe("manual");
			expect(new Headers(init?.headers).has("authorization")).toBe(false);
			expect(new Headers(init?.headers).has("x-opencodex-api-key")).toBe(false);
			if (url.endsWith("/v1/models"))
				return json({ object: "list", data: [sol] });
			if (url.endsWith("/v1/catalog"))
				return json({ error: { code: "catalog_not_found" } }, 404);
			throw new Error("unexpected " + url);
		},
	});
	const control = hub.createModelControl(() => settings());
	await hub.refresh();
	expect(hub.status()).toEqual({
		configured: true,
		connected: true,
		guiUrl: "https://hub.example.ts.net:10100",
		error: null,
		modelCount: 1,
	});
	expect(control.catalog()[0]?.id).toBe("gpt-5.6-sol");
	expect(control.catalog()[0]?.provider).toBe("opencodex");
	expect(JSON.stringify(hub.status())).not.toContain(SECRET);
	const isolated = hub.isolatedHomeConnection();
	expect(isolated?.providerTable).toContain("requires_openai_auth = false");
	expect(isolated?.providerTable).not.toContain("env_key");
	expect(isolated?.catalogSource).not.toBe("hub");

	env["LINA_OPENCODEX_BASE_URL"] = "http://127.0.0.1:19999";
	await hub.refresh();
	expect(calls.some((url) => url.startsWith("http://127.0.0.1:19999/"))).toBe(
		true,
	);
	expect(hub.isolatedHomeConnection()?.origin).toBe("http://127.0.0.1:19999");
});

test("child environment carries the data token while status JSON does not", () => {
	const dir = mkdtempSync(join(tmpdir(), "lina-ocx-child-"));
	mkdirSync(join(dir, ".opencodex"), { recursive: true });
	writeFileSync(join(dir, ".opencodex", "config.json"), "{}");
	const token = "ocx_data_token_child_zzzzzzzz";
	const hub = new OpenCodexHub({
		env: {
			LINA_OPENCODEX_BASE_URL: "https://hub.example.ts.net:10100",
			LINA_OPENCODEX_API_KEY: token,
		},
		homeDir: dir,
	});
	expect(hub.childEnvironment()["OPENCODEX_API_AUTH_TOKEN"]).toBe(token);
	const publicJson = JSON.stringify({
		status: hub.status(),
		isolated: hub.isolatedHomeConnection(),
	});
	expect(publicJson).not.toContain(token);
	expect(JSON.stringify(hub.status())).not.toContain(
		"OPENCODEX_API_AUTH_TOKEN",
	);
});
