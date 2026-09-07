import type { AgentProfile } from "../../lina-core/src/agents/types.ts";
import type {
	SessionSnapshot,
	TimelineEntry,
} from "../../lina-core/src/protocol.ts";
import { AttachmentDraft } from "./attachment-draft.ts";

export type AgentListProfile = Pick<
	AgentProfile,
	"id" | "name" | "role" | "avatarId"
>;
export type PublicListMessage = Pick<
	TimelineEntry,
	"entryId" | "seq" | "text" | "timestamp"
> & { role: "user" | "assistant" };
export interface AgentConversationSummary {
	agentId: string;
	available: boolean;
	sessionId: string | null;
	revision: number;
	latestMessage: PublicListMessage | null;
	confirmationCount: number | null;
	running: boolean | null;
}
type Cursor = { sessionId: string; seq: number };
type CursorStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};
const cursorKey = (id: string) => `lina.seen.v1.${id}`;

export function publicMessagePreview(message: {
	role: "user" | "assistant";
	text: string;
}): string {
	const attachment = new AttachmentDraft();
	attachment.value = message.text;
	const text = attachment.text.trim();
	const preview = /^```|^~~~/.test(text)
		? "코드 답변"
		: text || attachment.refs.map((ref) => ref.name).join(", ");
	return `${message.role === "user" ? "나: " : ""}${preview.replace(/\s+/g, " ").slice(0, 160)}`;
}

/** Input must be the public snapshot, never an engine transcript. */
export function summaryFromSnapshot(
	snapshot: SessionSnapshot,
	confirmationCount: number | null = null,
): AgentConversationSummary {
	let latestMessage: PublicListMessage | null = null;
	for (const entry of snapshot.messages) {
		if (
			(entry.role === "user" || entry.role === "assistant") &&
			(!latestMessage || entry.seq > latestMessage.seq)
		) {
			latestMessage = {
				entryId: entry.entryId,
				seq: entry.seq,
				role: entry.role,
				text: entry.text,
				timestamp: entry.timestamp,
			};
		}
	}
	return {
		agentId: snapshot.botId,
		available: true,
		sessionId: snapshot.sessionId,
		revision: snapshot.revision,
		latestMessage,
		confirmationCount,
		running: snapshot.state === "running",
	};
}

/** Shared projection: server order, public summaries, device drafts and observed cursors. */
export class AgentListModel {
	private profiles: AgentListProfile[] = [];
	private readonly summaries = new Map<string, AgentConversationSummary>();
	private readonly unavailable = new Set<string>();
	private readonly drafts = new Map<string, string>();
	private readonly seen = new Map<string, Cursor>();
	private filter = "";
	status: "loading" | "ready" | "error" = "loading";
	constructor(
		private currentId: string,
		private readonly storage?: CursorStorage,
	) {}

	replace(profiles: AgentListProfile[]): void {
		this.profiles = profiles;
		this.status = "ready";
		const ids = new Set(profiles.map((profile) => profile.id));
		for (const id of this.summaries.keys())
			if (!ids.has(id)) this.summaries.delete(id);
		for (const profile of profiles) {
			if (this.seen.has(profile.id)) continue;
			try {
				const value: unknown = JSON.parse(
					this.storage?.getItem(cursorKey(profile.id)) ?? "null",
				);
				if (
					value &&
					typeof value === "object" &&
					"sessionId" in value &&
					typeof value.sessionId === "string" &&
					"seq" in value &&
					typeof value.seq === "number" &&
					Number.isSafeInteger(value.seq) &&
					value.seq >= 0
				)
					this.seen.set(profile.id, {
						sessionId: value.sessionId,
						seq: value.seq,
					});
			} catch {
				/* Storage is optional; unknown history is never marked unread. */
			}
		}
	}
	summary(id: string): AgentConversationSummary | undefined {
		return this.summaries.get(id);
	}
	setCurrent(id: string): void {
		this.currentId = id;
	}
	setFilter(value: string): void {
		this.filter = value.trim().toLocaleLowerCase();
	}
	setDraft(id: string, value: string): void {
		this.drafts.set(id, value);
	}
	fail(): void {
		this.status = "error";
	}
	summariesFailed(): void {
		for (const profile of this.profiles) this.unavailable.add(profile.id);
	}
	updateSummary(summary: AgentConversationSummary): void {
		if (!summary.available) {
			this.unavailable.add(summary.agentId);
			return;
		}
		const previous = this.summaries.get(summary.agentId);
		if (
			previous?.sessionId === summary.sessionId &&
			previous.revision > summary.revision
		)
			return;
		this.summaries.set(summary.agentId, summary);
		this.unavailable.delete(summary.agentId);
	}
	/** Call only for messages actually visible in the foreground conversation. */
	markVisible(agentId: string, sessionId: string, seq: number): void {
		const summary = this.summaries.get(agentId);
		if (
			!summary ||
			summary.sessionId !== sessionId ||
			!Number.isSafeInteger(seq) ||
			seq < 0 ||
			seq > (summary.latestMessage?.seq ?? 0)
		)
			return;
		const previous = this.seen.get(agentId);
		const cursor = {
			sessionId,
			seq:
				previous?.sessionId === sessionId ? Math.max(seq, previous.seq) : seq,
		};
		this.seen.set(agentId, cursor);
		try {
			this.storage?.setItem(cursorKey(agentId), JSON.stringify(cursor));
		} catch {
			/* Keep the cursor in memory. */
		}
	}
	rows() {
		return this.profiles
			.filter((profile) =>
				`${profile.name} ${profile.role}`
					.toLocaleLowerCase()
					.includes(this.filter),
			)
			.map((profile) => {
				const summary = this.summaries.get(profile.id);
				const message = summary?.latestMessage;
				const draft = this.drafts.get(profile.id)?.trim();
				const cursor = this.seen.get(profile.id);
				const confirmationCount = summary?.confirmationCount ?? null;
				const summaryUnavailable = this.unavailable.has(profile.id);
				const preview =
					confirmationCount && confirmationCount > 0
						? `확인 필요 · ${confirmationCount}건`
						: draft
							? `초안: ${publicMessagePreview({ role: "assistant", text: draft })}`
							: message
								? publicMessagePreview(message)
								: summaryUnavailable
									? "대화 요약을 불러오지 못했어요"
									: summary
										? "대화를 시작해보세요"
										: "대화 요약을 불러오는 중…";
				return {
					...profile,
					selected: profile.id === this.currentId,
					preview,
					timestamp: message?.timestamp ?? null,
					sessionId: summary?.sessionId ?? null,
					messageSequence: message?.seq ?? null,
					confirmationCount,
					summaryUnavailable,
					running: summary?.running === true,
					unread: Boolean(
						message?.role === "assistant" &&
							cursor?.sessionId === summary?.sessionId &&
							message &&
							cursor &&
							message.seq > cursor.seq,
					),
				};
			});
	}
}
export type AgentListRow = ReturnType<AgentListModel["rows"]>[number];
