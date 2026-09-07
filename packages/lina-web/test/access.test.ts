import { describe, expect, it } from "bun:test";
import { createAccessPolicy } from "../src/access.ts";

describe("web access policy", () => {
	it("accepts matching loopback authorities when a browser forwards another port", () => {
		const policy = createAccessPolicy();
		for (const host of [
			"localhost:60875",
			"127.0.0.1:60875",
			"[::1]:60875",
			"localhost",
		]) {
			expect(policy.allowsHost(host)).toBe(true);
			expect(policy.allowsSocket(host, `http://${host}`)).toBe(true);
		}
		expect(
			policy.allowsSocket("localhost:7980", "http://localhost:60875"),
		).toBe(false);
	});
	it("rejects untrusted authorities when a caller supplies misleading host text", () => {
		const policy = createAccessPolicy();
		for (const host of [
			null,
			"",
			"evil.example",
			"localhost.evil",
			"localhost:7980@evil.example",
			"localhost:7980/path",
			"localhost:65536",
			"localhost:7980 ",
		])
			expect(policy.allowsHost(host)).toBe(false);
		for (const origin of [
			null,
			"null",
			"https://evil.example",
			"http://localhost:1",
		])
			expect(policy.allowsSocket("localhost:7980", origin)).toBe(false);
	});
	it("accepts only the configured external origin when the proxy preserves or rewrites Host", () => {
		const origin = "https://lina.example.test:7980";
		const policy = createAccessPolicy(origin);
		for (const host of ["lina.example.test:7980", "127.0.0.1:7980"]) {
			expect(policy.allowsHost(host)).toBe(true);
			expect(policy.allowsSocket(host, origin)).toBe(true);
			expect(policy.allowsSocket(host, "https://evil.example")).toBe(false);
		}
		expect(
			policy.allowsSocket(
				"lina.example.test:7980",
				"http://lina.example.test:7980",
			),
		).toBe(false);
		expect(policy.allowsSocket("lina.example.test:7980", `${origin}/`)).toBe(
			false,
		);
		expect(policy.allowsHost("lina.example.test.evil:7980")).toBe(false);
	});
	it("normalizes a default HTTPS port when the proxy includes it in Host", () => {
		const policy = createAccessPolicy("https://lina.example.test:443/");
		expect(
			policy.allowsSocket("lina.example.test:443", "https://lina.example.test"),
		).toBe(true);
	});
	it("fails startup when the configured public origin contains non-origin components", () => {
		for (const origin of [
			"not-url",
			"ftp://lina.example.test",
			"https://user:secret@lina.example.test",
			"https://lina.example.test/path",
			"https://lina.example.test?key=x",
			"https://lina.example.test#x",
		])
			expect(() => createAccessPolicy(origin)).toThrow();
	});
});
