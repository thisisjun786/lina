import { isDeepStrictEqual } from "node:util";
import { publicIdentity } from "./config.ts";
import {
	type Json,
	object,
	parseRemoteMessage,
	partKey,
	string,
} from "./messages.ts";
import { queryPrefix, recallPrefix } from "./text.ts";
import { type FetchLike, HonchoTransport } from "./transport.ts";
import {
	type HonchoConfig,
	type HonchoIdentity,
	HonchoRequestError,
	type OutboxPart,
	type RecallResult,
	type RemoteMessage,
} from "./types.ts";

export interface HonchoClientOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
	bodyCapBytes?: number;
}

export const RECALL_MAX_CHARS = 4096;
export const RECALL_TOP_K = 8;
export type { FetchLike } from "./transport.ts";

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_BODY_CAP = 256 * 1024;

export class HonchoClient {
	readonly identity: HonchoIdentity;
	private readonly config: HonchoConfig;
	private readonly transport: HonchoTransport;

	constructor(config: HonchoConfig, options: HonchoClientOptions = {}) {
		this.config = { ...config };
		this.identity = publicIdentity(config);
		this.transport = new HonchoTransport({
			baseUrl: config.baseUrl,
			apiKey: config.apiKey,
			fetch: options.fetch ?? ((input, init) => fetch(input, init)),
			timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			bodyCapBytes: options.bodyCapBytes ?? DEFAULT_BODY_CAP,
		});
	}

	private items(body: unknown): unknown[] {
		const items = object(body, "page")["items"];
		if (!Array.isArray(items))
			throw new HonchoRequestError("honcho page has no items", "body");
		return items;
	}

	peerFor(role: "user" | "assistant"): string {
		return role === "user"
			? this.config.userPeerId
			: this.config.observerPeerId;
	}

	// Exact identity: scope, peer, content and the full metadata key must all agree.
	matches(message: RemoteMessage, part: OutboxPart): boolean {
		const { workspaceId, sessionId } = this.config;
		return (
			message.workspaceId === workspaceId &&
			message.sessionId === sessionId &&
			message.peerId === this.peerFor(part.role) &&
			message.content === part.content &&
			isDeepStrictEqual(message.key, partKey(part))
		);
	}

	private messagesPath(): string {
		const { workspaceId, sessionId } = this.config;
		return `/workspaces/${workspaceId}/sessions/${sessionId}/messages`;
	}

	// WRITES one message. Never call twice for the same part without reconciling.
	async createMessage(
		part: OutboxPart,
		signal?: AbortSignal,
	): Promise<{ remoteId: string }> {
		const body = {
			messages: [
				{
					content: part.content,
					peer_id: this.peerFor(part.role),
					metadata: { lina: partKey(part) },
				},
			],
		};
		const created = this.transport.expect(
			await this.transport.request("POST", this.messagesPath(), body, signal),
			[201],
		);
		if (!Array.isArray(created) || created.length !== 1)
			throw new HonchoRequestError(
				"honcho did not return exactly one message",
				"body",
			);
		const message = parseRemoteMessage(created[0]);
		if (!this.matches(message, part))
			throw new HonchoRequestError(
				"honcho receipt does not match the sent part",
				"body",
			);
		return { remoteId: message.id };
	}

	// READ. Containment filter selects candidates; exact matching is the caller's job.
	async findMessages(
		part: OutboxPart,
		signal?: AbortSignal,
	): Promise<RemoteMessage[]> {
		const body = {
			filters: {
				peer_id: this.peerFor(part.role),
				metadata: { lina: partKey(part) },
			},
		};
		const page = this.transport.expect(
			await this.transport.request(
				"POST",
				`${this.messagesPath()}/list`,
				body,
				signal,
			),
			[200],
		);
		const fields = object(page, "reconciliation page"),
			items = this.items(page);
		if (
			!Number.isSafeInteger(fields["total"]) ||
			fields["total"] !== items.length ||
			fields["page"] !== 1 ||
			!Number.isSafeInteger(fields["pages"]) ||
			(fields["pages"] as number) > 1
		)
			throw new HonchoRequestError(
				"honcho reconciliation page is incomplete",
				"body",
			);
		return items.map((item) => parseRemoteMessage(item));
	}

