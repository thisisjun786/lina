import { expect, test } from "bun:test";
import { activateSocialPack } from "../../lina-core/test/life-social-store-fixture.ts";
import { authorPack } from "./life-authoring-fixture.ts";
import {
	bindingFixture,
	putBinding,
	selection,
} from "./life-binding-routes-fixture.test.ts";

test("protected binding HTTP persists explicit V2, checks CAS and reopens without starting a session", async () => {
	const f = await bindingFixture();
	try {
		const empty = await fetch(f.url);
		expect(empty.status).toBe(200);
		expect(await empty.json()).toBeNull();
		const saved = await putBinding(f.url, { expectedRevision: 0, selection });
		expect(saved.status).toBe(200);
		expect(saved.headers.get("cache-control")).toBe("no-store");
		expect(saved.headers.get("x-content-type-options")).toBe("nosniff");
		const expected = { ...selection, agentId: "lina", revision: 1 };
		expect(await saved.json()).toEqual(expected);
		expect(f.store().worldBinding("lina")).toEqual(expected);
		expect(
			(await putBinding(f.url, { expectedRevision: 0, selection })).status,
		).toBe(409);
		await f.reopen();
		expect(await (await fetch(f.url)).json()).toEqual(expected);
		const growthOnly = { ...selection, conversationRecipientId: null };
		expect(
			await (
				await putBinding(f.url, { expectedRevision: 1, selection: growthOnly })
			).json(),
		).toEqual({ ...growthOnly, agentId: "lina", revision: 2 });
		const unbound = {
			version: 2,
			worldId: null,
			projectionPolicyRevision: 0,
			conversationRecipientId: null,
		};
		expect(
			await (
				await putBinding(f.url, { expectedRevision: 2, selection: unbound })
			).json(),
		).toEqual({ ...unbound, agentId: "lina", revision: 3 });
		await f.reopen();
		expect(await (await fetch(f.url)).json()).toEqual({
			...unbound,
			agentId: "lina",
			revision: 3,
		});
		expect(f.sessionCalls).toBe(0);
	} finally {
		await f.close();
	}
});

test("GET preserves V1 bytes and V2 replacement requires its persisted revision", async () => {
	const f = await bindingFixture();
	try {
		const old = f.store().setWorldBinding("lina", 0, {
			worldId: "test-world",
			projectionPolicyRevision: 1,
		});
		expect(await (await fetch(f.url)).json()).toEqual(old);
		expect(old).not.toHaveProperty("conversationRecipientId");
		expect(
			(await putBinding(f.url, { expectedRevision: 0, selection })).status,
		).toBe(409);
		expect(
			await (
				await putBinding(f.url, { expectedRevision: 1, selection })
			).json(),
		).toEqual({ ...selection, agentId: "lina", revision: 2 });
	} finally {
		await f.close();
	}
});

test("binding HTTP rejects forged fields, malformed revisions, omitted recipient and non-V2 selection", async () => {
	const f = await bindingFixture();
	try {
		const body = { expectedRevision: 0, selection };
		const {
			conversationRecipientId: _recipient,
			version: _version,
			...v1
		} = selection;
		for (const invalid of [
			null,
			[],
			{},
			{ selection },
			...["0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null].map(
				(expectedRevision) => ({ ...body, expectedRevision }),
			),
			{ ...body, selection: v1 },
			{ ...body, selection: { ...v1, version: 2 } },
			...[
				null,
				[],
				{ ...selection, version: 1 },
				{ ...selection, conversationRecipientId: "" },
				{ ...selection, conversationRecipientId: { id: "owner" } },
				{ ...selection, conversationRecipientId: "x".repeat(257) },
				{ ...selection, worldId: null, projectionPolicyRevision: 0 },
				{ ...selection, worldId: "../foreign" },
				{ ...selection, projectionPolicyRevision: "1" },
				{ ...selection, projectionPolicyRevision: 0 },
			].map((selection) => ({ ...body, selection })),
			...[
				{ agentId: "mira" },
				{ ownerAgentId: "lina" },
				{ authority: { kind: "management" } },
				{ grantId: "forged" },
				{ revision: 99 },
				{ recipientId: "owner" },
			].flatMap((extra) => [
				{ ...body, ...extra },
				{ ...body, selection: { ...selection, ...extra } },
			]),
		]) {
			expect((await putBinding(f.url, invalid)).status).toBe(400);
			expect(f.store().worldBinding("lina")).toBeNull();
		}
	} finally {
		await f.close();
	}
});

