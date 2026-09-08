import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startCodexFleet } from "../src/fleet/codex-fleet.ts";
import * as sessionApp from "../src/session-app.ts";
import { createImageAppFixture } from "./image-app-fixture.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

test.each([false, true])(
	"Fleet passes the existing ima2 configuration to the session (override: %s)",
	async (override) => {
		const root = mkdtempSync(join(tmpdir(), "lina-image-fleet-options-"));
		const app = await startCodexFleet({
			workspace: resolve(import.meta.dir, "../../.."),
			stateRoot: join(root, "state"),
			homeDir: root,
			port: 0,
			env: override
				? {
						LINA_IMA2_URL: "http://127.0.0.1:43210",
						LINA_IMA2_SERVER_FILE: join(root, "selected-ima2.json"),
					}
				: {},
		});
		const status = app.hub.status();
		const connection = spyOn(app.hub, "isolatedHomeConnection").mockReturnValue(
			{
				origin: "http://127.0.0.1:43211",
				baseUrl: "http://127.0.0.1:43211/v1",
				catalogJson: null,
				catalogSource: "missing",
				requiresAdmissionToken: false,
				tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
				providerTable:
					'[model_providers.opencodex]\nname = "Synthetic"\nbase_url = "http://127.0.0.1:43211/v1"\nwire_api = "responses"',
			},
		);
		const connected = spyOn(app.hub, "status").mockReturnValue({
			...status,
			connected: true,
		});
		let captured: sessionApp.AppOptions | undefined;
		const start = spyOn(sessionApp, "startPersistentApp").mockImplementation(
			async (options) => {
				captured = options;
				throw Error("captured image session options");
			},
		);
		try {
			app.fleet.modelSettings.replace(0, {
				profiles: [
					{
						id: "synthetic",
						provider: "opencodex",
						model: "synthetic-driver",
						reasoning: "off",
					},
				],
				defaultProfileId: "synthetic",
				roles: {},
				agentRoles: {},
			});
			await expect(app.fleet.app("lina")).rejects.toThrow(
				"captured image session options",
			);
			expect(captured?.imageEngine).toEqual(
				override
					? {
							baseUrl: "http://127.0.0.1:43210",
							serverFile: join(root, "selected-ima2.json"),
						}
					: { serverFile: join(root, ".ima2", "server.json") },
			);
		} finally {
			start.mockRestore();
			connected.mockRestore();
			connection.mockRestore();
			await app.stop();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test("an explicitly disabled image adapter has no image storage or provider activity across restart", async () => {
	const fixture = await createImageAppFixture({ imageEngine: false });
	cleanup.push(() => fixture.close());
	for (let start = 0; start < 2; start++) {
		expect(fixture.app.images).toBeUndefined();
		expect(
			existsSync(join(dirname(fixture.app.binding.sessionFile), "images")),
		).toBe(false);
		expect(fixture.ima2.requests).toEqual([]);
		if (start === 0) await fixture.restart();
	}
});

test("an idle image adapter stays disconnected and shutdown prevents new work", async () => {
	const fixture = await createImageAppFixture();
	cleanup.push(() => fixture.close());
	const jobs = fixture.app.images;
	if (!jobs) throw Error("Image adapter missing");
	await jobs.recover();
	expect(jobs.list()).toEqual([]);
	expect(fixture.ima2.requests).toEqual([]);
	await fixture.app.stop();
	await expect(
		jobs.start({
			requestId: "closed-request",
			callId: "closed-call",
			provider: "api",
			model: "image-model",
			prompt: "generate",
			sourceArtifactId: null,
		}),
	).rejects.toThrow();
	expect(fixture.ima2.requests).toEqual([]);
});
