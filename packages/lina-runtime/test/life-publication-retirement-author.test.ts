import { expect, test } from "bun:test";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { authoringPack } from "../../lina-core/test/life-authoring-fixture.ts";
import { publicationStoreFixture } from "../../lina-core/test/life-publication-store-fixture.ts";
import { fleetPublicationAuthor } from "../src/fleet/life-runtime.ts";
import { authorPreview } from "./life-authoring-fixture.ts";

test("fleet public author uses legacy participants until a current authored role retires", () => {
	const store = publicationStoreFixture(),
		agents = new AgentStore(":memory:");
	try {
		for (const id of ["lina", "mira", "sol"])
			agents.create({
				id,
				name: id,
				role: "assistant",
				personality: "curious",
				voice: "Public voice",
				profile: "PRIVATE_BIO",
				appearance: "silver eyes",
				interests: [],
				avatarId: null,
				evolution: "adaptive",
			});
		expect(
			fleetPublicationAuthor(store, agents, "test-world", "lina").voice,
		).toBe("Public voice");
		for (const retired of [false, true]) {
			const pack = authoringPack();
			pack.life = store.lifeDefinition("test-world");
			if (retired) {
				pack.version = 2;
				pack.world.version = 2;
				pack.life.revision++;
				for (const role of pack.roles)
					if (role.agentId === "lina") role.status = "retired";
				for (const scene of pack.world.scenes)
					scene.occupants = scene.occupants.filter((id) => id !== "lina");
			}
			const draft = store.draftWorld({
				worldId: pack.worldId,
				authoredText: pack.background.authoredText,
			});
			const edited = store.editWorldDraft(draft.id, draft.revision, {
				authoredText: draft.authoredText,
				pack,
			});
			const options = {
				...authorPreview,
				agentId: "mira",
				expectedWorldRevision: 1,
				simulationTime: 1,
				relocations: retired ? [{ agentId: "lina", sceneId: null }] : [],
			};
			const preview = store.previewWorldDraft(
				edited.id,
				edited.revision,
				options,
			);
			if (!preview.packDigest) throw Error("Missing authored fixture");
			store.activateWorldDraft({
				draftId: edited.id,
				expectedRevision: edited.revision,
				idempotencyKey: `activate-${pack.version}`,
				packDigest: preview.packDigest,
				previewDigest: preview.digest,
				options,
			});
			if (retired) {
				expect(
					store
						.worldPack("test-world")
						.roles.find((role) => role.agentId === "lina")?.status,
				).toBe("retired");
				expect(() =>
					fleetPublicationAuthor(store, agents, "test-world", "lina"),
				).toThrow("Publication author unavailable");
			} else
				expect(
					fleetPublicationAuthor(store, agents, "test-world", "lina").agentId,
				).toBe("lina");
		}
		expect(
			fleetPublicationAuthor(store, agents, "test-world", "mira").agentId,
		).toBe("mira");
	} finally {
		store.close();
		agents.close();
	}
});
