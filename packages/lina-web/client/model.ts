import type { ToolMetadata } from "../../lina-core/src/protocol.ts";
import { MAX_CHAT_LENGTH, type ServerFrame } from "../src/protocol.ts";

export type MessageStatus =
	| "pending"
	| "requested"
	| "unconfirmed"
	| "streaming"
	| "complete"
	| "partial"
	| "saved"
	| "interrupted"
	| "rejected";
export type ChatMessage = {
	readonly id: string;
	readonly role: "user" | "assistant" | "tool";
	text: string;
	status: MessageStatus;
	sourceId?: string;
	nextOffset?: number | null;
	/** Persisted tool result metadata; absent on legacy rows, which render generically. */
	tool?: ToolMetadata;
};
export type Activity = { readonly text: string; readonly time: Date };

export class ChatModel {
	connected = false;
	running = false;
	pendingId: string | undefined;
	readonly messages: ChatMessage[] = [];
	readonly activity: Activity[] = [];
	private active: ChatMessage | undefined;
	private sequence = 0;

	send(id: string, text: string): boolean {
		if (
			!this.connected ||
			this.pendingId !== undefined ||
			text.trim().length === 0 ||
			text.length > MAX_CHAT_LENGTH
		)
			return false;
		this.messages.push({ id, role: "user", text, status: "pending" });
		this.pendingId = id;
		this.note("전송 요청 확인 중");
		return true;
	}

	receive(frame: ServerFrame): void {
		switch (frame.type) {
			case "ack": {
				if (frame.id !== this.pendingId) return;
				const message = this.messages.find((entry) => entry.id === frame.id);
				if (message !== undefined) message.status = "requested";
				this.pendingId = undefined;
				this.note("전송 요청 확인");
				break;
			}
			case "agent-status": {
				if (!this.connected) this.note("연결됨");
				const changed = this.running !== (frame.state === "running");
				this.connected = true;
				this.running = frame.state === "running";
				if (!this.running && this.active !== undefined) {
					this.active.status = "complete";
					this.active = undefined;
				}
				if (changed) this.note(this.running ? "작업 시작" : "응답 완료");
				break;
			}
			case "agent-text": {
				if (!this.connected || frame.text.length === 0) return;
				if (this.active === undefined) {
					this.sequence += 1;
					this.active = {
						id: `assistant-${this.sequence}`,
						role: "assistant",
						text: "",
						status: "streaming",
					};
					this.messages.push(this.active);
				}
				this.active.text += `${this.active.text.length > 0 ? "\n\n" : ""}${frame.text}`;
				break;
			}
			case "agent-thinking":
				this.note("응답 준비 중");
				break;
			case "error":
				this.note("요청 실패");
				break;
		}
	}

	disconnect(): void {
		if (this.connected) this.note("연결 끊김");
		this.connected = false;
		this.running = false;
		if (this.active !== undefined) this.active.status = "partial";
		this.active = undefined;
		const pending = this.messages.find((entry) => entry.id === this.pendingId);
		if (pending !== undefined) pending.status = "unconfirmed";
		this.pendingId = undefined;
	}

	note(text: string): void {
		if (this.activity[0]?.text === text) return;
		this.activity.unshift({ text, time: new Date() });
		this.activity.splice(8);
	}
}
