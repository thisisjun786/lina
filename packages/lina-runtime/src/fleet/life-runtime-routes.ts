import { LifeRunnerUnavailable } from "../life/runner.ts";
import type { AgentFleet } from "./manager.ts";

const reply = (value: unknown, status = 200) =>
	Response.json(value, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;

/** Full diagnostics are owner-only. Never register this service on ordinary agent tools. */
export async function lifeRuntimeRoutes(
	request: Request,
	fleet: AgentFleet,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	const parts = url.pathname.split("/");
	const worldId = parts[4],
		action = parts[5],
		stepId = parts[6];
	if (
		parts[1] !== "api" ||
		parts[2] !== "life" ||
		parts[3] !== "worlds" ||
		!worldId ||
		!identifier.test(worldId) ||
		!(
			(parts.length === 6 && (action === "status" || action === "step")) ||
			(parts.length === 7 &&
				action === "steps" &&
				stepId &&
				identifier.test(stepId))
		)
	)
		return;
	if (
		request.headers.has("origin") ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		request.headers.get("host") !== url.host
	)
		return reply({ error: "Forbidden" }, 403);
	if (request.method !== (action === "step" ? "POST" : "GET"))
		return reply({ error: "Method not allowed" }, 405);
	if (url.search) return reply({ error: "Invalid LIFE query" }, 400);
	try {
		if (action === "status") return reply(fleet.lifeRuntime.status(worldId));
		if (action === "steps" && stepId)
			return reply(fleet.lifeRuntime.step(worldId, stepId));
		if (
			request.headers.get("content-type")?.split(";")[0]?.trim() !==
			"application/json"
		)
			return reply({ error: "Invalid LIFE request" }, 400);
		const input = await json();
		const key = input["idempotencyKey"],
			revision = input["expectedConfigRevision"];
		if (
			Object.keys(input).length !== 2 ||
			typeof key !== "string" ||
			!identifier.test(key) ||
			typeof revision !== "number" ||
			!Number.isSafeInteger(revision) ||
			revision < 0
		)
			return reply({ error: "Invalid LIFE request" }, 400);
		return reply(
			await fleet.lifeRuntime.run(worldId, key, revision, request.signal),
		);
	} catch (error) {
		if (error instanceof LifeRunnerUnavailable)
			return reply(
				{ error: `LIFE ${error.status}`, missing: error.missing },
				error.status === "closed" ? 503 : 409,
			);
		const message = error instanceof Error ? error.message : "";
		const status = /ownership|unauthorized|foreign|scope/i.test(message)
			? 403
			: /conflict|stale|revision|uncertain/i.test(message)
				? 409
				: /unavailable/i.test(message)
					? 503
					: 400;
		return reply(
			{
				error:
					status === 403
						? "LIFE owner authority unavailable"
						: status === 409
							? "LIFE state changed; reload the exact revision"
							: status === 503
								? "LIFE runtime unavailable"
								: "Invalid LIFE request",
			},
			status,
		);
	}
}
