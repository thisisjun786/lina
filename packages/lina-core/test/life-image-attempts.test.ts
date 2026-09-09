import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ImageAttempts } from "../src/world/image-attempts.ts";
import {
	artifact,
	attemptFixture,
	jobId,
	nextJobId,
	sample,
} from "./life-image-attempt-fixture.test.ts";

// Stable identity oracle is independent of the production digest helper.
function expectedId(worldId: string, intentId: string, n: number) {
	return `life-image-attempt-${createHash("sha256")
		.update(JSON.stringify({ attemptNumber: n, intentId, worldId }))
		.digest("hex")}`;
}

test("logical attempt precedes UUID, retains concrete intent, and new run keys cannot regenerate", () => {
	const f = attemptFixture();
	try {
		const first = f.tx(() => f.ledger.prepare(f.input));
		expect(first.attemptId).toBe(
			expectedId("test-world", f.intent.intentId, 1),
		);
		expect(first.jobId).toBeNull();
		expect(first.attemptNumber).toBe(1);
		expect(first.owner).toEqual(f.intent.owner);
		expect(first.briefDigest).toBe(f.intent.briefDigest);
		const linked = f.tx(() =>
			f.ledger.link("test-world", first.attemptId, jobId),
		);
		expect(linked.jobId).toBe(jobId);
		expect(f.tx(() => f.ledger.prepare(f.input))).toEqual(first);
		expect(
			f.tx(() => f.ledger.prepare({ ...f.input, requestKey: "later-run" }))
				.attemptId,
		).toBe(first.attemptId);
		expect(f.ledger.list("test-world", f.intent.intentId)).toHaveLength(1);
		const r = f.reopen();
		try {
			r.ledger.validate();
			expect(r.ledger.head("test-world", f.intent.intentId)?.jobId).toBe(jobId);
		} finally {
			r.db.close();
		}
	} finally {
		f.close();
	}
});

test("caller rollback removes attempt and request receipt; writes require a transaction", () => {
	const f = attemptFixture();
	try {
		expect(() => f.ledger.prepare(f.input)).toThrow(/transaction/i);
		expect(() =>
			f.tx(() => {
				f.ledger.prepare(f.input);
				throw Error("abort");
			}),
		).toThrow("abort");
		expect(f.ledger.list("test-world")).toEqual([]);
		expect(f.tx(() => f.ledger.prepare(f.input)).attemptNumber).toBe(1);
	} finally {
		f.close();
	}
});

test("exact payload, actual intent, owner, brief, route and one-time UUID conflicts reject", () => {
	const f = attemptFixture();
	try {
		const a = f.tx(() => f.ledger.prepare(f.input));
		for (const input of [
			{ ...f.input, briefDigest: "f".repeat(64) },
			{ ...f.input, owner: { ...f.input.owner, agentId: "mira" } },
			{ ...f.input, route: { ...f.input.route, model: "changed" } },
			{ ...f.input, intentId: "made-up" },
		])
			expect(() => f.tx(() => f.ledger.prepare(input))).toThrow();
		f.tx(() => f.ledger.link("test-world", a.attemptId, jobId));
		expect(() =>
			f.tx(() => f.ledger.link("test-world", a.attemptId, nextJobId)),
		).toThrow(/conflict/i);
		const missing = new ImageAttempts(f.db, { ...f.ports, intent: () => null });
		expect(() => missing.get("test-world", a.attemptId)).toThrow(/intent/i);
		expect(f.ledger.list("test-world")).toHaveLength(1);
	} finally {
		f.close();
	}
});

test("unknown/active/missing accounting cannot authorize retry; failed settled attempt can", () => {
	const f = attemptFixture();
	try {
		const a = f.tx(() => f.ledger.prepare(f.input));
		const retry = {
			...f.input,
			requestKey: "retry-one",
			previousAttemptId: a.attemptId,
		};
		expect(() => f.tx(() => f.ledger.retry(retry))).toThrow();
		f.tx(() => f.ledger.link("test-world", a.attemptId, jobId));
		for (const state of ["submitting", "running", "uncertain"] as const) {
			f.tx(() =>
				f.ledger.observe("test-world", a.attemptId, sample({ state })),
			);
			expect(() => f.tx(() => f.ledger.retry(retry))).toThrow();
		}
		const failed = f.tx(() =>
			f.ledger.observe("test-world", a.attemptId, sample({ state: "failed" })),
		);
		expect(() => f.tx(() => f.ledger.retry(retry))).toThrow(
			/accounting|outcome/i,
		);
		f.settle(failed);
		const b = f.tx(() => f.ledger.retry(retry));
		expect(b.attemptId).toBe(expectedId("test-world", f.intent.intentId, 2));
		expect(b.previousAttemptId).toBe(a.attemptId);
		expect(b.jobId).toBeNull();
		expect(f.tx(() => f.ledger.retry(retry))).toEqual(b);
		expect(() =>
			f.tx(() => f.ledger.retry({ ...retry, requestKey: "second-retry" })),
		).toThrow();
		expect(() =>
			f.tx(() => f.ledger.link("test-world", b.attemptId, jobId)),
		).toThrow();
		f.tx(() => f.ledger.link("test-world", b.attemptId, nextJobId));
		expect(f.ledger.head("test-world", f.intent.intentId)?.attemptId).toBe(
			b.attemptId,
		);
		expect(f.ledger.list("test-world")).toHaveLength(2);
		f.ledger.validate();
	} finally {
		f.close();
	}
});

