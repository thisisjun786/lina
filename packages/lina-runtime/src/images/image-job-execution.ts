import { createHash } from "node:crypto";
import { AttachmentError } from "../../../lina-core/src/attachments/store.ts";
import { isImageMime } from "../../../lina-core/src/attachments/types.ts";
import { type Ima2ClientPort, Ima2Error } from "./client-types.ts";
import type {
	ImageArtifactPort,
	ImageJob,
	ImageReferenceBytes,
	ImageStartAuthority,
} from "./contracts.ts";
import { inputFor } from "./image-store-schema.ts";
import { type ImageJobStore, terminalImageState } from "./store.ts";

const ERROR_GUIDANCE: Record<string, string> = {
	DISCOVERY_UNAVAILABLE:
		"이미지 엔진이 연결되지 않았습니다. ima2를 시작하거나 연결 주소를 설정해주세요.",
	ACCESS_DENIED: "ima2에서 인증 정보를 확인해주세요.",
	LANE_UNAVAILABLE:
		"선택한 이미지 서비스가 준비되지 않았습니다. ima2 연결 설정을 확인해주세요.",
	MODEL_UNAVAILABLE:
		"선택한 이미지 모델을 찾지 못했습니다. 이미지 모델 목록을 확인해주세요.",
	UNSUPPORTED_OPERATION: "선택한 모델은 이 이미지 작업을 지원하지 않습니다.",
	UNSUPPORTED_VERSION: "연결된 ima2 버전이 지원 범위와 다릅니다.",
	BODY_TOO_LARGE:
		"이미지가 첨부 크기 한도를 넘었습니다. 최대 2 MiB까지 저장할 수 있습니다.",
	INVALID_IMAGE:
		"이미지 파일을 검증하지 못했습니다. 결과를 표시하지 않았습니다.",
};
export function safeError(error: unknown): string {
	if (error instanceof AttachmentError)
		return `ATTACHMENT_${error.code.toUpperCase().replaceAll("-", "_")}: 이미지 결과를 저장하거나 검증하지 못했습니다.`;
	// Upstream response bodies may contain credentials. Persist only our own code.
	const code =
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string" &&
		/^[A-Z_]{1,64}$/.test(error.code)
			? error.code
			: "IMAGE_CONNECTION_FAILED";
	return `${code}: ${ERROR_GUIDANCE[code] ?? "이미지 연결 또는 작업 상태를 확인해주세요."}`;
}
export class ImageJobExecution {
	constructor(
		private readonly store: ImageJobStore,
		private readonly client: Ima2ClientPort,
		private readonly artifacts: ImageArtifactPort,
		private readonly signal: (signal?: AbortSignal) => AbortSignal,
	) {}
	private get(id: string): ImageJob {
		return this.store.get(id);
	}
	async submit(
		id: string,
		authority?: ImageStartAuthority,
		signal?: AbortSignal,
		resolved?: ImageReferenceBytes | null,
	): Promise<ImageJob> {
		const job = this.get(id);
		if (job.state !== "prepared") return job;
		const life = job.owner.kind === "life";
		let dispatched = false;
		let admitted = false;
		try {
			this.signal(signal).throwIfAborted();
			await this.artifacts.preflight(job);
			const reference =
				resolved === undefined
					? await this.artifacts.resolveReference(inputFor(job))
					: resolved;
			const frozen = this.freezeReference(job, reference);
			const connection = await this.client.connect(this.signal(signal));
			this.signal(signal).throwIfAborted();
			if (this.get(id).cancelRequested)
				return this.store.update(id, { state: "cancelled", error: null });
			if (!life) {
				this.store.update(id, {
					endpoint: connection.baseUrl,
					runtimeVersion: connection.version,
					state: "submitting",
				});
				dispatched = true;
			}
			const result = await this.client.submit(
				{
					requestId: id,
					provider: job.provider,
					model: job.model,
					prompt: job.prompt,
					...(frozen ? { reference: frozen } : {}),
				},
				this.signal(signal),
				life
					? (snapshot) => {
							this.signal(signal).throwIfAborted();
							const current = this.get(id);
							if (
								current.state !== "prepared" ||
								current.cancelRequested ||
								!authority
							)
								throw Error("LIFE image admission changed");
							if (
								snapshot.body.requestId !== current.id ||
								snapshot.body.provider !== current.provider ||
								snapshot.body.model !== current.model ||
								snapshot.body.prompt !== current.prompt ||
								snapshot.url !== `${connection.baseUrl}/api/generate` ||
								snapshot.version !== connection.version ||
								(current.reference
									? snapshot.reference?.sha256 !== current.reference.sha256 ||
										snapshot.reference?.mime !== current.reference.mime ||
										snapshot.reference?.byteLength !== current.reference.size
									: snapshot.reference !== undefined)
							)
								throw Error("Frozen image submission conflict");
							const result = authority.beforeSubmit(current, snapshot);
							if (result !== undefined)
								throw Error("LIFE final authority must be synchronous");
							this.store.update(id, {
								endpoint: connection.baseUrl,
								runtimeVersion: connection.version,
								state: "submitting",
								error: null,
							});
							dispatched = true;
							return undefined;
						}
					: undefined,
			);
			if (life && !dispatched)
				throw Error("LIFE client omitted final admission hook");
			admitted = true;
			await this.apply(id, result);
		} catch (error) {
			if (!terminalImageState(this.get(id).state)) {
				const rejected =
					!admitted &&
					error instanceof Ima2Error &&
					error.outcome === "rejected";
				this.store.update(id, {
					state:
						life && !dispatched
							? "prepared"
							: dispatched && !rejected
								? this.get(id).cancelRequested
									? "cancelling"
									: "uncertain"
								: signal?.aborted
									? "cancelled"
									: "failed",
					error: safeError(error),
				});
			}
		}
		return this.get(id);
	}
	private freezeReference(
		job: ImageJob,
		reference: ImageReferenceBytes | null,
	): ImageReferenceBytes | null {
		if (job.owner.kind === "life") {
			if (job.reference === null) return null;
			if (
				!reference ||
				reference.mime !== job.reference.mime ||
				reference.bytes.length !== job.reference.size ||
				createHash("sha256").update(reference.bytes).digest("hex") !==
					job.reference.sha256
			)
				throw Error("Frozen image reference bytes conflict");
		}
		return reference
			? { bytes: new Uint8Array(reference.bytes), mime: reference.mime }
			: null;
	}
	async apply(
		id: string,
		result: Awaited<ReturnType<Ima2ClientPort["read"]>>,
	): Promise<void> {
		if (
			result.requestId !== id ||
			(result.result && result.result.requestId !== id)
		)
			throw Error("Foreign image result");
		const job = this.get(id);
		if (result.state === "completed" && !result.result)
			throw Error("Missing image result");
		if (result.state === "completed" && result.result) {
			this.store.update(id, { resultFilename: result.result.filename });
			try {
				const output = await this.client.download(result.result, this.signal());
				if (!isImageMime(output.mime)) throw Error("Unsupported image format");
				const artifact = await this.artifacts.importOutput(
					this.get(id),
					output,
				);
				await this.artifacts.verify({ ...this.get(id), artifact });
				this.store.update(id, {
					state: "completed",
					artifact,
					error: null,
				});
			} catch (error) {
				if (
					job.owner.kind === "life" ||
					error instanceof AttachmentError ||
					(error instanceof Ima2Error &&
						["BODY_TOO_LARGE", "INVALID_IMAGE", "INVALID_RESULT"].includes(
							error.code,
						))
				) {
					this.store.update(id, {
						state: "failed",
						error: safeError(error),
					});
				} else throw error;
			}
		} else if (result.state === "failed" || result.state === "cancelled") {
			this.store.update(id, {
				state: result.state,
				error: result.state === "failed" ? safeError(result.error) : null,
			});
		} else {
			this.store.update(id, {
				state: job.cancelRequested
					? "cancelling"
					: result.state === "unknown" || result.state === "timed_out"
						? "uncertain"
						: result.state,
				error:
					result.state === "unknown" || result.state === "timed_out"
						? "생성 결과가 아직 확인되지 않았습니다. 같은 요청을 조회하며 다시 생성하지 않습니다."
						: null,
			});
		}
	}
}
