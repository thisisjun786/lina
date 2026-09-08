import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { ConversationStore } from "../../lina-core/src/agents/conversation.ts";
import { captureSourceProofs } from "../../lina-core/src/source-policy.ts";
import { nativePreferences } from "../src/persona/native-preferences.ts";
import {
	discloseNative,
	nativeEpisode,
} from "./helpers/native-memory-source.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("native preference dispatch checks the frozen existing preference seed after an adapter await", async () => {
	const f = createRuntimeFixture(),
		s = new ConversationStore(join(f.root, "dispatch.sqlite"));
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let dispatches = 0;
	try {
		nativeEpisode(f.store, f.runtime.binding, "seed");
		const first = nativePreferences(s, "lina", f.store, async () =>
			JSON.stringify({
				communicationPreferences: [
					{ dimension: "emoji", value: "none", quote: "tea" },
				],
			}),
		);
		await first.process(
			required(f.store.entry("seed-user")),
			0,
			new AbortController().signal,
		);
		nativeEpisode(f.store, f.runtime.binding, "fresh");
		const next = nativePreferences(
			s,
			"lina",
			f.store,
			async (text, _signal, beforeDispatch?: () => void) => {
				expect(JSON.parse(text).userCommunicationPreferences).toHaveLength(1);
				started.resolve();
				await release.promise;
				beforeDispatch?.();
				dispatches++;
				return "{}";
			},
		);
		const run = next
			.process(
				required(f.store.entry("fresh-user")),
				0,
				new AbortController().signal,
			)
			.then(
				() => false,
				() => true,
			);
		await started.promise;
		discloseNative(f.store, "seed");
		release.resolve();
		expect(await run).toBe(true);
		expect(dispatches).toBe(0);
		expect(s.hasPreferenceReceipt("lina", "fresh")).toBe(false);
	} finally {
		release.resolve();
		s.close();
		await f.close();
	}
});

test("native preference final dispatch does not recapture a changed ordinary revision", async () => {
	const f = createRuntimeFixture(),
		s = new ConversationStore(join(f.root, "frozen-dispatch.sqlite"));
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let dispatches = 0;
	const original = f.store.sourceEntry.bind(f.store);
	let revised = false;
	const lookup = spyOn(f.store, "sourceEntry").mockImplementation((id) => {
		const entry = original(id);
		return revised && id === "ordinary-assistant" && entry?.sourcePolicy
			? {
					...entry,
					sourcePolicy: {
						...entry.sourcePolicy,
						policyRevision: entry.sourcePolicy.policyRevision + 1,
					},
				}
			: entry;
	});
	try {
		nativeEpisode(f.store, f.runtime.binding, "ordinary");
		const p = nativePreferences(
			s,
			"lina",
			f.store,
			async (_text, _signal, beforeDispatch) => {
				expect(typeof beforeDispatch).toBe("function");
				beforeDispatch?.();
				started.resolve();
				await release.promise;
				beforeDispatch?.();
				dispatches++;
				return "{}";
			},
		);
		const run = p
			.process(
				required(f.store.entry("ordinary-user")),
				0,
				new AbortController().signal,
			)
			.then(
				() => false,
				() => true,
			);
		await started.promise;
		revised = true;
		expect(f.store.sourceEntry("ordinary-assistant")?.sourcePolicy?.scope).toBe(
			"ordinary",
		);
		release.resolve();
		expect(await run).toBe(true);
		expect(dispatches).toBe(0);
		expect(s.hasPreferenceReceipt("lina", "ordinary")).toBe(false);
	} finally {
		release.resolve();
		lookup.mockRestore();
		s.close();
		await f.close();
	}
});

test("native preferences reject a mixed episode before provider and receipt shortcuts", async () => {
	const f = createRuntimeFixture(),
		s = new ConversationStore(join(f.root, "preferences.sqlite"));
	let calls = 0;
	try {
		nativeEpisode(f.store, f.runtime.binding, "mixed", true);
		const source = required(f.store.entry("mixed-user"));
		const p = nativePreferences(s, "lina", f.store, async () => {
			calls++;
			return "{}";
		});
		await expect(
			p.process(source, 0, new AbortController().signal),
		).rejects.toThrow();
		expect(calls).toBe(0);
		expect(p.hasReceipt(source.entryId)).toBe(false);
	} finally {
		s.close();
		await f.close();
	}
});
test("preference observation changing policy during await cannot persist an empty receipt", async () => {
	const f = createRuntimeFixture(),
		s = new ConversationStore(join(f.root, "preferences.sqlite"));
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<string>();
	try {
		nativeEpisode(f.store, f.runtime.binding, "r");
		const p = nativePreferences(s, "lina", f.store, async () => {
			started.resolve();
			return release.promise;
		});
		const run = p.process(
			required(f.store.entry("r-user")),
			0,
			new AbortController().signal,
		);
		const checked = run.then(
			() => false,
			() => true,
		);
		await started.promise;
		discloseNative(f.store, "r");
		release.resolve("{}");
		expect(await checked).toBe(true);
		expect(s.hasPreferenceReceipt("lina", "r")).toBe(false);
	} finally {
		release.resolve("{}");
		s.close();
		await f.close();
	}
});

function required<T>(value: T | undefined): T {
	if (value === undefined) throw Error("missing fixture value");
	return value;
}

