import {
	AttachmentDraft,
	attachmentHref,
	type DraftAttachment,
	MAX_DRAFT_ATTACHMENTS,
} from "../../lina-client/src/attachment-draft.ts";
import {
	ATTACHMENT_UPLOAD_MAX_BYTES,
	AttachmentQueue,
	type AttachmentQueueItem,
	type AttachmentSource,
} from "../../lina-client/src/attachment-queue.ts";
import { installClipboardAttachments } from "./clipboard-attachments.ts";
import { element } from "./render.ts";

export function createAttachments(
	input: HTMLTextAreaElement,
	session: () => string | undefined,
	changed: () => void,
	notice: (text: string) => void,
) {
	const draft = new AttachmentDraft();
	const list = element("draft-files", HTMLDivElement);
	const picker = element("file-picker", HTMLInputElement);
	const button = element("attach-file", HTMLButtonElement);
	let connected = false,
		signature = "";
	const queue = new AttachmentQueue(draft, {
		session,
		text: () => input.value,
		notice,
		changed: () => {
			render();
			changed();
		},
	});
	list.setAttribute("aria-label", "첨부 파일");
	list.setAttribute("aria-live", "polite");
	const render = () => {
		const next = JSON.stringify([session(), connected, queue.items]);
		if (signature !== next) {
			signature = next;
			list.replaceChildren();
			list.hidden = queue.items.length === 0;
			for (const item of queue.items) {
				const row =
					item.state === "ready"
						? fileChip(item.ref, session())
						: pendingChip(item);
				row.setAttribute("data-attachment-state", item.state);
				if (item.state === "ready" && item.owner === session()) {
					const status = document.createElement("span");
					status.className = "attachment-status";
					status.textContent = "준비됨";
					row.append(status);
					if (/\.(png|jpe?g)$/i.test(item.name)) {
						const image = document.createElement("img");
						image.src = attachmentHref(item.ref, "/preview");
						image.alt = `${item.name} 썸네일`;
						image.width = image.height = 40;
						image.addEventListener("error", () => {
							image.hidden = true;
						});
						row.append(image);
					}
				}
				if (item.state === "error") {
					const retry = document.createElement("button");
					retry.type = "button";
					retry.textContent = "재시도";
					retry.setAttribute("aria-label", `${item.name} 첨부 재시도`);
					retry.disabled = !connected || item.owner !== session();
					retry.addEventListener("click", () => {
						queue.retry(item.key);
						input.focus();
					});
					row.append(retry);
				}
				const remove = document.createElement("button");
				remove.type = "button";
				remove.textContent = "×";
				remove.setAttribute("aria-label", `${item.name} 첨부 제외`);
				remove.addEventListener("click", () => {
					queue.remove(item.key);
					input.focus();
				});
				row.append(remove);
				list.append(row);
			}
		}
		button.disabled =
			!connected || !session() || queue.items.length >= MAX_DRAFT_ATTACHMENTS;
	};
	const port = {
		get value() {
			draft.text = input.value;
			return draft.value;
		},
		set value(text: string) {
			queue.reset(text);
			input.value = draft.text;
			render();
		},
	};
	const addFiles = (
		files: readonly File[],
		source: AttachmentSource = "picker",
	) => queue.addFiles(files, source);
	const openPicker = () => picker.click();
	const picked = () => {
		const files = Array.from(picker.files ?? []);
		picker.value = "";
		addFiles(files, "picker");
	};
	button.addEventListener("click", openPicker);
	picker.addEventListener("change", picked);
	const removePaste = installClipboardAttachments(input, (files) =>
		addFiles(files, "paste"),
	);
	return {
		port,
		addFiles,
		get busy() {
			return queue.busy;
		},
		get blocked() {
			return queue.blocked;
		},
		update(online: boolean) {
			connected = online;
			queue.update(online);
			render();
		},
		dispose() {
			queue.update(false);
			removePaste();
			button.removeEventListener("click", openPicker);
			picker.removeEventListener("change", picked);
		},
	};
}

