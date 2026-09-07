import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

test("compiled sandbox preload exposes only marker and named OS capabilities", async () => {
	const output = await Bun.build({
		entrypoints: [fileURLToPath(new URL("../src/preload.ts", import.meta.url))],
		target: "node",
		format: "cjs",
		external: ["electron"],
	});
	expect(output.success).toBe(true);
	let exposed: Record<string, unknown> = {};
	const calls: unknown[][] = [];
	runInNewContext((await output.outputs[0]?.text()) ?? "", {
		require(name: string) {
			expect(name).toBe("electron");
			return {
				contextBridge: {
					exposeInMainWorld(name: string, value: Record<string, unknown>) {
						expect(name).toBe("linaDesktop");
						exposed = value;
					},
				},
				ipcRenderer: {
					invoke(...args: unknown[]) {
						calls.push(args);
						return Promise.resolve();
					},
				},
			};
		},
	});
	expect(Object.keys(exposed).sort()).toEqual([
		"notify",
		"openExternal",
		"platform",
	]);
	expect(exposed["platform"]).toBe("desktop");
	expect(Object.isFrozen(exposed)).toBe(true);
	// VM exports are untyped; assert the public functions before invoking them.
	const open = exposed["openExternal"],
		notify = exposed["notify"];
	if (typeof open !== "function" || typeof notify !== "function")
		throw Error("Missing OS methods");
	await open("https://github.com/");
	await notify({ title: "Lina", body: "Done" });
	expect(calls).toEqual([
		["lina:open-external", "https://github.com/"],
		["lina:notify", { title: "Lina", body: "Done" }],
	]);
});

test("main IPC rejects another window and same-origin child frames before OS access", async () => {
	const output = await Bun.build({
		entrypoints: [fileURLToPath(new URL("../src/window.ts", import.meta.url))],
		target: "node",
		format: "cjs",
		external: ["electron"],
	});
	expect(output.success).toBe(true);
	const handlers = new Map<
		string,
		(event: unknown, input: unknown) => Promise<unknown>
	>();
	const opened: string[] = [];
	let failOpen = false;
	const dialogs: unknown[] = [];
	const exports: Record<string, unknown> = {};
	const module = { exports };
	runInNewContext((await output.outputs[0]?.text()) ?? "", {
		module,
		exports,
		URL,
		require(name: string) {
			if (name === "node:path")
				return {
					basename: (s: string) => s,
					join: (...s: string[]) => s.join("/"),
				};
			if (name !== "electron") throw Error(`Unexpected runtime import ${name}`);
			return {
				ipcMain: {
					handle: (
						name: string,
						action: (event: unknown, input: unknown) => Promise<unknown>,
					) => handlers.set(name, action),
				},
				dialog: {
					showMessageBox: async (_window: unknown, options: unknown) => {
						dialogs.push(options);
					},
				},
				shell: {
					openExternal: async (url: string) => {
						if (failOpen) throw Error("No OS handler");
						opened.push(url);
					},
				},
			};
		},
	});
	const install = module.exports["installOsHandlers"];
	if (typeof install !== "function") throw Error("Missing IPC registration");
	const mainFrame = { url: "http://127.0.0.1:18141/" };
	const contents = { mainFrame };
	install(
		() => ({ isDestroyed: () => false, webContents: contents }),
		"http://127.0.0.1:18141",
		["https://github.com"],
	);
	const open = handlers.get("lina:open-external");
	if (!open) throw Error("Missing handler");
	for (const event of [
		{ sender: {}, senderFrame: mainFrame },
		{ sender: contents, senderFrame: { ...mainFrame } },
		{ sender: contents, senderFrame: null },
	])
		await expect(open(event, "https://github.com/")).rejects.toThrow();
	await expect(
		open({ sender: contents, senderFrame: mainFrame }, "file:///etc/passwd"),
	).rejects.toThrow();
	expect(opened).toEqual([]);
	await open(
		{ sender: contents, senderFrame: mainFrame },
		"https://github.com/electron",
	);
	expect(opened).toEqual(["https://github.com/electron"]);
	await open(
		{ sender: contents, senderFrame: mainFrame },
		"codex://threads/native_1",
	);
	expect(opened).toEqual([
		"https://github.com/electron",
		"codex://threads/native_1",
	]);
	failOpen = true;
	await expect(
		open(
			{ sender: contents, senderFrame: mainFrame },
			"codex://threads/native_1",
		),
	).rejects.toThrow();
	expect(dialogs.at(-1)).toMatchObject({
		type: "error",
		message: "연결된 앱에서 링크를 열지 못했습니다.",
	});
});
