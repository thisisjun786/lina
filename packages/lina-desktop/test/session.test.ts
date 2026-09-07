import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopConfig } from "../src/config.ts";
import { bindProfile, createBrokerSession } from "../src/session.ts";

test("session secret stays in main and is installed as a host-only HttpOnly strict cookie", async () => {
	const first = createBrokerSession(),
		second = createBrokerSession();
	expect(first.authorizes(undefined)).toBe(false);
	expect(first.authorizes("lina_desktop=incorrect")).toBe(false);
	const cookie = first.cookie("http://127.0.0.1:18141");
	expect(cookie).toMatchObject({
		url: "http://127.0.0.1:18141",
		name: "lina_desktop",
		httpOnly: true,
		sameSite: "strict",
		path: "/",
	});
	expect(cookie).not.toHaveProperty("domain");
	expect(cookie).not.toHaveProperty("expirationDate");
	expect(cookie.value.length).toBe(64);
	expect(first.authorizes(`lina_desktop=${cookie.value}`)).toBe(true);
	expect(
		first.authorizes(
			`lina_desktop=${cookie.value}; lina_desktop=${cookie.value}`,
		),
	).toBe(false);
	expect(second.authorizes(`lina_desktop=${cookie.value}`)).toBe(false);
});

test("profile restart preserves binding and rejects mixing server/port with old drafts", async () => {
	const qa = fileURLToPath(new URL("../.qa/", import.meta.url));
	await mkdir(qa, { recursive: true });
	const dir = await mkdtemp(resolve(qa, "profile-"));
	const config = desktopConfig({
		LINA_DESKTOP_SERVER_URL: "http://127.0.0.1:18140",
		LINA_DESKTOP_PORT: "18141",
		LINA_DESKTOP_USER_DATA: dir,
	});
	await bindProfile(config);
	const before = await readFile(resolve(dir, "connection.json"), "utf8");
	await bindProfile(config);
	expect(await readFile(resolve(dir, "connection.json"), "utf8")).toBe(before);
	await expect(
		bindProfile({ ...config, serverOrigin: "http://127.0.0.1:19140" }),
	).rejects.toThrow();
	await expect(bindProfile({ ...config, brokerPort: 19141 })).rejects.toThrow();
});
