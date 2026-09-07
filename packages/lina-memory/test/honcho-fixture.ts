import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotBinding } from "../../lina-core/src/protocol.ts";
import type { FetchLike } from "../src/honcho/client.ts";
import type { HonchoConfig } from "../src/honcho/types.ts";

export const config: HonchoConfig = {
	baseUrl: "http://127.0.0.1:8000",
	workspaceId: "lina-test",
	sessionId: "lina-main",
	userPeerId: "example",
	observerPeerId: "lina",
	apiKey: "secret-key",
};

export class Fixture {
	readonly dir = mkdtempSync(join(tmpdir(), "lina-honcho-"));
	readonly file = join(this.dir, "honcho-outbox.sqlite");
	readonly binding: BotBinding = {
		version: 1,
		botId: "lina",
		sessionId: "session-1",
		sessionFile: join(this.dir, "session.jsonl"),
		workspace: join(this.dir, "workspace"),
	};
	private readonly resources: { close(): void }[] = [];

	constructor() {
		mkdirSync(this.binding.workspace);
		writeFileSync(this.binding.sessionFile, "");
	}

	keep<T extends { close(): void }>(resource: T): T {
		this.resources.push(resource);
		return resource;
	}

	close(): void {
		for (const resource of this.resources.reverse()) resource.close();
		rmSync(this.dir, { recursive: true, force: true });
	}
}

export interface Seen {
	method: string;
	url: string;
	body: unknown;
	headers: Record<string, string>;
}

interface Stored {
	id: string;
	workspace_id: string;
	session_id: string;
	peer_id: string;
	content: string;
	metadata: Record<string, unknown>;
}

// In-memory stand-in for the pinned /v3 message routes. Deterministic; no network.
export class FakeHoncho {
	readonly seen: Seen[] = [];
	readonly messages: Stored[] = [];
	readonly peers = new Set<string>();
	readonly sessions = new Set<string>();
	readonly workspaces = new Set<string>();
	private nextId = 1;
	// Test hooks: throw, hang, or replace the response for the next request.
	behavior:
		| ((seen: Seen) => Response | Promise<Response> | undefined)
		| undefined;

	get fetch(): FetchLike {
		return async (url, init) => {
			const headers = Object.fromEntries(
				Object.entries((init.headers ?? {}) as Record<string, string>),
			);
			const seen: Seen = {
				method: init.method ?? "GET",
				url,
				body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
				headers,
			};
			this.seen.push(seen);
			const signal = init.signal ?? null;
			const custom = await Promise.race([
				Promise.resolve(this.behavior?.(seen)),
				new Promise<never>((_, reject) => {
					if (!signal) return;
					const fail = () => reject(new Error("aborted"));
					if (signal.aborted) fail();
					else signal.addEventListener("abort", fail, { once: true });
				}),
			]);
			if (custom) return custom;
			return this.route(seen, signal);
		};
	}

	store(
		peer: string,
		content: string,
		metadata: Record<string, unknown>,
	): Stored {
		const stored: Stored = {
			id: `msg_${this.nextId++}`,
			workspace_id: config.workspaceId,
			session_id: config.sessionId,
			peer_id: peer,
			content: content.replaceAll("\0", ""),
			metadata,
		};
		this.messages.push(stored);
		return stored;
	}

	private route(seen: Seen, signal: AbortSignal | null): Response {
		if (signal?.aborted) throw new Error("aborted");
		const json = (status: number, body: unknown) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		const path = new URL(seen.url).pathname;
		const body = (seen.body ?? {}) as Record<string, unknown>;
		const base = `/v3/workspaces/${config.workspaceId}`;
		if (path === `${base}/sessions/${config.sessionId}/messages`) {
			const items = (body["messages"] as Record<string, unknown>[]).map((m) =>
				this.store(
					String(m["peer_id"]),
					String(m["content"]),
					m["metadata"] as Record<string, unknown>,
				),
			);
			return json(201, items);
		}
		if (path === `${base}/sessions/${config.sessionId}/messages/list`) {
			const filters = (body["filters"] ?? {}) as Record<string, unknown>;
			const wanted = JSON.stringify(
				(filters["metadata"] as Record<string, unknown>)?.["lina"],
			);
			const items = this.messages.filter(
				(m) =>
					(filters["peer_id"] === undefined ||
						m.peer_id === filters["peer_id"]) &&
					(wanted === undefined ||
						JSON.stringify(m.metadata["lina"]) === wanted),
			);
			return json(200, {
				items,
				total: items.length,
				page: 1,
				size: 50,
				pages: 1,
			});
		}
		if (path === `${base}/peers/${config.observerPeerId}/representation`)
			return json(200, {
				representation: `Representation for ${body["target"]}: ${body["search_query"]}`,
			});
		if (path === `${base}/peers/list`)
			return json(200, {
				items: [...this.peers].map((id) => ({
					id,
					workspace_id: config.workspaceId,
				})),
			});
		if (path === `${base}/sessions/list`)
			return json(200, {
				items: [...this.sessions].map((id) => ({
					id,
					workspace_id: config.workspaceId,
					is_active: true,
				})),
			});
		if (path === "/v3/workspaces") {
			const fresh = !this.workspaces.has(String(body["id"]));
			this.workspaces.add(String(body["id"]));
			return json(fresh ? 201 : 200, { id: body["id"] });
		}
		if (path === `${base}/peers`) {
			const fresh = !this.peers.has(String(body["id"]));
			this.peers.add(String(body["id"]));
			return json(fresh ? 201 : 200, { id: body["id"] });
		}
		if (path === `${base}/sessions`) {
			const fresh = !this.sessions.has(String(body["id"]));
			this.sessions.add(String(body["id"]));
			return json(fresh ? 201 : 200, { id: body["id"] });
		}
		return json(404, { detail: "Not found" });
	}
}
