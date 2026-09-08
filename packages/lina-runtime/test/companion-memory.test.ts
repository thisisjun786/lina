import { expect, test } from "bun:test";
import { join } from "node:path";
import { captureSourceProofs } from "../../lina-core/src/source-policy.ts";
import { CompanionMemory } from "../src/context/companion.ts";
import { CompanionQueue } from "../src/context/companion-queue.ts";
import { trustNativeFixture } from "./helpers/native-memory-source.ts";
import { createRuntimeFixture as baseFixture } from "./runtime-fixture.ts";

test("settled evidence becomes scoped memory without a Honcho request and survives reopening", async () => {
	const f = createRuntimeFixture();
	const options = {
		path: join(f.root, "native.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
	};
	let calls = 0;
	let memory = new CompanionMemory(options);
	memory.configure(async () => {
		calls++;
		return JSON.stringify({
			observations: [
				{
					subject: "user",
					kind: "preference",
					key: "drink",
					text: "Prefers tea",
					evidence: "explicit",
					sources: [{ entryId: "u", quote: "tea" }],
				},
			],
			communicationPreferences: [],
		});
	});
	try {
		f.store.createRequest("r", "tea");
		f.store.appendEntry({
			entryId: "u",
			role: "user",
			text: "tea",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		f.store.setRequest("r", "accepted", { entryId: "u" });
		f.store.setRequest("r", "settled");
		await memory.refresh();
		expect(memory.mind.state().records[0]?.text).toBe("Prefers tea");
		expect(await memory.recall("tea")).toContain("Prefers tea");
		await memory.close();
		memory = new CompanionMemory(options);
		memory.configure(async () => {
			calls++;
			return "[]";
		});
		await memory.refresh();
		expect(calls).toBe(1);
		expect(memory.mind.state().records[0]?.agentId).toBe(
			f.runtime.binding.botId,
		);
	} finally {
		await memory.close();
		await f.close();
	}
});

function entry(
	f: ReturnType<typeof createRuntimeFixture>,
	id: string,
	role: "user" | "assistant" | "tool",
	text = id,
	stopReason = "stop",
) {
	f.store.appendEntry({
		entryId: id,
		role,
		text,
		timestamp: "2026-09-06T00:00:00.000Z",
		raw: { type: "message", message: { role, stopReason } },
	});
}
function user(
	f: ReturnType<typeof createRuntimeFixture>,
	id: string,
	status: "accepted" | "settled" | "interrupted" = "settled",
) {
	f.store.createRequest(`r-${id}`, id);
	entry(f, id, "user");
	f.store.setRequest(`r-${id}`, "accepted", { entryId: id });
	if (status !== "accepted") f.store.setRequest(`r-${id}`, status);
}
function sources(
	prompt: string,
): { entryId: string; role: string; text: string }[] {
	const line = prompt
		.split("\n")
		.find((line) => line.startsWith("SOURCE DATA: "));
	if (!line) throw Error("Missing source data");
	return JSON.parse(line.slice("SOURCE DATA: ".length));
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test("a memory correction invalidates cached recall even when original source permissions stay valid", async () => {
	const f = createRuntimeFixture();
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
	});
	const lookup = (id: string) => f.store.sourceEntry(id);
	const observe = (id: string, text: string) => {
		f.store.createRequest(`request-${id}`, text);
		entry(f, id, "user", text);
		f.store.setRequest(`request-${id}`, "accepted", { entryId: id });
		f.store.setRequest(`request-${id}`, "settled");
		memory.mind.apply({
			requestId: id,
			expectedRevision: memory.mind.snapshot().revision,
			sourceProofs: captureSourceProofs([id], lookup),
			observations: [
				{
					subject: "user",
					kind: "preference",
					key: "drink",
					text,
					evidence: "explicit",
					sources: [{ entryId: id, quote: text }],
				},
			],
		});
	};
	try {
		observe("tea", "Prefers tea");
		const cached = await memory.recall("drink");
		expect(cached).toContain("Prefers tea");
		expect(memory.recallSourceProofs(cached)).toBeDefined();
		observe("coffee", "Prefers coffee");
		expect(memory.recallSourceProofs(cached)).toBeUndefined();
		expect(memory.status().recallText).toBe("");
		expect(await memory.recall("drink")).toContain("Prefers coffee");
	} finally {
		await memory.close();
		await f.close();
	}
});

// RED: separate assistant jobs included interrupted output and split settled episodes.
test("only complete settled episodes include the last final assistant", async () => {
	const f = createRuntimeFixture();
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
	});
	const seen: string[][] = [];
	memory.configure(async (prompt) => {
		seen.push(sources(prompt).map((e) => e.entryId));
		return "[]";
	});
	try {
		user(f, "interrupted", "interrupted");
		entry(f, "bad", "assistant");
		user(f, "good");
		entry(f, "partial", "assistant", "thinking", "toolUse");
		entry(f, "old-final", "assistant");
		entry(f, "tool", "tool");
		entry(f, "final", "assistant");
		user(f, "busy", "accepted");
		entry(f, "premature", "assistant");
		await memory.refresh();
		expect(seen).toEqual([["good", "final"]]);
		f.store.setRequest("r-busy", "settled");
		await memory.refresh();
		expect(seen).toEqual([
			["good", "final"],
			["busy", "premature"],
		]);
	} finally {
		await memory.close();
		await f.close();
	}
});

