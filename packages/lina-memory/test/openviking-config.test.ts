import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseOpenVikingEnv,
	publicIdentity,
	resolveWorkUri,
	validateOpenVikingConfig,
} from "../src/openviking/index.ts";

const config = {
	baseUrl: "http://127.0.0.1:1933",
	apiKey: "test-key",
	rootUri: "viking://resources/lina",
};

describe("openviking config", () => {
	it("accepts an explicit self-host config and omits apiKey from the public identity", () => {
		const parsed = validateOpenVikingConfig({
			...config,
			baseUrl: "http://127.0.0.1:1933/",
		});
		expect(parsed.baseUrl).toBe("http://127.0.0.1:1933");
		expect(publicIdentity(parsed)).toEqual({
			baseUrl: "http://127.0.0.1:1933",
			rootUri: "viking://resources/lina",
		});
		expect("apiKey" in publicIdentity(parsed)).toBe(false);
	});

	it("rejects non-http origins, credentials in the URL, query/hash and unknown keys", () => {
		expect(() =>
			validateOpenVikingConfig({ ...config, baseUrl: "ftp://x" }),
		).toThrow();
		expect(() =>
			validateOpenVikingConfig({
				...config,
				baseUrl: "http://user:pass@127.0.0.1:1933",
			}),
		).toThrow();
		expect(() =>
			validateOpenVikingConfig({
				...config,
				baseUrl: "http://127.0.0.1:1933/?a=1",
			}),
		).toThrow();
		expect(() => validateOpenVikingConfig({ ...config, extra: 1 })).toThrow(
			/unknown/,
		);
		expect(() =>
			validateOpenVikingConfig({ ...config, apiKey: "a\nb" }),
		).toThrow(/apiKey/);
	});

	it("requires a resources-scope root URI and rejects filesystem import roots", () => {
		expect(() =>
			validateOpenVikingConfig({ ...config, rootUri: "viking://user/example" }),
		).toThrow(/rootUri/);
		expect(() =>
			validateOpenVikingConfig({ ...config, rootUri: "file:///tmp" }),
		).toThrow(/rootUri/);
		expect(() =>
			validateOpenVikingConfig({ ...config, rootUri: "/home/example/code" }),
		).toThrow(/rootUri/);
		expect(() =>
			validateOpenVikingConfig({
				...config,
				rootUri: "viking://resources/lina/../secret",
			}),
		).toThrow(/rootUri/);
	});

	it("treats no LINA_OPENVIKING_* variables as disabled and partial ones as an error", () => {
		expect(
			parseOpenVikingEnv({ PATH: "/bin", LINA_OPENVIKING_URL: "" }),
		).toBeUndefined();
		expect(() =>
			parseOpenVikingEnv({ LINA_OPENVIKING_URL: "http://127.0.0.1:1933" }),
		).toThrow();
		const parsed = parseOpenVikingEnv({
			LINA_OPENVIKING_URL: "http://127.0.0.1:1933",
			LINA_OPENVIKING_API_KEY: "test-key",
			LINA_OPENVIKING_ROOT_URI: "viking://resources/lina",
		});
		expect(parsed?.apiKey).toBe("test-key");
		expect(parsed?.rootUri).toBe("viking://resources/lina");
	});

	it("reads LINA_OPENVIKING_TOKEN_FILE instead of API_KEY and rejects both together", () => {
		const dir = mkdtempSync(join(tmpdir(), "lina-ov-token-"));
		const file = join(dir, "token");
		writeFileSync(file, "file-secret\n", { mode: 0o600 });
		try {
			const parsed = parseOpenVikingEnv({
				LINA_OPENVIKING_URL: "http://127.0.0.1:1933",
				LINA_OPENVIKING_TOKEN_FILE: file,
				LINA_OPENVIKING_ROOT_URI: "viking://resources/lina",
			});
			expect(parsed?.apiKey).toBe("file-secret");
			expect(() =>
				parseOpenVikingEnv({
					LINA_OPENVIKING_URL: "http://127.0.0.1:1933",
					LINA_OPENVIKING_API_KEY: "test-key",
					LINA_OPENVIKING_TOKEN_FILE: file,
					LINA_OPENVIKING_ROOT_URI: "viking://resources/lina",
				}),
			).toThrow(/API_KEY|TOKEN_FILE/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("openviking URI boundaries", () => {
	const root = "viking://resources/lina";

	it("defaults omitted URI to the configured root and joins relative children", () => {
		expect(resolveWorkUri(root)).toBe(root);
		expect(resolveWorkUri(root, "notes.md")).toBe(
			"viking://resources/lina/notes.md",
		);
		expect(resolveWorkUri(root, "decisions/2026-09-06.md")).toBe(
			"viking://resources/lina/decisions/2026-09-06.md",
		);
		expect(resolveWorkUri(root, "viking://resources/lina/task-1.md")).toBe(
			"viking://resources/lina/task-1.md",
		);
	});

	it("rejects encoded, traversal and slash-escape URIs and sibling prefix matches", () => {
		const rejected = [
			"../secret.md",
			"..%2fsecret.md",
			"%2e%2e/secret.md",
			"foo/%2e%2e/secret.md",
			"foo%2fbar.md",
			"foo%5cbar.md",
			"foo\\bar.md",
			"foo//bar.md",
			"foo/./bar.md",
			"viking://resources/lina/../secret.md",
			"viking://resources/lina-other/notes.md",
			"viking://user/example/memories/x.md",
			"viking://agent/skills/x",
			"file:///etc/passwd",
			"/etc/passwd",
			"viking://resources/lina/notes.md?x=1",
			"viking://resources/lina/notes.md#frag",
		];
		for (const uri of rejected) {
			expect(() => resolveWorkUri(root, uri)).toThrow(/uri|unsafe|root/i);
		}
	});

	it("does not treat a string prefix as a directory boundary", () => {
		expect(() =>
			resolveWorkUri(
				"viking://resources/lina",
				"viking://resources/lina2/x.md",
			),
		).toThrow();
		expect(
			resolveWorkUri("viking://resources/lina", "viking://resources/lina/x.md"),
		).toBe("viking://resources/lina/x.md");
	});
});
