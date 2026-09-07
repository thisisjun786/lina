import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorldSuggestionRequest } from "../../lina-core/src/world/authoring-types.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { socialPack } from "../../lina-core/test/life-social-pack-fixture.ts";
import { WorldAuthoring } from "../src/life/authoring.ts";
import { lifeConfigReadiness } from "../src/life/config.ts";
import type { ModelControl } from "../src/models/port.ts";
import { authorPack, emptyLifeConfig } from "./life-authoring-fixture.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(authoring: NonNullable<ModelControl["authoring"]>) {
	const root = mkdtempSync(join(tmpdir(), "lina-authoring-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const store = new WorldStore(join(root, "world.sqlite"));
	cleanup.push(() => store.close());
	let revision = 1;
	const service = new WorldAuthoring({
		store,
		authoring,
		modelSettingsRevision: () => revision,
		agentExists: (id) => id === "lina",
	});
	cleanup.push(() => service.close());
	const draft = service.create({
		worldId: "test-world",
		authoredText: "Keep this original source",
	});
	const input: WorldSuggestionRequest = {
		requestId: "suggestion-1",
		draftId: draft.id,
		draftRevision: draft.revision,
		agentId: "lina",
		modelSettingsRevision: 1,
	};
	return {
		root,
		store,
		service,
		draft,
		input,
		changeModel: () => {
			revision++;
		},
	};
}
const signal = () => new AbortController().signal;

test("author suggestions describe and retain explicit v2 social rules without activating them", async () => {
	let prompt = "";
	const f = fixture(async (input) => {
		prompt = input.systemPrompt;
		return {
			provider: "synthetic",
			model: "author",
			text: JSON.stringify(socialPack()),
		};
	});
	const result = await f.service.suggest(f.input, signal());
	expect(result.status).toBe("succeeded");
	expect(result.result?.draft.pack?.schemaVersion).toBe(2);
	expect(prompt).toContain("schemaVersion:2");
	expect(prompt).toContain("SocialDefinition");
	expect(f.store.worldCatalog({ afterId: null, limit: 10 }).items).toEqual([]);
});

test("suggestion dispatch is durable, pins settings, deduplicates keys and retains authored text", async () => {
	const returned = Promise.withResolvers<{
		provider: string;
		model: string;
		text: string;
	}>();
	const dispatched = Promise.withResolvers<void>();
	let calls = 0;
	const f = fixture(async (input) => {
		calls++;
		expect(input.expectedSettingsRevision).toBe(1);
		dispatched.resolve();
		return returned.promise;
	});
	const pending = f.service.suggest(f.input, signal());
	await dispatched.promise;
	expect(f.store.worldSuggestion(f.input.requestId).status).toBe("dispatched");
	expect((await f.service.suggest(f.input, signal())).status).toBe(
		"dispatched",
	);
	await expect(
		f.service.suggest({ ...f.input, requestId: "bypass" }, signal()),
	).rejects.toThrow();
	returned.resolve({
		provider: "synthetic",
		model: "author",
		text: JSON.stringify(authorPack()),
	});
	const result = await pending;
	expect(result.status).toBe("succeeded");
	expect(result.result?.draft.authoredText).toBe(f.draft.authoredText);
	expect((await f.service.suggest(f.input, signal())).result).toEqual(
		result.result,
	);
	expect(calls).toBe(1);
});

test.each(["invalid", "foreign", "stale", "model"] as const)(
	"%s model result cannot replace the source or commit a draft",
	async (reason) => {
		const returned = Promise.withResolvers<{
			provider: string;
			model: string;
			text: string;
		}>();
		const dispatched = Promise.withResolvers<void>();
		const f = fixture(async () => {
			dispatched.resolve();
			return returned.promise;
		});
		const pending = f.service.suggest(f.input, signal());
		await dispatched.promise;
		if (reason === "stale")
			f.service.edit(f.draft.id, f.draft.revision, {
				authoredText: "New source",
				pack: null,
			});
		if (reason === "model") f.changeModel();
		returned.resolve({
			provider: "synthetic",
			model: "author",
			text:
				reason === "invalid"
					? '{"execute":"shell"}'
					: JSON.stringify(
							authorPack(reason === "foreign" ? "foreign" : "test-world"),
						),
		});
		expect((await pending).status).toBe("failed");
		expect(f.service.read(f.draft.id).pack).toBeNull();
		expect(f.service.read(f.draft.id).authoredText).toBe(
			reason === "stale" ? "New source" : f.draft.authoredText,
		);
	},
);

test("cancel after dispatch retains uncertainty, blocks new keys, and requires explicit abandon", async () => {
	let calls = 0;
	const dispatched = Promise.withResolvers<void>();
	const f = fixture(async (_input, s) => {
		calls++;
		dispatched.resolve();
		return new Promise((_resolve, reject) =>
			s.addEventListener("abort", () => reject(s.reason), { once: true }),
		);
	});
	const controller = new AbortController();
	const pending = f.service.suggest(f.input, controller.signal);
	await dispatched.promise;
	controller.abort();
	expect((await pending).status).toBe("unknown");
	await expect(
		f.service.suggest({ ...f.input, requestId: "new-key" }, signal()),
	).rejects.toThrow();
	expect(f.service.abandon(f.input.requestId).status).toBe("abandoned");
	expect(f.service.read(f.draft.id).revision).toBe(f.draft.revision);
	expect(calls).toBe(1);
});

test("an active grant scopes reads and late model commits to its persisted world", async () => {
	const returned = Promise.withResolvers<{
		provider: string;
		model: string;
		text: string;
	}>();
	const dispatched = Promise.withResolvers<void>();
	const f = fixture(async () => {
		dispatched.resolve();
		return returned.promise;
	});
	const grant = f.store.grantWorldAuthor("test-world", "lina");
	const scope = { grantId: grant.id, grantRevision: grant.revision };
	const foreign = f.service.create({
		worldId: "foreign",
		authoredText: "Private foreign draft",
	});
	expect(() => f.service.read(foreign.id, scope)).toThrow();
	const pending = f.service.suggest(f.input, signal(), scope);
	await dispatched.promise;
	f.store.revokeWorldAuthor(grant.id, grant.revision);
	returned.resolve({
		provider: "synthetic",
		model: "author",
		text: JSON.stringify(authorPack()),
	});
	await pending.catch(() => undefined);
	expect(f.service.read(f.draft.id).pack).toBeNull();
	expect(() => f.service.read(f.draft.id, scope)).toThrow();
});

test("missing operational configuration stays null and never becomes automatically ready", () => {
	const before = structuredClone(emptyLifeConfig);
	expect(lifeConfigReadiness(emptyLifeConfig)).toMatchObject({
		status: "not_configured",
		automaticReady: false,
	});
	expect(emptyLifeConfig).toEqual(before);
});

test("partial source can persist explicit questions without inventing a world pack", async () => {
	let calls = 0;
	const f = fixture(async (input) => {
		calls++;
		expect(input.systemPrompt).toContain("timeUnit:string");
		expect(input.systemPrompt).toContain('kind:"attitude"');
		expect(input.systemPrompt).toContain("INCOMPLETE output shape");
		return {
			provider: "synthetic",
			model: "author",
			text: JSON.stringify({
				pack: null,
				unresolved: [
					{
						id: "participants",
						question: "Who participates in this world?",
						blocking: true,
					},
					{
						id: "time-unit",
						question: "What unit should a simulation step represent?",
						blocking: true,
					},
				],
			}),
		};
	});
	const result = await f.service.suggest(f.input, signal());
	expect(result.status).toBe("succeeded");
	if (!result.result) throw Error("Missing successful suggestion receipt");
	expect(result.result?.draft.pack).toBeNull();
	expect(result.result?.draft.unresolved.map((item) => item.id)).toEqual([
		"participants",
		"time-unit",
	]);
	expect(result.result?.draft.authoredText).toBe(f.draft.authoredText);
	expect(f.store.worldCatalog({ afterId: null, limit: 10 }).items).toHaveLength(
		0,
	);
	f.changeModel();
	expect((await f.service.suggest(f.input, signal())).result).toEqual(
		result.result,
	);
	expect(calls).toBe(1);
	await f.service.close();
	f.store.close();
	const reopened = new WorldStore(join(f.root, "world.sqlite"));
	cleanup.push(() => reopened.close());
	expect(reopened.worldDraft(f.draft.id)).toEqual(result.result.draft);
	expect(reopened.worldSuggestion(f.input.requestId).result).toEqual(
		result.result,
	);
});

test.each([
	{ pack: null, unresolved: [] },
	{
		pack: null,
		unresolved: [
			{ id: "participants", question: "Who participates?", blocking: false },
		],
	},
	{
		pack: null,
		unresolved: [
			{ id: "participants", question: "Who participates?", blocking: true },
		],
		provider: "forged",
	},
])(
	"invalid incomplete model output cannot change a draft or forge provenance: %j",
	async (output) => {
		const f = fixture(async () => ({
			provider: "synthetic",
			model: "author",
			text: JSON.stringify(output),
		}));
		const result = await f.service.suggest(f.input, signal());
		expect(result.status).toBe("failed");
		expect(result.error).toBe("invalid_result");
		expect(f.service.read(f.draft.id)).toEqual(f.draft);
	},
);

test("oversized suggestion input is rejected before provider dispatch without truncating source", async () => {
	let calls = 0;
	const f = fixture(async () => {
		calls++;
		throw Error("Unexpected provider call");
	});
	const pack = authorPack();
	pack.background.description = "x".repeat(30000);
	const draft = f.service.edit(f.draft.id, f.draft.revision, {
		authoredText: f.draft.authoredText,
		pack,
	});
	const input = { ...f.input, draftRevision: draft.revision };
	await expect(f.service.suggest(input, signal())).rejects.toThrow(/too large/);
	expect(f.store.worldSuggestion(input.requestId).status).toBe("prepared");
	expect(f.service.read(draft.id).pack?.background.description).toHaveLength(
		30000,
	);
	expect(calls).toBe(0);
});

test("reopening a durable dispatch marker never automatically spends again", async () => {
	let calls = 0;
	const f = fixture(async () => {
		calls++;
		throw Error("Must not retry unknown dispatch");
	});
	f.store.prepareWorldSuggestion(f.input);
	f.store.dispatchWorldSuggestion(f.input.requestId);
	const peer = new WorldStore(join(f.root, "world.sqlite"));
	expect(peer.worldSuggestion(f.input.requestId).status).toBe("dispatched");
	peer.close();
	f.store.close();
	const reopened = new WorldStore(join(f.root, "world.sqlite"));
	cleanup.push(() => reopened.close());
	const service = new WorldAuthoring({
		store: reopened,
		authoring: async () => {
			calls++;
			throw Error("Unexpected dispatch");
		},
		modelSettingsRevision: () => 1,
		agentExists: () => true,
	});
	cleanup.push(() => service.close());
	expect((await service.suggest(f.input, signal())).status).toBe("unknown");
	await expect(
		service.suggest({ ...f.input, requestId: "replacement" }, signal()),
	).rejects.toThrow();
	expect(service.read(f.draft.id).pack).toBeNull();
	expect(calls).toBe(0);
});

test.each(["abandon", "shutdown"] as const)(
	"%s fences a late provider response even when the provider ignores abort",
	async (action) => {
		const dispatched = Promise.withResolvers<AbortSignal>();
		const returned = Promise.withResolvers<{
			provider: string;
			model: string;
			text: string;
		}>();
		const f = fixture(async (_input, providerSignal) => {
			dispatched.resolve(providerSignal);
			return returned.promise;
		});
		const pending = f.service.suggest(f.input, signal());
		const providerSignal = await dispatched.promise;
		const closing =
			action === "shutdown"
				? f.service.close()
				: Promise.resolve(f.service.abandon(f.input.requestId));
		expect(providerSignal.aborted).toBe(true);
		returned.resolve({
			provider: "synthetic",
			model: "author",
			text: JSON.stringify(authorPack()),
		});
		expect((await pending).status).toBe(
			action === "shutdown" ? "unknown" : "abandoned",
		);
		await closing;
		expect(f.store.worldDraft(f.draft.id).revision).toBe(f.draft.revision);
		expect(f.store.worldDraft(f.draft.id).pack).toBeNull();
	},
);
