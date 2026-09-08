import { describe, expect, it } from "bun:test";
import { CaptureDelivery } from "../src/honcho/capture.ts";
import { HonchoClient } from "../src/honcho/client.ts";
import { publicIdentity } from "../src/honcho/config.ts";
import { HonchoOutbox } from "../src/honcho/outbox.ts";
import type { CaptureStatus } from "../src/honcho/types.ts";
import {
	qualifiedConfig as config,
	FakeHoncho,
	Fixture,
} from "./honcho-fixture.ts";

const identity = publicIdentity(config);

function setup(fixture: Fixture, fake: FakeHoncho | undefined) {
	const outbox = fixture.keep(
		new HonchoOutbox(
			fixture.file,
			fixture.binding,
			identity,
			fixture.outboxOptions,
		),
	);
	const changes: CaptureStatus[] = [];
	const delivery = new CaptureDelivery({
		outbox,
		batchSize: 2,
		onChange: (status) => changes.push(status),
		...(fake
			? {
					client: new HonchoClient(config, {
						...fixture.clientOptions(fake),
						fetch: fake.fetch,
						timeoutMs: 50,
					}),
				}
			: {}),
	});
	return { outbox, delivery, changes };
}

describe("CaptureDelivery", () => {
	it("auth and rate-limit rejections retain pending parts for recovery; HTTP timeout stays uncertain", async () => {
		for (const code of [401, 403, 404, 429, 408]) {
			const fixture = new Fixture();
			try {
				const fake = new FakeHoncho(),
					{ outbox, delivery } = setup(fixture, fake);
				fixture.enqueue(outbox, "e1", "user", "Keep this preference");
				fake.behavior = () =>
					new Response("Service rejection", { status: code });
				const rejected = await delivery.flush();
				expect(rejected.service).toBe("unavailable");
				expect(outbox.part(1)?.state).toBe(
					code === 408 ? "unknown" : "pending",
				);
				fake.behavior = undefined;
				await delivery.flush();
				expect(outbox.part(1)?.state).toBe(
					code === 408 ? "unknown" : "accepted",
				);
			} finally {
				fixture.close();
			}
		}
	});
	it("disabled delivery never touches the network and reports disabled", async () => {
		const fixture = new Fixture();
		try {
			const { outbox, delivery } = setup(fixture, undefined);
			fixture.enqueue(outbox, "e1", "user", "hello");
			const status = await delivery.flush();
			expect(status).toEqual({
				service: "disabled",
				counts: {
					pending: 1,
					sending: 0,
					accepted: 0,
					unknown: 0,
					failed: 0,
					withheld: 0,
				},
				freshness: "unknown",
			});
			await delivery.close();
		} finally {
			fixture.close();
		}
	});

	it("sends bounded batches one part per POST, selecting the peer by role, and stays single-flight", async () => {
		const fixture = new Fixture();
		try {
			const fake = new FakeHoncho();
			const { outbox, delivery, changes } = setup(fixture, fake);
			fixture.enqueue(outbox, "e1", "user", "hi");
			fixture.enqueue(outbox, "e2", "assistant", "hello");
			fixture.enqueue(outbox, "e3", "user", "again");
			const [first, second] = await Promise.all([
				delivery.flush(),
				delivery.flush(),
			]);
			expect(first).toBe(second);
			expect(first.service).toBe("ready");
			expect(first.counts).toEqual({
				pending: 1,
				sending: 0,
				accepted: 2,
				unknown: 0,
				failed: 0,
				withheld: 0,
			});
			expect(
				fake.seen.map((s) =>
					(s.body as { messages: { peer_id: string }[] }).messages.map(
						(m) => m.peer_id,
					),
				),
			).toEqual([["example"], ["lina"]]);
			expect(changes.length).toBe(1);
			expect((await delivery.flush()).counts.accepted).toBe(3);
			expect(outbox.part(1)?.remoteId).toBe("msg_1");
		} finally {
			fixture.close();
		}
	});

	it("marks a timed-out send unknown, becomes unavailable, and never blindly resends", async () => {
		const fixture = new Fixture();
		try {
			const fake = new FakeHoncho();
			const { outbox, delivery } = setup(fixture, fake);
			fixture.enqueue(outbox, "e1", "user", "hi");
			fake.behavior = () => new Promise<Response>(() => undefined);
			const status = await delivery.flush();
			expect(status.service).toBe("unavailable");
			expect(status.counts).toEqual({
				pending: 0,
				sending: 0,
				accepted: 0,
				unknown: 1,
				failed: 0,
				withheld: 0,
			});
			fake.behavior = undefined;
			// Reconcile finds nothing: still unknown, and no POST /messages happened.
			const again = await delivery.flush();
			expect(again.counts.unknown).toBe(1);
			expect(again.service).toBe("ready");
			expect(fake.seen.filter((s) => s.url.endsWith("/messages")).length).toBe(
				1,
			);
			expect(outbox.unknown()[0]?.error).toBe("no remote match yet");
		} finally {
			fixture.close();
		}
	});

	it("adopts exactly one exact remote match and keeps ambiguity or foreign scope unknown", async () => {
		const fixture = new Fixture();
		try {
			const fake = new FakeHoncho();
			const { outbox, delivery } = setup(fixture, fake);
			fixture.enqueue(outbox, "e1", "user", "one");
			fixture.enqueue(outbox, "e2", "user", "two");
			fixture.enqueue(outbox, "e3", "user", "three");
			for (const part of outbox.next()) {
				outbox.markSending(part.id);
				outbox.markUnknown(part.id, "crash");
			}
			const key = (part: import("../src/honcho/types.ts").OutboxPart) => ({
				lina: {
					entryId: part.entryId,
					partIndex: part.partIndex,
					contentHash: part.contentHash,
					version: part.version,
					sourceProofs: part.sourceProofs,
					policyScope: part.policyScope,
				},
			});
			const [p1, p2, p3] = outbox.unknown(10);
			if (!p1 || !p2 || !p3) throw new Error("expected three unknown parts");
			fake.store("example", "one", key(p1));
			fake.store("example", "two", key(p2));
			fake.store("example", "two", key(p2));
			const foreign = fake.store("example", "three", key(p3));
			foreign.session_id = "other-session";
			await delivery.flush();
			const status = await delivery.flush();
			expect(status.counts).toEqual({
				pending: 0,
				sending: 0,
				accepted: 1,
				unknown: 2,
				failed: 0,
				withheld: 0,
			});
			expect(outbox.part(p1.id)).toMatchObject({
				state: "accepted",
				remoteId: "msg_1",
			});
			expect(outbox.part(p2.id)?.error).toBe("ambiguous: 2 remote matches");
			expect(outbox.part(p3.id)?.error).toBe("no remote match yet");
			expect(fake.seen.every((s) => s.url.endsWith("/messages/list"))).toBe(
				true,
			);
		} finally {
			fixture.close();
		}
	});

	it("records a 4xx rejection as failed and keeps going; abort during flush leaves unknown, not resent", async () => {
		const fixture = new Fixture();
		try {
			const fake = new FakeHoncho();
			const { outbox, delivery } = setup(fixture, fake);
			fixture.enqueue(outbox, "e1", "user", "bad");
			fake.behavior = () =>
				new Response(JSON.stringify({ detail: "rejected" }), { status: 422 });
			expect((await delivery.flush()).counts.failed).toBe(1);
			expect(outbox.part(1)?.error).toMatch(/422/);
			fixture.enqueue(outbox, "e2", "user", "slow");
			let started: (() => void) | undefined;
			const begun = new Promise<void>((resolve) => {
				started = resolve;
			});
			fake.behavior = () => {
				started?.();
				return new Promise<Response>(() => undefined);
			};
			const flushing = delivery.flush();
			await begun;
			await delivery.close();
			const status = await flushing;
			expect(status.service).toBe("unavailable");
			expect(outbox.part(2)?.state).toBe("unknown");
			expect((await delivery.flush()).service).toBe("unavailable");
		} finally {
			fixture.close();
		}
	});
});
