import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { desktopConfig, externalUrl, serverOrigin } from "../src/config.ts";

describe("desktop configuration boundary", () => {
	test("requires an explicit server and literal loopback pin", () => {
		expect(() => desktopConfig({})).toThrow();
		for (const url of [
			"https://127.0.0.1:3000",
			"http://localhost:3000",
			"http://127.1:3000",
			"http://2130706433:3000",
			"http://127.0.0.1.evil:3000",
			"http://127.0.0.1:3000/api",
			"http://127.0.0.1:3000/?url=evil",
			"http://x@127.0.0.1:3000",
			"http://127.0.0.1:0",
			"http://127.0.0.1:3000/#x",
		]) {
			expect(() => serverOrigin(url)).toThrow();
		}
		expect(serverOrigin("http://127.0.0.1:3000/")).toBe(
			"http://127.0.0.1:3000",
		);
		expect(serverOrigin("http://[::1]:3000")).toBe("http://[::1]:3000");
	});
	test("keeps broker origin and storage stable; supports isolated QA configuration", () => {
		const env = {
			LINA_DESKTOP_SERVER_URL: "http://127.0.0.1:18140",
			LINA_HOME: resolve("packages/lina-desktop/.qa/home"),
		};
		const a = desktopConfig(env);
		expect(a).toEqual(desktopConfig(env));
		expect(a.brokerPort).toBe(43127);
		expect(a.userData).toBe(resolve("packages/lina-desktop/.qa/home/desktop"));
		const b = desktopConfig({
			...env,
			LINA_DESKTOP_PORT: "18141",
			LINA_DESKTOP_USER_DATA: resolve("packages/lina-desktop/.qa/isolated"),
		});
		expect(b.brokerPort).toBe(18141);
		expect(b.sessionData).toBe(
			resolve("packages/lina-desktop/.qa/isolated/sessions"),
		);
		for (const port of ["0", "-1", "65536", "1.2", " 18141", "18140"])
			expect(() =>
				desktopConfig({ ...env, LINA_DESKTOP_PORT: port }),
			).toThrow();
	});
	test("external links require exact HTTPS allowlisted origins", () => {
		const allow = ["https://github.com"];
		expect(externalUrl("https://github.com/electron/electron", allow)).toBe(
			"https://github.com/electron/electron",
		);
		for (const url of [
			"https://github.com.evil/",
			"https://github.com:444/",
			"https://user@github.com/",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"https://127.0.0.1/",
			"http://github.com/",
			"https://github.com/\nfoo",
		])
			expect(() => externalUrl(url, allow)).toThrow();
	});
	test("Codex links allow only a canonical existing thread id", () => {
		const good = "codex://threads/019b1234-5678-7000-abcd-0123456789ab";
		expect(externalUrl(good, [])).toBe(good);
		expect(externalUrl("codex://threads/native_task-1", [])).toBe(
			"codex://threads/native_task-1",
		);
		for (const url of [
			"codex://commands/run",
			"codex://threads",
			"codex://threads/",
			"codex://threads/a/../b",
			"codex://threads/%2e%2e",
			"codex://threads/a%2fb",
			"codex://threads/a?x=1",
			"codex://threads/a#x",
			"codex://user@threads/a",
			"codex://threads:80/a",
			"codex://threads/a/",
			"codex://threads/a\\b",
			"codex://threads/..",
			"codex://threads/" + "a".repeat(129),
			"other://threads/a",
		])
			expect(() => externalUrl(url, [])).toThrow();
	});
});
