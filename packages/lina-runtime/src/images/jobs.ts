import { setTimeout as delay } from "node:timers/promises";
import {
	AttachmentError,
	type AttachmentStore,
} from "../../../lina-core/src/attachments/store.ts";
import { isImageMime } from "../../../lina-core/src/attachments/types.ts";
import type { SessionPort } from "../sdk-port.ts";
import type { Ima2Client } from "./client.ts";
import { Ima2Error } from "./client-types.ts";
import {
	type ImageJob,
	type ImageJobInput,
	type ImageJobStore,
	terminalImageState,
} from "./store.ts";

export type ImageClient = Pick<
	Ima2Client,
	"connect" | "submit" | "read" | "cancel" | "download"
>;
type Options = {
	store: ImageJobStore;
	attachments: AttachmentStore;
	client: ImageClient;
	notify: SessionPort["appendNotice"];
};
const POLL_MS = 1500;
const WAIT_MS = 5 * 60 * 1000;
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
function safeError(error: unknown): string {
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
export class ImageJobs {
	private readonly active = new Map<string, Promise<ImageJob>>();
	private readonly shutdown = new AbortController();
	private poll: Promise<void> | undefined;
	private notices: Promise<void> | undefined;
	private recoveryError: string | null = null;
	constructor(private readonly options: Options) {
		if (!options.attachments.isBoundTo(options.store.binding))
			throw Error("Image attachment binding differs");
	}
	list() {
		return this.options.store.list();
	}
	get(id: string) {
		return this.options.store.get(id);
	}
	async connect(signal?: AbortSignal) {
		const connection = await this.options.client.connect(signal);
		const verified = this.list()
			.filter((j) => j.state === "completed")
			.map((j) => ({
				provider: j.provider,
				model: j.model,
				version: j.runtimeVersion,
				endpoint: j.endpoint,
				completedAt: j.updatedAt,
			}));
		return {
			...connection,
			ownership: "external" as const,
			setupUrl: connection.baseUrl,
			generationVerified: verified,
			recoveryError: this.recoveryError,
		};
	}
	async start(input: ImageJobInput, signal?: AbortSignal): Promise<ImageJob> {
		this.shutdown.signal.throwIfAborted();
		signal?.throwIfAborted();
		const previous = this.list().find(
			(j) => j.requestId === input.requestId && j.callId === input.callId,
		);
		if (previous) return this.options.store.create(input);
		if (this.list().some((j) => !terminalImageState(j.state)))
			throw Error(
				"이미지 작업이 아직 끝나지 않았습니다. 기존 작업을 확인해주세요.",
			);
		let reference:
			| { bytes: Uint8Array; mime: "image/png" | "image/jpeg" }
			| undefined;
		if (input.sourceArtifactId) {
			const meta = this.options.attachments.get(input.sourceArtifactId);
			if (!isImageMime(meta.mime))
				throw Error("편집할 이미지 첨부가 아닙니다.");
			reference = {
				bytes: this.options.attachments.bytes(meta.id),
				mime: meta.mime,
			};
		}
		const created = this.options.store.create(input);
		return this.exclusive(created.id, async () => {
			let dispatched = false;
			let admitted = false;
			try {
				const connection = await this.options.client.connect(
					this.signal(signal),
				);
				this.signal(signal).throwIfAborted();
				if (this.get(created.id).cancelRequested) {
					return this.options.store.update(created.id, {
						state: "cancelled",
						error: null,
					});
				}
				this.options.store.update(created.id, {
					endpoint: connection.baseUrl,
					runtimeVersion: connection.version,
					state: "submitting",
				});
				dispatched = true;
				const result = await this.options.client.submit(
					{
						requestId: created.id,
						provider: input.provider,
						model: input.model,
						prompt: input.prompt,
						...(reference ? { reference } : {}),
					},
					this.signal(signal),
				);
				admitted = true;
				await this.apply(created.id, result);
			} catch (error) {
				const rejected =
					!admitted &&
					error instanceof Ima2Error &&
					error.outcome === "rejected";
				this.options.store.update(created.id, {
					state:
						dispatched && !rejected
							? this.get(created.id).cancelRequested
								? "cancelling"
								: "uncertain"
							: signal?.aborted
								? "cancelled"
								: "failed",
					error: safeError(error),
				});
			}
			return this.get(created.id);
		});
	}
	async reconcile(id: string): Promise<ImageJob> {
		return this.exclusive(id, async () => {
			const job = this.get(id);
			if (terminalImageState(job.state)) {
				await this.flushNotices();
				return this.get(id);
			}
			try {
				if (
					job.state === "prepared" ||
					(job.cancelRequested && job.endpoint === null)
				) {
					this.options.store.update(id, {
						state: job.cancelRequested ? "cancelled" : "failed",
						error:
							"생성 요청 전에 실행이 중단되었습니다. 새 요청으로 시작해주세요.",
					});
				} else {
					const connection = await this.options.client.connect(
						this.shutdown.signal,
					);
					if (
						connection.baseUrl !== job.endpoint ||
						connection.version !== job.runtimeVersion
					)
						throw Error("Image runtime changed");
					let result = await this.options.client.read(id, this.shutdown.signal);
					if (
						this.get(id).cancelRequested &&
						["queued", "running", "post_processing"].includes(result.state)
					) {
						await this.options.client.cancel(id, this.shutdown.signal);
						result = await this.options.client.read(id, this.shutdown.signal);
					}
					await this.apply(id, result);
				}
			} catch (error) {
				if (!terminalImageState(this.get(id).state))
					this.options.store.update(id, {
						state: this.get(id).cancelRequested ? "cancelling" : "uncertain",
						error: safeError(error),
					});
			}
			await this.flushNotices();
			return this.get(id);
		});
	}
	async cancel(id: string): Promise<ImageJob> {
		// Serialize the intent behind submission without coalescing it with a read.
		const current = this.get(id);
		if (terminalImageState(current.state)) return current;
		this.options.store.update(id, {
			cancelRequested: true,
			state: "cancelling",
			error: null,
		});
		return this.exclusive(id, async () => {
			const job = this.get(id);
			if (terminalImageState(job.state)) return job;
			if (job.endpoint === null)
				return this.options.store.update(id, {
					state: "cancelled",
					error: null,
				});
			try {
				const connection = await this.options.client.connect(
					this.shutdown.signal,
				);
				if (
					connection.baseUrl !== job.endpoint ||
					connection.version !== job.runtimeVersion
				)
					throw Error("Image runtime changed");
				await this.options.client.cancel(id, this.shutdown.signal);
				await this.apply(
					id,
					await this.options.client.read(id, this.shutdown.signal),
				);
			} catch (error) {
				this.options.store.update(id, {
					state: "cancelling",
					error: safeError(error),
				});
			}
			await this.flushNotices();
			return this.get(id);
		});
	}
	async wait(id: string, signal?: AbortSignal): Promise<ImageJob> {
		const deadline = Date.now() + WAIT_MS;
		while (!this.shutdown.signal.aborted) {
			if (signal?.aborted) return this.cancel(id);
			const job = await this.reconcile(id);
			if (
				terminalImageState(job.state) ||
				job.state === "uncertain" ||
				Date.now() >= deadline
			)
				return job;
			try {
				await delay(POLL_MS, undefined, { signal: this.signal(signal) });
			} catch {
				if (signal?.aborted) return this.cancel(id);
				break;
			}
		}
		return this.get(id);
	}
	async recover(): Promise<void> {
		for (const job of this.list()) {
			if (this.shutdown.signal.aborted) return;
			await this.reconcile(job.id);
		}
	}
	resume(): void {
		if (this.poll) return;
		this.poll = (async () => {
			while (!this.shutdown.signal.aborted) {
				try {
					await this.recover();
					this.recoveryError = null;
				} catch {
					this.recoveryError =
						"이미지 작업 복구를 완료하지 못했습니다. 저장소 상태를 확인해주세요.";
				}
				await delay(POLL_MS, undefined, { signal: this.shutdown.signal });
			}
		})().catch((error) => {
			if (!this.shutdown.signal.aborted) throw error;
		});
		// Errors remain observable via close(), without an unhandled rejection.
		void this.poll.catch(() => undefined);
	}
	async flushNotices(): Promise<void> {
		if (this.notices) return this.notices;
		this.notices = Promise.resolve().then(async () => {
			for (const job of this.list()) {
				if (!terminalImageState(job.state) || job.deliveredEntryId) continue;
				try {
					const artifact = job.artifact;
					if (artifact) this.options.attachments.get(artifact.id);
					const suffix = `?sessionId=${encodeURIComponent(this.options.store.binding.sessionId)}`;
					const text = artifact
						? `${job.sourceArtifactId ? "이미지를 수정했습니다." : "이미지를 만들었습니다."}\n\n![생성 이미지](/api/attachments/${artifact.id}/preview${suffix})\n\n[이미지 다운로드](/api/attachments/${artifact.id}${suffix})`
						: job.state === "cancelled"
							? "이미지 생성을 취소했습니다."
							: `${job.resultFilename ? "이미지는 생성됐지만 저장하지 못했습니다." : "이미지를 만들지 못했습니다."} ${job.error ?? "연결 상태를 확인해주세요."}`;
					const entry = await this.options.notify(
						{ jobId: `image_${job.id}`, terminalRevision: 1 },
						text,
					);
					if (entry)
						this.options.store.update(job.id, {
							deliveredEntryId: entry,
							deliveryError: null,
						});
				} catch {
					this.options.store.update(job.id, {
						deliveryError:
							"이미지 결과를 대화에 전달하지 못했습니다. 저장된 결과로 다시 전달합니다.",
					});
				}
			}
		});
		try {
			await this.notices;
		} finally {
			this.notices = undefined;
		}
	}
	async close(): Promise<void> {
		this.shutdown.abort();
		await Promise.allSettled([...this.active.values()]);
		await this.poll;
		await this.notices;
	}
	private signal(signal?: AbortSignal): AbortSignal {
		return signal
			? AbortSignal.any([signal, this.shutdown.signal])
			: this.shutdown.signal;
	}
	private exclusive(
		id: string,
		run: () => Promise<ImageJob>,
	): Promise<ImageJob> {
		const current = this.active.get(id);
		const promise = (
			current
				? current.then(
						() => undefined,
						() => undefined,
					)
				: Promise.resolve()
		)
			.then(run)
			.finally(() => {
				if (this.active.get(id) === promise) this.active.delete(id);
			});
		this.active.set(id, promise);
		return promise;
	}
	private async apply(
		id: string,
		result: Awaited<ReturnType<ImageClient["read"]>>,
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
			this.options.store.update(id, { resultFilename: result.result.filename });
			try {
				const output = await this.options.client.download(
					result.result,
					this.shutdown.signal,
				);
				if (!isImageMime(output.mime)) throw Error("Unsupported image format");
				const artifact = this.options.attachments.put(
					`image-${id}.${output.mime === "image/png" ? "png" : "jpg"}`,
					output.bytes,
					id,
				);
				this.options.store.update(id, {
					state: "completed",
					artifact,
					error: null,
				});
			} catch (error) {
				if (
					error instanceof AttachmentError ||
					(error instanceof Ima2Error &&
						["BODY_TOO_LARGE", "INVALID_IMAGE", "INVALID_RESULT"].includes(
							error.code,
						))
				) {
					this.options.store.update(id, {
						state: "failed",
						error: safeError(error),
					});
				} else throw error;
			}
		} else if (result.state === "failed" || result.state === "cancelled") {
			this.options.store.update(id, {
				state: result.state,
				error: result.state === "failed" ? safeError(result.error) : null,
			});
		} else {
			this.options.store.update(id, {
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
