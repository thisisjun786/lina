import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSourceProofs } from "../../../lina-core/src/source-policy.ts";
import { generationOwner } from "../../../lina-memory/src/honcho/qualification.ts";
import type {
	HonchoConfig,
	QualifiedHonchoAdapter,
} from "../../../lina-memory/src/honcho/types.ts";
import type { HonchoHttpFixture } from "../../../lina-memory/test/honcho-http-fixture.ts";
import { namespace } from "../../../lina-memory/test/honcho-v1-fixture.ts";
import { AgentFleet } from "../../src/fleet/manager.ts";
import { startFleetServer } from "../../src/fleet/server.ts";
import type { AppOptions } from "../../src/session-app.ts";
import { qualifyRequest } from "../context-honcho-fixture.ts";
import { startTestApp } from "../fake-session-engine.ts";

type FleetOptions = ConstructorParameters<typeof AgentFleet>[0];
export function selectedConfig(baseUrl: string, botId: string): HonchoConfig {
	return {
		baseUrl,
		workspaceId: "legacy",
		sessionId: "legacy-session",
		userPeerId: "legacy-user",
		observerPeerId: "legacy-observer",
		ordinaryNamespace: {
			...namespace,
			ownerBotId: botId,
			workspaceId: `ordinary-${botId}`,
		},
	};
}
export async function fleetMemoryFixture(
	options: Partial<FleetOptions> & {
		honchoByAgent?: Record<string, HonchoConfig>;
		qualifiedHonchoAdapter?: QualifiedHonchoAdapter;
	} = {},
	http?: HonchoHttpFixture,
) {
	const root =
		options.stateRoot ?? mkdtempSync(join(tmpdir(), "fleet-work-memory-"));
	const received = new Map<string, Omit<AppOptions, "engine">>();
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "BASE",
		...options,
		createApp: async (input) => {
			received.set(input.botId ?? "lina", input);
			const app = await startTestApp(input);
			if (
				http &&
				input.honcho?.ordinaryNamespace?.ownerBotId === app.binding.botId
			)
				http.register(generationOwner(app.binding, input.honcho));
			return app;
		},
	});
	const seed = fleet.presets.find((p) => p.id === "kai");
	if (!seed) throw Error("fixture preset missing");
	if (!fleet.agents.get(seed.id)) fleet.agents.create(seed);
	const server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
		lazy: true,
	});
	const call = (path: string, data?: unknown) =>
		fetch(`http://127.0.0.1:${server.port}${path}`, {
			method: data === undefined ? "GET" : "POST",
			...(data === undefined ? {} : { body: JSON.stringify(data) }),
			headers: { "Content-Type": "application/json" },
		});
	return {
		root,
		fleet,
		received,
		call,
		async close() {
			await server.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function ordinaryEpisode(
	app: Awaited<ReturnType<typeof startTestApp>>,
	id: string,
	text = "tea",
) {
	const journal = app.runtime.store;
	const userId = `${id}-user`,
		assistantId = `${id}-assistant`;
	for (const [entryId, role] of [
		[userId, "user"],
		[assistantId, "assistant"],
	] as const)
		journal.appendEntry({
			entryId,
			role,
			text,
			timestamp: "2026-09-08T00:00:00Z",
			raw: {},
		});
	journal.createRequest(id, text);
	journal.setRequest(id, "accepted", { entryId: userId });
	qualifyRequest(journal, app.binding, id, [userId, assistantId]);
	journal.setRequest(id, "settled");
	const lookup = (entryId: string) => journal.sourceEntry(entryId);
	return {
		sourceProofs: captureSourceProofs([userId, assistantId], lookup),
		lookup,
	};
}

export function revokeEpisode(
	app: Awaited<ReturnType<typeof startTestApp>>,
	id: string,
) {
	app.runtime.store.recordSourceExposure({
		type: "context_exposure",
		version: 1,
		id: `revoke-${id}`,
		nativeEpoch: 1,
		scopeDigest: "a".repeat(64),
		source: {
			kind: "tool",
			requestId: id,
			toolName: "world_read",
			callId: `call-${id}`,
		},
		materials: [{ kind: "disclosed-life", sourceId: "life-event" }],
		outcome: "planned",
	});
	app.runtime.store.extendRequestSource(id, [`revoke-${id}`]);
}
