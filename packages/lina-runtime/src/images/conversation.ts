import { isDeepStrictEqual } from "node:util";
import type { AttachmentStore } from "../../../lina-core/src/attachments/store.ts";
import { isImageMime } from "../../../lina-core/src/attachments/types.ts";
import type { SessionPort } from "../sdk-port.ts";
import type { ImageArtifactPort, ImageCompletionPort } from "./contracts.ts";
import type { ImageJobStore } from "./store.ts";
/** Original session constructors and native image_<UUID>/revision-1 notices stay compatible. */
export function conversationImagePorts(
	store: ImageJobStore,
	attachments: AttachmentStore,
	notify: SessionPort["appendNotice"],
): { artifacts: ImageArtifactPort; completion: ImageCompletionPort } {
	if (!attachments.isBoundTo(store.binding))
		throw Error("Image attachment binding differs");
	const artifacts: ImageArtifactPort = {
		resolveReference(input) {
			if (!("sourceArtifactId" in input))
				throw Error("Conversation image input required");
			if (!input.sourceArtifactId) return null;
			const meta = attachments.get(input.sourceArtifactId);
			if (!isImageMime(meta.mime))
				throw Error("편집할 이미지 첨부가 아닙니다.");
			return { bytes: attachments.bytes(meta.id), mime: meta.mime };
		},
		preflight() {
			// The AttachmentStore remains the original conversation quota owner.
			attachments.preflight(2_097_152);
		},
		importOutput(job, output) {
			return attachments.put(
				`image-${job.id}.${output.mime === "image/png" ? "png" : "jpg"}`,
				output.bytes,
				job.id,
			);
		},
		verify(job) {
			if (
				!job.artifact ||
				!isDeepStrictEqual(attachments.get(job.artifact.id), job.artifact)
			)
				throw Error("Image artifact metadata conflict");
			attachments.bytes(job.artifact.id);
		},
	};
	const completion: ImageCompletionPort = {
		async complete(job) {
			if (job.owner.kind !== "conversation")
				throw Error("Conversation completion required");
			const artifact = job.artifact;
			const suffix = `?sessionId=${encodeURIComponent(store.binding.sessionId)}`;
			const text = artifact
				? `${job.sourceArtifactId ? "이미지를 수정했습니다." : "이미지를 만들었습니다."}\n\n![생성 이미지](/api/attachments/${artifact.id}/preview${suffix})\n\n[이미지 다운로드](/api/attachments/${artifact.id}${suffix})`
				: job.state === "cancelled"
					? "이미지 생성을 취소했습니다."
					: `${job.resultFilename ? "이미지는 생성됐지만 저장하지 못했습니다." : "이미지를 만들지 못했습니다."} ${job.error ?? "연결 상태를 확인해주세요."}`;
			const entryId = await notify(
				{ jobId: `image_${job.id}`, terminalRevision: 1 },
				text,
			);
			return entryId ? { kind: "conversation", entryId } : { kind: "pending" };
		},
	};
	return { artifacts, completion };
}
