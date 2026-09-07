import type { DraftStore, PendingSend } from "../../lina-client/src/draft.ts";
import type { ServerFrame } from "../../lina-client/src/protocol.ts";
import { element } from "./render.ts";

/** Unconfirmed sends stay separate from authoritative server history. */
export class PendingRecovery {
	private sends: PendingSend[];
	private selectedId: string | undefined;
	private restoredId: string | undefined;
	private signature = "";
	private readonly container = element("pending-recovery", HTMLDetailsElement);

	constructor(
		private readonly drafts: DraftStore,
		private readonly input: Pick<HTMLTextAreaElement, "value">,
		private readonly restore: (text: string) => void,
		private readonly notice: (message: string) => void,
	) {
		this.sends = drafts.pendingSends();
		input.value = drafts.draft();
		if (!input.value && this.sends[0]) {
			input.value = this.sends[0].text;
			this.restoredId = this.sends[0].id;
		}
		const restored = this.sends.find((send) => send.text === input.value);
		if (restored) {
			this.restoredId = restored.id;
			this.selectedId = restored.id;
		}
		this.render();
	}

	edited(): void {
		this.restoredId = undefined;
	}
	prepare(text: string, sessionId: string): PendingSend | undefined {
		const same = this.sends.filter(
			(send) => send.text === text && send.sessionId === sessionId,
		);
		const previous =
			same.find((send) => send.id === this.selectedId) ?? same[0];
		if (previous) return previous;
		if (this.sends.length >= 20) {
			this.notice("복구 목록 한도 초과 · 이전 메시지 확인 필요");
			return;
		}
		return { id: crypto.randomUUID(), text, sessionId };
	}
	sent(send: PendingSend): void {
		if (!this.sends.some((item) => item.id === send.id)) this.sends.push(send);
		this.drafts.savePending(send);
		this.restoredId = undefined;
		this.render();
	}

	receive(frame: ServerFrame, sessionId: string | undefined): void {
		const confirmed = this.sends.filter(
			(send) =>
				send.sessionId === sessionId &&
				((frame.type === "ack" && frame.id === send.id) ||
					(frame.type === "snapshot" &&
						frame.snapshot.requests.some((request) => request.id === send.id))),
		);
		for (const send of confirmed) {
			if (this.restoredId === send.id && this.input.value === send.text) {
				this.input.value = "";
				this.drafts.saveDraft("");
				this.restoredId = undefined;
			}
			this.remove(send.id);
		}
		if (frame.type === "snapshot" && this.sends.length) {
			const send =
				this.sends.find((item) => item.sessionId === sessionId) ??
				this.sends[0];
			if (send && !this.input.value) this.restoreEmpty(send);
			this.notice(
				send && this.input.value === send.text
					? send.sessionId === sessionId
						? "전송 미확인 메시지 복원됨"
						: "다른 대화에서 복원됨 · 전송 전 확인"
					: "전송 미확인 메시지 있음",
			);
		}
		this.render();
	}

	disconnected(): void {
		const send = this.sends[0];
		if (send && !this.input.value) this.restoreEmpty(send);
		this.render();
	}
	private restoreEmpty(send: PendingSend): void {
		this.input.value = send.text;
		this.restoredId = send.id;
		this.selectedId = send.id;
		this.drafts.saveDraft(send.text);
	}
	private remove(id: string): void {
		this.sends = this.sends.filter((send) => send.id !== id);
		this.drafts.clearPending(id);
	}
	private render(): void {
		this.container.hidden = this.sends.length === 0;
		const signature = this.sends.map((send) => send.id).join("\n");
		if (signature === this.signature) return;
		this.signature = signature;
		const summary = document.createElement("summary");
		summary.textContent = `미확인 메시지 복구 (${this.sends.length})`;
		this.container.replaceChildren(summary);
		for (const send of this.sends) {
			const row = document.createElement("div");
			row.className = "pending-item";
			const preview = document.createElement("p");
			preview.textContent = send.text.slice(0, 256);
			const restore = document.createElement("button");
			restore.type = "button";
			restore.textContent = "복원";
			restore.addEventListener("click", () => {
				this.restore(send.text);
				this.selectedId = send.id;
				this.restoredId = send.id;
			});
			const dismiss = document.createElement("button");
			dismiss.type = "button";
			dismiss.textContent = "목록에서 제외";
			dismiss.addEventListener("click", () => {
				this.remove(send.id);
				this.render();
			});
			row.append(preview, restore, dismiss);
			this.container.append(row);
		}
	}
}