function pendingChip(
	item: Exclude<AttachmentQueueItem, { state: "ready" }>,
): HTMLElement {
	const row = document.createElement("span");
	row.className = "file-chip";
	const name = document.createElement("span");
	name.className = "attachment-name";
	name.textContent = item.name;
	name.title = item.name;
	const status = document.createElement("span");
	status.className = "attachment-status";
	status.textContent =
		item.state === "error"
			? (item.error ?? "첨부 실패")
			: item.state === "pending"
				? "대기 중"
				: "첨부 중…";
	if (item.state === "error") status.setAttribute("role", "alert");
	row.append(name, status);
	if (
		["image/png", "image/jpeg"].includes(item.file.type) &&
		item.file.size <= ATTACHMENT_UPLOAD_MAX_BYTES &&
		typeof createImageBitmap === "function"
	) {
		// Canvas keeps local thumbnails within the existing self-only image CSP.
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 40;
		canvas.setAttribute("role", "img");
		canvas.setAttribute("aria-label", `${item.name} 썸네일`);
		row.append(canvas);
		void createImageBitmap(item.file)
			.then((bitmap) => {
				try {
					if (!canvas.isConnected) return;
					const context = canvas.getContext("2d");
					const scale = Math.min(40 / bitmap.width, 40 / bitmap.height);
					context?.drawImage(
						bitmap,
						0,
						0,
						bitmap.width * scale,
						bitmap.height * scale,
					);
				} finally {
					bitmap.close();
				}
			})
			.catch(() => {
				canvas.hidden = true;
			});
	}
	return row;
}
function fileChip(
	ref: DraftAttachment,
	sessionId: string | undefined,
): HTMLElement {
	const row = document.createElement("span");
	row.className = "file-chip";
	if (ref.sessionId !== sessionId) {
		row.textContent = `${ref.name} · ${sessionId ? "다른 대화의 첨부" : "연결 후 확인"}`;
		return row;
	}
	const link = document.createElement("a");
	link.href = attachmentHref(ref);
	link.textContent = ref.name;
	link.title = ref.name;
	link.download = ref.name;
	const preview = document.createElement("button");
	preview.type = "button";
	preview.textContent = "미리보기";
	preview.addEventListener("click", () => void showPreview(ref));
	row.append(link, preview);
	return row;
}
export function renderUserBody(
	container: Element,
	text: string,
	sessionId: string | undefined,
): void {
	const draft = new AttachmentDraft();
	draft.value = text;
	container.replaceChildren(document.createTextNode(draft.text));
	if (draft.refs.length) {
		const files = document.createElement("div");
		files.className = "message-files";
		files.append(...draft.refs.map((ref) => fileChip(ref, sessionId)));
		container.append(files);
	}
}
async function showPreview(ref: DraftAttachment): Promise<void> {
	const dialog = document.createElement("dialog");
	dialog.className = "file-preview";
	dialog.setAttribute("aria-label", `${ref.name} 미리보기`);
	const title = document.createElement("strong");
	title.textContent = ref.name;
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "닫기";
	close.addEventListener("click", () => dialog.close());
	const body = document.createElement("div");
	body.textContent = "불러오는 중";
	dialog.append(title, close, body);
	document.body.append(dialog);
	dialog.addEventListener("close", () => dialog.remove(), { once: true });
	dialog.showModal();
	try {
		const response = await fetch(attachmentHref(ref, "/preview"), {
			signal: AbortSignal.timeout(10000),
			redirect: "error",
		});
		if (!response.ok) throw new Error("미리보기 실패");
		const mime = response.headers.get("Content-Type") ?? "";
		if (mime.startsWith("image/png") || mime.startsWith("image/jpeg")) {
			const image = document.createElement("img");
			image.alt = ref.name;
			// Same-origin URL, not a data/blob URL; server validates format and dimensions.
			image.src = attachmentHref(ref, "/preview");
			image.addEventListener(
				"error",
				() => {
					body.textContent = "이미지 표시 실패 · 다운로드 가능";
				},
				{ once: true },
			);
			body.replaceChildren(image);
			await response.body?.cancel();
		} else if (mime.startsWith("text/plain")) {
			const text = await response.text();
			const pre = document.createElement("pre");
			pre.textContent =
				text.slice(0, 8192) +
				(text.length > 8192 ? "\n… 전체 내용은 다운로드로 확인" : "");
			body.replaceChildren(pre);
		} else {
			await response.body?.cancel();
			throw new Error("미리보기 미지원");
		}
	} catch (error) {
		body.textContent = error instanceof Error ? error.message : "미리보기 실패";
	}
}