test("unknown samples dedupe, original endpoint is immutable, withdrawn sources permit observed facts", () => {
	const f = attemptFixture();
	try {
		const a = f.tx(() => f.ledger.prepare(f.input));
		f.tx(() => f.ledger.link("test-world", a.attemptId, jobId));
		const unknown = f.tx(() =>
			f.ledger.observe("test-world", a.attemptId, sample()),
		);
		const length = f.ledger.history("test-world", a.attemptId).length;
		f.advance(100);
		expect(
			f.tx(() => f.ledger.observe("test-world", a.attemptId, sample())),
		).toEqual(unknown);
		expect(f.ledger.history("test-world", a.attemptId)).toHaveLength(length);
		expect(() =>
			f.tx(() =>
				f.ledger.observe(
					"test-world",
					a.attemptId,
					sample({ endpoint: "https://replacement.invalid" }),
				),
			),
		).toThrow();
		const oldSettings = f.ports.settings;
		f.ports.settings = (world, at) =>
			at === undefined ? null : oldSettings(world, at);
		const done = f.tx(() =>
			f.ledger.observe(
				"test-world",
				a.attemptId,
				sample({ state: "completed", resultFilename: "output.png", artifact }),
			),
		);
		expect(done.observation?.artifact).toEqual(artifact);
		expect(() =>
			f.tx(() =>
				f.ledger.observe(
					"test-world",
					a.attemptId,
					sample({ state: "running", resultFilename: "output.png" }),
				),
			),
		).toThrow(/terminal/i);
	} finally {
		f.close();
	}
});

test("known output import failure recovers same UUID and filename while preserving first failed receipt", () => {
	const f = attemptFixture();
	try {
		const a = f.tx(() => f.ledger.prepare(f.input));
		f.tx(() => f.ledger.link("test-world", a.attemptId, jobId));
		const failure = sample({
			state: "failed",
			resultFilename: "output.png",
			error: "import failed",
		});
		const failed = f.tx(() =>
			f.ledger.observe("test-world", a.attemptId, failure),
		);
		f.settle(failed);
		expect(() =>
			f.tx(() =>
				f.ledger.retry({
					...f.input,
					requestKey: "retry",
					previousAttemptId: a.attemptId,
				}),
			),
		).toThrow(/recover|result/i);
		const completed = sample({
			state: "completed",
			resultFilename: "output.png",
			artifact,
		});
		expect(() =>
			f.tx(() => f.ledger.observe("test-world", a.attemptId, completed)),
		).toThrow(/terminal|recover/i);
		expect(() =>
			f.tx(() =>
				f.ledger.recoverArtifact("test-world", a.attemptId, {
					...completed,
					resultFilename: "different.png",
				}),
			),
		).toThrow();
		const recovered = f.tx(() =>
			f.ledger.recoverArtifact("test-world", a.attemptId, completed),
		);
		expect(recovered.observation?.state).toBe("completed");
		expect(
			f.tx(() => f.ledger.observe("test-world", a.attemptId, failure)),
		).toEqual(failed);
		expect(
			f.tx(() =>
				f.ledger.recoverArtifact("test-world", a.attemptId, completed),
			),
		).toEqual(recovered);
		expect(f.ledger.get("test-world", a.attemptId)).toEqual(recovered);
		f.ledger.validate();
	} finally {
		f.close();
	}
});

test("completion requires same UUID verified artifact metadata; delivery replay survives later state", () => {
	const f = attemptFixture();
	try {
		const a = f.tx(() => f.ledger.prepare(f.input));
		f.tx(() => f.ledger.link("test-world", a.attemptId, jobId));
		const done = sample({
			state: "completed",
			resultFilename: "out.png",
			artifact,
		});
		for (const invalid of [
			{ ...done, artifact: null },
			{ ...done, artifact: { ...artifact, id: nextJobId } },
			{ ...done, artifact: { ...artifact, sha256: "not-a-hash" } },
			{ ...done, resultFilename: "../out.png" },
		])
			expect(() =>
				f.tx(() => f.ledger.observe("test-world", a.attemptId, invalid)),
			).toThrow();
		const pending = f.tx(() =>
			f.ledger.acknowledge("test-world", a.attemptId, "pending-one", {
				kind: "pending",
			}),
		);
		f.tx(() => f.ledger.observe("test-world", a.attemptId, done));
		const delivery = {
			kind: "avatar" as const,
			receiptId: "owner-receipt",
			candidateId: "candidate",
			applicationId: "apply",
			avatarId: artifact.sha256,
			profileRevision: 2,
			visualRevision: 2,
			artifactId: jobId,
		};
		const applied = f.tx(() =>
			f.ledger.acknowledge("test-world", a.attemptId, "ack-one", delivery),
		);
		expect(
			f.tx(() =>
				f.ledger.acknowledge("test-world", a.attemptId, "pending-one", {
					kind: "pending",
				}),
			),
		).toEqual(pending);
		expect(
			f.tx(() =>
				f.ledger.acknowledge("test-world", a.attemptId, "ack-one", delivery),
			),
		).toEqual(applied);
		expect(() =>
			f.tx(() =>
				f.ledger.acknowledge("test-world", a.attemptId, "ack-one", {
					...delivery,
					applicationId: "changed",
				}),
			),
		).toThrow(/conflict/i);
		expect(f.ledger.get("test-world", a.attemptId)?.delivery).toEqual(delivery);
		f.ledger.validate();
	} finally {
		f.close();
	}
});
