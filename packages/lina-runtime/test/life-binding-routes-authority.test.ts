import { expect, spyOn, test } from "bun:test";
import { lifeBindingRoutes } from "../src/fleet/life-binding-routes.ts";
import {
	bindingFixture,
	putBinding,
	selection,
} from "./life-binding-routes-fixture.test.ts";

test("direct binding helper cannot bypass the protected HTTP boundary", async () => {
	const f = await bindingFixture();
	try {
		let bodyCalls = 0;
		for (const request of [
			new Request(f.url, { method: "PUT" }),
			new Request(f.url, { headers: { host: "foreign.test" } }),
			new Request(f.url, {
				headers: { host: new URL(f.url).host, origin: "" },
			}),
			...[
				"https://127.0.0.1:9",
				"http://localhost:9",
				"http://192.0.2.1:9",
			].map(
				(base) =>
					new Request(`${base}/api/life/agents/lina/binding`, {
						headers: { host: new URL(base).host },
					}),
			),
		]) {
			expect(
				(
					await lifeBindingRoutes(request, f.fleet, async () => {
						bodyCalls++;
						return { expectedRevision: 0, selection };
					})
				)?.status,
			).toBe(403);
		}
		expect(bodyCalls).toBe(0);
		expect(f.store().worldBinding("lina")).toBeNull();
	} finally {
		await f.close();
	}
});

test("binding reads and writes require current installation authority", async () => {
	const f = await bindingFixture();
	try {
		const store = f.store();
		f.setOwner(false);
		expect((await fetch(f.url)).status).toBe(403);
		expect(
			(await putBinding(f.url, { expectedRevision: 0, selection })).status,
		).toBe(403);
		expect(store.worldBinding("lina")).toBeNull();
	} finally {
		await f.close();
	}
});

for (const change of ["owner", "agent", "binding", "closed"] as const)
	test(`binding rechecks ${change} after awaiting JSON before committing`, async () => {
		const f = await bindingFixture();
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<Record<string, unknown>>();
		const store = f.store();
		let restore: (() => void) | undefined;
		const pending = lifeBindingRoutes(
			new Request(f.url, {
				method: "PUT",
				headers: {
					host: new URL(f.url).host,
					"content-type": "application/json",
				},
			}),
			f.fleet,
			() => {
				entered.resolve();
				return released.promise;
			},
		);
		try {
			await entered.promise;
			if (change === "owner") f.setOwner(false);
			if (change === "agent") {
				// Simulate current registry removal; the route still uses the real fleet/store.
				const original = f.fleet.agents.get.bind(f.fleet.agents);
				const unavailable = spyOn(f.fleet.agents, "get").mockImplementation(
					(id) => (id === "lina" ? undefined : original(id)),
				);
				restore = () => unavailable.mockRestore();
			}
			if (change === "binding")
				store.setWorldBinding("lina", 0, {
					...selection,
					conversationRecipientId: "other-explicit-recipient",
				});
			if (change === "closed") await f.fleet.close();
			released.resolve({ expectedRevision: 0, selection });
			const result = await pending;
			expect(result?.status).toBe(
				change === "owner"
					? 403
					: change === "agent"
						? 404
						: change === "binding"
							? 409
							: 503,
			);
			if (change === "binding")
				expect(store.worldBinding("lina")).toEqual({
					...selection,
					conversationRecipientId: "other-explicit-recipient",
					agentId: "lina",
					revision: 1,
				});
			else if (change !== "closed")
				expect(store.worldBinding("lina")).toBeNull();
		} finally {
			released.resolve({ expectedRevision: 0, selection });
			await pending;
			restore?.();
			await f.close();
		}
	});
