import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import type { AvatarApplyInput } from "../../../lina-core/src/agents/visual.ts";
import { discoverEventImageCandidates } from "../../../lina-core/src/world/image-discovery.ts";
import { avatarPeriodicSource } from "../../../lina-core/src/world/image-policy.ts";
import type { LifeImageSettingsInput } from "../../../lina-core/src/world/image-types.ts";
import {
	identifier,
	revision,
} from "../../../lina-core/src/world/life-json.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";
import { fields } from "../../../lina-core/src/world/validation.ts";
import type { ImageJob } from "../images/contracts.ts";

type LifeImageManagementPort = {
	run(
		worldId: string,
		intentId: string,
		requestKey: string,
		signal: AbortSignal,
	): Promise<ImageJob>;
	retry(
		worldId: string,
		intentId: string,
		previousAttemptId: string,
		requestKey: string,
		signal: AbortSignal,
	): Promise<ImageJob>;
	reconcile(
		worldId: string,
		attemptId: string,
		signal: AbortSignal,
	): Promise<ImageJob>;
	read(worldId: string, attemptId: string): ImageJob;
	destinations: {
		avatar(
			job: ImageJob,
			invocation: "automatic" | "candidate",
			apply?: AvatarApplyInput,
		): unknown;
	};
	posts: { attach(job: ImageJob, invocation: "manual" | "automatic"): unknown };
};

export type LifeImageRouteSource =
	| { kind: "event_post"; postId: string; recipientId: string }
	| { kind: "avatar_periodic" };

export interface LifeImageRouteServices {
	store(): WorldStore;
	agents: AgentStore;
	/** Lazy image owner: management reads must never call this factory. */
	images(): LifeImageManagementPort;
	now(): number;
	changed(): void;
	assertSourceCurrent(worldId: string): void;
}

type Action =
	| "settings"
	| "intents"
	| "intent"
	| "run"
	| "retry"
	| "reconcile"
	| "apply";
type Route = { worldId: string; action: Action; intentId?: string };
const METHODS: Record<Action, readonly string[]> = {
	settings: ["GET", "PUT"],
	intents: ["GET", "POST"],
	intent: ["GET"],
	run: ["POST"],
	retry: ["POST"],
	reconcile: ["POST"],
	apply: ["POST"],
};
const MAX_URL_LENGTH = 4096;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const MAX_ATTEMPTS_PER_INTENT = 10;

const reply = (
	value: unknown,
	status = 200,
	headers: Record<string, string> = {},
) =>
	Response.json(value, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			...headers,
		},
	});
const failure = (status: 400 | 403 | 404 | 409) =>
	reply(
		{
			error:
				status === 403
					? "Forbidden"
					: status === 404
						? "Not found"
						: status === 409
							? "Image state changed; reload the exact revision"
							: "Invalid image request",
		},
		status,
	);

