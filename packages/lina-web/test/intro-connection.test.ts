import { expect, test } from "bun:test";
import { checkIntroConnection } from "../client/intro-connection.ts";

const profile = {
	id: "default",
	provider: "opencodex",
	model: "connected",
	reasoning: "low",
};
const settings = {
	revision: 1,
	profiles: [profile],
	defaultProfileId: "default",
	roles: {},
	agentRoles: {},
};
const catalog = [
	{ provider: "opencodex", id: "connected", authenticated: true },
];
function request(models: unknown, hub: unknown = { connected: true }) {
	const calls: string[] = [];
	return {
		calls,
		send: async (path: string, method = "GET") => {
			expect(method).toBe("GET");
			calls.push(path);
			if (path === "/api/models") return models;
			if (path === "/api/hub/status") return hub;
			throw Error("must not generate or write");
		},
	};
}
test("unconfigured first entry offers model setup without a model turn", async () => {
	const api = request({
		settings: { ...settings, profiles: [], defaultProfileId: null },
		catalog,
	});
	expect(await checkIntroConnection(api.send, "lina")).toMatchObject({
		ready: false,
	});
	expect(api.calls).not.toContain("/api/agents/lina/intro/turn");
});
test("first entry requires a connected Hub and the selected authenticated model", async () => {
	expect(
		(await checkIntroConnection(request({ settings, catalog }).send, "lina"))
			.ready,
	).toBe(true);
	expect(
		(
			await checkIntroConnection(
				request({ settings, catalog }, { connected: false }).send,
				"lina",
			)
		).ready,
	).toBe(false);
	expect(
		(
			await checkIntroConnection(
				request({ settings, catalog: [] }).send,
				"lina",
			)
		).ready,
	).toBe(false);
	expect(
		(
			await checkIntroConnection(
				request({
					settings,
					catalog: [{ ...catalog[0], authenticated: false }],
				}).send,
				"lina",
			)
		).ready,
	).toBe(false);
});
test("agent conversation override determines readiness independently of global default", async () => {
	const own = { ...profile, id: "own", model: "missing" };
	const api = request({
		settings: {
			...settings,
			profiles: [profile, own],
			agentRoles: { custom: { conversation: "own" } },
		},
		catalog,
	});
	expect((await checkIntroConnection(api.send, "custom")).ready).toBe(false);
	expect((await checkIntroConnection(api.send, "lina")).ready).toBe(true);
});
test("invalid or unreachable settings return a recoverable setup message", async () => {
	for (const raw of [
		null,
		{},
		{ settings: null, catalog },
		{ settings: { ...settings, revision: -1 }, catalog },
	]) {
		const result = await checkIntroConnection(request(raw).send, "lina");
		expect(result.ready).toBe(false);
		expect(result.message).toBeTruthy();
	}
	const result = await checkIntroConnection(async () => {
		throw Error("offline");
	}, "lina");
	expect(result.ready).toBe(false);
});
