import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/agents/store.ts";
import { unspecifiedProfile } from "../src/onboarding/helpers.ts";
import { OnboardingStore } from "../src/onboarding/store.ts";

test("conversational candidate is frozen and applied atomically without editing legacy draft ahead of confirmation", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-candidate-"));
	const agents = new AgentStore(join(root, "agents.sqlite"));
	const store = new OnboardingStore(join(root, "intro.sqlite"));
	try {
		agents.create(unspecifiedProfile("sera"));
		const draft = store.createDraft(
			{ targetAgentId: "sera", mode: "fast" },
			{ agents, presets: [], existingCount: 1 },
		);
		const candidate = {
			profile: { ...draft.profile, name: "세라" },
			chapters: {
				identity: "은빛 나침반을 지닌 동반자",
				values: "솔직함",
				temperament: "",
				interests: "",
				relationship: "",
				expression: "",
			},
		};
		expect(store.getDraft(draft.id)?.profile.name).not.toBe("세라");
		const input = {
			revision: draft.revision,
			userRevision: 0,
			shareUser: false,
		};
		store.applyDraft(draft.id, input, agents, { candidate });
		expect(agents.get("sera")?.name).toBe("세라");
		expect(store.getDraft(draft.id)?.chapters.identity.status).toBe(
			"confirmed",
		);
		expect(store.authoredContextFor("sera", 2)).toContain("은빛 나침반");
		store.applyDraft(draft.id, input, agents, { candidate });
		expect(agents.get("sera")?.revision).toBe(2);
		expect(() =>
			store.applyDraft(draft.id, input, agents, {
				candidate: {
					...candidate,
					profile: { ...candidate.profile, name: "다른이름" },
				},
			}),
		).toThrow(/conflict/);
	} finally {
		store.close();
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("interrupted conversational apply resumes frozen intent after restart without duplicate profile writes", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-candidate-restart-"));
	const agents = new AgentStore(join(root, "agents.sqlite"));
	let interrupt = true;
	let store = new OnboardingStore(join(root, "intro.sqlite"), {
		onBoundary: (name) => {
			if (interrupt && name === "profile-applied") throw Error("interrupted");
		},
	});
	try {
		agents.create(unspecifiedProfile("sera"));
		const draft = store.createDraft(
			{ targetAgentId: "sera", mode: "fast" },
			{ agents, presets: [], existingCount: 1 },
		);
		const candidate = {
			profile: { ...draft.profile, name: "세라" },
			chapters: {
				identity: "나침반",
				values: "",
				temperament: "",
				interests: "",
				relationship: "",
				expression: "",
			},
		};
		const input = {
			revision: draft.revision,
			userRevision: 0,
			shareUser: false,
		};
		expect(() =>
			store.applyDraft(draft.id, input, agents, { candidate }),
		).toThrow("interrupted");
		expect(agents.get("sera")?.revision).toBe(2);
		expect(store.authoredContextFor("sera", 2)).toBe("");
		store.close();
		interrupt = false;
		store = new OnboardingStore(join(root, "intro.sqlite"));
		store.applyDraft(draft.id, input, agents, { candidate });
		expect(agents.get("sera")?.revision).toBe(2);
		expect(store.authoredContextFor("sera", 2)).toContain("나침반");
		agents.update("sera", 2, { name: "직접 정정" });
		store.applyDraft(draft.id, input, agents, { candidate });
		expect(agents.get("sera")?.name).toBe("직접 정정");
		expect(store.authoredContextFor("sera", 3)).toBe("");
	} finally {
		store.close();
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("explicit restart can open a fresh draft without deleting a locked prior intent", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-candidate-fresh-"));
	const agents = new AgentStore(join(root, "agents.sqlite"));
	const store = new OnboardingStore(join(root, "intro.sqlite"), {
		onBoundary: (name) => {
			if (name === "intent-prepared") throw Error("interrupted");
		},
	});
	try {
		agents.create(unspecifiedProfile("sera"));
		const deps = { agents, presets: [], existingCount: 1 };
		const d = store.createDraft({ targetAgentId: "sera", mode: "fast" }, deps);
		const candidate = {
			profile: { ...d.profile, name: "세라" },
			chapters: {
				identity: "나침반",
				values: "",
				temperament: "",
				interests: "",
				relationship: "",
				expression: "",
			},
		};
		expect(() =>
			store.applyDraft(
				d.id,
				{ revision: d.revision, userRevision: 0, shareUser: false },
				agents,
				{ candidate },
			),
		).toThrow("interrupted");
		const fresh = store.createDraft(
			{ targetAgentId: "sera", mode: "fast" },
			deps,
			{ fresh: true },
		);
		expect(fresh.id).not.toBe(d.id);
		expect(store.getDraft(d.id)).toBeDefined();
		expect(fresh.baseRevision).toBe(1);
	} finally {
		store.close();
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});
