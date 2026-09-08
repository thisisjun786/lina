import { expect, test } from "bun:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DurableStore } from "../../lina-core/src/store.ts";
import {
	generationDigest,
	generationOutboxPath,
	generationOwner,
	HonchoClient,
	HonchoOutbox,
	publicIdentity,
	selectHonchoConfig,
} from "../../lina-memory/src/honcho/index.ts";
import { config, Fixture } from "../../lina-memory/test/honcho-fixture.ts";
import { HonchoHttpFixture } from "../../lina-memory/test/honcho-http-fixture.ts";
import {
	legacyOutbox,
	namespace,
} from "../../lina-memory/test/honcho-v1-fixture.ts";
import { MemoryBridge } from "../src/context/memory.ts";
import { qualifyRequest } from "./context-honcho-fixture.ts";

function setup(http: HonchoHttpFixture, botId: string, old = false) {
	const f = new Fixture();
	f.binding.botId = botId;
	if (old) legacyOutbox(f);
	const selected = {
		...config,
		baseUrl: http.baseUrl,
		ordinaryNamespace: {
			...namespace,
			ownerBotId: botId,
			workspaceId: `ordinary-${botId}`,
			sessionId: `session-${botId}`,
			observerPeerId: `observer-${botId}`,
		},
	};
	const owner = generationOwner(f.binding, selected);
	http.register(owner);
	const journal = f.keep(
		new DurableStore(join(f.dir, "journal.sqlite"), f.binding),
	);
	const clientOptions = {
		binding: f.binding,
		sourceLookup: (id: string) => journal.sourceEntry(id),
		qualifiedAdapter: http.adapter,
	};
	const client = new HonchoClient(selected, clientOptions);
	const memory = new MemoryBridge({
		path: f.file,
		binding: f.binding,
		journal,
		config: selected,
		clientOptions,
	});
	const append = (id: string, text: string) => {
		journal.appendEntry({
			entryId: id,
			role: "user",
			text,
			timestamp: "2026-09-08T00:00:00Z",
			raw: { sourcePolicy: { scope: "ordinary" } },
		});
		journal.createRequest(`r-${id}`, text);
		journal.setRequest(`r-${id}`, "accepted", { entryId: id });
		qualifyRequest(journal, f.binding, `r-${id}`, [id]);
		journal.setRequest(`r-${id}`, "settled");
	};
	return { f, selected, owner, journal, clientOptions, client, memory, append };
}

test("real HTTP two-owner generations initialize/write/recall exact isolated tuples and preserve old DB", async () => {
	const http = new HonchoHttpFixture(),
		a = setup(http, "lina", true),
		b = setup(http, "npc");
	try {
		await a.client.initialize();
		await b.client.initialize();
		a.append("a", "Lina ordinary coffee");
		b.append("b", "NPC ordinary tea");
		await a.memory.refresh();
		await b.memory.refresh();
		expect(await a.memory.recall("drink")).toBe("Lina ordinary coffee");
		const proof = a.memory.recallSourceProofs("Lina ordinary coffee");
		expect(proof?.length).toBeGreaterThan(0);
		if (!proof?.[0]) throw Error("Missing qualified recall proof");
		proof[0].policyDigest = "tampered";
		expect(
			a.memory.recallSourceProofs("Lina ordinary coffee")?.[0]?.policyDigest,
		).not.toBe("tampered");
		expect(a.memory.recallSourceProofs("forged recall text")).toBeUndefined();
		expect(await b.memory.recall("drink")).toBe("NPC ordinary tea");
		expect(selectHonchoConfig(a.selected, "npc")).toBeUndefined();
		expect(
			selectHonchoConfig(b.selected, "npc")?.ordinaryNamespace?.sessionId,
		).toBe("session-npc");
		expect(
			() =>
				new HonchoClient(a.selected, {
					...a.clientOptions,
					binding: b.f.binding,
				}),
		).toThrow(/owner/);
		const wrong = new MemoryBridge({
			path: join(b.f.dir, "wrong.sqlite"),
			binding: b.f.binding,
			journal: b.journal,
			config: a.selected,
			clientOptions: b.clientOptions,
		});
		const before = http.seen.length;
		await wrong.refresh();
		expect(await wrong.recall("coffee")).toBe("");
		expect(http.seen.length).toBe(before);
		expect(wrong.status().service).toBe("unavailable");
		await wrong.close();
		const path = generationOutboxPath(a.f.file, a.owner);
		expect(path).toMatch(
			/honcho-generations\/[a-f0-9]{64}\/honcho-outbox.sqlite$/,
		);
		expect(
			generationDigest({
				...a.owner,
				ordinaryNamespace: Object.fromEntries(
					Object.entries(a.owner.ordinaryNamespace).reverse(),
				) as typeof a.owner.ordinaryNamespace,
				identity: { ...a.owner.identity },
			}),
		).toBe(generationDigest(a.owner));
		await a.memory.close();
		const reopened = new MemoryBridge({
			path: a.f.file,
			binding: a.f.binding,
			journal: a.journal,
			config: a.selected,
			clientOptions: a.clientOptions,
		});
		await reopened.refresh();
		expect(reopened.status().accepted).toBe(1);
		expect(await reopened.recall("drink")).toBe("Lina ordinary coffee");
		await reopened.close();
		const old = new HonchoOutbox(a.f.file, a.f.binding, publicIdentity(config));
		expect(old.counts().withheld).toBe(5);
		expect(old.next()).toEqual([]);
		expect(old.unknown()).toEqual([]);
		expect(old.part(4)?.remoteId).toBe("old-remote");
		expect(old.history(2)[0]).toMatchObject({
			from_state: "unknown",
			error: "old attempt detail",
		});
		old.close();
		expect(http.seen.filter((s) => s.path.includes("lina-test"))).toHaveLength(
			0,
		);
		const newDb = new DatabaseSync(path);
		expect(newDb.prepare("SELECT COUNT(*) AS n FROM parts").get()?.["n"]).toBe(
			1,
		);
		newDb.close();
		expect(
			http.namespaces.get("lina")?.fake.messages.map((m) => m.content),
		).toEqual(["Lina ordinary coffee"]);
		expect(
			http.namespaces.get("npc")?.fake.messages.map((m) => m.content),
		).toEqual(["NPC ordinary tea"]);
	} finally {
		await a.memory.close();
		await b.memory.close();
		a.f.close();
		b.f.close();
		http.close();
	}
});

