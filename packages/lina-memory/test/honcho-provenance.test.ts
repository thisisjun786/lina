import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { CaptureDelivery } from "../src/honcho/capture.ts";
import { HonchoClient } from "../src/honcho/client.ts";
import { publicIdentity, validateHonchoConfig } from "../src/honcho/config.ts";
import { HonchoOutbox } from "../src/honcho/outbox.ts";
import { config, FakeHoncho, Fixture } from "./honcho-fixture.ts";

import { legacyOutbox, namespace } from "./honcho-v1-fixture.ts";

test("stock HTTP v3 does not expose unqualified legacy representation", async () => {
	const fake = new FakeHoncho();
	const client = new HonchoClient(config, { fetch: fake.fetch });
	expect((await client.recall("preference")).text).toBe("");
	expect(fake.seen).toHaveLength(0);
});

test("explicit ordinary namespace selects all identity fields and rejects legacy aggregate reuse", () => {
	const selected = validateHonchoConfig({
		...config,
		ordinaryNamespace: namespace,
	});
	expect(publicIdentity(selected)).toEqual({
		baseUrl: config.baseUrl,
		workspaceId: "ordinary-lina",
		sessionId: "ordinary-session",
		userPeerId: "ordinary-user",
		observerPeerId: "ordinary-observer",
	});
	expect(() =>
		validateHonchoConfig({
			...config,
			ordinaryNamespace: {
				...namespace,
				workspaceId: config.workspaceId,
				sessionId: "only-renamed-session",
			},
		}),
	).toThrow(/isolat/);
});

test("v1 real DB migrates and reopens with old pending/unknown content withheld", () => {
	const fixture = new Fixture();
	try {
		legacyOutbox(fixture);
		let outbox = new HonchoOutbox(
			fixture.file,
			fixture.binding,
			publicIdentity(config),
		);
		expect(outbox.next()).toHaveLength(0);
		expect(outbox.unknown()).toHaveLength(0);
		expect(outbox.part(1)).toMatchObject({
			state: "withheld",
			content: "old text 0",
			withheldReason: "legacy_unclassified",
		});
		expect(outbox.part(4)?.remoteId).toBe("old-remote");
		expect(outbox.scanState()).toEqual({ after: 42, eligibleUser: true });
		outbox.close();
		outbox = new HonchoOutbox(
			fixture.file,
			fixture.binding,
			publicIdentity(config),
		);
		expect(outbox.next()).toHaveLength(0);
		outbox.close();
		const db = new DatabaseSync(fixture.file);
		expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM delivery_history").get()?.["n"],
		).toBe(5);
		db.close();
	} finally {
		fixture.close();
	}
});

test("unknown legacy schema and malformed rows roll back before schema version advances", () => {
	for (const change of [
		"UPDATE scan SET after=-1",
		"CREATE TABLE foreign_data(x TEXT)",
	]) {
		const fixture = new Fixture();
		try {
			legacyOutbox(fixture);
			const db = new DatabaseSync(fixture.file);
			db.exec(change);
			db.close();
			expect(
				() =>
					new HonchoOutbox(
						fixture.file,
						fixture.binding,
						publicIdentity(config),
					),
			).toThrow();
			const reopened = new DatabaseSync(fixture.file);
			expect(
				reopened.prepare("PRAGMA user_version").get()?.["user_version"],
			).toBe(1);
			expect(
				reopened.prepare("SELECT state FROM parts WHERE id=1").get()?.["state"],
			).toBe("pending");
			expect(
				reopened.prepare("SELECT COUNT(*) AS n FROM parts").get()?.["n"],
			).toBe(5);
			reopened.close();
		} finally {
			fixture.close();
		}
	}
});

test("configured delivery is unavailable until qualification is validated", () => {
	const fixture = new Fixture();
	try {
		const outbox = fixture.keep(
			new HonchoOutbox(fixture.file, fixture.binding, publicIdentity(config)),
		);
		const delivery = new CaptureDelivery({
			outbox,
			client: new HonchoClient(config, { fetch: new FakeHoncho().fetch }),
		});
		expect(delivery.status().service).toBe("unavailable");
	} finally {
		fixture.close();
	}
});
