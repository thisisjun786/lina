import {
	type AttachmentDraft,
	type DraftAttachment,
	MAX_DRAFT_ATTACHMENTS,
} from "./attachment-draft.ts";

// Client admission mirrors the server's current byte limit; server still validates bytes.
export const ATTACHMENT_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
export type AttachmentSource = "picker" | "paste";
type Item = {
	key: string;
	name: string;
	owner: string;
	source: AttachmentSource;
};
type LocalItem = Item & {
	file: File;
	state: "pending" | "uploading" | "error";
	error?: string;
};
export type AttachmentQueueItem =
	| LocalItem
	| (Item & { state: "ready"; ref: DraftAttachment });
type Upload = (
	file: File,
	owner: string,
	signal: AbortSignal,
) => Promise<DraftAttachment>;
type Options = {
	session: () => string | undefined;
	text: () => string;
	changed: () => void;
	notice: (message: string) => void;
	upload?: Upload;
};
type Flight = {
	item: LocalItem;
	generation: number;
	controller: AbortController;
};

/** In-memory file queue. Only ready refs enter the existing serializable draft. */
export class AttachmentQueue {
	private entries: AttachmentQueueItem[] = [];
	private active: Flight | undefined;
	private generation = 0;
	private sequence = 0;
	private owner: string | undefined;
	private online = false;
	constructor(
		private readonly draft: AttachmentDraft,
		private readonly options: Options,
	) {
		this.owner = options.session();
	}
	get items(): readonly AttachmentQueueItem[] {
		return this.entries;
	}
	get busy(): boolean {
		return this.active !== undefined;
	}
	get blocked(): boolean {
		return this.entries.some(
			(item) => item.state !== "ready" || item.owner !== this.options.session(),
		);
	}
	reset(value: string): void {
		this.generation++;
		this.cancel();
		this.owner = this.options.session();
		this.draft.value = value;
		this.entries = this.draft.refs.map((ref) => ({
			key: this.key(),
			name: ref.name,
			owner: ref.sessionId,
			source: "picker",
			state: "ready",
			ref,
		}));
		// The value setter's caller owns persistence and its update cycle.
	}
	update(online: boolean): void {
		const owner = this.options.session();
		const changedOwner = owner !== this.owner;
		const disconnected = this.online && !online;
		this.online = online;
		if (changedOwner || disconnected) {
			this.owner = owner;
			this.generation++;
			for (const item of this.entries) {
				if (
					item.state === "ready" ||
					(!changedOwner && item.state !== "uploading")
				)
					continue;
				item.state = "error";
				item.error = changedOwner
					? "대화가 바뀌었어요 · 제외 후 다시 첨부"
					: "연결이 끊겼어요 · 연결 후 재시도";
			}
			this.cancel();
		}
		this.pump();
	}
	addFiles(files: readonly File[], source: AttachmentSource): void {
		this.update(this.online);
		if (!files.length) return;
		const owner = this.owner;
		if (!owner) {
			this.options.notice("대화 연결 후 파일을 다시 첨부해 주세요.");
			return;
		}
		if (files.length + this.entries.length > MAX_DRAFT_ATTACHMENTS) {
			this.options.notice(
				`첨부 한도 초과 · 최대 4개 · 이번 ${files.length}개는 추가되지 않았어요.`,
			);
			return;
		}
		for (const input of files) {
			const file = namedFile(input);
			this.entries.push({
				key: this.key(),
				name: file.name || "이름 없는 파일",
				owner,
				source,
				state: "pending",
				file,
			});
		}
		this.pump();
		this.options.changed();
	}
	retry(key: string): void {
		this.update(this.online);
		const item = this.entries.find((item) => item.key === key);
		if (item?.state !== "error") return;
		if (item.owner !== this.owner) {
			this.options.notice(
				"다른 대화의 파일이에요 · 제외 후 다시 첨부해 주세요.",
			);
			return;
		}
		if (!this.online) {
			this.options.notice("연결 후 다시 시도해 주세요.");
			return;
		}
		item.state = "pending";
		delete item.error;
		this.pump();
		this.options.changed();
	}
	remove(key: string): void {
		const item = this.entries.find((item) => item.key === key);
		if (!item) return;
		this.entries = this.entries.filter((item) => item.key !== key);
		if (item.state === "ready") this.draft.remove(item.ref.id);
		if (this.active?.item === item) this.cancel();
		this.pump();
		this.options.changed();
	}
	private key(): string {
		return `attachment-${++this.sequence}`;
	}
	private cancel(): void {
		const previous = this.active;
		this.active = undefined;
		previous?.controller.abort();
	}
	private pump(): void {
		if (this.active || !this.online) return;
		const item = this.entries.find(
			(item): item is LocalItem =>
				item.state === "pending" && item.owner === this.owner,
		);
		if (!item) return;
		item.state = "uploading";
		const flight = {
			item,
			generation: this.generation,
			controller: new AbortController(),
		};
		this.active = flight;
		void this.upload(flight);
	}
	private current(flight: Flight): boolean {
		return (
			this.active === flight &&
			this.generation === flight.generation &&
			this.options.session() === flight.item.owner
		);
	}
	private async upload(flight: Flight): Promise<void> {
		const { item } = flight;
		try {
			if (item.file.size > ATTACHMENT_UPLOAD_MAX_BYTES)
				throw Error("파일 크기 초과 · 최대 2 MiB");
			const ref = await (this.options.upload ?? uploadAttachment)(
				item.file,
				item.owner,
				flight.controller.signal,
			);
			if (!this.current(flight)) return;
			if (ref.sessionId !== item.owner)
				throw Error("첨부 결과 미확인 · 재시도 또는 제외해 주세요.");
			this.draft.text = this.options.text();
			const index = this.entries.indexOf(item);
			this.draft.add(
				ref,
				this.entries.slice(0, index).filter((item) => item.state === "ready")
					.length,
			);
			this.entries[index] = {
				key: item.key,
				name: ref.name,
				owner: item.owner,
				source: item.source,
				state: "ready",
				ref,
			};
		} catch (error) {
			if (!this.current(flight)) return;
			item.state = "error";
			item.error =
				error instanceof Error
					? error.message
					: "첨부 실패 · 재시도 또는 제외해 주세요.";
		} finally {
			if (this.active === flight) {
				this.active = undefined;
				this.update(this.online);
				this.options.changed();
			}
		}
	}
}

