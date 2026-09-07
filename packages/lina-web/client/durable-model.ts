import type {
	RequestRecord,
	SessionSnapshot,
	TimelineEntry,
} from "../../lina-core/src/protocol.ts";
import type { ServerFrame } from "../src/protocol.ts";
import { type ChatMessage, ChatModel } from "./model.ts";

type Expanded = {
	text: string;
	nextOffset: number | null;
	displayLimited: boolean;
};
const MAX_DISPLAY_ENTRIES = 500;

/** The server owns history; this bounded projection can be rebuilt on every connect. */
export class DurableChatModel extends ChatModel {
	sessionId: string | undefined;
	revision = -1;
	hasEarlier = false;
	hasNewer = false;
	beforeCursor: number | null = null;
	private readonly entries = new Map<string, TimelineEntry>();
	private readonly expanded = new Map<string, Expanded>();
	private requests: RequestRecord[] = [];
	requestStartedAt(id?: string | null): string | undefined {
		return this.requests.find((request) =>
			id ? request.id === id : request.status === "accepted",
		)?.createdAt;
	}

	override receive(frame: ServerFrame): void {
		switch (frame.type) {
			case "snapshot":
				this.restore(frame.snapshot);
				return;
			case "history":
				if (
					frame.sessionId !== this.sessionId ||
					frame.revision < this.revision ||
					frame.before !== this.beforeCursor
				)
					return;
				this.hasNewer = this.merge(frame.page.messages, true) || this.hasNewer;
				this.hasEarlier = frame.page.hasEarlier;
				this.beforeCursor = this.firstCursor();
				this.project();
				return;
			case "live-text":
				// Untagged text may precede a tool call. Wait for the committed human reply.
				return;
			case "entry-text": {
				if (frame.requestId !== undefined) return;
				if (
					frame.sessionId !== this.sessionId ||
					!this.entries.has(frame.entryId)
				)
					return;
				const previous = this.expanded.get(frame.entryId)?.text ?? "";
				if (frame.offset !== 0 && frame.offset !== previous.length) return;
				const text = (frame.offset === 0 ? "" : previous) + frame.text;
				this.expanded.set(frame.entryId, {
					text: text.slice(0, 65536),
					nextOffset: text.length >= 65536 ? null : frame.nextOffset,
					displayLimited: text.length >= 65536 && frame.nextOffset !== null,
				});
				this.project();
				return;
			}
			default:
				if (
					this.sessionId &&
					(frame.type === "agent-text" || frame.type === "agent-status")
				)
					return;
				super.receive(frame);
		}
	}

	private restore(snapshot: SessionSnapshot): void {
		if (
			this.sessionId === snapshot.sessionId &&
			snapshot.revision < this.revision
		)
			return;
		if (this.sessionId !== snapshot.sessionId) {
			this.entries.clear();
			this.expanded.clear();
			this.beforeCursor = null;
		}
		if (
			this.entries.size &&
			snapshot.messages.length &&
			!snapshot.messages.some((entry) => this.entries.has(entry.entryId))
		) {
			this.entries.clear();
			this.expanded.clear();
			this.beforeCursor = null;
		}
		this.sessionId = snapshot.sessionId;
		this.revision = snapshot.revision;
		this.connected = true;
		this.running = snapshot.state === "running";
		this.requests = snapshot.requests;
		if (
			this.pendingId &&
			snapshot.requests.some((request) => request.id === this.pendingId)
		)
			this.pendingId = undefined;
		const hadEarlier =
			this.beforeCursor !== null &&
			snapshot.beforeCursor !== null &&
			this.beforeCursor < snapshot.beforeCursor;
		const removedEarlier = this.merge(snapshot.messages, false);
		this.hasEarlier =
			removedEarlier || (hadEarlier ? this.hasEarlier : snapshot.hasEarlier);
		this.beforeCursor = this.firstCursor();
		this.hasNewer = false;
		this.project();
	}

	showLatest(): void {
		this.entries.clear();
		this.expanded.clear();
		this.beforeCursor = null;
		this.hasNewer = false;
	}
	private firstCursor(): number | null {
		return this.entries.size
			? Math.min(...[...this.entries.values()].map((entry) => entry.seq))
			: null;
	}
	private merge(entries: TimelineEntry[], older: boolean): boolean {
		for (const entry of entries) this.entries.set(entry.entryId, entry);
		const sorted = [...this.entries.values()].sort((a, b) => a.seq - b.seq);
		const keep = new Set(
			(older
				? sorted.slice(0, MAX_DISPLAY_ENTRIES)
				: sorted.slice(-MAX_DISPLAY_ENTRIES)
			).map((entry) => entry.entryId),
		);
		for (const key of this.entries.keys())
			if (!keep.has(key)) {
				this.entries.delete(key);
				this.expanded.delete(key);
			}
		return sorted.length > MAX_DISPLAY_ENTRIES;
	}

	private project(): void {
		const messages: ChatMessage[] = [];
		for (const entry of [...this.entries.values()].sort(
			(a, b) => a.seq - b.seq,
		)) {
			if (
				entry.role === "meta" ||
				entry.role === "tool" ||
				(entry.role === "assistant" && !entry.text)
			)
				continue;
			const request = this.requests.find(
				(item) => item.entryId === entry.entryId,
			);
			const expanded = this.expanded.get(entry.entryId);
			messages.push({
				id: `entry:${entry.entryId}`,
				sourceId: entry.entryId,
				role: entry.role,
				text:
					(expanded?.text ?? entry.text) +
					(expanded?.displayLimited
						? "\n\n화면 표시 한도에 도달했습니다. 원문은 서버에 보존되어 있습니다."
						: ""),
				status:
					request?.status === "interrupted" || request?.status === "rejected"
						? request.status
						: entry.role === "user"
							? "saved"
							: "complete",
				...(expanded
					? { nextOffset: expanded.nextOffset }
					: entry.truncated
						? { nextOffset: 0 }
						: {}),
				...(entry.tool ? { tool: entry.tool } : {}),
			});
		}
		for (const request of [...this.requests].reverse()) {
			if (request.entryId || request.status === "settled") continue;
			messages.push({
				id: `request:${request.id}`,
				role: "user",
				text: request.text,
				status:
					request.status === "rejected" || request.status === "interrupted"
						? request.status
						: "requested",
			});
		}
		this.messages.splice(0, this.messages.length, ...messages);
	}
}
