import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	ContextStore,
	type SourceRef,
} from "../../lina-core/src/context/index.ts";
import { appendContextEntry } from "../../lina-core/test/context-journal-fixture.ts";
import { createSummaryTree } from "../src/context/tree.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("summarization consumes the complete source projection including its final page", async () => {
	const f = createRuntimeFixture();
	const store = new ContextStore(
		join(f.root, "context-complete.sqlite"),
		f.runtime.binding,
		(id) => f.store.sourceEntry(id),
	);
	try {
		const text =
			"Early background. ".repeat(6000) +
			"\nFinal correction: use violet, not blue. UNIQUE-END-927";
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "long",
			role: "user",
			text,
			timestamp: "2026-09-06T00:00:00Z",
			raw: { type: "message", message: { role: "user", content: text } },
		});
		const inputs: string[] = [];
		await createSummaryTree(
			[{ kind: "entry", id: "long" }],
			store,
			async (input) => {
				inputs.push(input);
				return "Decisions archived with original source references.";
			},
			new AbortController().signal,
			() => true,
		);
		expect(inputs.some((input) => input.includes("UNIQUE-END-927"))).toBe(true);
		expect(inputs.every((input) => input.length <= 32768)).toBe(true);
		expect(
			store.expand({ kind: "entry", id: "long" }).nextOffset,
		).not.toBeNull();
	} finally {
		store.close();
		await f.close();
	}
});

test("a thousand sources and a megabyte entry form a bounded tree with every original reachable", async () => {
	const f = createRuntimeFixture();
	const store = new ContextStore(
		join(f.root, "context.sqlite"),
		f.runtime.binding,
		(id) => f.store.sourceEntry(id),
	);
	try {
		const sources: SourceRef[] = [];
		for (let index = 0; index < 1000; index++) {
			const id = `entry-${index}`,
				text =
					index === 0
						? "Source original. ".repeat(65536)
						: `Important decision ${index}. `;
			appendContextEntry(f.store, f.runtime.binding.sessionId, {
				entryId: id,
				role: "user",
				text,
				timestamp: "2026-09-05T00:00:00Z",
				raw: { type: "message", message: { role: "user", content: text } },
			});
			sources.push({ kind: "entry", id });
		}
		const inputs: number[] = [];
		const root = await createSummaryTree(
			sources,
			store,
			async (text) => {
				inputs.push(text.length);
				return "Archived decisions and unfinished work; inspect linked originals for specifics.";
			},
			new AbortController().signal,
			(summary) => summary.length < 8192,
		);
		expect(Math.max(...inputs)).toBeLessThanOrEqual(32768);
		expect(root.sources.every((ref) => ref.kind === "summary")).toBe(true);
		const found = new Set<string>(),
			pending: SourceRef[] = [{ kind: "summary", id: root.id }];
		while (pending.length) {
			const ref = pending.shift();
			if (!ref) throw new Error("missing source");
			if (ref.kind === "entry") {
				found.add(ref.id);
				continue;
			}
			let sourceOffset = 0;
			while (true) {
				const page = store.expand(ref, { sourceOffset });
				expect(page.text.length).toBeLessThanOrEqual(4096);
				expect(page.sources.length).toBeLessThanOrEqual(16);
				pending.push(...page.sources);
				if (page.nextSourceOffset === null) break;
				sourceOffset = page.nextSourceOffset;
			}
		}
		expect(found).toEqual(new Set(sources.map((ref) => ref.id)));
		expect(f.store.entry("entry-0")?.text.length).toBeGreaterThan(1_000_000);
	} finally {
		store.close();
		await f.close();
	}
}, 30_000); // Real journal provenance adds durable request/association transactions.

test("unchanged source summaries reuse successful cached nodes but recheck active budget", async () => {
	const f = createRuntimeFixture();
	const store = new ContextStore(
		join(f.root, "cached.sqlite"),
		f.runtime.binding,
		(id) => f.store.sourceEntry(id),
	);
	try {
		appendContextEntry(f.store, f.runtime.binding.sessionId, {
			entryId: "cached",
			role: "user",
			text: "Saved decisions. ".repeat(100),
			timestamp: new Date().toISOString(),
			raw: {},
		});
		let calls = 0;
		const call = async () => {
			calls++;
			return "Stable decision summary.";
		};
		const refs: SourceRef[] = [{ kind: "entry", id: "cached" }];
		const first = await createSummaryTree(
			refs,
			store,
			call,
			new AbortController().signal,
			() => true,
			"profile-v1",
		);
		const second = await createSummaryTree(
			refs,
			store,
			call,
			new AbortController().signal,
			() => true,
			"profile-v1",
		);
		expect(second.id).toBe(first.id);
		expect(calls).toBe(1);
		await expect(
			createSummaryTree(
				refs,
				store,
				call,
				new AbortController().signal,
				() => false,
				"profile-v1",
			),
		).rejects.toThrow();
	} finally {
		store.close();
		await f.close();
	}
});
