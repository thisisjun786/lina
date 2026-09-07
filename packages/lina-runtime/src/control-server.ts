import type { ServerWebSocket } from "bun";
import type { AttachmentStore } from "../../lina-core/src/attachments/store.ts";
import { parseContextClient } from "../../lina-core/src/context-wire.ts";
import {
	type ControlClient,
	parseControlClient,
} from "../../lina-core/src/control-wire.ts";
import { parseWireClient, type WireClient } from "../../lina-core/src/wire.ts";
import { handleAttachmentRequest } from "./attachment-http.ts";
import type { ContextChannel } from "./context/channel.ts";
import type { ExecutionCoordinator } from "./execution.ts";
import type { DurableRuntime, RuntimeNotice } from "./runtime.ts";

type Peer = { durable: boolean };
type Socket = ServerWebSocket<Peer>;
function send(peer: Socket, frame: unknown): void {
	if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(frame));
}

function command(
	peer: Socket,
	frame: WireClient,
	runtime: DurableRuntime,
	execution?: ExecutionCoordinator,
	context?: ContextChannel,
): void {
	if (frame.type === "subscribe") {
		peer.data.durable = true;
		send(peer, { type: "snapshot", snapshot: runtime.snapshot() });
		if (execution)
			send(peer, { type: "control-state", state: execution.snapshot() });
		if (context)
			send(peer, { type: "context-state", state: context.snapshot() });
		return;
	}
	if (
		("sessionId" in frame && frame.sessionId !== runtime.binding.sessionId) ||
		(frame.type === "chat" &&
			peer.data.durable &&
			frame.sessionId === undefined)
	)
		throw new Error("Session changed; reconnect before sending");
	switch (frame.type) {
		case "search":
			send(peer, {
				type: "search-results",
				sessionId: runtime.binding.sessionId,
				requestId: frame.requestId,
				page: runtime.store.conversationSearch(frame.query, {
					before: frame.before,
				}),
			});
			return;
		case "ping":
			send(peer, {
				type: "pong",
				sessionId: runtime.binding.sessionId,
				nonce: frame.nonce,
			});
			return;
		case "chat":
			runtime.submit(frame.id, frame.text);
			send(peer, { type: "ack", id: frame.id });
			return;
		case "history":
			send(peer, {
				type: "history",
				before: frame.before,
				sessionId: runtime.binding.sessionId,
				revision: runtime.store.revision(),
				page: runtime.store.conversationHistory({ before: frame.before }),
			});
			return;
		case "entry": {
			const entry = runtime.store.entry(frame.entryId);
			if (!entry || entry.role === "meta" || frame.offset > entry.text.length)
				throw new Error("Original text not found at that offset");
			const text = entry.text.slice(frame.offset, frame.offset + 8192),
				next = frame.offset + text.length;
			send(peer, {
				type: "entry-text",
				...(frame.requestId === undefined
					? {}
					: { requestId: frame.requestId }),
				sessionId: runtime.binding.sessionId,
				entryId: frame.entryId,
				offset: frame.offset,
				text,
				nextOffset: next < entry.text.length ? next : null,
			});
			return;
		}
	}
}

function executionCommand(
	peer: Socket,
	frame: ControlClient,
	runtime: DurableRuntime,
	execution: ExecutionCoordinator | undefined,
): void {
	const operation = frame.type === "cancel" ? "cancel" : "approval";
	const fail = () =>
		send(peer, {
			type: "control-error",
			operation,
			message:
				operation === "cancel"
					? "중단 실패 · 현재 상태 확인 후 다시 시도"
					: "승인 요청 만료 또는 작업 불일치",
		});
	if (!execution || frame.sessionId !== runtime.binding.sessionId) {
		fail();
		return;
	}
	if (frame.type === "approval_reply") {
		try {
			if (!execution.reply(frame.id, frame.inputDigest, frame.decision)) fail();
		} catch {
			fail();
		}
		return;
	}
	void runtime
		.cancel(frame.requestId)
		.then(() => execution.refresh())
		.catch(fail);
}