	// READ despite POST: representation of the user peer as seen by the observer peer.
	async recall(query: string, signal?: AbortSignal): Promise<RecallResult> {
		const scope = { ...this.identity };
		if (typeof query !== "string" || !query.trim())
			return { text: "", scope, freshness: "unknown" };
		const searchQuery = queryPrefix(query);
		if (!searchQuery.trim()) return { text: "", scope, freshness: "unknown" };
		const { workspaceId, observerPeerId, userPeerId, sessionId } = this.config;
		const body = {
			target: userPeerId,
			session_id: sessionId,
			search_query: searchQuery,
			search_top_k: RECALL_TOP_K,
			max_conclusions: RECALL_TOP_K,
		};
		const result = this.transport.expect(
			await this.transport.request(
				"POST",
				`/workspaces/${workspaceId}/peers/${observerPeerId}/representation`,
				body,
				signal,
			),
			[200],
		);
		const representation = object(result, "representation")["representation"];
		if (typeof representation !== "string")
			throw new HonchoRequestError(
				"honcho representation is not a string",
				"body",
			);
		return {
			text: recallPrefix(representation),
			scope,
			freshness: "unknown",
		};
	}

	// READ. Reports which configured resources are missing without creating anything.
	async check(
		signal?: AbortSignal,
	): Promise<{ ok: boolean; missing: string[] }> {
		const { workspaceId, sessionId, userPeerId, observerPeerId } = this.config;
		const missing: string[] = [];
		const peers = this.items(
			this.transport.expect(
				await this.transport.request(
					"POST",
					`/workspaces/${workspaceId}/peers/list`,
					{ filters: { id: { in: [userPeerId, observerPeerId] } } },
					signal,
				),
				[200],
			),
		).map((item) => string(object(item, "peer")["id"], "peer id"));
		for (const peer of [userPeerId, observerPeerId])
			if (!peers.includes(peer)) missing.push(`peer:${peer}`);
		const sessions = this.items(
			this.transport.expect(
				await this.transport.request(
					"POST",
					`/workspaces/${workspaceId}/sessions/list`,
					{ filters: { id: sessionId } },
					signal,
				),
				[200],
			),
		).map((item) => string(object(item, "session")["id"], "session id"));
		if (!sessions.includes(sessionId)) missing.push(`session:${sessionId}`);
		return { ok: missing.length === 0, missing };
	}

	// WRITES: get-or-create exactly the configured workspace, two peers and session.
	async initialize(signal?: AbortSignal): Promise<{ created: string[] }> {
		const { workspaceId, sessionId, userPeerId, observerPeerId } = this.config;
		const created: string[] = [];
		const create = async (path: string, body: Json, label: string) => {
			const result = await this.transport.request("POST", path, body, signal);
			this.transport.expect(result, [200, 201]);
			if (result.status === 201) created.push(label);
		};
		await create(
			"/workspaces",
			{ id: workspaceId },
			`workspace:${workspaceId}`,
		);
		await create(
			`/workspaces/${workspaceId}/peers`,
			{ id: userPeerId },
			`peer:${userPeerId}`,
		);
		await create(
			`/workspaces/${workspaceId}/peers`,
			{ id: observerPeerId },
			`peer:${observerPeerId}`,
		);
		await create(
			`/workspaces/${workspaceId}/sessions`,
			{
				id: sessionId,
				peers: {
					[userPeerId]: { observe_me: true, observe_others: false },
					[observerPeerId]: { observe_me: false, observe_others: true },
				},
			},
			`session:${sessionId}`,
		);
		return { created };
	}
}
