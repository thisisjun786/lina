import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { activateSocialPack } from "../../lina-core/test/life-social-store-fixture.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import { authorPack } from "./life-authoring-fixture.ts";

export const selection = {
	version: 2,
	worldId: "test-world",
	projectionPolicyRevision: 1,
	conversationRecipientId: "explicit-recipient",
} as const;

export async function bindingFixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-life-binding-"));
	let ownsInstallation = true;
	let sessionCalls = 0;
	const open = () =>
		new AgentFleet({
			workspace: process.cwd(),
			stateRoot: root,
			agentDir: join(root, "auth"),
			systemPrompt: "unused",
			ownsInstallation: () => ownsInstallation,
			createApp: async () => {
				sessionCalls++;
				throw Error("No session/provider may start");
			},
		});
	let fleet = open();
	let server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
		lazy: true,
	});
	const store = () => {
		const current = fleet.life.store;
		if (!(current instanceof WorldStore)) throw Error("Missing world store");
		return current;
	};
	activateSocialPack(store(), authorPack());
	return {
		root,
		store,
		get fleet() {
			return fleet;
		},
		get url() {
			return `http://127.0.0.1:${server.port}/api/life/agents/lina/binding`;
		},
		get sessionCalls() {
			return sessionCalls;
		},
		setOwner(value: boolean) {
			ownsInstallation = value;
		},
		async reopen() {
			await server.stop();
			fleet = open();
			server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
				lazy: true,
			});
		},
		async close() {
			await server.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function putBinding(url: string, body: unknown, headers = {}) {
	return fetch(url, {
		method: "PUT",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}
