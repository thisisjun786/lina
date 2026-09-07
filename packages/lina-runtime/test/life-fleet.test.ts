import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost } from "../../lina-codex/src/host.ts";
import { startCodexFleet } from "../src/fleet/codex-fleet.ts";
import { startPersistentApp } from "../src/session-app.ts";
import { testSessionEngine } from "./fake-session-engine.ts";
import { worldServices } from "./world-fixture.ts";

test("Codex fleet passes grant-native inputs to the trusted factory and leaves ordinary registrations without author tools", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-life-fleet-"));
	let providerCalls = 0;
	const hub = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/v1/models")
				return Response.json({
					object: "list",
					data: [
						{
							id: "synthetic-guide",
							api_types: ["responses"],
							capabilities: {
								context_length: 32000,
								max_output_tokens: 2048,
								input_modalities: ["text"],
							},
						},
					],
				});
			if (url.pathname === "/v1/catalog")
				return Response.json({
					models: [{ slug: "synthetic-guide", context_window: 32000 }],
				});
			providerCalls++;
			return Response.json(
				{ error: "No provider calls authorized" },
				{ status: 500 },
			);
		},
	});
	mkdirSync(join(root, ".opencodex"));
	writeFileSync(
		join(root, ".opencodex", "config.json"),
		JSON.stringify({
			unauthenticatedLoopbackListener: { enabled: true, port: hub.port },
		}),
	);
	const ordinaryTools: string[] = [];
	let factoryCalls = 0;
	const app = await startCodexFleet({
		workspace: process.cwd(),
		stateRoot: join(root, "state"),
		homeDir: root,
		env: { LINA_MEMORY_BACKEND: "disabled" },
		port: 0,
		createApp: (options) => {
			const engine = testSessionEngine();
			const create = engine.create;
			engine.create = async (sdk) => {
				const host = new CodexHost(sdk.workspace, () => ({ action: "allow" }));
				sdk.register?.(host.asLinaHost(), worldServices(), host.permissions);
				ordinaryTools.push(...host.tools.keys());
				return create(sdk);
			};
			return startPersistentApp({ ...options, engine });
		},
		createWorldAuthorEngine: async (input) => {
			factoryCalls++;
			expect(input.nativeRoot).toBe(
				join(root, "state", "life", "author-sessions", input.grantId, "native"),
			);
			expect(input.agentId).toBe("lina");
			expect(input.worldId).toBe("test-world");
			expect(input.selected.model).toBe("synthetic-guide");
			expect(input.currentSelection()).toEqual({
				selected: input.selected,
				connection: input.connection,
			});
			expect(input.connection.catalogJson).toContain("synthetic-guide");
			const workspace = join(input.nativeRoot, "workspace");
			mkdirSync(workspace, { recursive: true });
			return {
				workspace,
				engine: testSessionEngine(),
				capabilityPolicyDigest: "b".repeat(64),
			};
		},
	});
	try {
		app.fleet.modelSettings.replace(0, {
			profiles: [
				{
					id: "guide",
					provider: "opencodex",
					model: "synthetic-guide",
					reasoning: "off",
				},
			],
			defaultProfileId: null,
			roles: {},
			agentRoles: { lina: { conversation: "guide" } },
		});
		app.fleet.life.create({
			worldId: "test-world",
			authoredText: "Author source",
		});
		const grant = app.fleet.grantWorldAuthor("test-world", "lina");
		const author = await app.fleet.openWorldAuthor(grant.id);
		expect(author.grant.id).toBe(grant.id);
		expect(factoryCalls).toBe(1);
		const ordinary = await app.fleet.app("lina");
		expect(ordinary.binding.sessionId).not.toBe(author.binding.sessionId);
		expect(ordinaryTools.length).toBeGreaterThan(0);
		expect(
			ordinaryTools.some(
				(name) =>
					name.startsWith("lina_world_draft_") ||
					name.startsWith("lina_life_config_"),
			),
		).toBe(false);
		expect(providerCalls).toBe(0);
	} finally {
		await app.stop();
		await hub.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
});
