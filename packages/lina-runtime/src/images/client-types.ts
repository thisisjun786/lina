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
	submit(input: Ima2SubmitInput, signal?: AbortSignal): Promise<Ima2Job>;
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
	) {
		super(message);
		this.name = "Ima2Error";
	}
}
