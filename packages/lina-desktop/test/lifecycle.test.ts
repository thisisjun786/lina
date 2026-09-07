import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

test("a cancelled window close keeps the broker alive; accepted quit closes it once", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-quit-test-"));
	const handlers = new Map<
		string,
		(event: { preventDefault(): void }) => void
	>();
	let closed = 0,
		flushed = 0,
		quit = 0;
	const ready = Promise.withResolvers<void>();
	const ended = Promise.withResolvers<void>();
	const app = {
		setName() {},
		enableSandbox() {},
		setPath() {},
		requestSingleInstanceLock: () => true,
		whenReady: async () => {},
		on: (name: string, handler: (event: { preventDefault(): void }) => void) =>
			handlers.set(name, handler),
		quit() {
			quit++;
			ended.resolve();
		},
		exit: (code: number) => ready.reject(new Error(`Startup failed: ${code}`)),
	};
	const fake = {
		app,
		Menu: {
			buildFromTemplate: (value: unknown) => value,
			setApplicationMenu() {},
		},
		dialog: {
			showErrorBox: (_title: string, message: string) =>
				ready.reject(new Error(message)),
		},
		session: {
			fromPartition: () => ({
				cookies: { set: async () => {} },
				flushStorageData() {
					flushed++;
				},
			}),
		},
	};
	const stubs: Record<string, string> = {
		"broker.ts":
			"export async function startBroker(){return {origin:'http://127.0.0.1:43127',close:globalThis.closeBroker}}",
		"bundled-assets.ts": "export async function loadBundle(){return new Map()}",
		"session.ts":
			"export async function bindProfile(){};export function createBrokerSession(){return {cookie(){return {}}}}",
		"window.ts":
			"export async function prepareSession(){};export function installOsHandlers(){};export function createWindow(){globalThis.windowReady();return {}}",
	};
	try {
		const built = await Bun.build({
			entrypoints: [new URL("../src/main.ts", import.meta.url).pathname],
			target: "node",
			format: "cjs",
			external: ["electron"],
			plugins: [
				{
					name: "lifecycle-boundaries",
					setup(builder) {
						builder.onLoad(
							{ filter: /\/(broker|bundled-assets|session|window)\.ts$/ },
							({ path }) => ({
								contents: stubs[path.split("/").at(-1) ?? ""] ?? "",
								loader: "js",
							}),
						);
					},
				},
			],
		});
		expect(built.success).toBe(true);
		const require = createRequire(import.meta.url);
		runInNewContext((await built.outputs[0]?.text()) ?? "", {
			require: (id: string) => (id === "electron" ? fake : require(id)),
			module: { exports: {} },
			exports: {},
			__dirname: root,
			URL,
			process: {
				platform: "linux",
				env: {
					LINA_DESKTOP_SERVER_URL: "http://127.0.0.1:18140",
					LINA_DESKTOP_USER_DATA: root,
				},
			},
			windowReady: () => ready.resolve(),
			closeBroker: async () => {
				closed++;
			},
		});
		await ready.promise;
		// Electron emits before-quit before asking windows to close. A renderer
		// may veto there; will-quit is only emitted after all windows have closed.
		handlers.get("before-quit")?.({ preventDefault() {} });
		expect(closed).toBe(0);
		expect(flushed).toBe(0);
		handlers.get("will-quit")?.({ preventDefault() {} });
		await ended.promise;
		expect(closed).toBe(1);
		expect(flushed).toBe(1);
		expect(quit).toBe(1);
		handlers.get("will-quit")?.({ preventDefault() {} });
		expect(closed).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
