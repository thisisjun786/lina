/**
 * Client for the lina-runtime intervention socket: acks correlate strictly by the
 * chat frame id, only ONE chat frame is in flight (error frames carry no id, so
 * a second one could not be attributed), and reconnects walk a backoff ladder
 * that restarts once a socket opens. Every timer comes from the scheduler.
 */
import {
	type AgentRunState,
	assertNever,
	type ChatFrame,
	decodeOutboundFrame,
	type OutboundFrame,
} from "./frames.ts";

/** Reconnect ladder in ms; the index restarts at 0 after a socket opens. */
export const DEFAULT_BACKOFF_MS = [
	250, 500, 1000, 2000, 4000, 8000, 16000, 30000,
] as const;

export type ConnectionState = "connected" | "disconnected";

/** The socket surface this client uses; a `ws` client satisfies it structurally. */
export type WebSocketLike = {
	send(data: string): void;
	close(): void;
	addEventListener(
		type: "open" | "message" | "close" | "error",
		listener: (event: unknown) => void,
	): void;
};

/** Same shape as the REST client's scheduler: `delay` returns its own canceller. */
export type InterventionScheduler = {
	readonly delay: (ms: number, handler: () => void) => () => void;
};

/** Proof that the agent accepted the chat frame carrying this id. */
export type AckResult = { readonly id: string };

export type InterventionClientOptions = {
	readonly url: string;
	readonly wsFactory: (url: string) => WebSocketLike;
	readonly backoff?: readonly number[];
	readonly scheduler?: InterventionScheduler;
	readonly log?: (message: string) => void;
};

export interface InterventionClient {
	connect(): void;
	close(): void;
	/** Resolves on the ack echoing `frame.id`; rejects on error frame, close, or a concurrent send. */
	send(frame: ChatFrame): Promise<AckResult>;
	onStatus(callback: (state: AgentRunState) => void): void;
	onText(callback: (text: string) => void): void;
	onConnectionChange(callback: (state: ConnectionState) => void): void;
	state(): ConnectionState;
}

export class InterventionClientError extends Error {}
/** The socket is not open, so nothing was sent. */
export class NotConnectedError extends InterventionClientError {
	readonly name = "NotConnectedError";
}
/** A chat frame is still awaiting its ack; the caller must retry after it settles. */
export class InFlightError extends InterventionClientError {
	readonly name = "InFlightError";
}
/** The agent answered the in-flight chat frame with an error frame. */
export class AgentErrorFrameError extends InterventionClientError {
	readonly name = "AgentErrorFrameError";
}
/** The socket closed before the ack arrived; delivery is unproven, so re-send later. */
export class SocketClosedError extends InterventionClientError {
	readonly name = "SocketClosedError";
}

const realScheduler: InterventionScheduler = {
	delay: (ms, handler) => {
		const timer = setTimeout(handler, ms);
		return () => clearTimeout(timer);
	},
};

function socketErrorReason(event: unknown): string {
	return typeof event === "object" && event !== null && "message" in event
		? String(event.message)
		: "unknown error";
}

