import type { BotBinding } from "../../../lina-core/src/protocol.ts";
import type { DurableStore } from "../../../lina-core/src/store.ts";
import {
	CaptureDelivery,
	HonchoClient,
	type HonchoClientOptions,
	type HonchoConfig,
	HonchoOutbox,
	openGenerationOutbox,
	publicIdentity,
	type RecallProof,
	selectHonchoConfig,
	validateHonchoConfig,
	validateRecallProof,
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
	withheld: number;
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
	private recallProof: RecallProof | undefined;
	constructor(private readonly options: Options) {
		if (!options.config) return;
		const config = selectHonchoConfig(
			validateHonchoConfig(options.config),
			options.binding.botId,
		);
		if (!config) return;
		const sourceLookup = (id: string) => options.journal.sourceEntry(id);
		this.outbox = config.ordinaryNamespace
			? openGenerationOutbox(
					options.path,
					options.binding,
					config,
					sourceLookup,
				)
			: new HonchoOutbox(options.path, options.binding, publicIdentity(config));
		try {
			this.client = new HonchoClient(config, {
				...options.clientOptions,
				binding: options.binding,
				sourceLookup,
			});
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
	private currentRecall(): boolean {
		if (!this.recallProof || !this.client?.owner) return false;
		try {
			validateRecallProof(this.recallProof, this.client.owner, (id) =>
				this.options.journal.sourceEntry(id),
			);
			return true;
		} catch {
			return false;
		}
	}
	status(): MemorySnapshot {
		if (!this.currentRecall()) {
			this.recallText = "";
			this.recallProof = undefined;
		}
		const counts = this.outbox?.counts() ?? {
			pending: 0,
			sending: 0,
			accepted: 0,
			unknown: 0,
			failed: 0,
			withheld: 0,
		};
		return {
			...counts,
			service: !this.client
				? this.options.config
					? "unavailable"
					: "disabled"
				: this.verified && this.delivery?.status().service !== "unavailable"
					? "ready"
					: "unavailable",
			freshness: "unknown",
			recallText: this.recallText,
		};
	}
	recallSourceProofs(text: string) {
		if (
			this.closed ||
			!text ||
			text !== this.recallText ||
			!this.currentRecall()
		)
			return undefined;
		return structuredClone(this.recallProof?.sourceProofs);
	}
	async recall(query: string, signal?: AbortSignal): Promise<string> {
		if (!this.client || this.closed || !query.trim()) {
			this.recallText = "";
			this.recallProof = undefined;
			return "";
		}
		try {
			const result = await this.client.recall(
				query,
				AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]),
			);
			if (this.closed) return "";
			this.recallProof = result.proof;
			this.verified = this.currentRecall();
			if (!this.verified) {
				this.recallText = "";
				this.recallProof = undefined;
				return "";
			}
			this.recallText = result.text.slice(0, 4096);
		} catch {
			this.verified = false;
			this.recallText = "";
			this.recallProof = undefined;
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
					this.verified = await client.qualify(this.controller.signal);
					if (this.verified)
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
					this.recallText = "";
					this.recallProof = undefined;
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
		this.recallText = "";
		this.recallProof = undefined;
		this.controller.abort();
		await this.delivery?.close();
		await this.refreshing;
		this.outbox?.close();
	}
}
