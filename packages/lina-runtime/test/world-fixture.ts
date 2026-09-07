import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost } from "../../lina-codex/src/host.ts";
import {
	type WorldActivityProposal,
	type WorldContextLimits,
	WorldStore,
} from "../../lina-core/src/world/index.ts";
import type { ContextServices } from "../src/context/port.ts";
import { createSessionContextPolicy } from "../src/context-policy.ts";
import type { LinaHost } from "../src/host.ts";
import { installWorldContext } from "../src/world.ts";

export const limits: WorldContextLimits = {
	maxChars: 12000,
	maxFacts: 20,
	maxEvents: 10,
};

/** Synthetic trusted LIFE scope; production composition belongs to its runtime owner. */
export function worldAccess(agentId: string, worldId = "island") {
	const policy = createSessionContextPolicy({
		version: 1,
		purpose: "life",
		agentId,
		worldId,
		bindingRevision: 0,
		disclosureRevision: 1,
		sourcePolicyVersion: 1,
	});
	return {
		purpose: "life" as const,
		currentContextPolicy: () => policy,
		lifeLimits: { maxChars: 12000, maxRecords: 30 },
	};
}

export function installTestWorldContext(
	host: LinaHost,
	options: {
		store: WorldStore;
		worldId: string;
		agentId: string;
		limits: WorldContextLimits;
	},
): void {
	installWorldContext(host, {
		...worldAccess(options.agentId, options.worldId),
		...options,
	});
}

export function worldFixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-world-context-"));
	const path = join(root, "world.sqlite");
	const store = new WorldStore(path, () => 1000);
	store.create({
		id: "island",
		version: 1,
		title: "An imaginary island",
		timeUnit: "day",
		initialTime: 0,
		agents: ["mina", "rumi"],
		places: [{ id: "port", name: "Harbor", description: "A quiet harbor" }],
		scenes: [
			{
				id: "dock",
				placeId: "port",
				description: "Morning on the dock",
				occupants: ["mina", "rumi"],
			},
		],
		lore: [
			{
				id: "bell",
				text: "The harbor bell rings at dawn",
				knownTo: ["mina", "rumi"],
			},
			{ id: "secret", text: "Mina hides a blue key", knownTo: ["mina"] },
		],
	});
	return {
		root,
		path,
		store,
		host: () => new CodexHost(root, () => ({ action: "allow" })),
		close() {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function activity(
	overrides: Partial<WorldActivityProposal> = {},
): WorldActivityProposal {
	return {
		worldId: "island",
		idempotencyKey: "boat-arrival",
		expectedRevision: 0,
		simulationTime: 1,
		kind: "activity",
		sceneId: "dock",
		actorIds: ["mina", "rumi"],
		audience: ["mina", "rumi"],
		summary: "A red boat arrives",
		facts: [{ id: "boat", text: "The boat is red", knownTo: ["mina", "rumi"] }],
		moves: [],
		...overrides,
	};
}

export function worldServices(): ContextServices {
	return {
		estimateText: (text) => text.length,
		estimateMessages: (messages) => messages.length,
		systemTokens: 0,
		contextWindow: 96000,
		reserveTokens: 1000,
		summarize: async () => {
			throw Error("Unexpected model call");
		},
		prepare: () => {
			throw Error("Unexpected native preparation");
		},
	};
}
