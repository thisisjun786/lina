import { parseBindingSelection } from "../../../lina-core/src/world/life-validation.ts";
import { WorldStore } from "../../../lina-core/src/world/store.ts";
import { type AgentFleet, validAgentId } from "./manager.ts";

const reply = (value: unknown, status = 200) =>
	Response.json(value, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});

function narrowWorldStore(fleet: AgentFleet): WorldStore {
	// Resolve through the live installation owner, including after body parsing.
	const service = fleet.life;
	service.assertScope();
	const store = service.store;
	if (!(store instanceof WorldStore))
		throw Error("LIFE binding store unavailable");
	return store;
}

/** Management-only composition. Never register binding writes as model tools. */
export async function lifeBindingRoutes(
	request: Request,
	fleet: AgentFleet,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (!/^\/api\/life\/agents(?:\/|$)/.test(url.pathname)) return;
	// Keep direct callers subject to the same boundary as lifeRoutes.
	if (
		request.headers.has("origin") ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		request.headers.get("host") !== url.host
	)
		return reply({ error: "Forbidden" }, 403);
	const match = /^\/api\/life\/agents\/([^/]+)\/binding$/.exec(url.pathname);
	const agentId = match?.[1];
	if (!agentId || !validAgentId(agentId))
		return reply({ error: "Unknown LIFE binding route" }, 404);
	if (request.method !== "GET" && request.method !== "PUT")
		return reply({ error: "Method not allowed" }, 405);
	if (url.search) return reply({ error: "Invalid LIFE binding query" }, 400);
	try {
		const store = narrowWorldStore(fleet);
		if (!fleet.agents.get(agentId))
			return reply({ error: "Unknown managed agent" }, 404);
		if (request.method === "GET") return reply(store.worldBinding(agentId));
		if (
			request.headers.get("content-type")?.split(";")[0]?.trim() !==
			"application/json"
		)
			return reply({ error: "Invalid LIFE binding request" }, 400);
		const input = await json();
		if (
			!input ||
			typeof input !== "object" ||
			Array.isArray(input) ||
			Object.keys(input).length !== 2 ||
			!Object.hasOwn(input, "expectedRevision") ||
			!Object.hasOwn(input, "selection") ||
			typeof input["expectedRevision"] !== "number" ||
			!Number.isSafeInteger(input["expectedRevision"]) ||
			input["expectedRevision"] < 0
		)
			return reply({ error: "Invalid LIFE binding request" }, 400);
		const selection = parseBindingSelection(input["selection"]);
		if (!("version" in selection) || selection.version !== 2)
			return reply({ error: "WorldBindingV2 selection required" }, 400);
		const currentStore = narrowWorldStore(fleet);
		if (!fleet.agents.get(agentId))
			return reply({ error: "Unknown managed agent" }, 404);
		return reply(
			currentStore.setWorldBinding(
				agentId,
				input["expectedRevision"],
				selection,
			),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const status = /ownership|unauthorized|revoked|foreign|scope/i.test(message)
			? 403
			: /conflict|stale/i.test(message)
				? 409
				: /unavailable|closed/i.test(message)
					? 503
					: 400;
		return reply(
			{
				error:
					status === 403
						? "LIFE owner authority unavailable"
						: status === 409
							? "LIFE binding changed; reload the exact revision"
							: status === 503
								? "LIFE binding store unavailable"
								: "Invalid LIFE binding request",
			},
			status,
		);
	}
}
