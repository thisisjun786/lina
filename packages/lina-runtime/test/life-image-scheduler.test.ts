import { expect, test } from "bun:test";
import type { LifeImageAttempt } from "../../lina-core/src/world/image-attempt-types.ts";
import type { LifeImageIntent } from "../../lina-core/src/world/image-types.ts";
import type { ImageJob } from "../src/images/contracts.ts";
import type { LifeImageDiscoveryCandidate } from "../src/images/life-discovery.ts";
import { visitLifeImages } from "../src/images/life-scheduler.ts";
import { RuntimeClock } from "./life-runtime-fixture.ts";

function fixture() {
	const clock = new RuntimeClock();
	const calls: string[] = [];
	let attempts: LifeImageAttempt[] = [];
	const candidates: LifeImageDiscoveryCandidate[] = [];
	const intents = new Map<string, LifeImageIntent>();
	const options = {
		clock,
		foreground: () => false,
		store: {
			imageAttempts: () => attempts,
			imageIntent: (_world: string, id: string) => intents.get(id) ?? null,
		},
		discovery: {
			preview: () => ({
				status: "ready" as const,
				candidates,
				dueAtMs: 1000,
				maxJobsPerVisit: 1,
			}),
			freeze: (_world: string, candidate: LifeImageDiscoveryCandidate) => {
				calls.push(`freeze:${candidate.intentId}`);
				const intent = intents.get(candidate.intentId);
				if (!intent) throw Error("Missing fixture intent");
				return intent;
			},
		},
		images: {
			read: () => ({ state: "completed" }) as ImageJob,
			async run(_world: string, id: string) {
				calls.push(`run:${id}`);
				return { state: "completed" } as ImageJob;
			},
			async resume(_world: string, id: string) {
				calls.push(`resume:${id}`);
				return { state: "uncertain" } as ImageJob;
			},
			async reconcile(_world: string, id: string) {
				calls.push(`reconcile:${id}`);
				return { state: "completed" } as ImageJob;
			},
		},
		completed: (job: ImageJob) => {
			calls.push(`complete:${job.state}`);
		},
		onError: (_id: string, _error: unknown) => {
			calls.push("error");
		},
	};
	return {
		options,
		calls,
		candidates,
		intents,
		setAttempts(value: LifeImageAttempt[]) {
			attempts = value;
		},
	};
}

// Port tests exercise scheduling decisions; storage/authority is checked by real runtime fixtures.
function saved(id: string, state: "prepared" | "queued", manual = false) {
	return {
		attempt: {
			attemptId: id,
			intentId: id,
			jobId: `uuid-${id}`,
			observation: { state },
			delivery: { kind: "pending" },
		} as LifeImageAttempt,
		intent: {
			intentId: id,
			requestKey: manual ? "manual-operation" : null,
			owner: { kind: "life", worldId: "world", agentId: "lina" },
		} as LifeImageIntent,
	};
}

test("recovery visits original UUID work before new candidates and does not retry an unknown outcome", async () => {
	const f = fixture();
	const old = saved("original", "queued");
	f.setAttempts([old.attempt]);
	f.intents.set("original", old.intent);
	const next = await visitLifeImages(
		f.options,
		"world",
		new AbortController().signal,
	);
	expect(f.calls).toEqual(["resume:original"]);
	expect(next).toBe(1000);
});

test("scheduled recovery preserves a prepared manual request without submitting it", async () => {
	const f = fixture();
	const old = saved("manual", "prepared", true);
	f.setAttempts([old.attempt]);
	f.intents.set("manual", old.intent);
	await visitLifeImages(f.options, "world", new AbortController().signal);
	expect(f.calls).toEqual([]);
});

test("a visit respects the configured job allowance and foreground suppresses all work", async () => {
	const f = fixture();
	for (const id of ["first", "second"]) {
		f.intents.set(id, saved(id, "prepared").intent);
		f.candidates.push({
			intentId: id,
			source: null,
			agentId: "lina",
			visualAgentIds: ["lina"],
			reason: "test",
		});
	}
	await visitLifeImages(f.options, "world", new AbortController().signal);
	expect(f.calls).toEqual(["freeze:first", "run:first", "complete:completed"]);
	f.calls.length = 0;
	f.options.foreground = () => true;
	await visitLifeImages(f.options, "world", new AbortController().signal);
	expect(f.calls).toEqual([]);
});