test("legacy preferences stay out of the seed and ordinary learning persists complete episode proofs", async () => {
	const f = createRuntimeFixture(),
		path = join(f.root, "proof-preferences.sqlite");
	let s = new ConversationStore(path);
	try {
		nativeEpisode(f.store, f.runtime.binding, "legacy");
		s.observePreferences(
			"lina",
			"legacy",
			"legacy-user",
			"tea",
			[{ dimension: "verbosity", value: "detailed", quote: "tea" }],
			(id) => ({ entryId: id, role: "user", text: "tea" }),
		);
		nativeEpisode(f.store, f.runtime.binding, "fresh");
		const p = nativePreferences(s, "lina", f.store, async (text) => {
			const seed = JSON.parse(text);
			expect(seed.userCommunicationPreferences).toEqual([]);
			return JSON.stringify({
				communicationPreferences: [
					{ dimension: "verbosity", value: "brief", quote: "tea" },
				],
			});
		});
		await p.process(
			required(f.store.entry("fresh-user")),
			0,
			new AbortController().signal,
		);
		expect(s.getPreferences("lina").items[0]?.value).toBe("brief");
		s.close();
		s = new ConversationStore(path);
		expect(
			s.modelPreferences("lina", (id) => f.store.sourceEntry(id)).items[0]
				?.value,
		).toBe("brief");
		discloseNative(f.store, "fresh");
		expect(
			s.modelPreferences("lina", (id) => f.store.sourceEntry(id)).items,
		).toEqual([]);
		expect(s.getPreferences("lina").items).toHaveLength(1);
	} finally {
		s.close();
		await f.close();
	}
});

test("existing preference ancestry changing during await rejects even an empty new result", async () => {
	const f = createRuntimeFixture(),
		s = new ConversationStore(join(f.root, "preferences.sqlite"));
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<string>();
	try {
		nativeEpisode(f.store, f.runtime.binding, "seed");
		const first = nativePreferences(s, "lina", f.store, async () =>
			JSON.stringify({
				communicationPreferences: [
					{ dimension: "emoji", value: "none", quote: "tea" },
				],
			}),
		);
		await first.process(
			required(f.store.entry("seed-user")),
			0,
			new AbortController().signal,
		);
		nativeEpisode(f.store, f.runtime.binding, "fresh");
		const next = nativePreferences(s, "lina", f.store, async (text) => {
			expect(JSON.parse(text).userCommunicationPreferences).toHaveLength(1);
			started.resolve();
			return release.promise;
		});
		const run = next
			.process(
				required(f.store.entry("fresh-user")),
				0,
				new AbortController().signal,
			)
			.then(
				() => false,
				() => true,
			);
		await started.promise;
		discloseNative(f.store, "seed");
		release.resolve("{}");
		expect(await run).toBe(true);
		expect(s.hasPreferenceReceipt("lina", "fresh")).toBe(false);
		expect(f.store.requestSourcePolicy("fresh")?.scope).toBe("ordinary");
	} finally {
		release.resolve("{}");
		s.close();
		await f.close();
	}
});

test("an ordinary user cannot strip an unclassified assistant out of its episode", async () => {
	const f = createRuntimeFixture(),
		s = new ConversationStore(join(f.root, "preferences.sqlite"));
	let calls = 0;
	try {
		nativeEpisode(f.store, f.runtime.binding, "ordinary");
		f.store.appendEntry({
			entryId: "legacy-assistant",
			role: "assistant",
			text: "legacy",
			timestamp: "2026-09-08T00:00:00.000Z",
			raw: {},
		});
		const p = nativePreferences(s, "lina", f.store, async () => {
			calls++;
			return "{}";
		});
		await expect(
			p.process(
				required(f.store.entry("ordinary-user")),
				0,
				new AbortController().signal,
			),
		).rejects.toThrow();
		expect(calls).toBe(0);
	} finally {
		s.close();
		await f.close();
	}
});

for (const phase of ["dispatch", "commit"] as const)
	for (const owner of ["current", "ancestry"] as const)
		test(`native preference ${phase} rejects a new ${owner} episode member after await`, async () => {
			const f = createRuntimeFixture();
			const s = new ConversationStore(join(f.root, "late-member.sqlite"));
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let dispatches = 0;
			try {
				nativeEpisode(f.store, f.runtime.binding, "seed");
				const ancestry = captureSourceProofs(
					["seed-user", "seed-assistant"],
					(id) => f.store.sourceEntry(id),
				);
				nativeEpisode(f.store, f.runtime.binding, "fresh");
				const preferences = nativePreferences(
					s,
					"lina",
					f.store,
					async (_text, _signal, guard) => {
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
							communicationPreferences: [
								{ dimension: "emoji", value: "none", quote: "tea" },
							],
						});
					},
				);
				const run = preferences
					.process(
						required(f.store.entry("fresh-user")),
						0,
						new AbortController().signal,
						ancestry,
					)
					.then(
						() => false,
						() => true,
					);
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
				expect(await run).toBe(true);
				expect(dispatches).toBe(phase === "dispatch" ? 0 : 1);
				expect(s.hasPreferenceReceipt("lina", "fresh")).toBe(false);
				expect(
					s.modelPreferences("lina", (id) => f.store.sourceEntry(id)).items,
				).toEqual([]);
			} finally {
				release.resolve();
				s.close();
				await f.close();
			}
		});
