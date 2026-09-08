import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ContextStore } from "../../lina-core/src/context/index.ts";
import { appendContextEntry } from "../../lina-core/test/context-journal-fixture.ts";
import { ContextCoordinator } from "../src/context/coordinator.ts";
import { ExternalContext } from "../src/context/external.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
function setup() {
	const f = createRuntimeFixture();
	const context = new ContextStore(
		join(f.root, "external.sqlite"),
		f.runtime.binding,
		(id) => f.store.sourceEntry(id),
	);
	cleanups.push(async () => {
		context.close();
		await f.close();
	});
	const add = (id: string, text: string) =>
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: id,
			role: "user",
			text,
			timestamp: new Date().toISOString(),
			raw: {
				type: "message",
				message: { role: "user", content: [{ type: "text", text }] },
			},
		});
	return { ...f, context, add };
}
test("external summaries survive restart without claiming a native receipt, and preserve correction sources", async () => {
	const f = setup();
	f.add("promise", "금요일에 보고하기로 약속함. 선택 이유는 월말 정산이다.");
	let calls = 0;
	const summarizer = async (text: string) => {
		calls++;
		return text.includes("화요일")
			? "보고일은 화요일로 정정됐다. 원래 이유는 월말 정산."
			: "금요일 보고 약속. 이유는 월말 정산.";
	};
	const first = new ExternalContext(f.context, f.store, summarizer, {
		thresholdChars: 1,
	});
	await first.refresh(new AbortController().signal);
	const id = f.context.active()?.id;
	expect(id).toBeDefined();
	expect(first.injection()).toContain("금요일");
	const resumed = new ExternalContext(f.context, f.store, summarizer, {
		thresholdChars: 1,
	});
	await resumed.refresh(new AbortController().signal);
	expect(calls).toBe(1);
	f.add("correction", "보고일을 화요일로 변경한다. 이전 금요일 약속은 취소.");
	await resumed.refresh(new AbortController().signal);
	const active = f.context.active();
	expect(active?.id).not.toBe(id);
	expect(f.context.get(active?.id ?? "")?.sources).toContainEqual({
		kind: "summary",
		id: id ?? "",
	});
	expect(f.context.expand({ kind: "entry", id: "promise" }).text).toContain(
		"월말 정산",
	);
	expect(f.context.expand({ kind: "entry", id: "correction" }).text).toContain(
		"화요일",
	);
	const coordinator = new ContextCoordinator({
		store: f.context,
		busy: () => false,
		compact: async () => {},
		external: resumed,
	});
	coordinator.restore([]);
	expect(coordinator.state().status).toBe("accepted");
	expect(coordinator.state().recoveryNeeded).toBe(false);
	coordinator.close();
});
test("summary failure and aborted calls preserve previous external checkpoint and originals", async () => {
	const f = setup();
	f.add("one", "original promise");
	const first = new ExternalContext(
		f.context,
		f.store,
		async () => "First summary",
		{ thresholdChars: 1 },
	);
	await first.refresh(new AbortController().signal);
	const active = f.context.active();
	f.add("two", "second detail");
	const broken = new ExternalContext(
		f.context,
		f.store,
		async () => {
			throw Error("offline");
		},
		{ thresholdChars: 1 },
	);
	await expect(broken.refresh(new AbortController().signal)).rejects.toThrow();
	expect(f.context.active()).toEqual(active);
	expect(f.store.entry("two")?.text).toBe("second detail");
	const aborted = AbortSignal.abort();
	expect(() => first.refresh(aborted)).toThrow();
	expect(f.context.active()).toEqual(active);
});

test("summary outage degrades context visibly while the next assistant turn remains available", async () => {
	const f = setup();
	f.add("first", "A promise still matters");
	const stable = new ExternalContext(
		f.context,
		f.store,
		async () => "Keep the promise",
		{ thresholdChars: 1 },
	);
	await stable.refresh(new AbortController().signal);
	f.add("later", "Additional source");
	const failing = new ExternalContext(
		f.context,
		f.store,
		async () => {
			throw Error("provider offline");
		},
		{ thresholdChars: 1 },
	);
	const coordinator = new ContextCoordinator({
		store: f.context,
		busy: () => false,
		compact: async () => {},
		external: failing,
	});
	await coordinator.refreshExternal(new AbortController().signal);
	expect(coordinator.state().status).toBe("failed");
	expect(coordinator.state().recoveryNeeded).toBe(true);
	expect(failing.injection()).toContain("Keep the promise");
	await expect(
		coordinator.refreshExternal(AbortSignal.abort()),
	).rejects.toThrow();
	coordinator.close();
});

