import { isDeepStrictEqual } from "node:util";
import {
	type SourceLookup,
	sourceProofsCurrent,
} from "../../../lina-core/src/source-policy.ts";
import { chunkText } from "./chunk.ts";
import { publicIdentity, validateHonchoConfig } from "./config.ts";
import {
	type Json,
	object,
	parseRemoteMessage,
	partKey,
	string,
} from "./messages.ts";
import {
	generationOwner,
	validateNamespaceProof,
	validateRecallProof,
} from "./qualification.ts";
import { queryPrefix, recallPrefix } from "./text.ts";
import { type FetchLike, HonchoTransport } from "./transport.ts";
import {
	type BotBinding,
	type GenerationOwner,
	type HonchoConfig,
	type HonchoIdentity,
	HonchoRequestError,
	type OutboxPart,
	type QualifiedHonchoAdapter,
	type RecallResult,
	type RemoteMessage,
} from "./types.ts";

export interface HonchoClientOptions {
	fetch?: FetchLike;
	binding?: BotBinding;
	sourceLookup?: SourceLookup;
	qualifiedAdapter?: QualifiedHonchoAdapter;
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
	readonly owner: GenerationOwner | undefined;
	private readonly lookup: SourceLookup | undefined;
	private readonly adapter: QualifiedHonchoAdapter | undefined;

	constructor(config: HonchoConfig, options: HonchoClientOptions = {}) {
		const checked = validateHonchoConfig(config);
		this.identity = Object.freeze(publicIdentity(checked));
		this.config = { ...checked, ...this.identity };
		this.lookup = options.sourceLookup;
		this.adapter = options.qualifiedAdapter;
		this.owner =
			checked.ordinaryNamespace && options.binding
				? generationOwner(options.binding, checked)
				: undefined;
		if (this.owner) {
			Object.freeze(this.owner.binding);
			Object.freeze(this.owner.identity);
			Object.freeze(this.owner.ordinaryNamespace);
			Object.freeze(this.owner);
		}
		this.transport = new HonchoTransport({
			baseUrl: config.baseUrl,
			apiKey: config.apiKey,
			fetch: options.fetch ?? ((input, init) => fetch(input, init)),
			timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			bodyCapBytes: options.bodyCapBytes ?? DEFAULT_BODY_CAP,
		});
	}

	async qualify(signal?: AbortSignal): Promise<boolean> {
		if (!this.owner || !this.adapter || signal?.aborted) return false;
		const proof = await this.adapter.qualify(
			structuredClone(this.owner),
			signal,
		);
		if (signal?.aborted) return false;
		validateNamespaceProof(proof, this.owner);
		return true;
	}
	eligible(part: OutboxPart): boolean {
		if (
			!this.owner ||
			!this.lookup ||
			part.version !== 2 ||
			!part.sourceProofs ||
			!isDeepStrictEqual(part.policyScope, this.owner.ordinaryNamespace) ||
			!sourceProofsCurrent(part.sourceProofs, this.lookup)
		)
			return false;
		const entry = this.lookup(part.entryId);
		const chunk = entry ? chunkText(entry.text)[part.partIndex] : undefined;
		return (
			entry?.role === part.role &&
			chunk?.content === part.content &&
			chunk.contentHash === part.contentHash
		);
	}
	private async admit(part: OutboxPart, signal?: AbortSignal): Promise<void> {
		if (
			!this.eligible(part) ||
			!(await this.qualify(signal)) ||
			!this.eligible(part)
		)
			throw new HonchoRequestError(
				"honcho capture qualification or source unavailable",
				"body",
			);
	}
	private requireCurrentSource(part: OutboxPart): void {
		if (!this.eligible(part))
			throw new HonchoRequestError(
				"honcho capture source changed before dispatch",
				"body",
			);
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
		// Keep the original proof and content together across admission awaits.
		const captured = structuredClone(part);
		await this.admit(captured, signal);
		const body = {
			messages: [
				{
					content: captured.content,
					peer_id: this.peerFor(captured.role),
					metadata: { lina: partKey(captured) },
				},
			],
		};
		// request() invokes fetch before its first await. No async hop may follow
		// this check before dispatch, including an awaited admission helper.
		this.requireCurrentSource(captured);
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
		if (!this.matches(message, captured))
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
		// Keep the original proof and content together across admission awaits.
		const captured = structuredClone(part);
		await this.admit(captured, signal);
		const body = {
			filters: {
				peer_id: this.peerFor(captured.role),
				metadata: { lina: partKey(captured) },
			},
		};
		this.requireCurrentSource(captured);
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

	// Ordinary model recall requires an explicit adapter proof, never a stock
	// HTTP/v3 representation or a scope copied from local configuration.
	async recall(query: string, signal?: AbortSignal): Promise<RecallResult> {
		const empty: RecallResult = {
			text: "",
			scope: { ...this.identity },
			freshness: "unknown",
		};
		if (
			typeof query !== "string" ||
			!query.trim() ||
			!this.owner ||
			!this.adapter ||
			!this.lookup
		)
			return empty;
		const searchQuery = queryPrefix(query);
		if (!searchQuery.trim() || !(await this.qualify(signal))) return empty;
		const response = object(
			await this.adapter.recall(
				{
					owner: structuredClone(this.owner),
					query: searchQuery,
					topK: RECALL_TOP_K,
				},
				signal,
			),
			"qualified recall",
		);
		if (signal?.aborted) return empty;
		if (typeof response["text"] !== "string")
			throw new HonchoRequestError(
				"honcho representation is not a string",
				"body",
			);
		const proof = validateRecallProof(
			response["proof"],
			this.owner,
			this.lookup,
		);
		return {
			text: recallPrefix(response["text"]),
			scope: { ...this.identity },
			freshness: "unknown",
			proof,
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
		if (this.config.ordinaryNamespace && !(await this.qualify(signal)))
			throw new HonchoRequestError(
				"honcho namespace qualification unavailable",
				"body",
			);
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
