export type Ima2ImageMime = "image/png" | "image/jpeg";
export type Ima2Result = { requestId: string; filename: string };
export type Ima2Failure = { code: string; message: string };
export type Ima2Job = {
	requestId: string;
	state:
		| "queued"
		| "running"
		| "post_processing"
		| "completed"
		| "failed"
		| "cancelled"
		| "timed_out"
		| "unknown";
	result?: Ima2Result;
	error?: Ima2Failure;
};
/** Registry acknowledgement, not a guarantee that the provider stopped or refunded. */
export type Ima2Cancellation = {
	requestId: string;
	active: boolean;
	aborted: boolean;
};
export type Ima2SubmitInput = {
	requestId: string;
	provider: string;
	model: string;
	prompt: string;
	reference?: { bytes: Uint8Array; mime: Ima2ImageMime };
};
export type Ima2GenerationBody = Readonly<{
	requestId: string;
	provider: string;
	model: string;
	prompt: string;
	async: true;
	n: 1;
	references: readonly string[];
	format: "png";
}>;
/** Trusted runtime material, not a public DTO or a log payload. */
export type Ima2SubmissionSnapshot = Readonly<{
	url: string;
	method: "POST";
	version: "3.14.0";
	headers: Readonly<Record<string, string>>;
	body: Ima2GenerationBody;
	/** Exact UTF-8 JSON sent to fetch. Strings retain bytes without mutable buffers. */
	bodyJson: string;
	bodySha256: string;
	bodyByteLength: number;
	reference?: Readonly<{
		mime: Ima2ImageMime;
		sha256: string;
		byteLength: number;
		/** Exact approved bytes including metadata, encoded without transformation. */
		dataUrl: string;
	}>;
}>;
/**
 * Trusted, nonserialized authority check after all preparation awaits. Finish
 * guards and durable dispatch marking synchronously, then return undefined.
 * Throwing denies POST. Async/non-undefined returns deny; void would allow async
 * callbacks in TypeScript. Do not mark an attempt and then throw or abort.
 */
export type Ima2BeforeSubmit = (snapshot: Ima2SubmissionSnapshot) => undefined;
/** Handoff to fetch, independent of HTTP rejection or provider execution/cost. */
export type Ima2Dispatch = "not-dispatched" | "dispatched" | "unknown";
export type Ima2ClientOptions = {
	baseUrl?: string;
	serverFile?: string;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	timeoutMs?: number;
	/** May lower, but never raise, the managed attachment limit of 2 MiB. */
	maxImageBytes?: number;
};
export type Ima2Lane = {
	provider: string;
	status: "ready" | "locked" | "disconnected" | "key-missing";
	models: { id: string; label: string; generate: boolean; edit: boolean }[];
};
export type Ima2Connection = {
	/** Canonical origin; fixed for this client instance after discovery. */
	baseUrl: string;
	version: string;
	/** Catalog readiness only; does not prove a successful provider call. */
	ready: boolean;
	lanes: Ima2Lane[];
};
export interface Ima2ClientPort {
	connect(signal?: AbortSignal): Promise<Ima2Connection>;
	submit(
		input: Ima2SubmitInput,
		signal?: AbortSignal,
		beforeSubmit?: Ima2BeforeSubmit,
	): Promise<Ima2Job>;
	read(requestId: string, signal?: AbortSignal): Promise<Ima2Job>;
	cancel(requestId: string, signal?: AbortSignal): Promise<Ima2Cancellation>;
	download(
		result: Ima2Result,
		signal?: AbortSignal,
	): Promise<{ bytes: Uint8Array; mime: Ima2ImageMime }>;
}

export type Ima2ErrorCode =
	| "INVALID_INPUT"
	| "INVALID_SERVER_URL"
	| "DISCOVERY_UNAVAILABLE"
	| "UNSUPPORTED_VERSION"
	| "INVALID_RESPONSE"
	| "LANE_UNAVAILABLE"
	| "MODEL_UNAVAILABLE"
	| "UNSUPPORTED_OPERATION"
	| "SUBMIT_DENIED"
	| "INVALID_IMAGE"
	| "INVALID_RESULT"
	| "BODY_TOO_LARGE"
	| "ACCESS_DENIED"
	| "HTTP_ERROR"
	| "CONFLICT"
	| "RATE_LIMITED"
	| "REDIRECT_REFUSED"
	| "NETWORK_ERROR"
	| "ABORTED"
	| "TIMEOUT";

/** No upstream body, URL, prompt, credential, or raw exception is retained. */
export class Ima2Error extends Error {
	constructor(
		readonly code: Ima2ErrorCode,
		message: string,
		readonly outcome: "rejected" | "unknown" = "rejected",
		readonly status?: number,
		/** Unknown by default; only an owned submit boundary can prove no POST. */
		readonly dispatch: Ima2Dispatch = "unknown",
	) {
		super(message);
		this.name = "Ima2Error";
	}
}
