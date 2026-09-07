import { describe, expect, it } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { publicIdentity } from "../src/honcho/config.ts";
import { HonchoOutbox } from "../src/honcho/outbox.ts";
import { config, Fixture } from "./honcho-fixture.ts";

const identity = publicIdentity(config);

describe("HonchoOutbox", () => {
	it("enqueues deterministic idempotent parts and rejects a differing replay", () => {
		const fixture = new Fixture();
		try {
			const outbox = fixture.keep(
				new HonchoOutbox(fixture.file, fixture.binding, identity),
			);
			const long = "x".repeat(1600);
			expect(outbox.enqueue("e1", "user", long)).toEqual({
				parts: 2,
				inserted: 2,
			});
			expect(outbox.enqueue("e1", "user", long)).toEqual({
				parts: 2,
				inserted: 0,
			});
			expect(() => outbox.enqueue("e1", "user", "different")).toThrow(
				/differs/,
			);
			expect(() => outbox.enqueue("e1", "assistant", long)).toThrow(/differs/);
			expect(outbox.enqueue("e2", "assistant", "")).toEqual({
				parts: 0,
				inserted: 0,
			});
			expect(() => outbox.enqueue("e3", "tool" as "user", "x")).toThrow(/role/);
			const next = outbox.next();
			expect(next.map((p) => [p.entryId, p.partIndex, p.state])).toEqual([
				["e1", 0, "pending"],
				["e1", 1, "pending"],
			]);
			expect(next[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
			expect(outbox.counts()).toEqual({
				pending: 2,
				sending: 0,
				accepted: 0,
				unknown: 0,
				failed: 0,
			});
		} finally {
			fixture.close();
		}
	});

	it("follows exact state transitions and turns interrupted sends into unknown on reopen", () => {
		const fixture = new Fixture();
		try {
			let outbox = new HonchoOutbox(fixture.file, fixture.binding, identity);
			outbox.enqueue("e1", "user", "hello");
			outbox.enqueue("e2", "assistant", "world");
			const [a, b] = outbox.next();
			if (!a || !b) throw new Error("expected two parts");
			expect(() => outbox.markAccepted(a.id, "msg_1")).toThrow(/not in/);
			outbox.markSending(a.id);
			expect(() => outbox.markSending(a.id)).toThrow(/not in/);
			outbox.markSending(b.id);
			outbox.markFailed(b.id, "422 rejected");
			outbox.close();
			outbox = fixture.keep(
				new HonchoOutbox(fixture.file, fixture.binding, identity),
			);
			expect(outbox.counts()).toEqual({
				pending: 0,
				sending: 0,
				accepted: 0,
				unknown: 1,
				failed: 1,
			});
			expect(outbox.unknown()[0]?.error).toBe("interrupted while sending");
			outbox.markAccepted(a.id, "msg_9");
			expect(outbox.part(a.id)?.remoteId).toBe("msg_9");
			expect(() => outbox.markAccepted(a.id, "")).toThrow();
		} finally {
			fixture.close();
		}
	});

	it("persists scan state atomically as a pair and validates it", () => {
		const fixture = new Fixture();
		try {
			let outbox = new HonchoOutbox(fixture.file, fixture.binding, identity);
			expect(outbox.scanState()).toEqual({ after: 0, eligibleUser: false });
			outbox.setScanState({ after: 42, eligibleUser: true });
			expect(() =>
				outbox.setScanState({ after: -1, eligibleUser: true }),
			).toThrow();
			expect(() =>
				outbox.setScanState({ after: 1 } as {
					after: number;
					eligibleUser: boolean;
				}),
			).toThrow();
			outbox.close();
			outbox = fixture.keep(
				new HonchoOutbox(fixture.file, fixture.binding, identity),
			);
			expect(outbox.scanState()).toEqual({ after: 42, eligibleUser: true });
		} finally {
			fixture.close();
		}
	});

	it("rejects foreign bindings, foreign identities and unknown schemas", () => {
		const fixture = new Fixture();
		try {
			new HonchoOutbox(fixture.file, fixture.binding, identity).close();
			expect(
				() =>
					new HonchoOutbox(
						fixture.file,
						{ ...fixture.binding, botId: "other" },
						identity,
					),
			).toThrow(/foreign/);
			expect(
				() =>
					new HonchoOutbox(fixture.file, fixture.binding, {
						...identity,
						workspaceId: "other",
					}),
			).toThrow(/foreign/);
			expect(
				() =>
					new HonchoOutbox(fixture.file, fixture.binding, {
						...identity,
						apiKey: "x",
					} as typeof identity),
			).toThrow();
			const stray = `${fixture.file}.other`;
			const db = new DatabaseSync(stray);
			db.exec("CREATE TABLE junk(x)");
			db.close();
			expect(() => new HonchoOutbox(stray, fixture.binding, identity)).toThrow(
				/unknown outbox schema/,
			);
		} finally {
			fixture.close();
		}
	});
});
