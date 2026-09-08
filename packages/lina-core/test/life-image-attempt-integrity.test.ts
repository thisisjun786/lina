import { expect, test } from "bun:test";
import { ImageAttempts } from "../src/world/image-attempts.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import {
	artifact,
	attemptFixture,
	jobId,
	nextJobId,
	sample,
} from "./life-image-attempt-fixture.test.ts";
import { publishedImageFixture } from "./life-image-publication-fixture.ts";

for (const corruption of [
	"missing-history",
	"missing-head",
	"orphan-history",
	"forged-brief",
	"forged-link",
	"unknown-field",
	"noncanonical",
] as const) {
	test(`reopen rejects ${corruption} in the exact persisted record set`, () => {
		const f = attemptFixture();
		try {
			const first = f.tx(() => f.ledger.prepare(f.input));
			f.tx(() => f.ledger.link("test-world", first.attemptId, jobId));
			f.db.exec("PRAGMA foreign_keys=OFF");
			if (corruption === "missing-history")
				f.db.exec("DELETE FROM life_image_attempt_history WHERE revision=1");
			else if (corruption === "missing-head")
				f.db.exec("DELETE FROM life_image_attempt_heads");
			else if (corruption === "orphan-history")
				f.db.exec(
					"UPDATE life_image_attempt_history SET attempt_id='orphan' WHERE revision=1",
				);
			else {
				const row = f.db
					.prepare(
						"SELECT record_json FROM life_image_attempt_history WHERE revision=2",
					)
					.get() as { record_json: string } | undefined;
				if (!row) throw Error("Missing fixture receipt");
				const record = JSON.parse(String(row.record_json));
				if (corruption === "forged-brief")
					record.result.briefDigest = "c".repeat(64);
				if (corruption === "forged-link") record.result.jobId = nextJobId;
				if (corruption === "unknown-field")
					record.operation.providerAccepted = true;
				const json =
					corruption === "noncanonical"
						? JSON.stringify(record, null, 2)
						: canonicalLifeJson(record);
				f.db
					.prepare(
						"UPDATE life_image_attempt_history SET record_json=?,digest=? WHERE revision=2",
					)
					.run(json, lifeDigest(record));
			}
			const r = f.reopen();
			try {
				expect(() => r.ledger.validate()).toThrow();
				expect(() => r.ledger.head("test-world", f.intent.intentId)).toThrow();
			} finally {
				r.db.close();
			}
		} finally {
			f.close();
		}
	});
}

test("corrupt retry head and fabricated accounting settlement fail closed", () => {
	const f = attemptFixture();
	try {
		const a = f.tx(() => f.ledger.prepare(f.input));
		f.tx(() => f.ledger.link("test-world", a.attemptId, jobId));
		const failed = f.tx(() =>
			f.ledger.observe("test-world", a.attemptId, sample({ state: "failed" })),
		);
		const retry = {
			...f.input,
			requestKey: "retry",
			previousAttemptId: a.attemptId,
		};
		f.settle(failed);
		f.db.exec(
			"UPDATE fixture_counts SET value=json_set(value,'$.reservation.binding.intentId','invented-intent')",
		);
		expect(() => f.tx(() => f.ledger.retry(retry))).toThrow(/binding/i);
		f.settle(failed);
		const b = f.tx(() => f.ledger.retry(retry));
		expect(b.attemptNumber).toBe(2);
		f.db
			.prepare("UPDATE life_image_attempt_heads SET attempt_id=?")
			.run(a.attemptId);
		const r = f.reopen();
		try {
			expect(() => r.ledger.validate()).toThrow(/head/i);
		} finally {
			r.db.close();
		}
	} finally {
		f.close();
	}
});

test("never submitted known-zero accounting permits explicit retry, cancellation acknowledgment alone does not", () => {
	const f = attemptFixture();
	try {
		const a = f.tx(() => f.ledger.prepare(f.input));
		f.tx(() => f.ledger.link("test-world", a.attemptId, jobId));
		const cancelled = f.tx(() =>
			f.ledger.observe(
				"test-world",
				a.attemptId,
				sample({ state: "cancelled", endpoint: null, runtimeVersion: null }),
			),
		);
		const retry = {
			...f.input,
			requestKey: "retry",
			previousAttemptId: a.attemptId,
		};
		expect(() => f.tx(() => f.ledger.retry(retry))).toThrow(/accounting/i);
		f.settle(cancelled, "no_post");
		expect(f.tx(() => f.ledger.retry(retry)).attemptNumber).toBe(2);
	} finally {
		f.close();
	}
});

