import type { WorldAuthorSession } from "../life/author-session.ts";
import { lifeBindingRoutes } from "./life-binding-routes.ts";
import { lifeRuntimeRoutes } from "./life-runtime-routes.ts";
import type { AgentFleet } from "./manager.ts";

const reply = (value: unknown, status = 200) =>
	Response.json(value, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
const invalid = () => {
	throw Error("Invalid world authoring request");
};
function keys(input: Record<string, unknown>, allowed: string[]) {
	if (
		Object.keys(input).length !== allowed.length ||
		Object.keys(input).some((key) => !allowed.includes(key))
	)
		invalid();
}
function id(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value)
	)
		throw Error("Invalid identifier");
	return value;
}
function revision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw Error("Invalid revision");
	return value;
}
function query(url: URL, allowed: string[]) {
	for (const key of url.searchParams.keys())
		if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
			invalid();
}
function queryNumber(value: string | null): number | undefined {
	if (value === null) return undefined;
	if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid();
	return revision(Number(value));
}
function opened(fleet: AgentFleet, grantId: string): WorldAuthorSession {
	const author = fleet.openedWorldAuthor(grantId);
	if (!author) throw Error("Author session is not open; reopen required");
	return author;
}

export async function lifeRoutes(
	request: Request,
	fleet: AgentFleet,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== "/api/life" && !url.pathname.startsWith("/api/life/"))
		return;
	if (
		request.headers.has("origin") ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		request.headers.get("host") !== url.host
	)
		return reply({ error: "Forbidden" }, 403);
	const parts = url.pathname.slice("/api/life/".length).split("/");
	if (
		parts.some(
			(part) => !part || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(part),
		)
	)
		return reply({ error: "Unknown world authoring route" }, 404);
	const binding = await lifeBindingRoutes(request, fleet, json);
	if (binding) return binding;
	const runtime = await lifeRuntimeRoutes(request, fleet, json);
	if (runtime) return runtime;
	const [resource, resourceId, action] = parts;
	const method = request.method;
	const methods =
		resource === "drafts"
			? !resourceId
				? ["GET", "POST"]
				: !action
					? ["GET", "PATCH"]
					: ["preview", "confirm", "suggest"].includes(action)
						? ["POST"]
						: []
			: resource === "worlds"
				? !resourceId
					? ["GET"]
					: action === "pack"
						? ["GET"]
						: action === "config"
							? ["GET", "PUT"]
							: []
				: resource === "suggestions" && resourceId
					? !action
						? ["GET"]
						: action === "abandon"
							? ["POST"]
							: []
					: resource === "author-sessions"
						? !resourceId
							? ["POST"]
							: !action
								? ["GET"]
								: ["history", "approvals"].includes(action)
									? ["GET"]
									: ["open", "input", "approval", "cancel", "revoke"].includes(
												action,
											)
										? ["POST"]
										: []
						: [];
	if (parts.length > 3 || !methods.length)
		return reply({ error: "Unknown world authoring route" }, 404);
	if (!methods.includes(method))
		return reply({ error: "Method not allowed" }, 405);
	try {
		const list = !resourceId && method === "GET";
		query(
			url,
			list
				? ["afterId", "limit"]
				: resource === "worlds" && action === "pack"
					? ["version"]
					: resource === "author-sessions" && action === "history"
						? ["before", "limit"]
						: [],
		);
		const input = async (fields?: string[]) => {
			if (
				request.headers.get("content-type")?.split(";")[0]?.trim() !==
				"application/json"
			)
				invalid();
			const value = await json();
			if (fields) keys(value, fields);
			return value;
		};
		const service = fleet.life;
		if (list) {
			const cursor = {
				afterId: url.searchParams.get("afterId"),
				limit: queryNumber(url.searchParams.get("limit")) ?? 20,
			};
			return reply(
				resource === "drafts" ? service.list(cursor) : service.catalog(cursor),
			);
		}
		if (resource === "drafts") {
			if (!resourceId) return reply(service.create(await input()), 201);
			if (!action && method === "GET") return reply(service.read(resourceId));
			if (!action) {
				const value = await input(["expectedRevision", "patch"]);
				return reply(
					service.edit(
						resourceId,
						revision(value["expectedRevision"]),
						value["patch"],
					),
				);
			}
			if (action === "preview") {
				const value = await input(["expectedRevision", "options"]);
				return reply(
					service.preview(
						resourceId,
						revision(value["expectedRevision"]),
						value["options"],
					),
				);
			}
			if (action === "confirm") {
				const value = await input();
				if (value["draftId"] !== resourceId) invalid();
				return reply(service.confirm(value));
			}
			const value = await input();
			if (value["draftId"] !== resourceId) invalid();
			return reply(await service.suggest(value, request.signal));
		}
		if (resource === "worlds" && resourceId) {
			if (action === "pack")
				return reply(
					service.pack(
						resourceId,
						queryNumber(url.searchParams.get("version")),
					),
				);
			if (method === "GET") return reply(service.config(resourceId));
			const value = await input(["expectedRevision", "config"]);
			return reply(
				service.setConfig(
					resourceId,
					revision(value["expectedRevision"]),
					value["config"],
				),
			);
		}
		if (resource === "suggestions" && resourceId) {
			if (!action) return reply(service.suggestion(resourceId));
			await input([]);
			return reply(service.abandon(resourceId));
		}
		if (!resourceId) {
			const value = await input(["worldId", "agentId"]);
			const grant = fleet.grantWorldAuthor(
				id(value["worldId"]),
				id(value["agentId"]),
			);
			try {
				const author = await fleet.openWorldAuthor(grant.id);
				return reply({ grant, snapshot: author.snapshot() }, 201);
			} catch (error) {
				await fleet.revokeWorldAuthor(grant.id, grant.revision);
				throw error;
			}
		}
		if (!action) {
			const grant = service.store.worldAuthorGrant(resourceId);
			service.assertScope({ grantId: grant.id, grantRevision: grant.revision });
			return reply({
				grant,
				snapshot: fleet.openedWorldAuthor(resourceId)?.snapshot() ?? null,
			});
		}
		if (action === "open") {
			await input([]);
			const author = await fleet.openWorldAuthor(resourceId);
			return reply({ grant: author.grant, snapshot: author.snapshot() });
		}
		if (action === "revoke") {
			const value = await input(["expectedRevision"]);
			return reply(
				await fleet.revokeWorldAuthor(
					resourceId,
					revision(value["expectedRevision"]),
				),
			);
		}
		const author = opened(fleet, resourceId);
		if (action === "history") {
			const before = queryNumber(url.searchParams.get("before"));
			const limit = queryNumber(url.searchParams.get("limit"));
			return reply(
				author.history({
					...(before === undefined ? {} : { before }),
					...(limit === undefined ? {} : { limit }),
				}),
			);
		}
		if (action === "approvals") return reply(author.controls());
		if (action === "input") {
			const value = await input(["requestId", "text"]);
			if (typeof value["text"] !== "string") invalid();
			return reply(
				author.submit(id(value["requestId"]), value["text"] as string),
				202,
			);
		}
		if (action === "cancel") {
			const value = await input(["requestId"]);
			await author.cancel(id(value["requestId"]));
			return reply({ cancelled: true });
		}
		const value = await input(["id", "inputDigest", "decision"]);
		if (value["decision"] !== "allow" && value["decision"] !== "deny")
			invalid();
		const accepted = author.reply(
			id(value["id"]),
			id(value["inputDigest"]),
			value["decision"] as "allow" | "deny",
		);
		return reply({ accepted }, accepted ? 200 : 409);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const status =
			/revoked|unauthorized|not authorized|ownership|foreign|scope/i.test(
				message,
			)
				? 403
				: /conflict|stale|not open|revision|uncertain/i.test(message)
					? 409
					: /unavailable|required.*engine/i.test(message)
						? 503
						: 400;
		return reply(
			{
				error:
					status === 403
						? "World author authority is unavailable"
						: status === 409
							? "World authoring state changed; reload the exact revision"
							: status === 503
								? "World author engine unavailable"
								: "Invalid world authoring request",
			},
			status,
		);
	}
}