export function createInterventionClient(
	options: InterventionClientOptions,
): InterventionClient {
	const backoff = options.backoff ?? DEFAULT_BACKOFF_MS;
	const scheduler = options.scheduler ?? realScheduler;
	const log =
		options.log ??
		((message: string) => console.error(`[intervention-client] ${message}`));

	const statusListeners: ((state: AgentRunState) => void)[] = [];
	const textListeners: ((text: string) => void)[] = [];
	const connectionListeners: ((state: ConnectionState) => void)[] = [];

	let socket: WebSocketLike | undefined;
	let connection: ConnectionState = "disconnected";
	/** The one chat frame awaiting its ack, with the deferred that settles it. */
	let pending:
		| ({ readonly id: string } & PromiseWithResolvers<AckResult>)
		| undefined;
	let backoffIndex = 0;
	let cancelReconnect: (() => void) | undefined;
	let closedByCaller = false;

	function notifyConnection(next: ConnectionState): void {
		connection = next;
		for (const listener of connectionListeners) listener(next);
	}

	function failPending(error: Error): void {
		const inFlight = pending;
		pending = undefined;
		inFlight?.reject(error);
	}

	function settleAck(id: string): void {
		const inFlight = pending;
		if (inFlight === undefined || inFlight.id !== id) {
			log(`ignored ack for an id that is not in flight: ${id}`);
			return;
		}
		pending = undefined;
		inFlight.resolve({ id });
	}

	function dispatch(frame: OutboundFrame): void {
		switch (frame.type) {
			case "ack":
				settleAck(frame.id);
				return;
			case "error":
				if (pending === undefined) {
					log(`ignored error frame with no send in flight: ${frame.message}`);
					return;
				}
				failPending(new AgentErrorFrameError(frame.message));
				return;
			case "agent-status":
				for (const listener of statusListeners) listener(frame.state);
				return;
			case "agent-text":
				for (const listener of textListeners) listener(frame.text);
				return;
			case "agent-thinking":
				// The bridge posts finished turns only; thinking output never leaves the loop.
				return;
			default:
				assertNever(frame);
		}
	}

	function handleMessage(event: unknown): void {
		// Two variants only: reading `.reason` is what makes the compiler enforce the split.
		const decoded = decodeOutboundFrame(event);
		if (decoded.kind === "frame") {
			dispatch(decoded.frame);
			return;
		}
		log(`ignored ${decoded.reason}`);
	}

	function scheduleReconnect(): void {
		const delayMs = backoff[Math.min(backoffIndex, backoff.length - 1)] ?? 0;
		backoffIndex += 1;
		log(`reconnecting in ${delayMs}ms`);
		cancelReconnect = scheduler.delay(delayMs, () => {
			cancelReconnect = undefined;
			if (closedByCaller) return;
			openSocket();
		});
	}

	function openSocket(): void {
		const opening = options.wsFactory(options.url);
		socket = opening;
		opening.addEventListener("open", () => {
			if (socket !== opening) return;
			backoffIndex = 0;
			notifyConnection("connected");
		});
		opening.addEventListener("message", handleMessage);
		// `ws` throws on an unhandled error event; the close listener owns the transition.
		opening.addEventListener("error", (event) => {
			log(`socket error: ${socketErrorReason(event)}`);
		});
		opening.addEventListener("close", () => {
			if (socket !== opening) return;
			socket = undefined;
			failPending(new SocketClosedError("socket closed mid-flight"));
			notifyConnection("disconnected");
			if (!closedByCaller) scheduleReconnect();
		});
	}

	return {
		connect(): void {
			closedByCaller = false;
			if (socket !== undefined || cancelReconnect !== undefined) return;
			openSocket();
		},
		close(): void {
			closedByCaller = true;
			cancelReconnect?.();
			cancelReconnect = undefined;
			const current = socket;
			socket = undefined;
			failPending(new SocketClosedError("intervention client closed"));
			if (current === undefined) return;
			notifyConnection("disconnected");
			current.close();
		},
		send(frame: ChatFrame): Promise<AckResult> {
			const open = socket;
			if (open === undefined || connection !== "connected")
				return Promise.reject(
					new NotConnectedError(`intervention socket ${options.url} is closed`),
				);
			if (pending !== undefined)
				return Promise.reject(
					new InFlightError(`chat frame ${pending.id} is awaiting its ack`),
				);
			const deferred = Promise.withResolvers<AckResult>();
			pending = { id: frame.id, ...deferred };
			open.send(JSON.stringify(frame));
			return deferred.promise;
		},
		onStatus(callback): void {
			statusListeners.push(callback);
		},
		onText(callback): void {
			textListeners.push(callback);
		},
		onConnectionChange(callback): void {
			connectionListeners.push(callback);
		},
		state: () => connection,
	};
}
