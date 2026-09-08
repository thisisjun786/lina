import {
	acceptedSchema,
	cancelSchema,
	catalogLanes,
	healthSchema,
	historyJob,
	IMA2_VERSION,
	IMAGE_MAX_BYTES,
	imageMime,
	inflightJob,
	parse,
	prepareSubmission,
	replaySchema,
	requestIdSchema,
	resultSchema,
} from "./client-contract.ts";
import { Ima2Http } from "./client-http.ts";
import {
	type Ima2BeforeSubmit,
	type Ima2Cancellation,
	type Ima2ClientOptions,
	type Ima2ClientPort,
	type Ima2Connection,
	Ima2Error,
	type Ima2ImageMime,
	type Ima2Job,
	type Ima2Result,
	type Ima2SubmitInput,
} from "./client-types.ts";

export type {
	Ima2BeforeSubmit,
	Ima2Cancellation,
	Ima2ClientOptions,
	Ima2ClientPort,
	Ima2Connection,
	Ima2Dispatch,
	Ima2ErrorCode,
	Ima2Failure,
	Ima2GenerationBody,
	Ima2ImageMime,
	Ima2Job,
	Ima2Lane,
	Ima2Result,
	Ima2SubmissionSnapshot,
	Ima2SubmitInput,
} from "./client-types.ts";
export { Ima2Error } from "./client-types.ts";

/**
 * HTTP contracts verified against ima2-gen 36aa6fcea62f753d858d20c4823e04922951c954.
 * No engine lifecycle, polling loop, automatic retry, or provider fallback.
 * Persist baseUrl + requestId outside this adapter before submitting. Upstream
 * idempotency expires after 24h; absent records must never cause blind replay.
 */
export class Ima2Client implements Ima2ClientPort {
	readonly #http: Ima2Http;
	readonly #maxImageBytes: number;
	#connection: Ima2Connection | undefined;