test("strict receipt parser rejects extra keys/accessors without executing them or writing history", () => {
	const f = attemptFixture();
	try {
		const a = f.tx(() => f.ledger.prepare(f.input));
		f.tx(() => f.ledger.link("test-world", a.attemptId, jobId));
		const before = f.ledger.history("test-world", a.attemptId).length;
		let reads = 0;
		const hostile = {
			...sample(),
			get error() {
				reads++;
				return "injected";
			},
		};
		expect(() =>
			f.tx(() => f.ledger.observe("test-world", a.attemptId, hostile)),
		).toThrow();
		expect(reads).toBe(0);
		const extra = { ...sample(), deliveredEntryId: "invented-conversation" };
		expect(() =>
			f.tx(() => f.ledger.observe("test-world", a.attemptId, extra)),
		).toThrow();
		const oversized = { ...sample(), error: "x".repeat(513) };
		expect(() =>
			f.tx(() => f.ledger.observe("test-world", a.attemptId, oversized)),
		).toThrow();
		expect(f.ledger.history("test-world", a.attemptId)).toHaveLength(before);
	} finally {
		f.close();
	}
});

test("observations roll back with caller and another connection sees only committed UUID link", () => {
	const f = attemptFixture();
	try {
		const a = f.tx(() => f.ledger.prepare(f.input));
		const r = f.reopen();
		try {
			f.db.exec("BEGIN IMMEDIATE");
			f.ledger.link("test-world", a.attemptId, jobId);
			expect(r.ledger.get("test-world", a.attemptId)?.jobId).toBeNull();
			f.db.exec("COMMIT");
			expect(r.ledger.get("test-world", a.attemptId)?.jobId).toBe(jobId);
			expect(() =>
				f.tx(() => {
					f.ledger.observe("test-world", a.attemptId, sample());
					throw Error("rollback fact");
				}),
			).toThrow("rollback fact");
			expect(r.ledger.get("test-world", a.attemptId)?.observation).toBeNull();
			r.ledger.validate();
		} finally {
			r.db.close();
		}
	} finally {
		f.close();
	}
});

test("late acknowledgment replay after restart preserves later completed result without another effect", () => {
	const f = attemptFixture();
	try {
		const a = f.tx(() => f.ledger.prepare(f.input));
		f.tx(() => f.ledger.link("test-world", a.attemptId, jobId));
		const pending = f.tx(() =>
			f.ledger.acknowledge("test-world", a.attemptId, "pending", {
				kind: "pending",
			}),
		);
		f.tx(() =>
			f.ledger.observe(
				"test-world",
				a.attemptId,
				sample({ state: "completed", resultFilename: "avatar.png", artifact }),
			),
		);
		const delivery = {
			kind: "avatar" as const,
			receiptId: "avatar-owner-receipt",
			candidateId: "candidate",
			applicationId: "operation",
			avatarId: artifact.sha256,
			profileRevision: 3,
			visualRevision: 4,
			artifactId: jobId,
		};
		const acknowledged = f.tx(() =>
			f.ledger.acknowledge("test-world", a.attemptId, "apply", delivery),
		);
		const r = f.reopen();
		try {
			r.db.exec("BEGIN IMMEDIATE");
			expect(
				r.ledger.acknowledge("test-world", a.attemptId, "pending", {
					kind: "pending",
				}),
			).toEqual(pending);
			r.db.exec("COMMIT");
			expect(r.ledger.get("test-world", a.attemptId)).toEqual(acknowledged);
			r.ledger.validate();
		} finally {
			r.db.close();
		}
		const dishonest = new ImageAttempts(f.db, {
			...f.ports,
			intent: () => ({
				...f.intent,
				material: { ...f.intent.material, prompt: "rewritten" },
			}),
		});
		expect(() => dishonest.validate()).toThrow(/history|intent/i);
	} finally {
		f.close();
	}
});

