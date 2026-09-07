import type { TimelineEntry } from "../../lina-core/src/protocol.ts";
import type { WireClient, WireServer } from "../../lina-core/src/wire.ts";
export type SearchCommand = Extract<WireClient, { type: "search" | "entry" }>;
type Pending =
	| { kind: "search"; id: string }
	| { kind: "entry"; id: string; offset: number };
/** Search is a read-only view. It never replaces the active conversation. */
export class SearchModel {
	connected = false;
	sessionId: string | undefined;
	query = "";
	rows: TimelineEntry[] = [];
	pending: Pending | undefined;
	error = "";
	selected: TimelineEntry | undefined;
	original = "";
	nextOffset: number | null = null;
	limited = false;
	private cursors = [Number.MAX_SAFE_INTEGER];
	private index = 0;
	private olderCursor: number | null = null;
	constructor(private readonly id: () => string = () => crypto.randomUUID()) {}
	connect(connected: boolean, sessionId: string | undefined): void {
		if (this.sessionId !== sessionId) {
			this.rows = [];
			this.query = "";
			this.cursors = [Number.MAX_SAFE_INTEGER];
			this.index = 0;
			this.olderCursor = null;
			this.back();
			this.error = "";
		}
		if (!connected && this.pending) this.fail();
		this.connected = connected;
		this.sessionId = sessionId;
	}
	get hasNewer(): boolean {
		return this.index > 0;
	}
	get hasOlder(): boolean {
		return this.olderCursor !== null;
	}
	search(
		query: string,
		direction: "reset" | "older" | "newer" = "reset",
	): SearchCommand | undefined {
		const text = query.trim();
		if (!this.connected || !this.sessionId || !text || text.length > 512)
			return;
		if (direction === "older" && this.olderCursor !== null) {
			this.cursors = this.cursors.slice(0, this.index + 1);
			this.cursors.push(this.olderCursor);
			this.index++;
		} else if (direction === "newer" && this.index > 0) this.index--;
		else if (direction !== "reset") return;
		else {
			this.cursors = [Number.MAX_SAFE_INTEGER];
			this.index = 0;
		}
		this.olderCursor = null;
		this.back();
		this.query = text;
		this.rows = [];
		this.error = "";
		const requestId = this.id();
		this.pending = { kind: "search", id: requestId };
		return {
			type: "search",
			sessionId: this.sessionId,
			requestId,
			query: text,
			before: this.cursors[this.index] ?? Number.MAX_SAFE_INTEGER,
		};
	}
	select(id: string): SearchCommand | undefined {
		const row = this.rows.find((r) => r.entryId === id);
		if (!this.connected || !this.sessionId || !row) return;
		this.selected = row;
		this.original = "";
		this.nextOffset = 0;
		this.limited = false;
		return this.more();
	}
	more(): SearchCommand | undefined {
		if (
			!this.connected ||
			!this.sessionId ||
			!this.selected ||
			this.pending ||
			this.nextOffset === null
		)
			return;
		this.error = "";
		const requestId = this.id();
		this.pending = { kind: "entry", id: requestId, offset: this.nextOffset };
		return {
			type: "entry",
			requestId,
			sessionId: this.sessionId,
			entryId: this.selected.entryId,
			offset: this.nextOffset,
		};
	}
	receive(frame: WireServer): void {
		if (
			frame.type === "search-error" &&
			frame.sessionId === this.sessionId &&
			frame.requestId === this.pending?.id
		) {
			this.fail();
			return;
		}
		if (
			frame.type === "search-results" &&
			frame.sessionId === this.sessionId &&
			this.pending?.kind === "search" &&
			frame.requestId === this.pending.id
		) {
			this.rows = frame.page.messages.filter(
				(r) => r.role === "user" || r.role === "assistant",
			);
			this.olderCursor = frame.page.hasEarlier ? frame.page.beforeCursor : null;
			this.pending = undefined;
		}
		if (
			frame.type === "entry-text" &&
			frame.sessionId === this.sessionId &&
			frame.entryId === this.selected?.entryId &&
			this.pending?.kind === "entry" &&
			frame.requestId === this.pending.id &&
			frame.offset === this.pending.offset
		) {
			this.original = (
				frame.offset === 0 ? frame.text : this.original + frame.text
			).slice(0, 65536);
			this.limited = this.original.length >= 65536 && frame.nextOffset !== null;
			this.nextOffset = this.limited ? null : frame.nextOffset;
			this.pending = undefined;
		}
	}
	back(): void {
		this.selected = undefined;
		this.original = "";
		this.pending = undefined;
		this.nextOffset = null;
		this.limited = false;
	}
	cancel(): void {
		this.pending = undefined;
	}
	fail(): void {
		this.pending = undefined;
		this.error = "불러오지 못했습니다. 다시 시도해주세요.";
	}
}
