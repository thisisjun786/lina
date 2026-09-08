import { expect, test } from "bun:test";
import { join } from "node:path";
import { ConversationStore } from "../../lina-core/src/agents/conversation.ts";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import {
	captureSourceProofs,
	type SourceProof,
} from "../../lina-core/src/source-policy.ts";
import type { ContextServices } from "../src/context/port.ts";
import { readPresets } from "../src/fleet/presets.ts";
import { PersonaReflection } from "../src/persona/reflection.ts";
import {
	discloseNative,
	nativeEpisode,
} from "./helpers/native-memory-source.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

function fixture(
	reflect: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
	) => Promise<string>,
	recall = async () => "",
	recallSourceProofs?: (text: string) => SourceProof[] | undefined,
) {
	const f = createRuntimeFixture(),
		agents = new AgentStore(join(f.root, "agents.sqlite")),
		conversations = new ConversationStore(join(f.root, "preferences.sqlite"));
	const seed = readPresets(process.cwd()).find((p) => p.id === "lina");
	if (!seed) throw Error("preset");
	agents.create(seed);
	const services: ContextServices = {
		contextWindow: 96000,
		reserveTokens: 1000,
		systemTokens: 0,
		estimateText: (t) => t.length,
		estimateMessages: () => 0,
		summarize: async () => "",
		prepare: () => {
			throw Error("unused");
		},
		reflect,
	};
	const reflection = new PersonaReflection({
		agents,
		conversations,
		agentId: "lina",
		journal: f.store,
		services,
		memory: { recall, ...(recallSourceProofs ? { recallSourceProofs } : {}) },
	});
	return {
		...f,
		agents,
		conversations,
		reflection,
		close: async () => {
			await reflection.close();
			agents.close();
			conversations.close();
			await f.close();
		},
	};
}

for (const phase of ["dispatch", "commit"] as const)
	for (const owner of ["current", "history"] as const)
		test(`reflection ${phase} rejects a new ${owner} episode member after await`, async () => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let dispatches = 0;
			const f = fixture(async (_text, _signal, guard) => {
				if (phase === "commit") {
					guard?.();
					dispatches++;
				}
				started.resolve();
				await release.promise;
				if (phase === "dispatch") {
					guard?.();
					dispatches++;
				}
				return JSON.stringify({
					mood: { label: "happy", reason: "tea" },
					communicationPreferences: [
						{ dimension: "emoji", value: "none", quote: "tea" },
					],
				});
			});
			try {
				nativeEpisode(f.store, f.runtime.binding, "seed");
				nativeEpisode(f.store, f.runtime.binding, "fresh");
				f.reflection.settled();
				await started.promise;
				const late = {
					entryId: "late",
					role: "assistant" as const,
					text: "late",
					timestamp: "2026-09-08T00:00:00.000Z",
					raw: {},
				};
				if (owner === "current") f.store.appendEntry(late);
				else f.store.appendSourceEntry(late, "seed");
				release.resolve();
				await f.reflection.drain();
				expect(dispatches).toBe(phase === "dispatch" ? 0 : 1);
				expect(f.conversations.hasPreferenceReceipt("lina", "fresh")).toBe(
					false,
				);
				expect(f.agents.dynamics("lina").revision).toBe(0);
			} finally {
				release.resolve();
				await f.close();
			}
		});

test("reflection rejects changed episode membership during memory recall before inference", async () => {
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<string>();
	let calls = 0;
	const f = fixture(
		async () => {
			calls++;
			return "{}";
		},
		async () => {
			started.resolve();
			return release.promise;
		},
	);
	try {
		nativeEpisode(f.store, f.runtime.binding, "fresh");
		f.reflection.settled();
		await started.promise;
		f.store.appendEntry({
			entryId: "late",
			role: "assistant",
			text: "late",
			timestamp: "2026-09-08T00:00:00.000Z",
			raw: {},
		});
		release.resolve("");
		await f.reflection.drain();
		expect(calls).toBe(0);
		expect(f.conversations.hasPreferenceReceipt("lina", "fresh")).toBe(false);
	} finally {
		release.resolve("");
		await f.close();
	}
});

