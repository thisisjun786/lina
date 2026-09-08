import { expect, test } from "bun:test";
import type { AgentDraft } from "../../lina-core/src/onboarding/types.ts";
import type { SourceProof } from "../../lina-core/src/source-policy.ts";
import type { ModelControl } from "../src/models/port.ts";
import {
	fleetMemoryFixture,
	ordinaryEpisode,
	revokeEpisode,
} from "./helpers/fleet-work-memory.ts";

type Input = Parameters<NonNullable<ModelControl["authoring"]>>[0] & {
	beforeDispatch?: () => void;
};
async function setup(author: (input: Input) => Promise<void> = async () => {}) {
	const prompts: Input[] = [];
	const f = await fleetMemoryFixture({
		memoryBackend: "disabled",
		modelControl: {
			catalog: () => [],
			state: () => ({
				provider: "fixture",
				model: "preview",
				settingsRevision: 0,
				error: null,
			}),
			test: async () => {
				throw Error("unused");
			},
			authoring: async (input: Input) => {
				await author(input);
				prompts.push(input);
				return {
					provider: "fixture",
					model: "preview",
					text: "DERIVED_PREVIEW",
				};
			},
		},
	});
	const app = await f.fleet.app("lina");
	const draft = (await (
		await f.call("/api/onboarding/drafts", {
			targetAgentId: "lina",
			mode: "thoughtful",
		})
	).json()) as AgentDraft;
	const preview = () =>
		f.call("/api/onboarding/preview", {
			draftId: draft.id,
			revision: draft.revision,
			shareUser: false,
			messages: [{ role: "user", content: "preview please" }],
		});
	const learn = (id: string, qualified = true, extra: SourceProof[] = []) => {
		const provenance = ordinaryEpisode(app, id);
		provenance.sourceProofs.push(...extra);
		f.fleet.conversations.observePreferences(
			"lina",
			id,
			`${id}-user`,
			"tea",
			[{ dimension: "emoji", value: "none", quote: "tea" }],
			(entryId) => {
				const entry = app.runtime.store.entry(entryId);
				return entry?.role === "user"
					? { entryId, role: "user", text: entry.text }
					: undefined;
			},
			undefined,
			qualified ? provenance : undefined,
		);
		f.fleet.agents.applyReflection(
			"lina",
			{
				profileRevision: f.fleet.agents.get("lina")?.revision ?? 0,
				dynamicsRevision: f.fleet.agents.dynamics("lina").revision,
				requestId: id,
				sourceEntryIds: [`${id}-user`],
				mood: { label: `${id}-mood`, reason: `${id}-private-rationale` },
			},
			() => true,
			qualified ? provenance : undefined,
		);
	};
	return { ...f, app, draft, preview, prompts, learn };
}

test("onboarding preview excludes raw legacy and mixed preferences and reflection rationale", async () => {
	const f = await setup();
	try {
		f.learn("legacy", false);
		expect((await f.preview()).status).toBe(200);
		let prompt = f.prompts.at(-1)?.systemPrompt ?? "";
		expect(prompt).not.toContain("이모지를 쓰지 않는다.");
		expect(prompt).not.toContain("legacy-private-rationale");
		f.learn("mixed");
		revokeEpisode(f.app, "mixed");
		expect((await f.preview()).status).toBe(200);
		prompt = f.prompts.at(-1)?.systemPrompt ?? "";
		expect(prompt).not.toContain("이모지를 쓰지 않는다.");
		expect(prompt).not.toContain("mixed-private-rationale");
		expect(f.fleet.conversations.getPreferences("lina").items).toHaveLength(1);
		expect(f.fleet.agents.dynamics("lina").mood?.reason).toBe(
			"mixed-private-rationale",
		);
		f.learn("ordinary");
		expect((await f.preview()).status).toBe(200);
		prompt = f.prompts.at(-1)?.systemPrompt ?? "";
		expect(prompt).toContain("이모지를 쓰지 않는다.");
		expect(prompt).toContain("ordinary-mood");
		expect(prompt).toContain(f.draft.profile.name);
	} finally {
		await f.close();
	}
});

test("onboarding holds a generated preview when any original prompt ancestor changes during await", async () => {
	const begun = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const f = await setup(async () => {
		begun.resolve();
		await release.promise;
	});
	try {
		const ancestor = ordinaryEpisode(f.app, "ancestor");
		f.learn("ordinary", true, ancestor.sourceProofs);
		const pending = f.preview();
		await begun.promise;
		revokeEpisode(f.app, "ancestor");
		release.resolve();
		const response = await pending;
		expect(response.status).toBe(409);
		expect(await response.text()).not.toContain("DERIVED_PREVIEW");
		expect(f.fleet.onboarding.getDraft(f.draft.id)?.revision).toBe(
			f.draft.revision,
		);
	} finally {
		release.resolve();
		await f.close();
	}
});

test("onboarding forwards original proof guard through fleet to a delayed authoring owner", async () => {
	const begun = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let dispatched = 0;
	const f = await setup(async (input) => {
		begun.resolve();
		await release.promise;
		input.beforeDispatch?.();
		dispatched++;
	});
	try {
		f.learn("ordinary");
		const pending = f.preview();
		await begun.promise;
		revokeEpisode(f.app, "ordinary");
		release.resolve();
		const response = await pending;
		expect(response.ok).toBe(false);
		expect(dispatched).toBe(0);
		expect(await response.text()).not.toContain("DERIVED_PREVIEW");
	} finally {
		release.resolve();
		await f.close();
	}
});