function namedFile(file: File): File {
	if (file.name?.trim() && !["image", "blob"].includes(file.name)) return file;
	const extension =
		file.type === "image/png"
			? "png"
			: file.type === "image/jpeg"
				? "jpg"
				: undefined;
	return extension
		? new File([file], `clipboard-${crypto.randomUUID()}.${extension}`, {
				type: file.type,
				lastModified: file.lastModified,
			})
		: file;
}

async function uploadAttachment(
	file: File,
	owner: string,
	signal: AbortSignal,
): Promise<DraftAttachment> {
	let response: Response;
	try {
		response = await fetch("/api/attachments", {
			method: "POST",
			headers: {
				"X-Lina-Session": owner,
				"X-Lina-Filename": encodeURIComponent(file.name),
				"Content-Type": "application/octet-stream",
			},
			body: file,
			signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
			redirect: "error",
		});
	} catch {
		throw Error("첨부 결과 미확인 · 연결 확인 후 재시도 또는 제외해 주세요.");
	}
	if (!response.ok) {
		if (response.status === 413) throw Error("파일 크기 초과 · 최대 2 MiB");
		if (response.status === 507)
			throw Error("첨부 저장 공간 부족 · 공간 확보 후 재시도");
		if (response.status >= 500)
			throw Error("첨부 저장소 오류 · 서버 상태 확인 후 재시도");
		throw Error(
			"첨부 실패 · 파일명·형식·이미지 크기를 확인해 주세요. PNG·JPEG·PDF·DOCX·XLSX·텍스트 지원",
		);
	}
	let meta: unknown;
	try {
		meta = await response.json();
	} catch {
		throw Error("첨부 결과 미확인 · 재시도 또는 제외해 주세요.");
	}
	if (
		typeof meta !== "object" ||
		!meta ||
		!("id" in meta) ||
		typeof meta.id !== "string" ||
		!("name" in meta) ||
		typeof meta.name !== "string"
	)
		throw Error("첨부 결과 미확인 · 재시도 또는 제외해 주세요.");
	return { id: meta.id, name: meta.name, sessionId: owner };
}
