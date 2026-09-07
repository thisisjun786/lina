import type { BotBinding } from "../../../lina-core/src/protocol.ts";
import type { DurableStore } from "../../../lina-core/src/store.ts";
import {
	CaptureDelivery,
	HonchoClient,
	type HonchoClientOptions,
	type HonchoConfig,
	HonchoOutbox,
	publicIdentity,
	validateHonchoConfig,
} from "../../../lina-memory/src/honcho/index.ts";
import { scanCaptures } from "./capture-scan.ts";

type Options = {
	path: string;
	binding: BotBinding;
	journal: DurableStore;
	config?: HonchoConfig;
	clientOptions?: HonchoClientOptions;
	onChange?: () => void;
};
export type MemorySnapshot = {
	service: "disabled" | "ready" | "unavailable";
	pending: number;
	sending: number;
	accepted: number;
	unknown: number;
	failed: number;
	freshness: "unknown";
	recallText: string;
};
export class MemoryBridge {
	private outbox: HonchoOutbox | undefined;
	private client: HonchoClient | undefined;
	private delivery: CaptureDelivery | undefined;
	private readonly controller = new AbortController();
	private refreshing: Promise<void> | undefined;
	private requestedAgain = false;
	private verified = false;
	private closed = false;
	private recallText = "";
	constructor(private readonly options: Options) {
		if (!options.config) return;
		const config = validateHonchoConfig(options.config);
		this.outbox = new HonchoOutbox(
			options.path,
			options.binding,
			publicIdentity(config),
		);
		try {
			this.client = new HonchoClient(config, options.clientOptions);
			this.delivery = new CaptureDelivery({
				outbox: this.outbox,
				client: this.client,
				onChange: () => this.changed(),
			});
		} catch (error) {
			this.outbox.close();
			throw error;
		}
	}
	private changed(): void {
		if (!this.closed) this.options.onChange?.();
	}
	status(): MemorySnapshot {
		const counts = this.outbox?.counts() ?? {
			pending: 0,
			sending: 0,
			accepted: 0,
			unknown: 0,
			failed: 0,
		};
		return {
			...counts,
			service: !this.client
				? "disabled"
				: this.verified && this.delivery?.status().service !== "unavailable"
					? "ready"
					: "unavailable",
			freshness: "unknown",
			recallText: this.recallText,
		};
	}
	async recall(query: string, signal?: AbortSignal): Promise<string> {
		if (!this.client || this.closed || !query.trim()) return "";
		try {
			const result = await this.client.recall(
				query,
				AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]),
			);
			if (this.closed) return "";
			this.verified = true;
			this.recallText = result.text.slice(0, 4096);
		} catch {
			this.verified = false;
			this.recallText = "";
		}
		this.changed();
		return this.recallText;
	}
	refresh(): Promise<void> {
		if (this.refreshing) {
			this.requestedAgain = true;
			return this.refreshing;
		}
		if (this.closed || !this.client || !this.outbox || !this.delivery)
			return Promise.resolve();
		const client = this.client,
			outbox = this.outbox,
			delivery = this.delivery;
		this.refreshing = (async () => {
			do {
				this.requestedAgain = false;
				try {
					// Scan locally even while the service is missing. Every page yields to app input.
					while (
						!this.closed &&
						scanCaptures(this.options.journal, outbox) === 100
					)
						await new Promise<void>((resolve) => setImmediate(resolve));
					this.changed();
					this.verified = (await client.check(this.controller.signal)).ok;
					let previous = -1;
					while (this.verified && !this.closed) {
						const pending = outbox.counts().pending;
						if (pending === previous) break;
						previous = pending;
						const state = await delivery.flush();
						if (!state.counts.pending || state.service === "unavailable") break;
					}
				} catch {
					this.verified = false;
				} finally {
					this.changed();
				}
			} while (this.requestedAgain && !this.closed);
		})().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		await this.delivery?.close();
		await this.refreshing;
		this.outbox?.close();
	}
}
