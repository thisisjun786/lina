import { expect, test } from "bun:test";
import type { ImageCountRecord } from "../src/world/image-accounting-types.ts";
import {
	actualSourceLifeRevision,
	ImageAttempts,
} from "../src/world/image-attempts.ts";
import { canonicalLifeJson } from "../src/world/life-json.ts";
import { identityPolicy, lifeCommit } from "./life-fixture.ts";
import {
	attemptFixture,
	jobId,
	sample,
} from "./life-image-attempt-fixture.test.ts";
import { publishedImageFixture } from "./life-image-publication-fixture.ts";
import { worldActivity } from "./world-fixture.ts";

function delayedEventFixture() {
	const f = attemptFixture(),
		published = publishedImageFixture();
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
	for (const at of [1, 2]) {
		published.store.acceptLife(
			lifeCommit({
				expectedLifeRevision: at,
				world: worldActivity({
					idempotencyKey: `later-step-${at + 1}`,
					expectedRevision: at,
					simulationTime: at + 1,
					kind: "tick",
					sceneId: null,
					actorIds: [],
					audience: [],
					summary: "",
					facts: [],
					moves: [],
				}),
			}),
			identityPolicy(),
		);
	}
	const material = published.store.publishedImageMaterial(
			"test-world",
			published.postId,
			"lina",
			"friends",
		),
		visual = f.intent.material.visuals[0];
	if (!material || !visual) throw Error("Missing actual published event");
	const request = {
		worldId: "test-world",
		agentId: "lina",
		source: material.source,
		requestKey: "delayed-event-image",
		visuals: [
			{
				...visual,
				grants: [
					{
						grantId: "image-grant",
						revision: 1,
						purpose: {
							kind: "life" as const,
							worldId: "test-world",
							recipientId: "friends",
						},
					},
				],
			},
		],
	};
	const intent = published.store.freezeImageIntent(request);
	const ports = {
		intent: (world: string, id: string) =>
			published.store.imageIntent(world, id),
		settings: (world: string) => published.store.imageSettings(world),
		count: f.ports.count,
	};
	const ledger = new ImageAttempts(f.db, ports, f.clock);
	const input = {
		...f.input,
		intentId: intent.intentId,
		briefDigest: intent.briefDigest,
	};
	const a = f.tx(() => ledger.prepare(input));
	f.tx(() => ledger.link("test-world", a.attemptId, jobId));
	f.tx(() =>
		ledger.observe("test-world", a.attemptId, sample({ state: "failed" })),
	);
	return {
		...f,
		intent,
		ledger,
		input,
		ports,
		published,
		request,
		attempt: a,
		settle(sourceLifeRevision: number) {
			const count: ImageCountRecord = {
				version: 1,
				reservation: {
					binding: {
						worldId: intent.owner.worldId,
						agentId: intent.owner.agentId,
						intentId: intent.intentId,
						attemptId: a.attemptId,
						jobId,
						kind: "event",
						sourceLifeRevision,
						settingsRevision: a.route.settingsRevision,
						configRevision: intent.configRevision,
						frozenDigest: intent.briefDigest,
					},
					outputBytes: 1024,
					metadataBytes: 16384,
					manifestBytes: 8192,
				},
				createdAtMs: 1000,
				archived: false,
				dispatchAtMs: 1000,
				state: "attempted",
				terminal: "failed",
				resultFilename: null,
			};
			f.db
				.prepare("INSERT OR REPLACE INTO fixture_counts VALUES(?,?)")
				.run(a.attemptId, canonicalLifeJson(count));
		},
		close() {
			published.store.close();
			f.close();
		},
	};
}

test("delayed event retry stays in original source revision 1 rather than intent creation revision 3", () => {
	const f = delayedEventFixture();
	try {
		expect(f.intent.source.kind).toBe("event_post");
		if (f.intent.source.kind !== "event_post")
			throw Error("Expected retained event intent");
		expect(f.intent.source.lifeRevision).toBe(1);
		expect(f.intent.createdLifeRevision).toBe(3);
		expect(actualSourceLifeRevision(f.intent)).toBe(1);
		const explicit = f.published.store.freezeImageIntent({
			...f.request,
			requestKey: "another-explicit-image",
		});
		expect(explicit.intentId).not.toBe(f.intent.intentId);
		expect(explicit.createdLifeRevision).toBe(3);
		expect(actualSourceLifeRevision(explicit)).toBe(1);
		f.settle(1);
		const next = f.tx(() =>
			f.ledger.retry({
				...f.input,
				requestKey: "retry-event",
				previousAttemptId: f.attempt.attemptId,
			}),
		);
		expect(next.attemptNumber).toBe(2);
		const reopened = f.reopen();
		try {
			const ledger = new ImageAttempts(reopened.db, f.ports, f.clock);
			ledger.validate();
			expect(ledger.head("test-world", f.intent.intentId)?.attemptId).toBe(
				next.attemptId,
			);
		} finally {
			reopened.db.close();
		}
	} finally {
		f.close();
	}
});

test("delayed event accounting cannot substitute the later intent creation revision", () => {
	const f = delayedEventFixture();
	try {
		f.settle(3);
		expect(() =>
			f.tx(() =>
				f.ledger.retry({
					...f.input,
					requestKey: "retry-event",
					previousAttemptId: f.attempt.attemptId,
				}),
			),
		).toThrow(/binding/i);
		expect(f.ledger.list("test-world")).toHaveLength(1);
	} finally {
		f.close();
	}
});

test("avatar event source counter is original; periodic avatar counter is intent creation", () => {
	const source = {
		kind: "avatar_event" as const,
		resolvedPolicyId: "policy",
		eventId: "test-world:1",
		worldRevision: 1,
		lifeRevision: 1,
		familyId: "meeting",
		stepId: "step-one",
		triggerSettingsRevision: 1,
		triggerDigest: "a".repeat(64),
	};
	expect(actualSourceLifeRevision({ source, createdLifeRevision: 3 })).toBe(1);
	const periodic = {
		scheduleKey: "b".repeat(64),
		slotIndex: 2,
		resolvedPolicyId: "periodic-policy",
	};
	expect(
		actualSourceLifeRevision({
			source: { kind: "avatar_steps", ...periodic, dueLifeRevision: 7 },
			createdLifeRevision: 3,
		}),
	).toBe(3);
	expect(
		actualSourceLifeRevision({
			source: { kind: "avatar_wall", ...periodic, dueAtMs: 9000 },
			createdLifeRevision: 3,
		}),
	).toBe(3);
});
