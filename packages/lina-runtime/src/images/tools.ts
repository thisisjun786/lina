import { Type } from "typebox";
import type { LinaToolResult } from "../host.ts";
import type { ImageJobs } from "./jobs.ts";
import type { ImageJob } from "./store.ts";

type Jobs = Pick<
	ImageJobs,
	"connect" | "list" | "get" | "start" | "wait" | "reconcile" | "cancel"
>;
const field = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const jobId = field(128);
const selection = {
	provider: field(128),
	model: field(256),
	prompt: field(16000),
};
const textResult = (details: unknown): LinaToolResult => ({
	content: [{ type: "text", text: JSON.stringify(details) }],
	details,
});
function project(job: ImageJob) {
	return {
		jobId: job.id,
		requestId: job.requestId,
		provider: job.provider,
		model: job.model,
		state: job.state,
		sourceArtifactId: job.sourceArtifactId,
		artifact: job.artifact,
		resultFilename: job.resultFilename,
		error: job.error,
		cancelRequested: job.cancelRequested,
		deliveryError: job.deliveryError,
		delivered: !!job.deliveredEntryId,
	};
}
export function createImageTools(
	jobs: Jobs,
	requestId: () => string | undefined,
) {
	const run = async (
		callId: string,
		input: {
			provider: string;
			model: string;
			prompt: string;
			sourceArtifactId?: string;
		},
		signal?: AbortSignal,
	) => {
		const owner = requestId();
		if (!owner) throw Error("Image tool has no active request owner");
		signal?.throwIfAborted();
		const job = await jobs.start(
			{
				...input,
				sourceArtifactId: input.sourceArtifactId ?? null,
				callId,
				requestId: owner,
			},
			signal,
		);
		const final = signal?.aborted
			? await jobs.cancel(job.id)
			: await jobs.wait(job.id, signal);
		if (final.state === "failed")
			throw Error(`Image job ${final.id}: ${final.error}`);
		return textResult(project(final));
	};
	return [
		{
			name: "lina_image_models",
			label: "이미지 연결 확인",
			description:
				"Inspect ima2 image service, setup URL, exact provider/model catalog and supported operations. Conversation models and credentials are separate. Ready/configured is not successful generation. Ask which exact available image model to use if the user has not selected one; never silently switch provider or billing lane.",
			parameters: Type.Object({}, { additionalProperties: false }),
			async execute(_id: string, _input: unknown, signal?: AbortSignal) {
				return textResult(await jobs.connect(signal));
			},
		},
		{
			name: "lina_image_generate",
			label: "이미지 만들기",
			description:
				"Generate exactly one image through ima2 using the user's explicitly chosen provider and model. Requires user authorization for external generation. The result is saved as a managed attachment and delivered once to this conversation. If uncertain, inspect the same job; never create a replacement or switch provider automatically. Do not repeat the image in your reply: the managed completion notice displays it.",
			parameters: Type.Object(selection, { additionalProperties: false }),
			execute: run,
		},
		{
			name: "lina_image_edit",
			label: "이미지 수정하기",
			description:
				"Edit a managed image from this conversation, passing its exact sourceArtifactId as the reference to ima2. Inspect image jobs for the previous artifact ID. Explicit provider/model and authorization are required. This creates one new image while preserving the original. No mask/Studio editing. Never retry an uncertain edit or re-display the generated image yourself.",
			parameters: Type.Object(
				{ ...selection, sourceArtifactId: field(128) },
				{ additionalProperties: false },
			),
			execute: run,
		},
		{
			name: "lina_image_jobs",
			label: "이미지 작업 목록",
			description:
				"List image jobs and their source/result artifact IDs owned by this conversation, including pending, failed and recovered jobs. Use before re-editing an image or when a prior request is uncertain.",
			parameters: Type.Object({}, { additionalProperties: false }),
			execute() {
				return textResult({ jobs: jobs.list().map(project) });
			},
		},
		{
			name: "lina_image_read",
			label: "이미지 작업 확인",
			description:
				"Reconcile a known image job against ima2 using its original request ID. Never submits generation. Unknown means the outcome is uncertain, not failed or safe to retry.",
			parameters: Type.Object({ jobId }, { additionalProperties: false }),
			async execute(
				_id: string,
				input: { jobId: string },
				signal?: AbortSignal,
			) {
				signal?.throwIfAborted();
				return textResult(project(await jobs.reconcile(input.jobId)));
			},
		},
		{
			name: "lina_image_cancel",
			label: "이미지 작업 취소",
			description:
				"Request cancellation of a known image job in this conversation. Cancelling is pending until ima2 reports a terminal outcome; cancellation acknowledgements do not prove the provider stopped or refunded generation.",
			parameters: Type.Object({ jobId }, { additionalProperties: false }),
			async execute(
				_id: string,
				input: { jobId: string },
				signal?: AbortSignal,
			) {
				signal?.throwIfAborted();
				return textResult(project(await jobs.cancel(input.jobId)));
			},
		},
	];
}