// RED: advancing over a user without a request receipt permanently lost that episode.
test("missing request receipt blocks advancement until settlement is known", async () => {
	const f = createRuntimeFixture();
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
	});
	const seen: string[][] = [];
	memory.configure(async (prompt) => {
		seen.push(sources(prompt).map((e) => e.entryId));
		return "[]";
	});
	try {
		entry(f, "unlinked", "user");
		entry(f, "answer", "assistant");
		await memory.refresh();
		expect(seen).toEqual([]);
		f.store.createRequest("late", "unlinked");
		f.store.setRequest("late", "accepted", { entryId: "unlinked" });
		f.store.setRequest("late", "settled");
		await memory.refresh();
		expect(seen).toEqual([["unlinked", "answer"]]);
	} finally {
		await memory.close();
		await f.close();
	}
});

// RED: one refresh synchronously scanned the entire journal and lost page boundaries.
test("scan is bounded and resumes an unfinished episode across restart", async () => {
	const f = createRuntimeFixture();
	const options = {
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
	};
	let memory = new CompanionMemory(options);
	const original = f.store.scanAfter.bind(f.store);
	const positions: number[] = [];
	f.store.scanAfter = (after, limit) => {
		positions.push(after);
		return original(after, limit);
	};
	try {
		user(f, "u");
		for (let i = 0; i < 205; i++) entry(f, `tool-${i}`, "tool");
		entry(f, "a", "assistant");
		await memory.refresh();
		expect(positions).toEqual([0]);
		await memory.close();
		memory = new CompanionMemory(options);
		const seen: string[][] = [];
		memory.configure(async (prompt) => {
			seen.push(sources(prompt).map((e) => e.entryId));
			return "[]";
		});
		await memory.refresh();
		expect(positions).toEqual([0, 100]);
		await memory.refresh();
		expect(positions).toEqual([0, 100, 200]);
		expect(seen).toEqual([["u", "a"]]);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("rejects quotes outside the episode and mismatched exact quotes", async () => {
	for (const source of [
		{ entryId: "outside", quote: "outside" },
		{ entryId: "u", quote: "fabrication" },
	]) {
		const f = createRuntimeFixture();
		const memory = new CompanionMemory({
			path: join(f.root, "mind.sqlite"),
			binding: f.runtime.binding,
			journal: f.store,
		});
		try {
			user(f, "outside", "interrupted");
			user(f, "u");
			memory.configure(async () =>
				JSON.stringify([
					{
						subject: "user",
						kind: "fact",
						key: "claim",
						text: "claim",
						evidence: "explicit",
						sources: [source],
					},
				]),
			);
			await memory.refresh();
			expect(memory.status().failed).toBe(1);
			expect(memory.mind.state().records).toEqual([]);
		} finally {
			await memory.close();
			await f.close();
		}
	}
});

test("overlong source remains visibly failed after reopening", async () => {
	const f = createRuntimeFixture();
	const options = {
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
	};
	let memory = new CompanionMemory(options);
	let calls = 0;
	try {
		user(f, "u");
		entry(f, "large", "assistant", "x".repeat(40000));
		memory.configure(async () => {
			calls++;
			return "[]";
		});
		await memory.refresh();
		expect(calls).toBe(0);
		expect(memory.status().failed).toBe(1);
		expect(memory.detail().processing.error).toContain("budget");
		await memory.close();
		memory = new CompanionMemory(options);
		memory.configure(async () => {
			calls++;
			return "[]";
		});
		expect(memory.status().service).toBe("unavailable");
		expect(f.store.entry("large")?.text.length).toBe(40000);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("close cancels an observer that ignores abort and cannot commit its late result", async () => {
	const f = createRuntimeFixture();
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
	});
	const started = deferred<void>();
	const output = deferred<string>();
	try {
		user(f, "u");
		memory.configure(async () => {
			started.resolve();
			return output.promise;
		});
		const refresh = memory.refresh();
		await started.promise;
		// A close that merely awaits the observer will lose this microtask race.
		let closed = false;
		const closing = memory.close().then(() => {
			closed = true;
		});
		for (let i = 0; i < 30; i++) await Promise.resolve();
		const wasClosed = closed;
		output.resolve("[]");
		await closing;
		await refresh;
		expect(wasClosed).toBe(true);
	} finally {
		output.resolve("[]");
		await memory.close();
		await f.close();
	}
});

function clock() {
	let now = 1000;
	let next = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	return {
		now: () => now,
		schedule: (callback: () => void, delay: number) => {
			const id = next++;
			timers.set(id, { at: now + delay, callback });
			return () => {
				timers.delete(id);
			};
		},
		advance: (ms: number) => {
			now += ms;
			for (const [id, timer] of [...timers])
				if (timer.at <= now) {
					timers.delete(id);
					timer.callback();
				}
		},
		count: () => timers.size,
	};
}
function observation(entryId: string, text: string, key = "drink") {
	return {
		subject: "user" as const,
		kind: "preference" as const,
		key,
		text,
		evidence: "explicit" as const,
		sources: [{ entryId, quote: entryId }],
	};
}

test("concurrent apply discards stale generation and retries with a fresh snapshot", async () => {
	const f = createRuntimeFixture();
	const time = clock();
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		...time,
	});
	const started = deferred<void>();
	const output = deferred<string>();
	let calls = 0;
	const prompts: string[] = [];
	try {
		entry(f, "seed", "user");
		f.store.createRequest("seed-r", "seed");
		f.store.setRequest("seed-r", "accepted", { entryId: "seed" });
		f.store.setRequest("seed-r", "settled");
		memory.configure(async () => "[]");
		await memory.refresh();
		user(f, "u");
		memory.configure(async (prompt) => {
			prompts.push(prompt);
			calls++;
			if (calls === 1) {
				started.resolve();
				return output.promise;
			}
			return JSON.stringify([observation("u", "fresh")]);
		});
		const refresh = memory.refresh();
		await started.promise;
		memory.mind.apply({
			sourceProofs: captureSourceProofs(["seed"], (id) =>
				f.store.sourceEntry(id),
			),
			requestId: "other",
			expectedRevision: 1,
			observations: [observation("seed", "concurrent preference", "other")],
		});
		output.resolve(JSON.stringify([observation("u", "stale")]));
		await refresh;
		expect(memory.status().failed).toBe(1);
		expect(memory.mind.hasReceipt("u")).toBe(false);
		await memory.refresh();
		expect(calls).toBe(1);
		time.advance(1000);
		await memory.refresh();
		expect(calls).toBe(2);
		expect(prompts[1]).toContain("concurrent preference");
		expect(
			memory.mind
				.state()
				.records.map((r) => r.text)
				.sort(),
		).toEqual(["concurrent preference", "fresh"]);
	} finally {
		output.resolve("[]");
		await memory.close();
		await f.close();
	}
});

test("retraction during observation fences regenerated output through retry exhaustion", async () => {
	const f = createRuntimeFixture();
	const time = clock();
	const options = {
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		...time,
	};
	let memory = new CompanionMemory(options);
	const started = deferred<void>();
	const output = deferred<string>();
	let calls = 0;
	try {
		user(f, "u");
		const seed = memory.mind.apply({
			sourceProofs: captureSourceProofs(["u"], (id) => f.store.sourceEntry(id)),
			requestId: "seed",
			expectedRevision: 0,
			observations: [observation("u", "original")],
		});
		memory.configure(async () => {
			calls++;
			if (calls === 1) {
				started.resolve();
				return output.promise;
			}
			return JSON.stringify([observation("u", "regenerated")]);
		});
		const refresh = memory.refresh();
		await started.promise;
		const record = seed.records[0];
		if (!record) throw Error("Missing seeded record");
		memory.mind.retract(record.id, 1);
		output.resolve(JSON.stringify([observation("u", "stale")]));
		await refresh;
		time.advance(1000);
		await memory.refresh();
		time.advance(2000);
		await memory.refresh();
		expect(calls).toBe(3);
		expect(memory.mind.state().records).toEqual([]);
		expect(memory.mind.hasReceipt("u")).toBe(false);
		expect(memory.status().failed).toBe(1);
		expect(await memory.recall("original")).not.toContain("original");
		await memory.close();
		memory = new CompanionMemory(options);
		memory.configure(async () => {
			calls++;
			return "[]";
		});
		time.advance(100000);
		await memory.refresh();
		expect(calls).toBe(3);
		expect(memory.detail().state.records[0]?.status).toBe("retracted");
	} finally {
		output.resolve("[]");
		await memory.close();
		await f.close();
	}
});

test("timeout ignores late output, retries in the background and cancels wakes on close", async () => {
	const f = createRuntimeFixture();
	const time = clock();
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		...time,
	});
	const started = deferred<void>();
	const output = deferred<string>();
	let calls = 0;
	try {
		user(f, "u");
		memory.configure(async () => {
			calls++;
			if (calls === 1) {
				started.resolve();
				return output.promise;
			}
			return "[]";
		});
		const refresh = memory.refresh();
		await started.promise;
		time.advance(60000);
		await refresh;
		expect(memory.status().failed).toBe(1);
		expect(memory.mind.hasReceipt("u")).toBe(false);
		output.resolve(JSON.stringify([observation("u", "late")]));
		time.advance(999);
		expect(calls).toBe(1);
		time.advance(1);
		await memory.refresh();
		expect(calls).toBe(2);
		expect(memory.mind.hasReceipt("u")).toBe(true);
		expect(memory.mind.state().records).toEqual([]);
		await memory.close();
		expect(time.count()).toBe(0);
	} finally {
		output.resolve("[]");
		await memory.close();
		await f.close();
	}
});

