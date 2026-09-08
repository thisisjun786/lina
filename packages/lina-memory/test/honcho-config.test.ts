import { describe, expect, it } from "bun:test";
import { chunkText, PART_MAX_BYTES, sanitizeNul } from "../src/honcho/chunk.ts";
import {
	parseHonchoEnv,
	publicIdentity,
	validateHonchoConfig,
} from "../src/honcho/config.ts";
import { config } from "./honcho-fixture.ts";

describe("honcho config", () => {
	it("accepts an explicit self-host config and omits apiKey from the public identity", () => {
		const parsed = validateHonchoConfig({
			...config,
			baseUrl: "http://127.0.0.1:8000/",
		});
		expect(parsed.baseUrl).toBe("http://127.0.0.1:8000");
		expect(publicIdentity(parsed)).toEqual({
			baseUrl: "http://127.0.0.1:8000",
			workspaceId: "lina-test",
			sessionId: "lina-main",
			userPeerId: "example",
			observerPeerId: "lina",
		});
		expect("apiKey" in publicIdentity(parsed)).toBe(false);
	});

	it("rejects managed hosts, non-http origins, bad names, same peers and unknown keys", () => {
		expect(() =>
			validateHonchoConfig({ ...config, baseUrl: "https://api.honcho.dev" }),
		).toThrow(/self-host/);
		expect(() =>
			validateHonchoConfig({ ...config, baseUrl: "ftp://x" }),
		).toThrow();
		expect(() =>
			validateHonchoConfig({ ...config, baseUrl: "http://h:8000/?a=1" }),
		).toThrow();
		expect(() =>
			validateHonchoConfig({ ...config, workspaceId: "lina.test" }),
		).toThrow(/workspaceId/);
		expect(() =>
			validateHonchoConfig({ ...config, observerPeerId: "example" }),
		).toThrow(/differ/);
		expect(() => validateHonchoConfig({ ...config, extra: 1 })).toThrow(
			/unknown/,
		);
		expect(() => validateHonchoConfig({ ...config, apiKey: "a\nb" })).toThrow(
			/apiKey/,
		);
	});

	it("treats no LINA_HONCHO_* variables as disabled and partial ones as an error", () => {
		expect(
			parseHonchoEnv({ PATH: "/bin", LINA_HONCHO_BASE_URL: "" }),
		).toBeUndefined();
		expect(() =>
			parseHonchoEnv({ LINA_HONCHO_BASE_URL: "http://127.0.0.1:8000" }),
		).toThrow();
		const parsed = parseHonchoEnv({
			LINA_HONCHO_BASE_URL: "http://127.0.0.1:8000",
			LINA_HONCHO_WORKSPACE_ID: "lina-test",
			LINA_HONCHO_SESSION_ID: "lina-main",
			LINA_HONCHO_USER_PEER_ID: "example",
			LINA_HONCHO_OBSERVER_PEER_ID: "lina",
		});
		expect(parsed?.apiKey).toBeUndefined();
		expect(parsed?.workspaceId).toBe("lina-test");
	});
});

describe("honcho chunking", () => {
	it("is deterministic, NUL-free, and never splits a code point across the byte cap", () => {
		const text = `${"가".repeat(1000)}\0${"😀".repeat(200)}end`;
		const parts = chunkText(text);
		expect(parts).toEqual(chunkText(text));
		expect(parts.map((p) => p.content).join("")).toBe(sanitizeNul(text));
		for (const part of parts) {
			expect(Buffer.byteLength(part.content, "utf8")).toBeLessThanOrEqual(
				PART_MAX_BYTES,
			);
			expect(part.content).not.toContain("\uFFFD");
			expect(part.contentHash).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(parts.length).toBe(
			Math.ceil(3000 / 1500) + Math.ceil((800 + 3) / 1500),
		);
		expect(chunkText("")).toEqual([]);
		expect(chunkText("\0\0")).toEqual([]);
	});
});

describe("explicit ordinary namespace environment transport", () => {
	it("accepts full explicit JSON and never substitutes it for required base fields", () => {
		const namespace = {
			version: 1 as const,
			ownerBotId: "lina",
			generationId: "g1",
			workspaceId: "ordinary-workspace",
			sessionId: "ordinary-session",
			userPeerId: "ordinary-user",
			observerPeerId: "ordinary-observer",
			sourcePolicyVersion: 1 as const,
			qualificationId: "q1",
		};
		const env = {
			LINA_HONCHO_BASE_URL: config.baseUrl,
			LINA_HONCHO_WORKSPACE_ID: config.workspaceId,
			LINA_HONCHO_SESSION_ID: config.sessionId,
			LINA_HONCHO_USER_PEER_ID: config.userPeerId,
			LINA_HONCHO_OBSERVER_PEER_ID: config.observerPeerId,
			LINA_HONCHO_ORDINARY_NAMESPACE_JSON: JSON.stringify(namespace),
		};
		expect(parseHonchoEnv(env)?.ordinaryNamespace).toEqual(namespace);
		expect(() =>
			parseHonchoEnv({
				LINA_HONCHO_ORDINARY_NAMESPACE_JSON: JSON.stringify(namespace),
			}),
		).toThrow();
		for (const input of [
			"{",
			"null",
			"[]",
			JSON.stringify({ ...namespace, qualificationId: undefined }),
			JSON.stringify({ ...namespace, ownerBotId: undefined }),
			JSON.stringify({ ...namespace, extra: true }),
		])
			expect(() =>
				parseHonchoEnv({ ...env, LINA_HONCHO_ORDINARY_NAMESPACE_JSON: input }),
			).toThrow();
	});
});
