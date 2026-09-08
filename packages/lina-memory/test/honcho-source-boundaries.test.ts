import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import {
	CaptureDelivery,
	HonchoClient,
	HonchoOutbox,
	publicIdentity,
} from "../src/honcho/index.ts";
import { parsePartKey, parseRemoteMessage } from "../src/honcho/messages.ts";
import {
	FakeHoncho,
	Fixture,
	ordinarySource,
	qualifiedConfig,
} from "./honcho-fixture.ts";

function setup() {
	const f = new Fixture(),
		fake = new FakeHoncho();
	const outbox = f.keep(
		new HonchoOutbox(
			f.file,
			f.binding,
			publicIdentity(qualifiedConfig),
			f.outboxOptions,
		),
	);
	const options = f.clientOptions(fake),
		client = new HonchoClient(qualifiedConfig, options);
	const delivery = new CaptureDelivery({ outbox, client });
	return { f, fake, outbox, options, client, delivery };
}
function revoke(f: Fixture) {
	const source = f.sources.get("e1");
	if (!source?.sourcePolicy) throw new Error("missing fixture source");
	source.sourcePolicy.scope = "mixed";
	source.sourcePolicy.policyRevision++;
	source.sourcePolicy.materialKinds = ["disclosed-life"];
}

test("chunk metadata copies proofs, rejects forged parse and differing provenance replay", () => {
	const { f, outbox } = setup();
	try {
		f.enqueue(outbox, "e1", "user", "가😀".repeat(500));
		const parts = outbox.next();
		expect(parts.length).toBeGreaterThan(1);
		for (const part of parts) {
			expect(part.version).toBe(2);
			expect(part.sourceProofs?.map((p) => p.entryId)).toEqual(["e1"]);
			expect(part.policyScope?.ownerBotId).toBe("lina");
			if (!part.sourceProofs || !part.policyScope)
				throw new Error("missing qualified metadata");
			const key = {
				entryId: part.entryId,
				partIndex: part.partIndex,
				contentHash: part.contentHash,
				version: 2 as const,
				sourceProofs: part.sourceProofs,
				policyScope: part.policyScope,
			};
			expect(
				parseRemoteMessage({
					id: "remote",
					workspace_id: "lina-test",
					session_id: "lina-main",
					peer_id: "example",
					content: part.content,
					metadata: { lina: key },
				}).key,
			).toEqual(key);
			expect(() => parsePartKey({ ...key, sourceProofs: [] })).toThrow();
			expect(() =>
				parsePartKey({
					...key,
					sourceProofs: [
						...(part.sourceProofs ?? []),
						...(part.sourceProofs ?? []),
					],
				}),
			).toThrow();
			expect(() =>
				parsePartKey({
					...key,
					policyScope: { ...part.policyScope, ownerBotId: undefined },
				}),
			).toThrow();
			expect(() => parsePartKey({ ...key, version: 1 })).toThrow();
		}
		const source = f.sources.get("e1");
		if (!source?.sourcePolicy) throw new Error("missing source");
		source.sourcePolicy.policyRevision++;
		expect(() => outbox.enqueue("e1", "user", source.text)).toThrow(/differs/);
	} finally {
		f.close();
	}
});

test("pending and unknown parts are withheld before any message lookup/send when source changes", async () => {
	for (const unknown of [false, true]) {
		const { f, fake, outbox, delivery } = setup();
		try {
			f.enqueue(outbox, "e1", "user", "SECRET");
			if (unknown) {
				outbox.markSending(1);
				outbox.markUnknown(1, "prior attempt");
			}
			revoke(f);
			await delivery.flush();
			expect(fake.seen).toHaveLength(0);
			expect(outbox.part(1)?.state).toBe("withheld");
			expect(outbox.part(1)?.error).toBe(unknown ? "prior attempt" : undefined);
			await delivery.flush();
			expect(fake.seen).toHaveLength(0);
		} finally {
			await delivery.close();
			f.close();
		}
	}
});

