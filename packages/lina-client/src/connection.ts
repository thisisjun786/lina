import type { ContextClient } from "../../lina-core/src/context-wire.ts";
import type { ChatCommand, WireClient } from "../../lina-core/src/wire.ts";
import { parseServerFrame, type ServerFrame } from "./protocol.ts";

export type ConnectionEvents = {
	readonly frame: (frame: ServerFrame) => void;
	readonly disconnected: () => void;
	readonly notice: (message: string) => void;
};

type ConnectionOptions = {
	readonly createSocket: (url: string) => WebSocket;
	readonly schedule: (callback: () => void, delay: number) => () => void;
};
const defaults: ConnectionOptions = {
	createSocket: (url) => new WebSocket(url),
	schedule(callback, delay) {
		const timer = setTimeout(callback, delay);
		return () => clearTimeout(timer);
	},
};

/** One socket per page. Retired sockets cannot alter the current conversation. */
export class Connection {
	private socket: WebSocket | undefined;
	private cancelRetry: (() => void) | undefined;
	private cancelDeadline: (() => void) | undefined;
	private pending: string | undefined;
	private healthSession: string | undefined;
	private pingNonce: string | undefined;
	private cancelPing: (() => void) | undefined;
	private cancelPong: (() => void) | undefined;
	private stopped = false;
	private failures = 0;

	constructor(
		private readonly url: string,
		private readonly events: ConnectionEvents,
		private readonly options: ConnectionOptions = defaults,
	) {}

	connect(): void {
		if (this.stopped) return;
		this.cancelRetry?.();
		this.retire();
		const socket = this.options.createSocket(this.url);
		this.socket = socket;
		this.cancelDeadline = this.options.schedule(
			() => this.expire(socket, "연결 실패"),
			8_000,
		);
		socket.addEventListener("message", (event: MessageEvent<unknown>) => {
			if (this.socket !== socket) return;
			const frame = parseServerFrame(event.data);
			if (frame === undefined) return;
			if (frame.type === "pong") {
				if (
					frame.sessionId === this.healthSession &&
					frame.nonce === this.pingNonce &&
					this.pingNonce !== undefined
				) {
					this.cancelPong?.();
					this.pingNonce = undefined;
					this.probeLater(socket);
				}
				return;
			}
			if (frame.type === "agent-status" && this.pending === undefined) {
				this.cancelDeadline?.();
				this.failures = 0;
			}
			if (frame.type === "ack" && frame.id === this.pending) {
				this.cancelDeadline?.();
				this.pending = undefined;
			}
			if (frame.type === "snapshot") {
				if (this.healthSession !== frame.snapshot.sessionId) {
					this.cancelPing?.();
					this.cancelPong?.();
					this.pingNonce = undefined;
					this.healthSession = frame.snapshot.sessionId;
					this.probeLater(socket);
				}
				if (
					frame.snapshot.requests.some((request) => request.id === this.pending)
				)
					this.pending = undefined;
				if (this.pending === undefined) {
					this.cancelDeadline?.();
					this.failures = 0;
				}
			}
			this.events.frame(frame);
			if (frame.type === "error")
				this.expire(socket, "요청 실패 · 전송 결과 확인 필요");
		});
		socket.addEventListener("close", () => {
			if (this.socket !== socket) return;
			this.retire();
			this.schedule();
		});
		socket.addEventListener("error", () => {
			if (this.socket === socket) socket.close();
		});
	}

	send(frame: ChatCommand): boolean {
		const socket = this.socket;
		if (socket?.readyState !== WebSocket.OPEN || this.pending !== undefined)
			return false;
		try {
			socket.send(JSON.stringify(frame));
			this.pending = frame.id;
			this.cancelDeadline?.();
			this.cancelDeadline = this.options.schedule(
				() => this.expire(socket, "전송 결과 미확인 · 복구 목록 확인"),
				20_000,
			);
			return true;
		} catch {
			this.expire(socket, "연결 끊김 · 전송 결과 미확인");
			return false;
		}
	}

	command(
		frame: Exclude<WireClient, ChatCommand> | ControlClient | ContextClient,
	): boolean {
		const socket = this.socket;
		if (socket?.readyState !== WebSocket.OPEN) return false;
		try {
			socket.send(JSON.stringify(frame));
			if (frame.type === "subscribe") {
				this.cancelDeadline?.();
				this.cancelDeadline = this.options.schedule(
					() => this.expire(socket, "대화 기록 불러오기 실패"),
					8000,
				);
			}
			return true;
		} catch {
			this.expire(socket, "연결 끊김");
			return false;
		}
	}

	stop(): void {
		this.stopped = true;
		this.cancelRetry?.();
		this.retire();
	}

	resume(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.connect();
	}

	private probeLater(socket: WebSocket): void {
		this.cancelPing = this.options.schedule(() => {
			if (this.socket !== socket || !this.healthSession) return;
			const nonce = crypto.randomUUID();
			this.pingNonce = nonce;
			if (!this.command({ type: "ping", sessionId: this.healthSession, nonce }))
				return;
			this.cancelPong = this.options.schedule(
				() => this.expire(socket, "연결 확인 중"),
				8_000,
			);
		}, 15_000);
	}

	private expire(socket: WebSocket, message: string): void {
		if (this.socket !== socket) return;
		this.events.notice(message);
		this.retire();
		this.schedule();
	}

	private retire(): void {
		this.cancelDeadline?.();
		this.cancelPing?.();
		this.cancelPong?.();
		this.healthSession = undefined;
		this.pingNonce = undefined;
		const previous = this.socket;
		this.socket = undefined;
		this.pending = undefined;
		previous?.close();
		this.events.disconnected();
	}

	private schedule(): void {
		if (this.stopped) return;
		this.failures += 1;
		this.cancelRetry = this.options.schedule(
			() => this.connect(),
			Math.min(1_000 * 2 ** (this.failures - 1), 10_000),
		);
	}
}

import type { ControlClient } from "../../lina-core/src/control-wire.ts";
