import { expect, test } from "bun:test";
import { join } from "node:path";
import { DurableStore } from "../../lina-core/src/store.ts";
import {
	appendContextEntry,
	extendContextEntry,
} from "../../lina-core/test/context-journal-fixture.ts";
import {
	CaptureDelivery,
	generationOwner,
	HonchoClient,
	HonchoOutbox,
	publicIdentity,
} from "../src/honcho/index.ts";
import { Fixture, qualifiedConfig } from "./honcho-fixture.ts";
import { HonchoHttpFixture } from "./honcho-http-fixture.ts";

function setup() {
	const fixture = new Fixture(),
		http = new HonchoHttpFixture();
	const config = { ...qualifiedConfig, baseUrl: http.baseUrl };
	const owner = generationOwner(fixture.binding, config);
	http.register(owner);
	const journal = fixture.keep(
		new DurableStore(join(fixture.dir, "journal.sqlite"), fixture.binding),
	);
	const requestId = appendContextEntry(journal, fixture.binding.sessionId, {
		entryId: "entry",
		role: "user",
		text: "SYNTHETIC_SECRET",
		timestamp: "2026-09-08T00:00:00Z",
		raw: {},
	});
	const sourceLookup = (id: string) => journal.sourceEntry(id);
	const outbox = fixture.keep(
		new HonchoOutbox(fixture.file, fixture.binding, publicIdentity(config), {
			ordinaryNamespace: owner.ordinaryNamespace,
			sourceLookup,
		}),
	);
	outbox.enqueue("entry", "user", "SYNTHETIC_SECRET");
	return {
		fixture,
		http,
		config,
		owner,
		journal,
		requestId,
		sourceLookup,
		outbox,
	};
}

for (const operation of ["send", "reconcile"] as const) {
	test(`H1 ${operation}: nested microtask revocation after second qualification blocks HTTP dispatch`, async () => {
		const f = setup();
		const entered = Promise.withResolvers<void>(),
			gate = Promise.withResolvers<unknown>();
		const revoked = Promise.withResolvers<void>();
		let qualifications = 0;
		const beforeFetch: { path: string; scope: string | undefined }[] = [];
		const proof = {
			version: 1,
			owner: structuredClone(f.owner),
			isolation: "workspace",
			ordinaryOnly: true,
		};
		const client = new HonchoClient(f.config, {
			binding: f.fixture.binding,
			sourceLookup: f.sourceLookup,
			fetch(url, init) {
				beforeFetch.push({
					path: new URL(url).pathname,
					scope: f.journal.sourceEntry("entry")?.sourcePolicy?.scope,
				});
				return fetch(url, init);
			},
			qualifiedAdapter: {
				...f.http.adapter,
				qualify(owner, signal) {
					qualifications++;
					if (qualifications === 2) {
						entered.resolve();
						return gate.promise;
					}
					return f.http.adapter.qualify(owner, signal);
				},
			},
		});
		const delivery = new CaptureDelivery({ outbox: f.outbox, client });
		try {
			if (operation === "reconcile") {
				f.outbox.markSending(1);
				f.outbox.markUnknown(1, "prior timeout");
			}
			const frozenProofs = f.outbox.part(1)?.sourceProofs;
			const flushing = delivery.flush();
			await entered.promise;
			expect(qualifications).toBe(2);
			expect(beforeFetch).toEqual([]);
			gate.resolve(proof);
			queueMicrotask(() =>
				queueMicrotask(() => {
					extendContextEntry(f.journal, f.requestId, true);
					revoked.resolve();
				}),
			);
			await flushing;
			await revoked.promise;
			expect(f.journal.sourceEntry("entry")?.sourcePolicy?.scope).toBe("mixed");
			expect(f.outbox.part(1)?.sourceProofs).toEqual(frozenProofs);
			expect({
				beforeFetch,
				messageRequests: f.http.seen.filter((s) =>
					/\/messages(?:\/list)?$/.test(s.path),
				).length,
				uploads: f.http.namespaces.get("lina")?.fake.messages.length,
				state: f.outbox.part(1)?.state,
			}).toEqual({
				beforeFetch: [],
				messageRequests: 0,
				uploads: 0,
				state: "withheld",
			});
		} finally {
			gate.resolve(proof);
			await delivery.close();
			f.fixture.close();
			f.http.close();
		}
	});
}

test("H1 revocation after actual HTTP send retains the known remote acknowledgement", async () => {
	const f = setup();
	const received = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const remote = f.http.namespaces.get("lina");
	if (!remote) throw new Error("missing registered namespace");
	remote.fake.behavior = async () => {
		received.resolve();
		await release.promise;
		return undefined;
	};
	const client = new HonchoClient(f.config, {
		binding: f.fixture.binding,
		sourceLookup: f.sourceLookup,
		qualifiedAdapter: f.http.adapter,
	});
	const delivery = new CaptureDelivery({ outbox: f.outbox, client });
	try {
		const flushing = delivery.flush();
		await received.promise;
		expect(f.journal.sourceEntry("entry")?.sourcePolicy?.scope).toBe(
			"ordinary",
		);
		extendContextEntry(f.journal, f.requestId, true);
		release.resolve();
		await flushing;
		expect(f.outbox.part(1)).toMatchObject({
			state: "withheld",
			remoteId: "msg_1",
		});
		expect(f.outbox.history(1).map((row) => row["to_state"])).toEqual([
			"sending",
			"accepted",
			"withheld",
		]);
		expect(remote.fake.messages.map((message) => message.content)).toEqual([
			"SYNTHETIC_SECRET",
		]);
		await delivery.flush();
		expect(remote.fake.messages).toHaveLength(1);
	} finally {
		release.resolve();
		await delivery.close();
		f.fixture.close();
		f.http.close();
	}
});
