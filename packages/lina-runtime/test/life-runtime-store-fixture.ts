import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorldPackV3 } from "../../lina-core/src/world/authoring-types.ts";
import type { SocialIntent } from "../../lina-core/src/world/social-types.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import {
	autonomyPack,
	autonomySource,
	emptyReflection,
} from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import { socialIntent } from "../../lina-core/test/life-social-pack-fixture.ts";
import { activateSocialPack } from "../../lina-core/test/life-social-store-fixture.ts";
import { createLifeRunner } from "../src/life/runner.ts";
import { createEnsembleSocialEngine } from "../src/life/social/ensemble.ts";
import {
	RuntimeClock,
	RuntimeForeground,
	RuntimeModel,
	runtimeConfig,
} from "./life-runtime-fixture.ts";

export function revealToSol(pack: WorldPackV3) {
	pack.life.projection.disclosures.push({
		subject: { kind: "world_fact", id: "secret" },
		policy: {
			knowers: ["lina"],
			disclosures: [{ agentId: "lina", recipientId: "sol" }],
			publication: [],
		},
	});
}
export function revealIntent(): SocialIntent {
	return {
		...socialIntent(),
		description: "ACTOR_PRIVATE_DESCRIPTION_CANARY",
		primitives: [
			...socialIntent().primitives,
			{
				kind: "reveal",
				claim: { kind: "world_fact", id: "secret" },
				toAgentId: "sol",
			},
		],
	};
}

export function runtimeStoreFixture(
	quiet = true,
	configure?: (pack: ReturnType<typeof autonomyPack>) => void,
) {
	const root = mkdtempSync(join(tmpdir(), "lina-autonomy-runtime-"));
	const path = join(root, "world.sqlite");
	const clock = new RuntimeClock();
	const store = new WorldStore(path, () => clock.now());
	const pack = autonomyPack();
	pack.roles = pack.roles.map((role) => ({
		...role,
		roleId: role.agentId === "lina" ? "initiator" : "resident",
	}));
	for (const family of pack.eventFamilies) family.actorRoleIds = ["initiator"];
	for (const capability of pack.social.capabilities)
		capability.actorRoleIds = ["initiator"];
	if (quiet) {
		pack.autonomy.quietWeight = 1;
		pack.autonomy.events = [];
	}
	configure?.(pack);
	try {
		activateSocialPack(store, pack);
		const config = runtimeConfig();
		const { worldId: _world, revision: _revision, ...input } = config;
		store.setLifeConfig(pack.worldId, 0, input);
	} catch (error) {
		store.close();
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
	const source = autonomySource();
	source.profiles = source.profiles.map((profile) => ({
		...profile,
		profile: "Synthetic resident profile",
		appearance: "Synthetic resident appearance",
	}));
	const model = new RuntimeModel();
	const foreground = new RuntimeForeground();
	model.text = (request) => {
		if (request.lane === "director") return "ACTOR_PRIVATE_DIRECTOR_CANARY";
		if (request.lane === "actor")
			return JSON.stringify({
				...socialIntent(),
				description: "ACTOR_PRIVATE_DESCRIPTION_CANARY",
			});
		if (request.lane === "target")
			return JSON.stringify({
				intentId: "intent-1",
				agentId: "mira",
				decision: "accept",
			});
		return JSON.stringify(emptyReflection());
	};
	const options = {
		store,
		model,
		engine: createEnsembleSocialEngine(),
		identity: () => ({
			identity: source.identity,
			profiles: source.profiles,
			modelSettingsRevision: 1,
		}),
		clock,
		foreground,
		entropy: () => 42,
		owner: "runtime-test",
		leaseMs: 300,
	};
	const runner = createLifeRunner(options);
	return {
		store,
		model,
		clock,
		foreground,
		runner,
		options,
		path,
		pack,
		async close() {
			await runner.close();
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