	constructor(options: Ima2ClientOptions = {}) {
		this.#http = new Ima2Http(options);
		this.#maxImageBytes = options.maxImageBytes ?? IMAGE_MAX_BYTES;
		if (
			!Number.isSafeInteger(this.#maxImageBytes) ||
			this.#maxImageBytes < 1 ||
			this.#maxImageBytes > IMAGE_MAX_BYTES
		)
			throw new Ima2Error(
				"INVALID_INPUT",
				"Image byte limit must be between 1 and 2 MiB",
			);
	}

	async connect(signal?: AbortSignal): Promise<Ima2Connection> {
		this.#connection = undefined;
		const baseUrl = await this.#http.baseUrl(signal);
		const init = signal ? { signal } : {};
		const health = parse(
			healthSchema,
			(await this.#http.json("/api/health", init)).value,
		);
		if (health.version !== IMA2_VERSION)
			throw new Ima2Error(
				"UNSUPPORTED_VERSION",
				"This adapter requires ima2 3.14.0; qualify other versions before use",
			);
		const lanes = catalogLanes(
			(await this.#http.json("/api/models", init)).value,
		);
		this.#connection = {
			baseUrl,
			version: health.version,
			lanes,
			ready: lanes.some(
				(lane) =>
					lane.status === "ready" &&
					lane.models.some((model) => model.generate),
			),
		};
		return structuredClone(this.#connection);
	}

	async submit(
		input: Ima2SubmitInput,
		signal?: AbortSignal,
		beforeSubmit?: Ima2BeforeSubmit,
	): Promise<Ima2Job> {
		try {
			return await this.#submit(input, signal, beforeSubmit);
		} catch (error) {
			// Connection GET failures are still known zero generation POSTs. The
			// HTTP generation boundary marks all failures after handoff separately.
			const safe =
				error instanceof Ima2Error
					? error
					: new Ima2Error(
							"INVALID_INPUT",
							"ima2 submission preparation failed",
						);
			throw new Ima2Error(
				safe.code,
				safe.message,
				safe.outcome,
				safe.status,
				safe.dispatch === "unknown" ? "not-dispatched" : safe.dispatch,
			);
		}
	}

	async #submit(
		input: Ima2SubmitInput,
		signal: AbortSignal | undefined,
		beforeSubmit: Ima2BeforeSubmit | undefined,
	): Promise<Ima2Job> {
		const material = prepareSubmission(input, this.#maxImageBytes);
		const value = material.body;
		const reference = material.reference;
		const connection = this.#connection ?? (await this.connect(signal));
		const lane = connection.lanes.find(
			(lane) => lane.provider === value.provider,
		);
		if (lane?.status !== "ready")
			throw new Ima2Error(
				"LANE_UNAVAILABLE",
				"Selected ima2 provider is unavailable; configure it in ima2",
			);
		const model = lane.models.find((model) => model.id === value.model);
		if (!model)
			throw new Ima2Error(
				"MODEL_UNAVAILABLE",
				"Selected image model is absent from the ima2 catalog",
			);
		if (!model.generate || (reference && !model.edit))
			throw new Ima2Error(
				"UNSUPPORTED_OPERATION",
				"Selected ima2 model does not support this adapter operation",
			);
		const response = await this.#http.json(
			"/api/generate",
			{
				method: material.method,
				headers: material.headers,
				body: material.bodyJson,
				...(signal ? { signal } : {}),
			},
			beforeSubmit
				? (url) => beforeSubmit(Object.freeze({ ...material, url }))
				: undefined,
		);
		try {
			if (response.status === 202) {
				const accepted = parse(acceptedSchema, response.value);
				if (accepted.requestId !== value.requestId) throw new Error();
				return { requestId: value.requestId, state: "queued" };
			}
			if (response.status !== 200) throw new Error();
			const replay = parse(replaySchema, response.value);
			if (
				replay.requestId !== value.requestId ||
				replay.provider !== value.provider ||
				replay.model !== value.model
			)
				throw new Error();
			return {
				requestId: value.requestId,
				state: "completed",
				result: { requestId: value.requestId, filename: replay.filename },
			};
		} catch {
			throw new Ima2Error(
				"INVALID_RESPONSE",
				"ima2 submission response did not confirm the requested identity and output",
				"unknown",
				undefined,
				"dispatched",
			);
		}
	}

	async read(requestId: string, signal?: AbortSignal): Promise<Ima2Job> {
		parse(requestIdSchema, requestId, "INVALID_INPUT");
		if (!this.#connection) await this.connect(signal);
		const init = signal ? { signal } : {};
		const job = inflightJob(
			(await this.#http.json("/api/inflight?includeTerminal=1", init)).value,
			requestId,
		);
		if (job) return job;
		// Terminal snapshots expire, and unknown cancellation tombstones cannot
		// prove a job's outcome. History retains identity with the saved file;
		// no other job's "latest" is used.
		return historyJob(
			(
				await this.#http.json(
					`/api/history?requestId=${encodeURIComponent(requestId)}&limit=2`,
					init,
				)
			).value,
			requestId,
		);
	}

	async cancel(
		requestId: string,
		signal?: AbortSignal,
	): Promise<Ima2Cancellation> {
		parse(requestIdSchema, requestId, "INVALID_INPUT");
		if (!this.#connection) await this.connect(signal);
		const response = await this.#http.json(
			`/api/inflight/${encodeURIComponent(requestId)}`,
			{ method: "DELETE", ...(signal ? { signal } : {}) },
		);
		try {
			const ack = parse(cancelSchema, response.value);
			if (ack.requestId !== requestId) throw new Error();
			return ack;
		} catch {
			throw new Ima2Error(
				"INVALID_RESPONSE",
				"ima2 cancellation acknowledgement did not match the request",
				"unknown",
			);
		}
	}

	async download(
		result: Ima2Result,
		signal?: AbortSignal,
	): Promise<{ bytes: Uint8Array; mime: Ima2ImageMime }> {
		const value = parse(resultSchema, result, "INVALID_RESULT");
		if (!this.#connection) await this.connect(signal);
		const response = await this.#http.request(
			`/generated/${encodeURIComponent(value.filename)}`,
			signal ? { signal } : {},
			this.#maxImageBytes,
		);
		const mime = imageMime(response.bytes, response.mime, this.#maxImageBytes);
		if ((/\.png$/i.test(value.filename) ? "image/png" : "image/jpeg") !== mime)
			throw new Ima2Error(
				"INVALID_IMAGE",
				"ima2 image media type does not match its filename",
			);
		return { bytes: response.bytes, mime };
	}
}