function broadcast(peers: Set<Socket>, event: RuntimeNotice): void {
	for (const peer of peers) {
		if (event.type === "warning") {
			send(peer, { type: "error", message: event.message });
			continue;
		}
		if (peer.data.durable) {
			if (event.type !== "legacy-text") send(peer, event);
		} else if (event.type === "snapshot")
			send(peer, { type: "agent-status", state: event.snapshot.state });
		else if (event.type === "legacy-text")
			send(peer, { type: "agent-text", text: event.text });
	}
}

export function startControlServer(options: {
	runtime: DurableRuntime;
	execution?: ExecutionCoordinator;
	context?: ContextChannel;
	attachments?: AttachmentStore;
	port: number;
}) {
	const peers = new Set<Socket>();
	const server = Bun.serve<Peer>({
		hostname: "127.0.0.1",
		port: options.port,
		async fetch(request, server) {
			// Native gateway sockets omit Origin. Browser clients must use the public gateway.
			if (request.headers.has("origin"))
				return new Response("Forbidden", { status: 403 });
			if (options.attachments) {
				const reply = await handleAttachmentRequest(
					request,
					options.attachments,
					options.runtime.binding,
				);
				if (reply) return reply;
			}
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/health")
				return Response.json(
					{ ready: true, sessionId: options.runtime.binding.sessionId },
					{ headers: { "Cache-Control": "no-store" } },
				);
			if (
				(url.pathname === "/" || url.pathname === "/ws") &&
				peers.size < 32 &&
				server.upgrade(request, { data: { durable: false } })
			)
				return;
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			maxPayloadLength: 65_536,
			idleTimeout: 0,
			open(peer) {
				peers.add(peer);
				send(peer, {
					type: "agent-status",
					state: options.runtime.snapshot().state,
				});
			},
			message(peer, raw) {
				const contextFrame = parseContextClient(
					typeof raw === "string" ? raw : raw.toString(),
				);
				if (contextFrame) {
					const fail = () =>
						send(peer, {
							type: "context-error",
							message: "맥락 정리 요청 실패 · 진행 중인 작업 및 연결 확인",
						});
					if (
						!options.context ||
						contextFrame.sessionId !== options.runtime.binding.sessionId
					) {
						fail();
						return;
					}
					void (
						contextFrame.type === "compact"
							? options.context.compact()
							: options.context.refresh()
					).catch(fail);
					return;
				}
				const control = parseControlClient(
					typeof raw === "string" ? raw : raw.toString(),
				);
				if (control) {
					executionCommand(peer, control, options.runtime, options.execution);
					return;
				}
				const frame = parseWireClient(
					typeof raw === "string" ? raw : raw.toString(),
				);
				if (!frame) {
					send(peer, { type: "error", message: "Invalid control frame" });
					peer.close(1008, "Invalid frame");
					return;
				}
				try {
					command(
						peer,
						frame,
						options.runtime,
						options.execution,
						options.context,
					);
				} catch (error) {
					if (
						(frame.type === "search" || frame.type === "entry") &&
						frame.requestId &&
						frame.sessionId === options.runtime.binding.sessionId
					) {
						send(peer, {
							type: "search-error",
							sessionId: frame.sessionId,
							requestId: frame.requestId,
							message: "검색 결과를 불러오지 못했습니다.",
						});
						return;
					}
					send(peer, {
						type: "error",
						message: error instanceof Error ? error.message : "Request failed",
						...(frame.type === "chat" ? { id: frame.id } : {}),
					});
				}
			},
			close(peer) {
				peers.delete(peer);
			},
		},
	});
	const unsubscribe = options.runtime.subscribe((event) =>
		broadcast(peers, event),
	);
	const unsubscribeExecution = options.execution?.subscribe((state) => {
		for (const peer of peers)
			if (peer.data.durable) send(peer, { type: "control-state", state });
	});
	const unsubscribeContext = options.context?.subscribe((state) => {
		for (const peer of peers)
			if (peer.data.durable) send(peer, { type: "context-state", state });
	});

	return {
		port: server.port,
		async stop() {
			unsubscribe();
			unsubscribeExecution?.();
			unsubscribeContext?.();
			await server.stop(true);
		},
	};
}
