import { expect, test } from "bun:test";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { OnboardingStore } from "../../lina-core/src/onboarding/store.ts";
import type { AgentDraft } from "../../lina-core/src/onboarding/types.ts";
import type { AgentFleet } from "../src/fleet/manager.ts";
import { onboardingRoutes } from "../src/fleet/onboarding-routes.ts";

test("late authoring responses cannot commit after cancellation or concurrent draft edits", async () => {
	const agents = new AgentStore(":memory:");
	const store = new OnboardingStore(":memory:");
	let entered = Promise.withResolvers<void>();
	let result = Promise.withResolvers<{
		provider: string;
		model: string;
		text: string;
	}>();
	const fleet = {
		onboarding: store,
		agents,
		authoring: async () => {
			entered.resolve();
			return result.promise;
		},
	} as unknown as AgentFleet;
	let draft = store.createDraft(
		{ targetAgentId: null, mode: "thoughtful" },
		{ agents, presets: [], existingCount: 0 },
	);
	const answerId = crypto.randomUUID();
	draft = store.addAnswer(draft.id, {
		revision: draft.revision,
		chapter: "identity",
		text: "별을 관찰하는 동반자",
		answerId,
	});
	const payload = () => ({
		draftId: draft.id,
		revision: draft.revision,
		chapter: "identity",
		deepen: false,
	});
	const call = (signal?: AbortSignal) =>
		onboardingRoutes(
			new Request("http://localhost/api/onboarding/interview", {
				method: "POST",
				...(signal ? { signal } : {}),
			}),
			fleet,
			async () => payload(),
		);
	const finish = (
		text = JSON.stringify({
			text: "별을 관찰하는 동반자다.",
			question: "",
			sourceIds: [answerId],
		}),
	) => result.resolve({ provider: "test", model: "one", text });
	try {
		const cancel = new AbortController();
		const pending = call(cancel.signal);
		await entered.promise;
		expect((await call())?.status).toBe(429);
		cancel.abort();
		finish();
		expect((await pending)?.status).toBe(504);
		expect(store.getDraft(draft.id)?.revision).toBe(draft.revision);
		expect(store.getDraft(draft.id)?.chapters.identity.followups).toBe(0);
		entered = Promise.withResolvers<void>();
		result = Promise.withResolvers();
		const stale = call();
		await entered.promise;
		draft = store.patchDraft(draft.id, {
			revision: draft.revision,
			chapter: { id: "identity", text: "ユーザーの修正", status: "proposed" },
		});
		finish();
		expect((await stale)?.status).toBe(409);
		expect(store.getDraft(draft.id)?.chapters.identity.text).toBe(
			"ユーザーの修正",
		);
		for (const bad of [
			"not JSON",
			JSON.stringify({
				text: "invalid",
				question: "",
				sourceIds: [crypto.randomUUID()],
			}),
		]) {
			entered = Promise.withResolvers<void>();
			result = Promise.withResolvers();
			const invalid = call();
			await entered.promise;
			finish(bad);
			expect((await invalid)?.status).toBe(502);
			expect(store.getDraft(draft.id)?.revision).toBe(draft.revision);
		}
		entered = Promise.withResolvers<void>();
		result = Promise.withResolvers();
		const retry = call();
		await entered.promise;
		finish();
		const response = await retry;
		expect(response?.status).toBe(200);
		const saved = (await response?.json()) as { draft: AgentDraft };
		expect(saved.draft.chapters.identity.answers).toHaveLength(1);
		expect(saved.draft.chapters.identity.followups).toBe(1);
	} finally {
		store.close();
		agents.close();
	}
});

test("draft capacity explains the limit without deleting saved interviews", async () => {
	const agents = new AgentStore(":memory:");
	const store = new OnboardingStore(":memory:");
	const fleet = {
		onboarding: store,
		agents,
		presets: [],
	} as unknown as AgentFleet;
	const input = { targetAgentId: null, mode: "fast" as const };
	try {
		for (let i = 0; i < 16; i++)
			store.createDraft(input, { agents, presets: [], existingCount: 0 });
		const response = await onboardingRoutes(
			new Request("http://localhost/api/onboarding/drafts", { method: "POST" }),
			fleet,
			async () => input,
		);
		expect(response?.status).toBe(400);
		expect(await response?.text()).toContain("16");
		expect(store.snapshot().drafts).toHaveLength(16);
	} finally {
		store.close();
		agents.close();
	}
});

test("authoring concurrency is reserved before asynchronous body reading", async () => {
	const agents = new AgentStore(":memory:");
	const store = new OnboardingStore(":memory:");
	let calls = 0;
	let draft = store.createDraft(
		{ targetAgentId: null, mode: "fast" },
		{ agents, presets: [], existingCount: 0 },
	);
	const answerId = crypto.randomUUID();
	draft = store.addAnswer(draft.id, {
		revision: draft.revision,
		chapter: "identity",
		text: "기록가",
		answerId,
	});
	const fleet = {
		onboarding: store,
		agents,
		authoring: async () => {
			calls++;
			return {
				provider: "test",
				model: "one",
				text: JSON.stringify({
					text: "기록가다.",
					question: "",
					sourceIds: [answerId],
				}),
			};
		},
	} as unknown as AgentFleet;
	const input = {
		draftId: draft.id,
		revision: draft.revision,
		chapter: "identity",
		deepen: false,
	};
	const body = Promise.withResolvers<Record<string, unknown>>();
	const req = () =>
		new Request("http://localhost/api/onboarding/interview", {
			method: "POST",
		});
	const pending = onboardingRoutes(req(), fleet, () => body.promise);
	try {
		const duplicate = await onboardingRoutes(req(), fleet, async () => input);
		expect(duplicate?.status).toBe(429);
		expect(calls).toBe(0);
	} finally {
		body.resolve(input);
		await pending;
		store.close();
		agents.close();
	}
});