test("reflection dispatch checks frozen history ancestry after an adapter await", async () => {
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let dispatches = 0;
	const f = fixture(async (text, _signal, beforeDispatch) => {
		expect(
			JSON.parse(text).recentConversation.some(
				(e: { id: string }) => e.id === "seed-user",
			),
		).toBe(true);
		started.resolve();
		await release.promise;
		beforeDispatch?.();
		dispatches++;
		return "{}";
	});
	try {
		nativeEpisode(f.store, f.runtime.binding, "seed");
		nativeEpisode(f.store, f.runtime.binding, "fresh");
		f.reflection.settled();
		await started.promise;
		discloseNative(f.store, "seed");
		release.resolve();
		await f.reflection.drain();
		expect(dispatches).toBe(0);
		expect(f.store.requestSourcePolicy("fresh")?.scope).toBe("ordinary");
		expect(f.conversations.hasPreferenceReceipt("lina", "fresh")).toBe(false);
		expect(f.agents.dynamics("lina").lastRequestId).toBeNull();
	} finally {
		release.resolve();
		await f.close();
	}
});
test("non-native reflection withholds mixed episodes before recall or reflection", async () => {
	let calls = 0;
	const f = fixture(
		async () => {
			calls++;
			return "{}";
		},
		async () => {
			calls++;
			return "";
		},
	);
	try {
		nativeEpisode(f.store, f.runtime.binding, "mixed", true);
		f.reflection.settled();
		await f.reflection.drain();
		expect(calls).toBe(0);
		expect(f.agents.dynamics("lina").revision).toBe(0);
	} finally {
		await f.close();
	}
});
test("non-native reflection rejects policy changes during the provider await", async () => {
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<string>();
	const f = fixture(async () => {
		started.resolve();
		return release.promise;
	});
	try {
		nativeEpisode(f.store, f.runtime.binding, "r");
		f.reflection.settled();
		await started.promise;
		discloseNative(f.store, "r");
		release.resolve(
			JSON.stringify({ mood: { label: "happy", reason: "tea" } }),
		);
		await f.reflection.drain();
		expect(f.agents.dynamics("lina").revision).toBe(0);
	} finally {
		release.resolve("{}");
		await f.close();
	}
});

test("reflection filters legacy growth and forbidden history before its prompt budget", async () => {
	let payload: Record<string, unknown> | undefined;
	const f = fixture(async (text) => {
		payload = JSON.parse(text);
		return JSON.stringify({ mood: { label: "ordinary", reason: "tea" } });
	});
	try {
		f.agents.applyReflection(
			"lina",
			{
				profileRevision: f.agents.get("lina")?.revision ?? 0,
				dynamicsRevision: 0,
				requestId: "legacy",
				sourceEntryIds: ["missing"],
				mood: { label: "legacy-mood", reason: "private-life" },
				interests: ["private-life"],
			},
			() => true,
		);
		nativeEpisode(f.store, f.runtime.binding, "old-ordinary");
		for (let i = 0; i < 30; i++)
			nativeEpisode(f.store, f.runtime.binding, `forbidden-${i}`, true);
		nativeEpisode(f.store, f.runtime.binding, "current");
		f.reflection.settled();
		await f.reflection.drain();
		expect(payload).toBeDefined();
		expect(JSON.stringify(payload)).not.toContain("private-life");
		expect(JSON.stringify(payload)).not.toContain("legacy-mood");
		expect(JSON.stringify(payload)).not.toContain("forbidden-");
		expect(JSON.stringify(payload)).toContain("old-ordinary-user");
		expect(f.agents.dynamics("lina").mood?.label).toBe("ordinary");
	} finally {
		await f.close();
	}
});

test("whole existing dynamics and pending seed are checked after await while the new episode stays ordinary", async () => {
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<string>();
	const f = fixture(async (text) => {
		const seed = JSON.parse(text);
		expect(seed.dynamics.mood.label).toBe("seed");
		expect(seed.provisionalCharacterGrowth.interests).toEqual(["tea"]);
		started.resolve();
		return release.promise;
	});
	try {
		nativeEpisode(f.store, f.runtime.binding, "seed");
		const lookup = (id: string) => f.store.sourceEntry(id);
		f.agents.applyReflection(
			"lina",
			{
				profileRevision: 1,
				dynamicsRevision: 0,
				requestId: "seed",
				sourceEntryIds: ["seed-user"],
				mood: { label: "seed", reason: "tea" },
				interests: ["tea"],
			},
			() => true,
			{
				sourceProofs: captureSourceProofs(
					["seed-user", "seed-assistant"],
					lookup,
				),
				lookup,
			},
		);
		nativeEpisode(f.store, f.runtime.binding, "fresh");
		f.reflection.settled();
		await started.promise;
		discloseNative(f.store, "seed");
		release.resolve(
			JSON.stringify({ interests: ["tea"], communicationPreferences: [] }),
		);
		await f.reflection.drain();
		expect(f.store.requestSourcePolicy("fresh")?.scope).toBe("ordinary");
		expect(f.agents.dynamics("lina").lastRequestId).toBe("seed");
		expect(
			f.agents.modelDynamics("lina", lookup).pendingGrowth.interests,
		).toEqual([]);
		expect(f.conversations.hasPreferenceReceipt("lina", "fresh")).toBe(false);
	} finally {
		release.resolve("{}");
		await f.close();
	}
});

