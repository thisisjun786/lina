import { expect, test } from "bun:test";
import { join } from "node:path";
import { publicIdentity } from "../../lina-memory/src/honcho/config.ts";
import { HonchoOutbox } from "../../lina-memory/src/honcho/outbox.ts";
import { HonchoHttpFixture } from "../../lina-memory/test/honcho-http-fixture.ts";
import {
	fleetMemoryFixture,
	ordinaryEpisode,
	selectedConfig,
} from "./helpers/fleet-work-memory.ts";

test("fleet selects explicit owner configs unchanged and HTTP initialization/capture/recall share their tuples", async () => {
	const http = new HonchoHttpFixture();
	const lina = selectedConfig(http.baseUrl, "lina"),
		kai = selectedConfig(http.baseUrl, "kai");
	const f = await fleetMemoryFixture(
		{
			honcho: lina,
			honchoByAgent: { kai },
			qualifiedHonchoAdapter: http.adapter,
		},
		http,
	);
	try {
		expect(f.fleet.memoryConfig("lina")).toEqual(lina);
		expect(f.fleet.memoryConfig("kai")).toEqual(kai);
		for (const id of ["lina", "kai"]) {
			const app = await f.fleet.app(id);
			const initialized = await f.call(`/api/agents/${id}/memory`, {});
			expect(initialized.status).toBe(200);
			expect(f.received.get(id)?.honchoClientOptions?.qualifiedAdapter).toBe(
				http.adapter,
			);
			ordinaryEpisode(app, `${id}-ordinary`, `${id} ordinary tea`);
			await app.memory.refresh();
			expect(await app.memory.recall("tea")).toContain(`${id} ordinary tea`);
			expect(await app.memory.recall("tea")).not.toContain(
				`${id === "lina" ? "kai" : "lina"} ordinary tea`,
			);
			expect(http.namespaces.get(id)?.owner.identity).toEqual(
				publicIdentity(id === "lina" ? lina : kai),
			);
			expect(http.seen).toContainEqual({
				path: "/v3/workspaces",
				body: { id: `ordinary-${id}` },
			});
			expect(http.seen).toContainEqual({
				path: `/v3/workspaces/ordinary-${id}/sessions`,
				body: {
					id: "ordinary-session",
					peers: {
						"ordinary-user": { observe_me: true, observe_others: false },
						"ordinary-observer": { observe_me: false, observe_others: true },
					},
				},
			});
		}
		expect(http.seen.some((s) => s.path.includes("/legacy/"))).toBe(false);
	} finally {
		await f.close();
		http.close();
	}
});

test("legacy computed IDs and withheld rows survive fleet reopen while a selected generation learns", async () => {
	const http = new HonchoHttpFixture();
	const selected = selectedConfig(http.baseUrl, "lina");
	const { ordinaryNamespace: _namespace, ...legacy } = selected;
	const first = await fleetMemoryFixture({
		honcho: legacy,
		// Legacy inspection uses this local transport only; ordinary recall stays held.
		honchoClientOptions: { fetch: async () => Response.json({ items: [] }) },
	});
	let reopened: Awaited<ReturnType<typeof fleetMemoryFixture>> | undefined;
	try {
		const config = first.fleet.memoryConfig("lina");
		if (!config) throw Error("missing legacy fixture config");
		expect(config).toMatchObject({
			sessionId: "lina-lina",
			observerPeerId: "agent-lina",
		});
		const app = await first.fleet.app("lina");
		const path = join(first.root, "honcho-outbox.sqlite");
		const old = new HonchoOutbox(path, app.binding, publicIdentity(config));
		old.enqueue("legacy-entry", "user", "LEGACY_PRIVATE_MEMORY");
		old.close();
		expect(await app.memory.recall("tea")).toBe("");
		const status = (await (
			await first.call("/api/agents/lina/memory", {})
		).json()) as { withheld: number; service: string };
		expect(status).toMatchObject({ withheld: 1, service: "unavailable" });
		await first.fleet.close();
		reopened = await fleetMemoryFixture(
			{
				stateRoot: first.root,
				honcho: selected,
				qualifiedHonchoAdapter: http.adapter,
			},
			http,
		);
		const next = await reopened.fleet.app("lina");
		expect(next.binding).toEqual(app.binding);
		expect((await reopened.call("/api/agents/lina/memory", {})).status).toBe(
			200,
		);
		ordinaryEpisode(next, "new", "NEW_ORDINARY_TEA");
		await next.memory.refresh();
		expect(await next.memory.recall("tea")).toContain("NEW_ORDINARY_TEA");
		expect(await next.memory.recall("tea")).not.toContain(
			"LEGACY_PRIVATE_MEMORY",
		);
		const preserved = new HonchoOutbox(
			path,
			app.binding,
			publicIdentity(config),
		);
		try {
			expect(preserved.counts().withheld).toBe(1);
			expect(preserved.part(1)?.content).toBe("LEGACY_PRIVATE_MEMORY");
			expect(preserved.next()).toEqual([]);
		} finally {
			preserved.close();
		}
		expect(http.seen.some((s) => s.path.includes("/legacy/"))).toBe(false);
	} finally {
		await reopened?.close();
		await first.close();
		http.close();
	}
});

test("a foreign global owner is unavailable without native fallback or any remote dispatch", async () => {
	const http = new HonchoHttpFixture();
	const f = await fleetMemoryFixture(
		{
			honcho: selectedConfig(http.baseUrl, "lina"),
			qualifiedHonchoAdapter: http.adapter,
		},
		http,
	);
	try {
		expect(f.fleet.memoryConfig("kai")).toBeUndefined();
		const app = await f.fleet.app("kai");
		expect(f.received.get("kai")?.memoryBackend).toBe("honcho");
		expect(app.memory.status().service).toBe("unavailable");
		expect((await f.call("/api/agents/kai/memory", {})).status).toBe(409);
		await app.memory.refresh();
		expect(await app.memory.recall("tea")).toBe("");
		expect(http.seen).toEqual([]);
	} finally {
		await f.close();
		http.close();
	}
});

test("an explicit wrong-owner map entry fails instead of falling back to global configuration", async () => {
	const f = await fleetMemoryFixture({
		honcho: selectedConfig("http://127.0.0.1:1", "kai"),
		honchoByAgent: { kai: selectedConfig("http://127.0.0.1:1", "lina") },
	});
	try {
		expect(() => f.fleet.memoryConfig("kai")).toThrow(/owner/);
	} finally {
		await f.close();
	}
});

test("qualified startup and management refuse missing or forged qualification before resource calls", async () => {
	for (const fault of ["absent", "owner", "unqualified"] as const) {
		const http = new HonchoHttpFixture();
		if (fault !== "absent") http.fault = fault;
		const f = await fleetMemoryFixture(
			{
				honcho: selectedConfig(http.baseUrl, "lina"),
				...(fault === "absent" ? {} : { qualifiedHonchoAdapter: http.adapter }),
			},
			http,
		);
		try {
			const app = await f.fleet.app("lina");
			const response = await f.call("/api/agents/lina/memory", {});
			expect(response.status).toBe(409);
			expect(app.memory.status().service).toBe("unavailable");
			expect(http.seen.filter((s) => s.path.startsWith("/v3/"))).toEqual([]);
		} finally {
			await f.close();
			http.close();
		}
	}
});