test("an invalid external checkpoint rebuilds from existing journal sources without retaining broken ancestry", async () => {
	const f = setup();
	f.add("real", "The recoverable original");
	const broken = f.context.stage({
		kind: "model",
		text: "Invalid old summary",
		sources: [{ kind: "entry", id: "real" }],
	});
	f.context.activate({
		id: broken.id,
		nativeEntryId: `external:${broken.id}`,
		firstKeptEntryId: "missing-source",
		expectedActiveId: null,
	});
	const external = new ExternalContext(
		f.context,
		f.store,
		async () => "Rebuilt from the recoverable original",
	);
	expect(external.valid()).toBe(false);
	await external.refresh(new AbortController().signal);
	expect(external.valid()).toBe(true);
	expect(f.context.get(f.context.active()?.id ?? "")?.sources).toEqual([
		{ kind: "entry", id: "real" },
	]);
});

test("external summary injection is included in budget metrics and omitted when no headroom remains", async () => {
	const f = setup();
	f.add("entry", "original");
	const external = new ExternalContext(
		f.context,
		f.store,
		async () => "summary",
		{ thresholdChars: 1 },
	);
	await external.refresh(new AbortController().signal);
	const coordinator = new ContextCoordinator({
		store: f.context,
		external,
		busy: () => false,
		compact: async () => {},
	});
	const services = {
		estimateText: (text: string) => text.length,
		estimateMessages: () => 0,
		systemTokens: 0,
		contextWindow: 10000,
		reserveTokens: 1,
		summarize: async () => "summary",
		prepare: () => {
			throw Error("unused native preparation");
		},
	};
	coordinator.configure(services);
	const text = coordinator.injection([]);
	expect(text).toContain("summary");
	expect(coordinator.state().injectionTokens).toBe(text.length);
	services.contextWindow = 1;
	expect(coordinator.injection([])).toBe("");
	expect(coordinator.state().injectionOmitted).toBe(true);
	coordinator.close();
});

test("a successful root cannot hide a failed summary leaf", async () => {
	const f = setup();
	f.add("one", "Original stable promise");
	const stable = new ExternalContext(
		f.context,
		f.store,
		async () => "Stable promise",
		{ thresholdChars: 1 },
	);
	await stable.refresh(new AbortController().signal);
	const active = f.context.active();
	f.add("long", "New details ".repeat(4000));
	let calls = 0;
	const broken = new ExternalContext(
		f.context,
		f.store,
		async () => {
			if (++calls <= 2) throw Error("leaf outage");
			return "Later model calls succeeded";
		},
		{ thresholdChars: 1 },
	);
	await expect(broken.refresh(new AbortController().signal)).rejects.toThrow(
		/summary/,
	);
	expect(f.context.active()).toEqual(active);
	expect(f.store.entry("long")?.text).toContain("New details");
});

test("external injection reserves space already occupied by native context", async () => {
	const f = setup();
	f.add("one", "Keep this durable promise");
	const external = new ExternalContext(
		f.context,
		f.store,
		async () => "Durable promise",
		{ thresholdChars: 1 },
	);
	await external.refresh(new AbortController().signal);
	const coordinator = new ContextCoordinator({
		store: f.context,
		busy: () => false,
		compact: async () => {},
		external,
		nativeTokens: () => 9950,
	});
	coordinator.configure({
		contextWindow: 10000,
		reserveTokens: 100,
		systemTokens: 0,
		estimateText: (t) => t.length,
		estimateMessages: () => 0,
		summarize: async () => "summary",
		prepare: () => {
			throw Error("unused");
		},
	});
	expect(coordinator.injection([])).toBe("");
	expect(coordinator.state().injectionOmitted).toBe(true);
	coordinator.close();
});

test("policy changes rebuild an external checkpoint without new messages and retain a fresh tail", async () => {
	const { defaultEnginePolicy } = await import(
		"../src/context/policy-settings.ts"
	);
	const f = setup();
	f.add("old-a", "Initial decision A.");
	f.add("old-b", "Correction B and why.");
	f.add("fresh", "Keep this original promise.");
	let policy = {
		...defaultEnginePolicy(),
		context: {
			...defaultEnginePolicy().context,
			refreshThresholdTokens: 1,
			freshTailEntries: 1,
		},
	};
	const inputs: string[] = [];
	const external = new ExternalContext(
		f.context,
		f.store,
		async (text) => {
			inputs.push(text);
			return "Decision B.";
		},
		{ policy: () => policy, routeKey: () => "fixture-route" },
	);
	await external.refresh(new AbortController().signal);
	expect(
		inputs.some((text) => text.includes("Keep this original promise")),
	).toBe(false);
	expect(f.context.active()?.firstKeptEntryId).toBe("old-b");
	const previous = f.context.active()?.id;
	policy = {
		...policy,
		revision: 1,
		context: { ...policy.context, leafOutputTokens: 77 },
	};
	await external.refresh(new AbortController().signal);
	expect(f.context.active()?.id).not.toBe(previous);
	expect(inputs.length).toBe(2);
	external.close();
});

