import { expect, test } from "bun:test";
import {
	downloadUrl,
	notificationInput,
	rendererRequest,
	windowUrl,
} from "../src/window-policy.ts";

const origin = "http://127.0.0.1:18141";
test("renderer cannot reach another loopback port or navigate into API content", () => {
	expect(windowUrl(`${origin}/?agent=lina`, origin)).toBe(true);
	for (const url of [
		"http://127.0.0.1:18140/",
		`${origin}/api/agents`,
		"file:///etc/passwd",
		`${origin}.evil/`,
	])
		expect(windowUrl(url, origin)).toBe(false);
	expect(rendererRequest(`${origin}/api/agents`, origin)).toBe(true);
	expect(rendererRequest("ws://127.0.0.1:18141/ws?agent=lina", origin)).toBe(
		true,
	);
	for (const url of [
		"ws://127.0.0.1:18140/ws",
		"https://example.com/",
		"http://localhost:18141/",
		"ws://127.0.0.1:18141/api/agents",
	])
		expect(rendererRequest(url, origin)).toBe(false);
});
test("downloads remain scoped attachment URLs; notifications have bounded plain text", () => {
	const id = "01234567-89ab-4cde-8fab-0123456789ab";
	expect(
		downloadUrl(`${origin}/api/attachments/${id}?sessionId=${id}`, origin),
	).toBe(true);
	for (const url of [
		`${origin}/api/agents`,
		`${origin}/api/attachments/${id}`,
		"file:///etc/passwd",
	])
		expect(downloadUrl(url, origin)).toBe(false);
	expect(notificationInput({ title: "Lina", body: "작업 완료" })).toEqual({
		title: "Lina",
		body: "작업 완료",
	});
	for (const value of [
		null,
		{ title: "", body: "x" },
		{ title: "x", body: "x", icon: "/etc/passwd" },
		{ title: "x", body: "x".repeat(501) },
	])
		expect(() => notificationInput(value)).toThrow();
});
