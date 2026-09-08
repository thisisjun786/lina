import type { HonchoClient } from "./client.ts";
import type { HonchoOutbox } from "./outbox.ts";
import {
	type CaptureStatus,
	HonchoRequestError,
	type MemoryService,
	type OutboxPart,
} from "./types.ts";

const RETRYABLE_REJECTIONS = new Set([401, 403, 404, 429]);

export interface CaptureDeliveryOptions {
	outbox: HonchoOutbox;
	client?: HonchoClient;
	batchSize?: number;
	onChange?: (status: CaptureStatus) => void;
}

// Delivers outbox parts one POST at a time. Capture receipts say nothing about
// derivation; status therefore always reports freshness "unknown".
export class CaptureDelivery {
	private readonly outbox: HonchoOutbox;
	private readonly client: HonchoClient | undefined;
	private readonly batchSize: number;
	private readonly onChange: ((status: CaptureStatus) => void) | undefined;
	private service: MemoryService;
	private inflight: Promise<CaptureStatus> | undefined;
	private controller = new AbortController();
	private closed = false;

	constructor(options: CaptureDeliveryOptions) {
		this.outbox = options.outbox;
		this.client = options.client;
		this.batchSize = options.batchSize ?? 20;
		if (
			!Number.isInteger(this.batchSize) ||
			this.batchSize < 1 ||
			this.batchSize > 100
		)
			throw new Error("invalid capture batch size");
		this.onChange = options.onChange;
		this.service = this.client ? "unavailable" : "disabled";
	}

	status(): CaptureStatus {
		return {
			service: this.service,
			counts: this.outbox.counts(),
			freshness: "unknown",
		};
	}

	private notify(): CaptureStatus {
		const status = this.status();
		this.onChange?.(status);
		return status;
	}

	private unavailable(error: unknown): boolean {
		return (
			error instanceof HonchoRequestError &&
			(error.kind === "network" ||
				error.kind === "timeout" ||
				error.kind === "redirect" ||
				(error.kind === "status" &&
					error.status !== undefined &&
					(error.status >= 500 ||
						error.status === 408 ||
						RETRYABLE_REJECTIONS.has(error.status))))
		);
	}

	// Never resends: exactly one exact remote match adopts the receipt, zero keeps
	// the part unknown (an in-flight commit may still land), more than one is ambiguity.
	private admit(client: HonchoClient, part: OutboxPart): boolean {
		if (this.outbox.eligible(part) && client.eligible(part)) return true;
		this.outbox.withhold(part.id, "source_or_namespace_unavailable");
		return false;
	}
	private async reconcile(
		client: HonchoClient,
		part: OutboxPart,
		signal: AbortSignal,
	): Promise<void> {
		if (!this.admit(client, part)) return;
		const candidates = await client.findMessages(part, signal);
		if (!this.admit(client, part)) return;
		const exact = candidates.filter((message) => client.matches(message, part));
		if (exact.length === 1 && exact[0])
			this.outbox.markAccepted(part.id, exact[0].id);
		else if (exact.length === 0)
			this.outbox.markUnknown(part.id, "no remote match yet");
		else
			this.outbox.markUnknown(
				part.id,
				`ambiguous: ${exact.length} remote matches`,
			);
	}

	private async send(
		client: HonchoClient,
		part: OutboxPart,
		signal: AbortSignal,
	): Promise<void> {
		if (!this.admit(client, part)) return;
		// The sending state is durable before the request leaves the process.
		this.outbox.markSending(part.id);
		try {
			const { remoteId } = await client.createMessage(part, signal);
			this.outbox.markAccepted(part.id, remoteId);
			this.admit(client, part);
		} catch (error) {
			if (
				error instanceof HonchoRequestError &&
				error.kind === "status" &&
				error.status !== undefined &&
				RETRYABLE_REJECTIONS.has(error.status)
			)
				this.outbox.markPending(part.id, error.message);
			else if (
				error instanceof HonchoRequestError &&
				error.kind === "status" &&
				error.status !== undefined &&
				error.status !== 408 &&
				error.status < 500
			)
				this.outbox.markFailed(part.id, error.message);
			else
				this.outbox.markUnknown(
					part.id,
					error instanceof Error ? error.message : "send failed",
				);
			this.admit(client, part);
			throw error;
		}
	}

	private async run(client: HonchoClient): Promise<CaptureStatus> {
		const signal = this.controller.signal;
		try {
			// Withhold stale parts before even a qualification request or unknown lookup.
			for (const part of [
				...this.outbox.unknown(this.batchSize),
				...this.outbox.next(this.batchSize),
			])
				this.admit(client, part);
			if (!(await client.qualify(signal))) {
				this.service = "unavailable";
				return this.notify();
			}
			for (const part of this.outbox.unknown(this.batchSize)) {
				if (signal.aborted) break;
				await this.reconcile(client, part, signal);
			}
			for (const part of this.outbox.next(this.batchSize)) {
				if (signal.aborted) break;
				await this.send(client, part, signal);
			}
			if (!signal.aborted) this.service = "ready";
		} catch (error) {
			for (const part of [
				...this.outbox.unknown(this.batchSize),
				...this.outbox.next(this.batchSize),
			])
				this.admit(client, part);
			if (error instanceof HonchoRequestError && error.kind === "body")
				this.service = "unavailable";
			if (this.unavailable(error) || signal.aborted)
				this.service = "unavailable";
			else if (!(error instanceof HonchoRequestError)) throw error;
		}
		return this.notify();
	}

	// Single-flight: a concurrent caller shares the running flush.
	flush(): Promise<CaptureStatus> {
		if (this.inflight) return this.inflight;
		if (!this.client || this.closed) return Promise.resolve(this.status());
		const client = this.client;
		this.inflight = this.run(client).finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		if (this.inflight) await this.inflight.catch(() => undefined);
	}
}
