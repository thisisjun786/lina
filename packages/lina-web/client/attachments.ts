import {
	AttachmentDraft,
	attachmentHref,
	type DraftAttachment,
} from "./attachment-draft.ts";
import { element, setText } from "./render.ts";
export function createAttachments(
	input: HTMLTextAreaElement,
	session: () => string | undefined,
	changed: () => void,
	notice: (text: string) => void,
) {
	const draft = new AttachmentDraft();
	const list = element("draft-files", HTMLDivElement);
	const picker = element("file-picker", HTMLInputElement),
		button = element("attach-file", HTMLButtonElement);
	let uploading = false,
		connected = false,
		signature = "";
	const render = () => {
		const next = JSON.stringify([session(), draft.refs]);
		if (signature !== next) {
			signature = next;
			list.replaceChildren();
			list.hidden = !draft.refs.length;
			for (const ref of draft.refs) {
				const row = fileChip(ref, session());
				const remove = document.createElement("button");
				remove.type = "button";
				remove.textContent = "×";
				remove.setAttribute("aria-label", `${ref.name} 첨부 제외`);
				remove.addEventListener("click", () => {
					draft.remove(ref.id);
					render();
					changed();
				});
				row.append(remove);
				list.append(row);
			}
		}
		button.disabled = !connected || uploading || draft.refs.length >= 4;
		setText(button, uploading ? "첨부 중…" : "파일 첨부");
	};
	const port = {
		get value() {
			draft.text = input.value;
			return draft.value;
		},
		set value(text: string) {
			draft.value = text;
			input.value = draft.text;
			render();
		},
	};
	button.addEventListener("click", () => picker.click());
	picker.addEventListener("change", () => {
		const files = Array.from(picker.files ?? []);
		picker.value = "";
		if (!files.length) return;
		if (!connected || uploading) return;
		if (files.length + draft.refs.length > 4) {
			notice("첨부 한도 초과 · 최대 4개");
			return;
		}
		const owner = session();
		if (!owner) return;
		uploading = true;
		render();
		changed();
		void (async () => {
			for (const file of files) {
				try {
					if (file.size > 2097152) throw new Error("파일 크기 초과 · 최대 2MB");
					if (!connected || session() !== owner)
						throw new Error("연결 확인 후 파일 다시 선택");
					const response = await fetch("/api/attachments", {
						method: "POST",
						headers: {
							"X-Lina-Session": owner,
							"X-Lina-Filename": encodeURIComponent(file.name),
							"Content-Type": "application/octet-stream",
						},
						body: file,
						signal: AbortSignal.timeout(30000),
						redirect: "error",
					});
					if (!response.ok) {
						if (response.status === 413)
							throw new Error("파일 크기 초과 · 최대 2MB");
						if (response.status >= 500 && response.status !== 507)
							throw new Error("첨부 저장소 오류 · 서버 상태 확인 필요");
						if (response.status === 507) throw new Error("첨부 저장 공간 부족");
						throw new Error(
							"첨부 실패 · 텍스트·이미지·PDF·DOCX·XLSX 형식과 파일명 확인",
						);
					}
					const meta: unknown = await response.json();
					if (
						typeof meta !== "object" ||
						!meta ||
						!("id" in meta) ||
						typeof meta.id !== "string" ||
						!("name" in meta) ||
						typeof meta.name !== "string" ||
						session() !== owner
					)
						throw new Error("첨부 결과 미확인 · 자동 재전송 안 함");
					draft.text = input.value;
					draft.add({ id: meta.id, name: meta.name, sessionId: owner });
					render();
					changed();
				} catch (error) {
					notice(error instanceof Error ? error.message : "첨부 결과 미확인");
					break;
				}
			}
		})().finally(() => {
			uploading = false;
			render();
			changed();
		});
	});
	return {
		port,
		get busy() {
			return uploading;
		},
		update(online: boolean) {
			connected = online;
			render();
		},
	};
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