test("an empty reflection records full preference ancestry without changing preferences", async () => {
	const f = fixture(async (_text, _signal, beforeDispatch) => {
		expect(typeof beforeDispatch).toBe("function");
		beforeDispatch?.();
		return "{}";
	});
	try {
		nativeEpisode(f.store, f.runtime.binding, "empty");
		f.reflection.settled();
		await f.reflection.drain();
		const lookup = (id: string) => f.store.sourceEntry(id);
		expect(f.conversations.hasPreferenceReceipt("lina", "empty", lookup)).toBe(
			true,
		);
		expect(f.conversations.getPreferences("lina")).toEqual({
			revision: 0,
			items: [],
		});
		discloseNative(f.store, "empty");
		expect(f.conversations.hasPreferenceReceipt("lina", "empty", lookup)).toBe(
			false,
		);
		expect(f.conversations.hasPreferenceReceipt("lina", "empty")).toBe(true);
	} finally {
		await f.close();
	}
});

test("unqualified external recall cannot seed otherwise eligible reflection", async () => {
	let payload = "";
	const f = fixture(
		async (text) => {
			payload = text;
			return "{}";
		},
		async () => "unqualified-reference",
	);
	try {
		nativeEpisode(f.store, f.runtime.binding, "fresh");
		f.reflection.settled();
		await f.reflection.drain();
		expect(payload).not.toContain("unqualified-reference");
		expect(f.agents.dynamics("lina").lastRequestId).toBe("fresh");
	} finally {
		await f.close();
	}
});

test("qualified external recall ancestry is persisted and checked after provider await", async () => {
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<string>();
	let proofs: SourceProof[] = [];
	const f = fixture(
		async (text) => {
			expect(JSON.parse(text).honchoReference).toBe("qualified-reference");
			started.resolve();
			return release.promise;
		},
		async () => "qualified-reference",
		() => proofs,
	);
	try {
		nativeEpisode(f.store, f.runtime.binding, "reference");
		proofs = captureSourceProofs(
			["reference-user", "reference-assistant"],
			(id) => f.store.sourceEntry(id),
		);
		for (let i = 0; i < 13; i++)
			nativeEpisode(f.store, f.runtime.binding, `between-${i}`);
		nativeEpisode(f.store, f.runtime.binding, "fresh");
		f.reflection.settled();
		await started.promise;
		discloseNative(f.store, "reference");
		release.resolve("{}");
		await f.reflection.drain();
		expect(f.agents.dynamics("lina").lastRequestId).toBeNull();
		expect(f.conversations.hasPreferenceReceipt("lina", "fresh")).toBe(false);
	} finally {
		release.resolve("{}");
		await f.close();
	}
});

test("legacy assistant contamination excludes its whole history episode before the limit and permits new ordinary learning", async () => {
	let payload = "";
	const f = fixture(async (text) => {
		payload = text;
		return "{}";
	});
	try {
		nativeEpisode(f.store, f.runtime.binding, "incomplete");
		f.store.appendEntry({
			entryId: "legacy-assistant",
			role: "assistant",
			text: "legacy",
			timestamp: "2026-09-08T00:00:00.000Z",
			raw: {},
		});
		nativeEpisode(f.store, f.runtime.binding, "fresh");
		f.reflection.settled();
		await f.reflection.drain();
		expect(payload).not.toBe("");
		expect(payload).not.toContain("incomplete-user");
		expect(f.agents.dynamics("lina").lastRequestId).toBe("fresh");
	} finally {
		await f.close();
	}
});