test("binding HTTP requires managed agents and prepared participant worlds with exact projection revision", async () => {
	const f = await bindingFixture();
	try {
		// mira exists in the world pack, but has not been installed as a fleet agent.
		for (const agentId of ["mira", "unknown"])
			for (const method of ["GET", "PUT"]) {
				const url = f.url.replace("/lina/", `/${agentId}/`);
				const response =
					method === "GET"
						? await fetch(url)
						: await putBinding(url, { expectedRevision: 0, selection });
				expect(response.status).toBe(404);
				expect(f.store().worldBinding(agentId)).toBeNull();
			}
		const profile = f.fleet.agents.get("lina");
		if (!profile) throw Error("Missing managed agent");
		const { revision: _revision, ...input } = profile;
		f.fleet.agents.create({ ...input, id: "outsider" });
		const foreign = authorPack("foreign-world");
		foreign.life.participants = ["mira", "sol"];
		activateSocialPack(f.store(), foreign);
		f.fleet.life.create({ worldId: "draft-only", authoredText: "Unconfirmed" });
		for (const [agentId, selected] of [
			["outsider", selection],
			["lina", { ...selection, worldId: "foreign-world" }],
			["lina", { ...selection, worldId: "draft-only" }],
			["lina", { ...selection, worldId: "missing-world" }],
			["lina", { ...selection, projectionPolicyRevision: 2 }],
		] as const) {
			expect(
				(
					await putBinding(f.url.replace("/lina/", `/${agentId}/`), {
						expectedRevision: 0,
						selection: selected,
					})
				).status,
			).toBe(400);
			expect(f.store().worldBinding(agentId)).toBeNull();
		}
	} finally {
		await f.close();
	}
});

test("binding HTTP rejects Origin, hostile Host, query, verbs, extra paths and invalid JSON without writes", async () => {
	const f = await bindingFixture();
	try {
		const body = { expectedRevision: 0, selection };
		for (const headers of [
			{ origin: "https://foreign.test" },
			{ origin: "null" },
			{ origin: "" },
			{ host: "foreign.test" },
		]) {
			expect((await fetch(f.url, { headers })).status).toBe(403);
			expect((await putBinding(f.url, body, headers)).status).toBe(403);
		}
		for (const query of ["?worldId=foreign", "?recipientId=owner", "?x=1&x=2"])
			for (const method of ["GET", "PUT"])
				expect(
					(method === "GET"
						? await fetch(f.url + query)
						: await putBinding(f.url + query, body)
					).status,
				).toBe(400);
		for (const method of ["POST", "PATCH", "DELETE", "OPTIONS", "HEAD"])
			expect((await fetch(f.url, { method })).status).toBe(405);
		for (const suffix of ["/extra", "/", "/recall"])
			expect((await putBinding(f.url + suffix, body)).status).toBe(404);
		for (const raw of ["{", "[]", "null", " ".repeat(65537)])
			expect(
				(
					await fetch(f.url, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: raw,
					})
				).status,
			).toBe(400);
		expect(
			(await putBinding(f.url, body, { "content-type": "text/plain" })).status,
		).toBe(400);
		expect(f.store().worldBinding("lina")).toBeNull();
		expect(f.sessionCalls).toBe(0);
	} finally {
		await f.close();
	}
});