test("retry retains prior route history and admits only the exact current settings route", () => {
	const f = attemptFixture();
	try {
		const first = f.tx(() => f.ledger.prepare(f.input));
		expect(
			f.tx(() =>
				f.ledger.prepare({
					...f.input,
					requestKey: "another-run-before-manifest",
				}),
			).attemptId,
		).toBe(first.attemptId);
		f.tx(() => f.ledger.link("test-world", first.attemptId, jobId));
		const failed = f.tx(() =>
			f.ledger.observe(
				"test-world",
				first.attemptId,
				sample({ state: "failed" }),
			),
		);
		f.settle(failed);
		const old = f.ports.settings("test-world");
		if (!old) throw Error("Missing actual settings fixture");
		const current = {
			...old,
			revision: 2,
			route: { provider: "new-provider", model: "new-image" },
		};
		// Retain both concrete setting snapshots; current selection is deliberately different.
		f.ports.settings = (world, at) =>
			world !== old.worldId
				? null
				: at === 1
					? old
					: at === undefined || at === 2
						? current
						: null;
		const retry = {
			...f.input,
			requestKey: "retry-current",
			previousAttemptId: first.attemptId,
			route: { ...current.route, settingsRevision: 2 },
		};
		const second = f.tx(() => f.ledger.retry(retry));
		expect(second.route).toEqual(retry.route);
		expect(f.ledger.get("test-world", first.attemptId)?.route).toEqual(
			f.input.route,
		);
		expect(f.tx(() => f.ledger.prepare(f.input))).toEqual(first);
		const r = f.reopen();
		try {
			r.ledger.validate();
			expect(r.ledger.head("test-world", f.intent.intentId)?.attemptId).toBe(
				second.attemptId,
			);
		} finally {
			r.db.close();
		}
	} finally {
		f.close();
	}
});

test("published post receipt preserves exact destination and observations survive actual source withdrawal", () => {
	const f = attemptFixture(),
		published = publishedImageFixture();
	try {
		const {
			worldId: _world,
			revision: configRevision,
			...config
		} = published.store.lifeConfig("test-world");
		published.store.setLifeConfig("test-world", configRevision, {
			...config,
			images: { mode: "manual", maxPerStep: 2 },
		});
		const settings = f.ports.settings("test-world");
		if (!settings) throw Error("Missing image settings fixture");
		const {
			worldId: _settingsWorld,
			revision: _settingsRevision,
			...settingsInput
		} = settings;
		published.store.setImageSettings("test-world", 0, {
			...settingsInput,
			worldVersion: null,
		});
		const publication = published.store.publishedImageMaterial(
			"test-world",
			published.postId,
			"lina",
			"friends",
		);
		const visual = f.intent.material.visuals[0];
		if (!publication || !visual)
			throw Error("Missing actual publication fixture");
		const intent = published.store.freezeImageIntent({
			worldId: "test-world",
			agentId: "lina",
			source: publication.source,
			requestKey: "event-image",
			visuals: [
				{
					...visual,
					grants: [
						{
							grantId: "image-grant",
							revision: 1,
							purpose: {
								kind: "life",
								worldId: "test-world",
								recipientId: "friends",
							},
						},
					],
				},
			],
		});
		const ledger = new ImageAttempts(
			f.db,
			{
				intent: (world, id) => published.store.imageIntent(world, id),
				settings: (world) => published.store.imageSettings(world),
				count: () => null,
			},
			f.clock,
		);
		const input = {
			...f.input,
			intentId: intent.intentId,
			briefDigest: intent.briefDigest,
		};
		const a = f.tx(() => ledger.prepare(input));
		f.tx(() => ledger.link("test-world", a.attemptId, jobId));
		published.store.withdrawPublicationPost("test-world", published.postId, {
			requestKey: "withdraw",
			expectedRevision: 1,
		});
		expect(
			published.store.imageIntentAllowed(
				"test-world",
				intent.intentId,
				"destination",
			),
		).toBe(false);
		expect(
			f.tx(() =>
				ledger.observe(
					"test-world",
					a.attemptId,
					sample({ state: "completed", resultFilename: "scene.png", artifact }),
				),
			).observation?.state,
		).toBe("completed");
		const receipt = {
			kind: "post" as const,
			receiptId: "retained-owner-receipt",
			postId: published.postId,
			postRevision: 1,
			artifactId: jobId,
		};
		// The runtime port is responsible for an actual previously committed destination receipt.
		expect(() =>
			f.tx(() =>
				ledger.acknowledge("test-world", a.attemptId, "ack", {
					...receipt,
					postId: "foreign-post",
				}),
			),
		).toThrow(/destination/i);
		const ack = f.tx(() =>
			ledger.acknowledge("test-world", a.attemptId, "ack", receipt),
		);
		expect(ack.delivery).toEqual(receipt);
		expect(
			f.tx(() => ledger.acknowledge("test-world", a.attemptId, "ack", receipt)),
		).toEqual(ack);
		ledger.validate();
	} finally {
		published.store.close();
		f.close();
	}
});
