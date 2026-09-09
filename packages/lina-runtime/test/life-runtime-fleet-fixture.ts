import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexLifeModelOptions } from "../../lina-codex/src/life-model-policy.ts";
import { lifeMetadata } from "../../lina-codex/test/life-model-fixture.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import {
	autonomyPack,
	emptyReflection,
} from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import { socialIntent } from "../../lina-core/test/life-social-pack-fixture.ts";
import { activateSocialPack } from "../../lina-core/test/life-social-store-fixture.ts";
import {
	type CodexFleetOptions,
	startCodexFleet,
} from "../src/fleet/codex-fleet.ts";
import { startPersistentApp } from "../src/session-app.ts";
import { testSessionEngine } from "./fake-session-engine.ts";
import {
	RuntimeClock,
	RuntimeModel,
	runtimeConfig,
} from "./life-runtime-fixture.ts";

export async function fleetLifeFixture(
	overrides: Pick<
		CodexFleetOptions,
		| "createTaskRpc"
		| "createLifeModel"
		| "createApp"
		| "createImageClient"
		| "enginePolicy"
	> = {},
	respond?: (request: Request) => Response | Promise<Response>,
) {
	const root = mkdtempSync(join(tmpdir(), "lina-life-composition-"));
	const clock = new RuntimeClock();
	let providerCalls = 0;
	const hub = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/v1/models")
				return Response.json({
					object: "list",
					data: [
						{
							id: "route/director",
							api_types: ["responses"],
							capabilities: {
								context_length: 100000,
								input_modalities: ["text"],
							},
						},
						{
							id: "route/actor",
							api_types: ["responses"],
							capabilities: {
								context_length: 100000,
								input_modalities: ["text"],
							},
						},
					],
				});
			if (path === "/v1/catalog")
				return Response.json({
					models: ["route/director", "route/actor"].map((slug) => ({
						...lifeMetadata,
						slug,
						context_window: 100000,
					})),
				});
			providerCalls++;
			return (
				respond?.(request) ??
				new Response("Unexpected provider call", { status: 500 })
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
	const models: RuntimeModel[] = [];
	const selections: CodexLifeModelOptions[] = [];
	const engine = testSessionEngine();
	const options = {
		workspace: process.cwd(),
		stateRoot: join(root, "state"),
		homeDir: root,
		env: { LINA_MEMORY_BACKEND: "disabled" },
		port: 0,
		lifeClock: clock,
		createApp: (
			input: Omit<Parameters<typeof startPersistentApp>[0], "engine">,
		) => startPersistentApp({ ...input, engine }),
		createLifeModel(input: CodexLifeModelOptions) {
			const model = new RuntimeModel();
			model.text = (request) =>
				request.lane === "director"
					? "PRIVATE_FLEET_DIRECTOR"
					: request.lane === "actor"
						? JSON.stringify(socialIntent())
						: request.lane === "target"
							? JSON.stringify({
									intentId: "intent-1",
									agentId: "mira",
									decision: "accept",
								})
							: JSON.stringify(emptyReflection());
			const prepare = model.prepare.bind(model);
			model.prepare = (request, signal) => {
				input.selection(request);
				return prepare(request, signal);
			};
			models.push(model);
			selections.push(input);
			return model;
		},
		...overrides,
	};
	let app = await startCodexFleet(options);
	const setup = (
		quiet = true,
		automatic = false,
		configure?: (pack: ReturnType<typeof autonomyPack>) => void,
	) => {
		const seed = app.fleet.agents.get("lina");
		if (!seed) throw Error("Missing seed");
		const { revision: _seedRevision, ...profileInput } = seed;
		for (const id of ["mira", "sol"])
			if (!app.fleet.agents.get(id))
				app.fleet.agents.create({ ...profileInput, id });
		app.fleet.modelSettings.replace(0, {
			profiles: ["director", "actor"].map((id) => ({
				id,
				provider: "opencodex",
				model: `route/${id}`,
				reasoning: "off" as const,
			})),
			defaultProfileId: null,
			roles: {},
			agentRoles: {},
		});
		const pack = autonomyPack();
		pack.roles = pack.roles.map((role) => ({
			...role,
			roleId: role.agentId === "lina" ? "initiator" : "resident",
		}));
		for (const family of pack.eventFamilies)
			family.actorRoleIds = ["initiator"];
		for (const capability of pack.social.capabilities)
			capability.actorRoleIds = ["initiator"];
		if (quiet) {
			pack.autonomy.events = [];
			pack.autonomy.quietWeight = 1;
		}
		configure?.(pack);
		const store = app.fleet.life.store;
		if (!(store instanceof WorldStore))
			throw Error("Missing owned world store");
		activateSocialPack(store, pack);
		const { worldId, revision: _revision, ...config } = runtimeConfig();
		config.models = {
			director: { provider: "opencodex", model: "route/director" },
			actor: { provider: "opencodex", model: "route/actor" },
		};
		config.run = { mode: automatic ? "automatic" : "manual" };
		app.fleet.life.setConfig(worldId, 0, config);
		return { pack, config };
	};
	return {
		root,
		clock,
		models,
		selections,
		engine,
		setup,
		get app() {
			return app;
		},
		get providerCalls() {
			return providerCalls;
		},
		async restart() {
			await app.stop();
			// Model a cold process, including finalization of closed SQLite handles.
			Bun.gc(true);
			app = await startCodexFleet(options);
		},
		async close() {
			await app.stop();
			await hub.stop(true);
			rmSync(root, { recursive: true, force: true });
		},
	};
}
