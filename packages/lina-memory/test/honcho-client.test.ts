import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HonchoClient } from "../src/honcho/client.ts";
import { HonchoRequestError, type OutboxPart } from "../src/honcho/types.ts";
import {
	qualifiedConfig as config,
	FakeHoncho,
	Fixture,
} from "./honcho-fixture.ts";

let fixture: Fixture;
beforeEach(() => {
	fixture = new Fixture();
});
afterEach(() => fixture.close());
function part(patch: Partial<OutboxPart> = {}): OutboxPart {
	return fixture.part(patch);
}
function metadata() {
	const p = part();
	return {
		entryId: p.entryId,
		partIndex: p.partIndex,
		contentHash: p.contentHash,
		version: 2,
		sourceProofs: p.sourceProofs,
		policyScope: p.policyScope,
	};
}

describe("HonchoClient", () => {
	it("recall query respects the embedding byte budget and returned text fits the wire limit", async () => {
		const fake = new FakeHoncho();
		part();
		const options = fixture.clientOptions(fake),
			adapter = options.qualifiedAdapter;
		if (!adapter) throw new Error("missing fixture adapter");
		let sent = "";
		const client = new HonchoClient(config, {
			...options,
			qualifiedAdapter: {
				...adapter,
				async recall(request) {
					sent = request.query;
					const result = (await adapter.recall(request)) as { proof: unknown };
					return { text: "가" + "😀".repeat(5000), proof: result.proof };
				},
			},
		});
		const result = await client.recall("긴 대화 😀 ".repeat(1000));
		expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(1500);
		expect(result.text.length).toBeLessThanOrEqual(4096);
		expect(result.text.endsWith("😀")).toBe(true);
	});
	it("does not treat an incomplete reconciliation page as proof of a unique receipt", async () => {
		const fake = new FakeHoncho();
		const client = new HonchoClient(config, fixture.clientOptions(fake));
		await client.createMessage(part());
		fake.behavior = () =>
			Response.json({
				items: fake.messages,
				total: 51,
				page: 1,
				size: 50,
				pages: 2,
			});
		await expect(client.findMessages(part())).rejects.toThrow("incomplete");
	});
	it("posts one message per part to the pinned route with the exact match key and validates the receipt", async () => {
		const fake = new FakeHoncho();
		const client = new HonchoClient(config, fixture.clientOptions(fake));
		const receipt = await client.createMessage(part({ role: "assistant" }));
		expect(receipt).toEqual({ remoteId: "msg_1" });
		const seen = fake.seen[0];
		expect(seen?.url).toBe(
			"http://127.0.0.1:8000/v3/workspaces/lina-test/sessions/lina-main/messages",
		);
		expect(seen?.headers["authorization"]).toBe("Bearer secret-key");
		expect(seen?.body).toEqual({
			messages: [
				{
					content: "hello",
					peer_id: "lina",
					metadata: {
						lina: metadata(),
					},
				},
			],
		});
	});

	it("refuses a receipt whose scope, peer, content or key differs", async () => {
		const fake = new FakeHoncho();
		const client = new HonchoClient(config, fixture.clientOptions(fake));
		const wrong = (patch: Record<string, unknown>) => {
			fake.behavior = () =>
				new Response(
					JSON.stringify([
						{
							id: "msg_x",
							workspace_id: "lina-test",
							session_id: "lina-main",
							peer_id: "example",
							content: "hello",
							metadata: {
								lina: metadata(),
							},
							...patch,
						},
					]),
					{ status: 201 },
				);
			return client.createMessage(part());
		};
		await expect(wrong({ workspace_id: "other" })).rejects.toThrow(
			/does not match/,
		);
		await expect(wrong({ session_id: "other" })).rejects.toThrow(
			/does not match/,
		);
		await expect(wrong({ peer_id: "lina" })).rejects.toThrow(/does not match/);
		await expect(wrong({ content: "hellO" })).rejects.toThrow(/does not match/);
		await expect(
			wrong({
				metadata: {
					lina: { ...metadata(), extra: 1 },
				},
			}),
		).rejects.toThrow(/unexpected keys/);
		await expect(wrong({ id: 5 })).rejects.toThrow(/message id/);
	});

	it("surfaces HTTP status, redirect, timeout, oversized and malformed bodies without retrying", async () => {
		const fake = new FakeHoncho();
		const client = new HonchoClient(config, {
			...fixture.clientOptions(fake),
			fetch: fake.fetch,
			timeoutMs: 50,
			bodyCapBytes: 64,
		});
		const kinds: string[] = [];
		const attempt = async (behavior: FakeHoncho["behavior"]) => {
			fake.behavior = behavior;
			try {
				await client.createMessage(part());
			} catch (error) {
				if (!(error instanceof HonchoRequestError)) throw error;
				kinds.push(error.kind);
			}
		};
		await attempt(() => new Response("{}", { status: 422 }));
		await attempt(
			() =>
				new Response(null, {
					status: 307,
					headers: { location: "https://api.honcho.dev" },
				}),
		);
		await attempt(() => new Promise<Response>(() => undefined));
		await attempt(
			() =>
				new Response(`[${JSON.stringify({ id: "x".repeat(200) })}]`, {
					status: 201,
				}),
		);
		await attempt(() => new Response("<html>", { status: 201 }));
		await attempt(() => {
			throw new TypeError("fetch failed");
		});
		expect(kinds).toEqual([
			"status",
			"redirect",
			"timeout",
			"body",
			"body",
			"network",
		]);
		expect(fake.seen.length).toBe(6);
		expect(
			fake.seen.every(
				(seen) => seen.headers["authorization"] === "Bearer secret-key",
			),
		).toBe(true);
	});

	it("recall requires qualified provenance, short-circuits empty queries and rejects malformed text", async () => {
		const fake = new FakeHoncho();
		part();
		const options = fixture.clientOptions(fake),
			adapter = options.qualifiedAdapter;
		if (!adapter) throw new Error("missing fixture adapter");
		let captured: unknown;
		const client = new HonchoClient(config, {
			...options,
			qualifiedAdapter: {
				...adapter,
				async recall(request) {
					captured = request;
					return adapter.recall(request);
				},
			},
		});
		expect(await client.recall("   ")).toEqual({
			text: "",
			scope: client.identity,
			freshness: "unknown",
		});
		expect(captured).toBeUndefined();
		const result = await client.recall("coffee");
		expect(result.text).toBe("Representation for example: coffee");
		expect(result.proof?.owner.ordinaryNamespace.ownerBotId).toBe("lina");
		expect(captured).toMatchObject({
			query: "coffee",
			topK: 8,
			owner: { identity: client.identity },
		});
		const malformed = new HonchoClient(config, {
			...options,
			qualifiedAdapter: {
				...adapter,
				async recall() {
					return { text: 7 };
				},
			},
		});
		await expect(malformed.recall("x")).rejects.toThrow(/not a string/);
	});
	it("check only lists resources while initialize creates exactly the configured ones", async () => {
		const fake = new FakeHoncho();
		const client = new HonchoClient(config, fixture.clientOptions(fake));
		expect(await client.check()).toEqual({
			ok: false,
			missing: ["peer:example", "peer:lina", "session:lina-main"],
		});
		expect(fake.seen.map((s) => s.url.replace(/^.*\/v3/, ""))).toEqual([
			"/workspaces/lina-test/peers/list",
			"/workspaces/lina-test/sessions/list",
		]);
		expect(fake.workspaces.size + fake.peers.size + fake.sessions.size).toBe(0);
		expect(await client.initialize()).toEqual({
			created: [
				"workspace:lina-test",
				"peer:example",
				"peer:lina",
				"session:lina-main",
			],
		});
		expect(await client.initialize()).toEqual({ created: [] });
		expect(await client.check()).toEqual({ ok: true, missing: [] });
		const session = fake.seen.find(
			(s) => s.url.endsWith("/sessions") && s.method === "POST",
		);
		expect(session?.body).toEqual({
			id: "lina-main",
			peers: {
				example: { observe_me: true, observe_others: false },
				lina: { observe_me: false, observe_others: true },
			},
		});
	});
});
