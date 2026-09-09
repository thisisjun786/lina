import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSourceProofs } from "../../../lina-core/src/source-policy.ts";
import { AgentFleet } from "../../src/fleet/manager.ts";
import { startFleetServer } from "../../src/fleet/server.ts";
import type { AppOptions } from "../../src/session-app.ts";
import { startTestApp } from "../fake-session-engine.ts";

type FleetOptions = ConstructorParameters<typeof AgentFleet>[0];
export async function fleetMemoryFixture(options: Partial<FleetOptions> = {}) {
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
			return startTestApp(input);
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
	journal.registerRequestSource({
		version: 1,
		purpose: "conversation",
		sessionId: app.binding.sessionId,
		requestId: id,
		nativeEpoch: 1,
		scopeDigest: "a".repeat(64),
		contextReceiptIds: [],
	});
	for (const entryId of [userId, assistantId]) {
		const entry = journal.entry(entryId);
		if (!entry) throw Error(`missing fixture entry ${entryId}`);
		journal.appendSourceEntry(entry, id);
	}
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
