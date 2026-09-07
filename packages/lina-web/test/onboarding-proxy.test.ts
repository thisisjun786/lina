import { expect, test } from "bun:test";
import { startWebServer } from "../src/server.ts";

test("onboarding proxy permits bounded exact paths only with same-origin mutation", async () => {
	const seen: string[] = [];
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			seen.push(new URL(request.url).pathname);
			return Response.json({ ok: true });
		},
	});
	const web = startWebServer({
		port: 0,
		upstream: `ws://127.0.0.1:${upstream.port}`,
		assets: { html: "ok", script: "", css: "", icon: "" },
	});
	const base = `http://127.0.0.1:${web.port}`;
	const timeouts: number[] = [];
	const timeout = web.timeout.bind(web);
	web.timeout = (request, seconds) => {
		timeouts.push(seconds);
		timeout(request, seconds);
	};
	try {
		for (const path of [
			"/api/onboarding/user",
			"/api/onboarding/drafts",
			"/api/onboarding/drafts/12345678-1234-1234-1234-123456789abc/answer",
			"/api/onboarding/interview",
			"/api/onboarding/preview",
			"/api/onboarding/entry",
			"/api/onboarding/rooms/12345678-1234-1234-1234-123456789abc",
			"/api/agents/birth",
			"/api/agents/lina/intro",
			"/api/agents/lina/intro/turn",
			"/api/agents/lina/intro/finish",
			"/api/agents/lina/intro/choose",
			"/api/agents/lina/intro/mode",
			"/api/agents/lina/intro/restart",
		]) {
			expect(
				(
					await fetch(base + path, {
						method: "POST",
						headers: { Origin: base },
						body: "{}",
					})
				).status,
			).toBe(200);
			expect(
				(
					await fetch(base + path, {
						method: "POST",
						headers: { Origin: "https://attacker.example" },
						body: "{}",
					})
				).status,
			).toBe(403);
		}
		expect(seen).toHaveLength(14);
		expect(timeouts.filter((seconds) => seconds === 75)).toHaveLength(10);
		expect(
			(
				await fetch(base + "/api/onboarding/secrets", {
					method: "POST",
					headers: { Origin: base },
					body: "{}",
				})
			).status,
		).not.toBe(200);
		expect(seen).toHaveLength(14);
	} finally {
		await web.stop(true);
		await upstream.stop(true);
	}
});