// RED: queue done alone previously skipped work when the engine had no receipt.
test("restart reconciles done jobs against actual engine receipts", async () => {
	const f = createRuntimeFixture();
	const path = join(f.root, "mind.sqlite");
	user(f, "u");
	const q = new CompanionQueue(`${path}.queue`, f.runtime.binding, {
		lookup: (id) => f.store.sourceEntry(id),
	});
	q.add("u", ["u"], 1);
	q.start("u");
	q.finish("u", true);
	q.close();
	const memory = new CompanionMemory({
		path,
		binding: f.runtime.binding,
		journal: f.store,
	});
	let calls = 0;
	try {
		memory.configure(async () => {
			calls++;
			return "[]";
		});
		await memory.refresh();
		expect(calls).toBe(1);
		expect(memory.mind.hasReceipt("u")).toBe(true);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("committed receipt recovers a crash on the final queue attempt without generation", async () => {
	const f = createRuntimeFixture();
	const time = clock();
	const path = join(f.root, "mind.sqlite");
	user(f, "u");
	let memory = new CompanionMemory({
		path,
		binding: f.runtime.binding,
		journal: f.store,
		...time,
	});
	memory.mind.apply({
		sourceProofs: captureSourceProofs(["u"], (id) => f.store.sourceEntry(id)),
		requestId: "u",
		expectedRevision: 0,
		observations: [],
	});
	await memory.close();
	const q = new CompanionQueue(`${path}.queue`, f.runtime.binding, {
		...time,
		lookup: (id) => f.store.sourceEntry(id),
	});
	q.add("u", ["u"], 1);
	for (let i = 0; i < 2; i++) {
		q.start("u");
		q.finish("u", false);
		time.advance(10000);
	}
	q.start("u");
	q.close();
	memory = new CompanionMemory({
		path,
		binding: f.runtime.binding,
		journal: f.store,
		...time,
	});
	let calls = 0;
	try {
		memory.configure(async () => {
			calls++;
			return "[]";
		});
		await memory.refresh();
		expect(calls).toBe(0);
		expect(memory.status().accepted).toBe(1);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("scan failure preserves pending work without a zero-delay background loop", async () => {
	const f = createRuntimeFixture();
	const time = clock();
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		...time,
	});
	const scan = f.store.scanAfter.bind(f.store);
	try {
		user(f, "u");
		await memory.refresh();
		memory.configure(async () => "[]");
		f.store.scanAfter = () => {
			throw Error("sqlite unavailable");
		};
		await memory.refresh();
		expect(memory.status().pending).toBe(1);
		expect(memory.status().service).toBe("unavailable");
		expect(time.count()).toBe(0);
		f.store.scanAfter = scan;
		await memory.refresh();
		expect(memory.status().accepted).toBe(1);
	} finally {
		f.store.scanAfter = scan;
		await memory.close();
		await f.close();
	}
});

test("journal episode lookup failure preserves pending work and resumes without dispatching during the outage", async () => {
	const f = createRuntimeFixture();
	const time = clock();
	const memory = new CompanionMemory({
		path: join(f.root, "episode-outage.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		...time,
	});
	const episode = f.store.sourceEpisode.bind(f.store);
	let calls = 0;
	try {
		user(f, "u");
		entry(f, "a", "assistant");
		await memory.refresh();
		memory.configure(async () => {
			calls++;
			return "[]";
		});
		f.store.sourceEpisode = () => {
			f.store.sourceEpisode = episode;
			throw Error("episode lookup unavailable");
		};
		await memory.refresh();
		expect(calls).toBe(0);
		expect(memory.status().pending).toBe(1);
		expect(memory.status().withheld).toBe(0);
		expect(memory.status().service).toBe("unavailable");
		expect(time.count()).toBe(0);
		await memory.refresh();
		expect(calls).toBe(1);
		expect(memory.mind.hasReceipt("u")).toBe(true);
		expect(memory.status().accepted).toBe(1);
	} finally {
		f.store.sourceEpisode = episode;
		await memory.close();
		await f.close();
	}
});

test("background continuation drains more than one job batch", async () => {
	const f = createRuntimeFixture();
	const time = clock();
	const memory = new CompanionMemory({
		path: join(f.root, "mind.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		...time,
	});
	let calls = 0;
	try {
		for (let i = 0; i < 25; i++) user(f, `u-${i}`);
		memory.configure(async () => {
			calls++;
			return "[]";
		});
		await memory.refresh();
		expect(calls).toBe(20);
		expect(memory.status().pending).toBe(5);
		time.advance(0);
		await memory.refresh();
		expect(calls).toBe(25);
		expect(memory.status().accepted).toBe(25);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("manual character evolution still learns user context but does not write self or relationship changes", async () => {
	const f = createRuntimeFixture();
	const memory = new CompanionMemory({
		path: join(f.root, "manual.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		allowCharacterGrowth: () => false,
	});
	memory.configure(async () =>
		JSON.stringify([
			{
				subject: "self",
				kind: "mood",
				key: "curious",
				text: "Curious",
				evidence: "inferred",
				sources: [{ entryId: "u", quote: "tea" }],
			},
			{
				subject: "user",
				kind: "preference",
				key: "drink",
				text: "tea",
				evidence: "explicit",
				sources: [{ entryId: "u", quote: "tea" }],
			},
		]),
	);
	try {
		f.store.createRequest("r", "tea");
		f.store.appendEntry({
			entryId: "u",
			role: "user",
			text: "tea",
			timestamp: new Date().toISOString(),
			raw: {},
		});
		f.store.setRequest("r", "accepted", { entryId: "u" });
		f.store.setRequest("r", "settled");
		await memory.refresh();
		expect(memory.mind.state().records.map((r) => r.subject)).toEqual(["user"]);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("legacy uncorrelated history does not block later settled episodes", async () => {
	const f = createRuntimeFixture();
	const memory = new CompanionMemory({
		path: join(f.root, "legacy.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
	});
	const seen: string[][] = [];
	memory.configure(async (prompt) => {
		seen.push(sources(prompt).map((e) => e.entryId));
		return "[]";
	});
	try {
		entry(f, "legacy", "user");
		entry(f, "legacy-answer", "assistant");
		user(f, "new");
		entry(f, "new-answer", "assistant");
		await memory.refresh();
		await memory.refresh();
		expect(seen).toEqual([["new", "new-answer"]]);
	} finally {
		await memory.close();
		await f.close();
	}
});

test("historical failures do not poison a later successful no-change episode", async () => {
	const f = createRuntimeFixture();
	let now = 1000;
	const memory = new CompanionMemory({
		path: join(f.root, "status.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		now: () => now,
		schedule: () => () => {},
	});
	try {
		memory.configure(async () => {
			throw Error("provider failure");
		});
		user(f, "old");
		for (let i = 0; i < 3; i++) {
			await memory.refresh();
			now += 30000;
		}
		memory.configure(async () => "[]");
		user(f, "new");
		await memory.refresh();
		expect(memory.status().service).toBe("ready");
		expect(memory.detail().processing).toMatchObject({
			failed: 1,
			unchanged: 1,
			changed: 0,
		});
	} finally {
		await memory.close();
		await f.close();
	}
});

test("native preference stage survives observation failure and is not replayed after reopen", async () => {
	const f = createRuntimeFixture();
	let now = 1000;
	const options = {
		path: join(f.root, "stages.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		now: () => now,
		schedule: () => () => {},
	};
	let m = new CompanionMemory(options);
	let saved = false,
		calls = 0;
	const preferences = {
		resetRevision: () => 0,
		hasReceipt: () => saved,
		receiptWithheld: () => false,
		process: async () => {
			calls++;
			saved = true;
			return true;
		},
	};
	try {
		m.configure(async () => {
			throw Error("offline");
		}, preferences);
		user(f, "u");
		await m.refresh();
		expect(saved).toBe(true);
		expect(m.status().failed).toBe(1);
		await m.close();
		now += 30000;
		m = new CompanionMemory(options);
		m.configure(async () => "[]", preferences);
		await m.refresh();
		expect(calls).toBe(1);
		expect(m.status().accepted).toBe(1);
	} finally {
		await m.close();
		await f.close();
	}
});

test("validation retry explains duplicate slots to observer without weakening validation", async () => {
	const f = createRuntimeFixture();
	let now = 1000,
		calls = 0;
	const m = new CompanionMemory({
		path: join(f.root, "feedback.sqlite"),
		binding: f.runtime.binding,
		journal: f.store,
		now: () => now,
		schedule: () => () => {},
	});
	try {
		user(f, "u");
		m.configure(async (prompt) => {
			calls++;
			const o = {
				subject: "user",
				kind: "preference",
				key: "p",
				text: "u",
				evidence: "explicit",
				sources: [{ entryId: "u", quote: "u" }],
			};
			if (calls === 1) return JSON.stringify([o, o]);
			expect(prompt).toContain("duplicate_observation_slot");
			return JSON.stringify([o]);
		});
		await m.refresh();
		expect(m.mind.recordCount()).toBe(0);
		now += 30000;
		await m.refresh();
		expect(m.mind.recordCount()).toBe(1);
	} finally {
		await m.close();
		await f.close();
	}
});

function createRuntimeFixture() {
	const f = baseFixture();
	trustNativeFixture(f.store, f.runtime.binding);
	return f;
}
