import { expect, test } from "bun:test";
import type {
	ImageArchiveRecord,
	ImageCountRecord,
} from "../../lina-core/src/world/image-accounting-types.ts";
import type { LifeImageAttempt } from "../../lina-core/src/world/image-attempt-types.ts";
import type { LifeImageIntent } from "../../lina-core/src/world/image-types.ts";
import type { ImageJob } from "../src/images/contracts.ts";
import { archiveEligible } from "../src/images/image-store-schema.ts";
import { IMAGE_POLL_MS } from "../src/images/jobs.ts";
import type { LifeImageDiscoveryCandidate } from "../src/images/life-discovery.ts";
import { visitLifeImages } from "../src/images/life-scheduler.ts";
import { RuntimeClock } from "./life-runtime-fixture.ts";

function job(input: {
	state: ImageJob["state"];
	delivery?: ImageJob["delivery"];
	resultFilename?: string | null;
}): ImageJob {
	return {
		state: input.state,
		delivery: input.delivery ?? { kind: "life", receiptId: "receipt" },
		owner: { kind: "life", worldId: "world", agentId: "lina" },
		resultFilename: input.resultFilename ?? null,
	} as ImageJob;
}

function fixture(preview?: {
	status: "not_configured" | "hold" | "ready" | "quiet";
	dueAtMs: number | null;
	maxJobsPerVisit: number;
}) {
	const clock = new RuntimeClock();
	const calls: string[] = [];
	let attempts: LifeImageAttempt[] = [];
	const candidates: LifeImageDiscoveryCandidate[] = [];
	const intents = new Map<string, LifeImageIntent>();
	const jobs = new Map<string, ImageJob>();
	const archived = new Set<string>();
	const options = {
		clock,
		foreground: () => false,
		store: {
			imageIntentAllowed: () => true,
			imageAttempts: () => attempts,
			imageIntent: (_world: string, id: string) => intents.get(id) ?? null,
			imageAttemptCount: (_world: string, attemptId: string) =>
				archived.has(attemptId)
					? ({ archived: true } as ImageCountRecord)
					: null,
		},
		discovery: {
			preview: () => ({
				status: preview?.status ?? ("ready" as const),
				candidates,
				dueAtMs: preview === undefined ? 1000 : preview.dueAtMs,
				maxJobsPerVisit: preview === undefined ? 1 : preview.maxJobsPerVisit,
			}),
			freeze: (_world: string, candidate: LifeImageDiscoveryCandidate) => {
				calls.push(`freeze:${candidate.intentId}`);
				const intent = intents.get(candidate.intentId);
				if (!intent) throw Error("Missing fixture intent");
				return intent;
			},
		},
		images: {
			read(_world: string, attemptId: string) {
				calls.push(`read:${attemptId}`);
				const current = jobs.get(attemptId);
				if (!current) throw Error("Missing fixture job");
				return current;
			},
			archive(_world: string, attemptId: string) {
				calls.push(`archive:${attemptId}`);
				archived.add(attemptId);
				return { acknowledged: true } as ImageArchiveRecord;
			},
			async run(_world: string, id: string) {
				calls.push(`run:${id}`);
				return job({ state: "completed" });
			},
			async resume(_world: string, id: string) {
				calls.push(`resume:${id}`);
				return (
					jobs.get(id) ??
					job({ state: "uncertain", delivery: { kind: "pending" } })
				);
			},
			async reconcile(_world: string, id: string) {
				calls.push(`reconcile:${id}`);
				return jobs.get(id) ?? job({ state: "completed" });
			},
		},
		completed: (current: ImageJob) => {
			calls.push(`complete:${current.state}`);
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
		jobs,
		archived,
		setAttempts(value: LifeImageAttempt[]) {
			attempts = value;
		},
	};
}

function saved(
	id: string,
	state: NonNullable<LifeImageAttempt["observation"]>["state"],
	input?: {
		manual?: boolean;
		delivery?: LifeImageAttempt["delivery"]["kind"];
		resultFilename?: string | null;
		agentId?: string;
	},
) {
	return {
		attempt: {
			attemptId: id,
			intentId: id,
			jobId: `uuid-${id}`,
			observation: {
				state,
				resultFilename: input?.resultFilename ?? null,
			},
			delivery: { kind: input?.delivery ?? "pending" },
		} as LifeImageAttempt,
		intent: {
			intentId: id,
			requestKey: input?.manual ? "manual-operation" : null,
			owner: {
				kind: "life",
				worldId: "world",
				agentId: input?.agentId ?? "lina",
			},
		} as LifeImageIntent,
	};
}

test("generation settings disabled still recover uncertain work without a new POST", async () => {
	const f = fixture({
		status: "not_configured",
		dueAtMs: null,
		maxJobsPerVisit: 0,
	});
	const old = saved("original", "uncertain");
	f.setAttempts([old.attempt]);
	f.intents.set("original", old.intent);
	f.jobs.set(
		"original",
		job({ state: "uncertain", delivery: { kind: "pending" } }),
	);
	f.intents.set("fresh", saved("fresh", "prepared").intent);
	f.candidates.push({
		intentId: "fresh",
		source: null,
		agentId: "lina",
		visualAgentIds: ["lina"],
		reason: "test",
	});
	const next = await visitLifeImages(
		f.options,
		"world",
		new AbortController().signal,
	);
	expect(f.calls).toEqual(["resume:original"]);
	expect(next).toBe(IMAGE_POLL_MS);
});

test("a delivered terminal is archived once and does not retrigger destination or generation", async () => {
	const f = fixture();
	const done = saved("done", "completed", { delivery: "avatar" });
	f.setAttempts([done.attempt]);
	f.intents.set("done", done.intent);
	const archivedJob = job({ state: "completed" });
	expect(archiveEligible(archivedJob)).toBe(true);
	f.jobs.set("done", archivedJob);
	const first = await visitLifeImages(
		f.options,
		"world",
		new AbortController().signal,
	);
	expect(f.calls).toEqual(["read:done", "archive:done"]);
	expect(first).toBe(1000);
	f.calls.length = 0;
	const second = await visitLifeImages(
		f.options,
		"world",
		new AbortController().signal,
	);
	expect(f.calls).toEqual([]);
	expect(second).toBe(1000);
});

test("pending completed delivery is preserved before archive and failed recoverable output is not archived", async () => {
	const f = fixture({
		status: "hold",
		dueAtMs: 1000,
		maxJobsPerVisit: 0,
	});
	const pending = saved("pending", "completed");
	const failed = saved("failed", "failed", { resultFilename: "result.png" });
	const cancelled = saved("cancelled", "cancelled");
	f.setAttempts([pending.attempt, failed.attempt, cancelled.attempt]);
	f.intents.set("pending", pending.intent);
	f.intents.set("failed", failed.intent);
	f.intents.set("cancelled", cancelled.intent);
	f.jobs.set("pending", job({ state: "completed" }));
	f.jobs.set(
		"failed",
		job({
			state: "failed",
			delivery: { kind: "pending" },
			resultFilename: "result.png",
		}),
	);
	f.jobs.set("cancelled", job({ state: "cancelled" }));
	expect(archiveEligible(f.jobs.get("failed") as ImageJob)).toBe(false);
	expect(archiveEligible(f.jobs.get("cancelled") as ImageJob)).toBe(true);
	await visitLifeImages(f.options, "world", new AbortController().signal);
	expect(f.calls).toEqual([
		"read:pending",
		"complete:completed",
		"archive:pending",
		"resume:failed",
		"read:cancelled",
		"archive:cancelled",
	]);
});

test("archive and recovery errors do not request an immediate revisit", async () => {
	const f = fixture({
		status: "hold",
		dueAtMs: 4000,
		maxJobsPerVisit: 0,
	});
	const done = saved("done", "failed");
	f.setAttempts([done.attempt]);
	f.intents.set("done", done.intent);
	f.jobs.set("done", job({ state: "failed" }));
	f.options.images.archive = () => {
		f.calls.push("archive:done");
		throw Error("archive capacity");
	};
	const next = await visitLifeImages(
		f.options,
		"world",
		new AbortController().signal,
	);
	expect(f.calls).toEqual(["read:done", "archive:done", "error"]);
	expect(next).toBe(4000);
});

test("prepared automatic work still consumes admission while later retained recovery continues", async () => {
	const f = fixture({
		status: "ready",
		dueAtMs: 1000,
		maxJobsPerVisit: 1,
	});
	const prepared = saved("prepared", "prepared");
	const queued = saved("queued", "queued", { agentId: "other" });
	f.setAttempts([prepared.attempt, queued.attempt]);
	f.intents.set("prepared", prepared.intent);
	f.intents.set("queued", queued.intent);
	f.jobs.set(
		"prepared",
		job({ state: "prepared", delivery: { kind: "pending" } }),
	);
	f.jobs.set("queued", job({ state: "queued", delivery: { kind: "pending" } }));
	f.intents.set("fresh", saved("fresh", "prepared").intent);
	f.candidates.push({
		intentId: "fresh",
		source: null,
		agentId: "fresh-agent",
		visualAgentIds: ["fresh-agent"],
		reason: "test",
	});
	await visitLifeImages(f.options, "world", new AbortController().signal);
	expect(f.calls).toEqual(["resume:prepared", "resume:queued"]);
});