test("fresh tail is source guarded and omitted when native message identity is unavailable", async () => {
	const { defaultEnginePolicy } = await import(
		"../src/context/policy-settings.ts"
	);
	const f = setup();
	f.add("archived", "An older decision.");
	f.add("tail", "Fresh promise UNSEEN.");
	const policy = {
		...defaultEnginePolicy(),
		context: {
			...defaultEnginePolicy().context,
			refreshThresholdTokens: 1,
			freshTailEntries: 1,
		},
	};
	const external = new ExternalContext(
		f.context,
		f.store,
		async () => "Older decision.",
		{ policy: () => policy },
	);
	await external.refresh(new AbortController().signal);
	const visible = external.tail([{ entryId: "archived" }]);
	expect(visible.text).toContain("Fresh promise UNSEEN");
	visible.beforeDeliver();
	expect(external.tail([{ content: "opaque native history" }]).reason).toBe(
		"tail_dedup_unavailable",
	);
	expect(external.tail([{ entryId: "tail" }]).text).toBe("");
	external.close();
});

test("a policy change during summary never replaces the previous checkpoint", async () => {
	const { defaultEnginePolicy } = await import(
		"../src/context/policy-settings.ts"
	);
	const f = setup();
	f.add("original", "Original decision.");
	let policy = {
			...defaultEnginePolicy(),
			context: {
				...defaultEnginePolicy().context,
				refreshThresholdTokens: 1,
				freshTailEntries: 0,
			},
		},
		change = false,
		calls = 0;
	const external = new ExternalContext(
		f.context,
		f.store,
		async () => {
			calls++;
			if (change) policy = { ...policy, revision: policy.revision + 1 };
			return "Decision.";
		},
		{ policy: () => policy, routeKey: () => "model" },
	);
	await external.refresh(new AbortController().signal);
	const previous = f.context.active();
	f.add("new", "New decision.");
	change = true;
	await expect(external.refresh(new AbortController().signal)).rejects.toThrow(
		/policy changed/,
	);
	expect(f.context.active()).toEqual(previous);
	expect(calls).toBe(2);
	external.close();
});

test("route changes after staging cannot activate a summary from the previous generation", async () => {
	const { spyOn } = await import("bun:test");
	const { defaultEnginePolicy } = await import(
		"../src/context/policy-settings.ts"
	);
	const f = setup();
	f.add("original", "Original.");
	let route = "old";
	const policy = {
		...defaultEnginePolicy(),
		context: {
			...defaultEnginePolicy().context,
			refreshThresholdTokens: 1,
			freshTailEntries: 0,
		},
	};
	const external = new ExternalContext(
		f.context,
		f.store,
		async () => "Summary.",
		{ policy: () => policy, routeKey: () => route },
	);
	await external.refresh(new AbortController().signal);
	const before = f.context.active();
	f.add("next", "New source.");
	const original = f.context.stage.bind(f.context),
		stage = spyOn(f.context, "stage").mockImplementation((input) => {
			const result = original(input);
			route = "new";
			return result;
		});
	try {
		await expect(
			external.refresh(new AbortController().signal),
		).rejects.toThrow(/generation/);
		expect(f.context.active()).toEqual(before);
	} finally {
		stage.mockRestore();
		external.close();
	}
});

test("the injection policy also bounds external summaries rather than only working memory", async () => {
	const { defaultEnginePolicy } = await import(
		"../src/context/policy-settings.ts"
	);
	const { conservativeEstimator } = await import("../src/context/budget.ts");
	const f = setup();
	f.add("large", "Original detail. ".repeat(200));
	const policy = {
		...defaultEnginePolicy(),
		context: {
			...defaultEnginePolicy().context,
			injectionTokens: 128,
			refreshThresholdTokens: 1,
			freshTailEntries: 0,
		},
	};
	const external = new ExternalContext(
		f.context,
		f.store,
		async () => "SUMMARY".repeat(100),
		{ policy: () => policy },
	);
	await external.refresh(new AbortController().signal);
	const coordinator = new ContextCoordinator({
		store: f.context,
		external,
		policy: () => policy,
		busy: () => false,
		compact: async () => {},
	});
	coordinator.configure({
		estimator: conservativeEstimator,
		estimateText: conservativeEstimator.text,
		estimateMessages: conservativeEstimator.messages,
		systemTokens: 0,
		contextWindow: 10000,
		reserveTokens: 0,
		summarize: async () => "",
		prepare() {
			throw Error("unused");
		},
	});
	expect(coordinator.injection([])).toBe("");
	expect(coordinator.state().omittedParts).toContain("external");
	coordinator.close();
});