test("HTTP forged qualification/recall and deferred source changes clear model-facing cached text", async () => {
	const http = new HonchoHttpFixture(),
		a = setup(http, "lina");
	try {
		await a.client.initialize();
		a.append("a", "ordinary memory");
		await a.memory.refresh();
		expect(await a.memory.recall("remember")).toBe("ordinary memory");
		for (const fault of [
			"owner",
			"scope",
			"unqualified",
			"provenance",
		] as const) {
			http.fault = fault;
			expect(await a.memory.recall("remember")).toBe("");
			expect(a.memory.status().recallText).toBe("");
		}
		http.fault = undefined;
		expect(await a.memory.recall("remember")).toBe("ordinary memory");
		const begun = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		http.beforeRecall = async () => {
			begun.resolve();
			await release.promise;
		};
		const recalling = a.memory.recall("remember");
		await begun.promise;
		a.journal.recordSourceExposure({
			type: "context_exposure",
			version: 1,
			id: "later-life",
			nativeEpoch: 1,
			scopeDigest: "a".repeat(64),
			source: {
				kind: "tool",
				requestId: "r-a",
				toolName: "world_read",
				callId: "call",
			},
			materials: [{ kind: "disclosed-life", sourceId: "life-event" }],
			outcome: "planned",
		});
		a.journal.extendRequestSource("r-a", ["later-life"]);
		expect(a.memory.status().recallText).toBe("");
		expect(a.memory.recallSourceProofs("ordinary memory")).toBeUndefined();
		release.resolve();
		expect(await recalling).toBe("");
		expect(a.memory.status().recallText).toBe("");
	} finally {
		await a.memory.close();
		a.f.close();
		http.close();
	}
});

test("generation change starts with empty cache and no inherited parts; stock client has no qualification", async () => {
	const http = new HonchoHttpFixture(),
		a = setup(http, "lina");
	try {
		await a.client.initialize();
		a.append("a", "ordinary memory");
		await a.memory.refresh();
		expect(await a.memory.recall("remember")).toBe("ordinary memory");
		await a.memory.close();
		const next = {
			...a.selected,
			ordinaryNamespace: {
				...a.selected.ordinaryNamespace,
				generationId: "g2",
				workspaceId: "next-lina",
				qualificationId: "q2",
			},
		};
		const owner = generationOwner(a.f.binding, next);
		http.register(owner);
		const memory = new MemoryBridge({
			path: a.f.file,
			binding: a.f.binding,
			journal: a.journal,
			config: next,
			clientOptions: a.clientOptions,
		});
		expect(memory.status().recallText).toBe("");
		expect(memory.status().accepted).toBe(0);
		await memory.close();
		const stock = new HonchoClient(next, {
			binding: a.f.binding,
			sourceLookup: a.clientOptions.sourceLookup,
		});
		const before = http.seen.length;
		expect((await stock.recall("memory")).text).toBe("");
		await expect(stock.initialize()).rejects.toThrow(/qualification/);
		expect(http.seen.length).toBe(before);
	} finally {
		await a.memory.close();
		a.f.close();
		http.close();
	}
});