test("source change during deferred qualification prevents POST", async () => {
	const { f, fake, outbox, options } = setup();
	const begun = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const adapter = options.qualifiedAdapter;
	if (!adapter) throw new Error("missing adapter");
	const client = new HonchoClient(qualifiedConfig, {
		...options,
		qualifiedAdapter: {
			...adapter,
			async qualify(owner, signal) {
				begun.resolve();
				await release.promise;
				return adapter.qualify(owner, signal);
			},
		},
	});
	const delivery = new CaptureDelivery({ outbox, client });
	try {
		f.enqueue(outbox, "e1", "user", "SECRET");
		const flushing = delivery.flush();
		await begun.promise;
		revoke(f);
		release.resolve();
		await flushing;
		expect(fake.seen).toHaveLength(0);
		expect(outbox.part(1)?.state).toBe("withheld");
	} finally {
		release.resolve();
		await delivery.close();
		f.close();
	}
});

test("source change during awaited send preserves remote receipt then withholds", async () => {
	const { f, fake, outbox, delivery } = setup();
	const begun = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	fake.behavior = async () => {
		begun.resolve();
		await release.promise;
		return undefined;
	};
	try {
		f.enqueue(outbox, "e1", "user", "SECRET");
		const flushing = delivery.flush();
		await begun.promise;
		revoke(f);
		release.resolve();
		await flushing;
		expect(outbox.part(1)).toMatchObject({
			state: "withheld",
			remoteId: "msg_1",
		});
		expect(outbox.history(1).map((h) => h["to_state"])).toEqual([
			"sending",
			"accepted",
			"withheld",
		]);
		await delivery.flush();
		expect(fake.messages).toHaveLength(1);
	} finally {
		release.resolve();
		await delivery.close();
		f.close();
	}
});

test("source change during unknown reconciliation cannot adopt remote text", async () => {
	const { f, fake, outbox, delivery } = setup();
	const begun = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	try {
		f.enqueue(outbox, "e1", "user", "SECRET");
		outbox.markSending(1);
		outbox.markUnknown(1, "timeout");
		fake.behavior = async () => {
			begun.resolve();
			await release.promise;
			return undefined;
		};
		const flushing = delivery.flush();
		await begun.promise;
		revoke(f);
		release.resolve();
		await flushing;
		expect(outbox.part(1)).toMatchObject({
			state: "withheld",
			error: "timeout",
		});
		expect(outbox.history(1).some((h) => h["to_state"] === "accepted")).toBe(
			false,
		);
		expect(fake.seen.map((s) => s.url.endsWith("/messages/list"))).toEqual([
			true,
		]);
	} finally {
		release.resolve();
		await delivery.close();
		f.close();
	}
});

test("unsettled, missing and raw-forged sources cannot enqueue qualified content", () => {
	const { f, outbox } = setup();
	try {
		for (const status of ["accepted", "queued", "interrupted"] as const) {
			f.sources.set("e1", {
				...ordinarySource("e1", "SECRET"),
				requestStatus: status,
			});
			expect(() => outbox.enqueue("e1", "user", "SECRET")).toThrow(/source/i);
		}
		f.sources.set("e1", {
			entryId: "e1",
			text: "SECRET",
			role: "user",
			requestStatus: "settled",
		});
		expect(() => outbox.enqueue("e1", "user", "SECRET")).toThrow(/source/i);
		expect(outbox.counts().pending).toBe(0);
	} finally {
		f.close();
	}
});

test("qualified generation reopen checks the immutable owner and metadata before committing", () => {
	const { f, outbox } = setup();
	try {
		f.enqueue(outbox, "e1", "user", "ordinary");
		outbox.close();
		expect(
			() =>
				new HonchoOutbox(f.file, f.binding, publicIdentity(qualifiedConfig), {
					...f.outboxOptions,
					ordinaryNamespace: {
						...f.outboxOptions.ordinaryNamespace,
						qualificationId: "replacement",
					},
				}),
		).toThrow(/foreign/);
		const db = new DatabaseSync(f.file);
		db.exec(
			"UPDATE parts SET key_json=json_set(key_json,'$.policyScope.ownerBotId','intruder')",
		);
		db.close();
		expect(
			() =>
				new HonchoOutbox(
					f.file,
					f.binding,
					publicIdentity(qualifiedConfig),
					f.outboxOptions,
				),
		).toThrow(/provenance owner/);
		const reopened = new DatabaseSync(f.file);
		expect(
			reopened.prepare("SELECT state FROM parts WHERE id=1").get()?.["state"],
		).toBe("pending");
		reopened.close();
	} finally {
		f.close();
	}
});