function route(parts: string[]): Route | undefined {
	if (
		parts[1] !== "api" ||
		parts[2] !== "life" ||
		parts[3] !== "worlds" ||
		parts[5] !== "images"
	)
		return;
	const worldId = identifier(parts[4]);
	if (parts.length === 7 && parts[6] === "settings")
		return { worldId, action: "settings" };
	if (parts.length === 7 && parts[6] === "intents")
		return { worldId, action: "intents" };
	const intentId = identifier(parts[7]);
	if (parts.length === 8 && parts[6] === "intents")
		return { worldId, action: "intent", intentId };
	if (
		parts.length === 9 &&
		parts[6] === "intents" &&
		["run", "retry", "reconcile", "apply"].includes(parts[8] ?? "")
	)
		return {
			worldId,
			action: parts[8] as Extract<
				Action,
				"run" | "retry" | "reconcile" | "apply"
			>,
			intentId,
		};
}
function exact<T extends string>(
	value: unknown,
	allowed: readonly T[],
): Record<T, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid body");
	fields(value, [...allowed]);
	return value as Record<T, unknown>;
}
function requestKey(value: unknown): string {
	return identifier(value);
}
function source(value: unknown): LifeImageRouteSource {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid image source");
	const raw = value as { kind?: unknown };
	if (raw.kind === "event_post") {
		const body = exact(value, ["kind", "postId", "recipientId"]);
		return {
			kind: "event_post",
			postId: identifier(body.postId),
			recipientId: identifier(body.recipientId),
		};
	}
	if (raw.kind === "avatar_periodic") {
		exact(value, ["kind"]);
		return { kind: "avatar_periodic" };
	}
	throw Error("invalid image source");
}
function safeIntent(
	intent: ReturnType<WorldStore["imageIntent"]> extends infer T
		? NonNullable<T>
		: never,
) {
	return {
		intentId: intent.intentId,
		owner: intent.owner,
		source:
			intent.source.kind === "event_post"
				? {
						kind: intent.source.kind,
						postId: intent.source.publicationId,
						recipientId: intent.source.recipientId,
					}
				: {
						kind: intent.source.kind,
						resolvedPolicyId: intent.source.resolvedPolicyId,
					},
		settingsRevision: intent.settingsRevision,
		configRevision: intent.configRevision,
		createdAtMs: intent.createdAtMs,
		createdLifeRevision: intent.createdLifeRevision,
		requestKey: intent.requestKey,
	};
}
function safeAttempt(
	attempt: NonNullable<ReturnType<WorldStore["imageAttempt"]>>,
) {
	return {
		attemptId: attempt.attemptId,
		intentId: attempt.intentId,
		attemptNumber: attempt.attemptNumber,
		revision: attempt.revision,
		previousAttemptId: attempt.previousAttemptId,
		state: attempt.observation?.state ?? "prepared",
		delivery: attempt.delivery.kind,
	};
}
function currentAttempt(store: WorldStore, worldId: string, intentId: string) {
	return store.imageAttempts(worldId, intentId).at(-1) ?? null;
}
function expectAttempt(
	store: WorldStore,
	worldId: string,
	intentId: string,
	expected: unknown,
	attemptId?: unknown,
) {
	const attempt =
		attemptId === undefined
			? currentAttempt(store, worldId, intentId)
			: store.imageAttempt(worldId, identifier(attemptId));
	if (!attempt || attempt.intentId !== intentId)
		throw Error("missing image attempt");
	if (attempt.revision !== revision(expected))
		throw Error("stale image revision");
	return attempt;
}
function assertNoBrowser(request: Request, url: URL): boolean {
	return (
		!request.headers.has("origin") &&
		!request.headers.has("authorization") &&
		url.protocol === "http:" &&
		url.hostname === "127.0.0.1" &&
		request.headers.get("host") === url.host &&
		!url.username &&
		!url.password
	);
}
function listQuery(url: URL): { afterId: string | null; limit: number } {
	for (const key of url.searchParams.keys())
		if (key !== "afterId" && key !== "limit") throw Error("invalid query");
	const afterId = url.searchParams.get("afterId");
	if (afterId !== null) identifier(afterId);
	const raw = url.searchParams.get("limit");
	if (raw === null) return { afterId, limit: DEFAULT_LIST_LIMIT };
	if (!/^[1-9][0-9]*$/.test(raw)) throw Error("invalid query");
	const limit = Number(raw);
	if (!Number.isSafeInteger(limit) || limit > MAX_LIST_LIMIT)
		throw Error("invalid query");
	return { afterId, limit };
}
function attempts(store: WorldStore, worldId: string, intentId: string) {
	return store
		.imageAttempts(worldId, intentId)
		.slice(-MAX_ATTEMPTS_PER_INTENT)
		.map(safeAttempt);
}
function responseAttempt(store: WorldStore, worldId: string, job: ImageJob) {
	if (job.origin.kind !== "life") throw Error("foreign image job");
	const attempt = store.imageAttempt(worldId, job.origin.attemptId);
	if (!attempt) throw Error("missing image attempt");
	return { attempt: safeAttempt(attempt) };
}
function sameReplaySelector(
	intent: NonNullable<ReturnType<WorldStore["imageIntent"]>>,
	agentId: string,
	selected: LifeImageRouteSource,
) {
	return (
		intent.owner.agentId === agentId &&
		(intent.source.kind === "event_post"
			? selected.kind === "event_post" &&
				intent.source.publicationId === selected.postId &&
				intent.source.recipientId === selected.recipientId
			: selected.kind === "avatar_periodic")
	);
}

