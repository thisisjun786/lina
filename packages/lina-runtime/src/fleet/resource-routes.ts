import { z } from "zod";
import type { ResourceActivities } from "../../../lina-memory/src/resources/activities.ts";
import {
	canonical,
	createSchema,
	updateSchema,
} from "../../../lina-memory/src/resources/codec.ts";
import { readResource } from "../../../lina-memory/src/resources/retrieval.ts";
import type { ResourceStore } from "../../../lina-memory/src/resources/store.ts";
import type { ResourceScope } from "../../../lina-memory/src/resources/types.ts";
import {
	activityCommands,
	projectActivityRecord,
} from "../resources/activity-tools.ts";
import type { ResourceSearch } from "../resources/search.ts";

const reply = (data: unknown, status = 200) =>
	Response.json(data, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
const encodedFields = {
	text: z.string().optional(),
	base64: z.string().optional(),
};
const createInput = createSchema.omit({ bytes: true }).extend(encodedFields);
const updateInput = updateSchema.omit({ bytes: true }).extend(encodedFields);
async function json(request: Request, maxBytes: number): Promise<unknown> {
	if (!request.headers.get("content-type")?.startsWith("application/json"))
		throw Error("invalid content type");
	const reader = request.body?.getReader();
	if (!reader) throw Error("missing body");
	let size = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			request.signal.throwIfAborted();
			const next = await reader.read();
			if (next.done) break;
			size += next.value.length;
			if (size > maxBytes) {
				await reader.cancel();
				throw Error("body limit");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function bytes(input: { text?: string; base64?: string }) {
	if (input.text !== undefined && input.base64 !== undefined)
		throw Error("choose one content encoding");
	if (input.text !== undefined)
		return { bytes: new TextEncoder().encode(input.text) };
	if (input.base64 !== undefined) {
		if (
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				input.base64,
			)
		)
			throw Error("invalid base64");
		return { bytes: Uint8Array.from(Buffer.from(input.base64, "base64")) };
	}
	return {};
}
/** Behind the existing authenticated loopback Fleet gateway. Browser Origin requests are never accepted directly. */
export async function resourceRoutes(
	request: Request,
	options: {
		store: ResourceStore;
		activities?: ResourceActivities;
		onActivityChanged?: (worldId: string) => void;
		scope: () => ResourceScope;
		basePath?: string;
		search?: ResourceSearch;
		onStored?: (
			resource: import("../../../lina-memory/src/resources/types.ts").Resource,
		) => void;
	},
): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (options.basePath) {
		if (
			url.pathname !== options.basePath &&
			!url.pathname.startsWith(`${options.basePath}/`)
		)
			return;
		url.pathname =
			"/api/resources" + url.pathname.slice(options.basePath.length);
	}
	if (
		url.pathname !== "/api/resources" &&
		!url.pathname.startsWith("/api/resources/")
	)
		return;
	if (
		request.headers.has("origin") ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		request.headers.get("host") !== url.host
	)
		return reply({ error: "Forbidden" }, 403);
	const { store, scope } = options,
		before = canonical(scope());
	const guard = () => {
		request.signal.throwIfAborted();
		if (canonical(scope()) !== before) throw Error("resource scope changed");
	};
	try {
		guard();
		for (const key of url.searchParams.keys())
			if (url.searchParams.getAll(key).length !== 1)
				throw Error("duplicate query");
		const query = Object.fromEntries(url.searchParams);
		const path = url.pathname
			.slice("/api/resources".length)
			.split("/")
			.filter(Boolean);
		if (path[0] === "activities") {
			if (!options.activities)
				return reply({ error: "Activity storage unavailable" }, 503);
			if (!scope().agentId)
				return reply({ error: "Attributed agent required" }, 403);
			if (path.length !== 2 || Object.keys(query).length)
				return reply({ error: "Unknown activity route" }, 404);
			if (request.method === "GET") {
				const record = options.activities.get(scope(), path[1] ?? "");
				if (record.receipt.actorAgentId !== scope().agentId)
					return reply({ error: "Activity unavailable" }, 404);
				guard();
				return reply(projectActivityRecord(record));
			}
			if (request.method !== "POST")
				return reply({ error: "Method not allowed" }, 405);
			const operation = activityCommands(options.activities).find(
				(op) => op.name === path[1],
			);
			if (!operation) return reply({ error: "Unknown activity route" }, 404);
			const body = await json(request, 512 * 1024);
			guard();
			const record = operation.run(body, scope());
			options.onActivityChanged?.(record.grant.worldId);
			guard();
			return reply(projectActivityRecord(record));
		}
		if (path.length === 0) {
			if (request.method === "GET") {
				const input = z
					.strictObject({
						collectionId: z.uuid().optional(),
						cursor: z.uuid().optional(),
						limit: z.coerce.number().int().min(1).max(100).optional(),
					})
					.parse(query);
				const result = store.list(scope(), input.collectionId ?? null, {
					...(input.cursor ? { cursor: input.cursor } : {}),
					...(input.limit ? { limit: input.limit } : {}),
				});
				guard();

				return reply(result);
			}
			if (request.method === "POST") {
				if (url.search) throw Error("unexpected query");
				const input = createInput.parse(
					await json(
						request,
						Math.ceil((store.limits.maxFileBytes * 4) / 3) + 16384,
					),
				);
				guard();
				const { text, base64, ...metadata } = input;
				const result = store.create(scope(), {
					...metadata,
					...bytes({
						...(text === undefined ? {} : { text }),
						...(base64 === undefined ? {} : { base64 }),
					}),
				});
				guard();
				options.onStored?.(result);
				return reply(result, 201);
			}
		}
		if (path[0] === "search" && path.length === 1 && request.method === "GET") {
			const input = z
				.strictObject({
					query: z.string().min(1).max(1024),
					cursor: z.uuid().optional(),
					collectionId: z.uuid().optional(),
					limit: z.coerce.number().int().min(1).max(50).optional(),
				})
				.parse(query);
			if (input.collectionId)
				store.list(scope(), input.collectionId, { limit: 1 });
			if (input.cursor && !options.search)
				throw Error("resource cursor unavailable");
			const result = options.search
				? await options.search.search(input, request.signal)
				: {
						items: store
							.find(scope(), input.query, input.limit ?? 20)
							.filter(
								(r) =>
									!input.collectionId ||
									r.parentId === input.collectionId ||
									r.collectionIds.includes(input.collectionId),
							),
						method: "lexical",
						incomplete: true,
						reasons: ["semantic_service_unconfigured"],
					};
			guard();
			if (options.search)
				options.search.assertCurrent(
					result.items as Parameters<ResourceSearch["assertCurrent"]>[0],
				);
			else if (
				result.items.some(
					(r) =>
						store.get(scope(), r.id).revision !==
						("revision" in r ? r.revision : r.ref.resourceRevision),
				)
			)
				throw Error("resource search changed");

			return reply(result);
		}
		if (
			path[0] === "jobs" &&
			path.length === 3 &&
			path[2] === "retry" &&
			request.method === "POST"
		) {
			if (url.search) throw Error("unexpected query");
			z.strictObject({}).parse(await json(request, 1024));
			guard();
			const id = z
				.string()
				.regex(/^[a-f0-9]{64}$/)
				.parse(path[1]);
			store.indexing.retry(scope(), id);
			const job = store.indexing.get(scope(), id);
			options.onStored?.(store.get(scope(), job.resourceId));
			return reply(job);
		}
		const id = z.uuid().parse(path[0]);
		if (path.length === 1 && request.method === "DELETE") {
			if (url.search) throw Error("unexpected query");
			const input = z
				.strictObject({
					operationId: z.string().min(1).max(160),
					expectedRevision: z.number().int().min(1),
				})
				.parse(await json(request, 1024));
			guard();
			const result = store.update(scope(), { id, ...input, deleted: true });
			options.onStored?.(result);
			return reply(result);
		}
		if (path.length === 1 && request.method === "GET") {
			if (url.search) throw Error("unexpected query");
			return reply({
				resource: store.get(scope(), id),
				jobs: store.indexing.list(scope(), id),
			});
		}
		if (path.length === 1 && request.method === "PATCH") {
			if (url.search) throw Error("unexpected query");
			const raw = await json(
				request,
				Math.ceil((store.limits.maxFileBytes * 4) / 3) + 16384,
			);
			const input = updateInput.omit({ id: true }).parse(raw);
			guard();
			const { text, base64, ...metadata } = input;
			const result = store.update(scope(), {
				id,
				...metadata,
				...bytes({
					...(text === undefined ? {} : { text }),
					...(base64 === undefined ? {} : { base64 }),
				}),
			});
			guard();

			options.onStored?.(result);
			return reply(result);
		}
		if (
			path.length === 2 &&
			path[1] === "content" &&
			request.method === "GET"
		) {
			if (query["format"] === "original") {
				const input = z
					.strictObject({
						format: z.literal("original"),
						versionId: z.uuid().optional(),
					})
					.parse(query);
				const source = store.read(scope(), id, input.versionId);
				guard();
				return new Response(Uint8Array.from(source.bytes), {
					headers: {
						"Content-Type": "application/octet-stream",
						"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(source.resource.title)}`,
						"Cache-Control": "no-store",
						"X-Content-Type-Options": "nosniff",
					},
				});
			}
			const input = z
				.strictObject({
					versionId: z.uuid().optional(),
					level: z.enum(["brief", "overview", "content"]).optional(),
					offset: z.coerce.number().int().min(0).optional(),
					limit: z.coerce.number().int().min(2).max(8192).optional(),
				})
				.parse(query);
			const result = readResource(store, scope(), id, input);
			guard();

			return reply(result);
		}
		return reply({ error: "Unknown resource route" }, 404);
	} catch (error) {
		if (request.signal.aborted) return reply({ error: "Cancelled" }, 499);
		const message = error instanceof Error ? error.message : "invalid request";
		return reply(
			{
				error: /unavailable/.test(message)
					? "Resource unavailable"
					: /stale|conflict|changed/.test(message)
						? "Resource revision or scope conflict"
						: "Invalid resource request",
			},
			/unavailable/.test(message)
				? 404
				: /stale|conflict|changed/.test(message)
					? 409
					: 400,
		);
	}
}