/** Local owner management. It accepts selectors only and never projects material, prompts, paths or grants. */
export async function lifeImageRoutes(
	request: Request,
	services: LifeImageRouteServices,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return failure(403);
	}
	let matched: Route | undefined;
	try {
		matched = route(url.pathname.split("/"));
	} catch {
		return failure(404);
	}
	if (!matched) return;
	if (
		request.url.length > MAX_URL_LENGTH ||
		/[%\\]/.test(url.pathname) ||
		request.url.includes("\\") ||
		!assertNoBrowser(request, url)
	)
		return failure(403);
	if (!METHODS[matched.action].includes(request.method))
		return reply({ error: "Method not allowed" }, 405, {
			Allow: METHODS[matched.action].join(", "),
		});
	try {
		if (url.hash) throw Error("invalid query");
		const body = request.method === "GET" ? null : await json();
		const store = services.store();
		if (matched.action === "settings") {
			if (request.method === "GET")
				return reply(store.imageSettings(matched.worldId));
			const input = exact(body, ["expectedRevision", "settings"]);
			const result = store.setImageSettings(
				matched.worldId,
				revision(input.expectedRevision),
				input.settings as LifeImageSettingsInput,
			);
			services.changed();
			return reply(result);
		}
		if (matched.action === "intents" && request.method === "GET") {
			const { afterId, limit } = listQuery(url);
			const all = store.imageIntents(matched.worldId);
			const start =
				afterId === null
					? 0
					: all.findIndex((intent) => intent.intentId === afterId) + 1;
			if (start < 0) throw Error("invalid query");
			const page = all.slice(start, start + limit);
			return reply({
				intents: page.map((intent) => ({
					intent: safeIntent(intent),
					attempts: attempts(store, matched.worldId, intent.intentId),
				})),
				nextCursor:
					page.length === limit ? (page.at(-1)?.intentId ?? null) : null,
			});
		}
		if (matched.action === "intent") {
			if (!matched.intentId) return failure(404);
			const intent = store.imageIntent(matched.worldId, matched.intentId);
			return intent
				? reply({
						intent: safeIntent(intent),
						attempts: store
							.imageAttempts(matched.worldId, intent.intentId)
							.slice(-MAX_ATTEMPTS_PER_INTENT)
							.map(safeAttempt),
					})
				: failure(404);
		}
		if (matched.action === "intents") {
			const input = exact(body, [
				"requestKey",
				"expectedSettingsRevision",
				"agentId",
				"source",
			]);
			const agentId = identifier(input.agentId),
				selected = source(input.source);
			const key = requestKey(input.requestKey);
			const existing = store
				.imageIntents(matched.worldId)
				.find((intent) => intent.requestKey === key);
			if (existing) {
				if (!sameReplaySelector(existing, agentId, selected))
					throw Error("image request replay conflict");
				return reply({ intent: safeIntent(existing) });
			}
			const settings = store.imageSettings(matched.worldId);
			if (!settings) throw Error("image settings not configured");
			if (settings.revision !== revision(input.expectedSettingsRevision))
				throw Error("stale settings revision");
			let frozenSource: Parameters<
					WorldStore["freezeImageIntent"]
				>[0]["source"],
				visualAgentIds: string[];
			if (selected.kind === "event_post") {
				const material = store.publishedImageMaterial(
					matched.worldId,
					selected.postId,
					agentId,
					selected.recipientId,
				);
				if (!material) throw Error("image publication source unavailable");
				const candidate = discoverEventImageCandidates({
					settings,
					posts: store.imageDiscoveryPosts(matched.worldId),
					acceptedSteps: store.imageDiscoveryAcceptedSteps(matched.worldId),
					existingIntents: store.imageIntents(matched.worldId),
				}).candidates.find(
					(value) =>
						value.agentId === agentId &&
						value.source.publicationId === selected.postId &&
						value.source.recipientId === selected.recipientId,
				);
				if (!candidate) throw Error("image source has no current rule");
				frozenSource = material.source;
				visualAgentIds = candidate.visualAgentIds;
			} else {
				const visual = services.agents.visual(agentId);
				if (!visual.avatarPolicy)
					throw Error("avatar policy is not configured");
				const policy = store.resolveImageAvatarPolicy(
					matched.worldId,
					agentId,
					visual.avatarPolicyRevision,
					visual.avatarPolicy,
				);
				const due = avatarPeriodicSource(
					policy,
					services.now(),
					policy.policy.schedule?.kind === "wall"
						? 0
						: store.lifeSnapshot(matched.worldId).revision,
				);
				if (!due) throw Error("avatar cadence is not due");
				frozenSource = due;
				visualAgentIds = [agentId];
			}
			const intent = store.freezeImageIntent({
				worldId: matched.worldId,
				agentId,
				source: frozenSource,
				visuals: visualAgentIds.map((id) =>
					services.agents.freezeVisualIdentity(
						id,
						frozenSource.kind === "event_post"
							? {
									kind: "life",
									worldId: matched.worldId,
									recipientId: frozenSource.recipientId,
								}
							: { kind: "avatar" },
					),
				),
				requestKey: key,
			});
			services.changed();
			return reply({ intent: safeIntent(intent) }, 201);
		}
		if (!matched.intentId) return failure(404);
		const intent = store.imageIntent(matched.worldId, matched.intentId);
		if (!intent) return failure(404);
		services.assertSourceCurrent(matched.worldId);
		const input = exact(
			body,
			matched.action === "run"
				? ["requestKey", "expectedRevision"]
				: matched.action === "retry"
					? ["requestKey", "expectedRevision", "previousAttemptId"]
					: matched.action === "reconcile"
						? ["expectedRevision", "attemptId"]
						: ["expectedRevision", "attemptId", "avatarApply"],
		);
		if (matched.action === "run") {
			const latest = currentAttempt(store, matched.worldId, intent.intentId);
			const key = requestKey(input.requestKey);
			const original = store.imageAttemptRequest(matched.worldId, key);
			const replay = original?.intentId === intent.intentId;
			// The durable original prepare receipt, not the intent creation key, authorizes replay after head movement.
			if (
				!replay &&
				revision(input.expectedRevision) !== (latest?.revision ?? 0)
			)
				throw Error("stale image revision");
			const job = await services
				.images()
				.run(matched.worldId, intent.intentId, key, request.signal);
			services.changed();
			return reply(responseAttempt(store, matched.worldId, job));
		}
		if (matched.action === "retry") {
			expectAttempt(
				store,
				matched.worldId,
				intent.intentId,
				input.expectedRevision,
				input.previousAttemptId,
			);
			const job = await services
				.images()
				.retry(
					matched.worldId,
					intent.intentId,
					identifier(input.previousAttemptId),
					requestKey(input.requestKey),
					request.signal,
				);
			services.changed();
			return reply(responseAttempt(store, matched.worldId, job));
		}
		const attempt = expectAttempt(
			store,
			matched.worldId,
			intent.intentId,
			input.expectedRevision,
			input.attemptId,
		);
		if (matched.action === "reconcile") {
			const job = await services
				.images()
				.reconcile(matched.worldId, attempt.attemptId, request.signal);
			services.changed();
			return reply(responseAttempt(store, matched.worldId, job));
		}
		const job = services.images().read(matched.worldId, attempt.attemptId);
		if (intent.source.kind === "event_post") {
			if (input.avatarApply !== null)
				throw Error("event apply has no avatar input");
			services.images().posts.attach(job, "manual");
		} else {
			const avatarApply = exact(input.avatarApply, [
				"requestKey",
				"candidateId",
				"expectedProfileRevision",
				"expectedVisualRevision",
				"mode",
			]);
			if (avatarApply.mode !== "manual" && avatarApply.mode !== "restore")
				throw Error("invalid avatar apply mode");
			services.images().destinations.avatar(job, "candidate", {
				requestKey: requestKey(avatarApply.requestKey),
				candidateId: identifier(avatarApply.candidateId),
				expectedProfileRevision: revision(avatarApply.expectedProfileRevision),
				expectedVisualRevision: revision(avatarApply.expectedVisualRevision),
				mode: avatarApply.mode as "manual" | "restore",
			});
		}
		services.changed();
		const updated = store.imageAttempt(matched.worldId, attempt.attemptId);
		if (!updated) throw Error("missing image attempt");
		return reply({ attempt: safeAttempt(updated) });
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (/stale|revision mismatch|conflict/i.test(message)) return failure(409);
		if (/missing|unknown|unavailable|not configured/i.test(message))
			return failure(404);
		return failure(400);
	}
}
