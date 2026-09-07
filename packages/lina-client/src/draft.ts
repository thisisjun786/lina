export type PendingSend = { id: string; text: string; sessionId: string };
type StoragePort = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};
const DRAFT = "lina.draft.v1",
	PENDING = "lina.pending.v1";

function decodePending(value: unknown): PendingSend | undefined {
	if (
		typeof value !== "object" ||
		!value ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!value.id ||
		value.id.length > 128 ||
		!("sessionId" in value) ||
		typeof value.sessionId !== "string" ||
		!value.sessionId ||
		value.sessionId.length > 128 ||
		!("text" in value) ||
		typeof value.text !== "string" ||
		!value.text.trim() ||
		value.text.length > 16000
	)
		return;
	return { id: value.id, text: value.text, sessionId: value.sessionId };
}

/** Browser storage is an optional recovery aid; it never sends requests. */
export class DraftStore {
	constructor(
		private readonly storage: StoragePort | undefined,
		private readonly agentId = "lina",
	) {}
	private get draftKey() {
		return this.agentId === "lina" ? DRAFT : `${DRAFT}.${this.agentId}`;
	}
	private get pendingKey() {
		return this.agentId === "lina" ? PENDING : `${PENDING}.${this.agentId}`;
	}
	draft(): string {
		try {
			return (this.storage?.getItem(this.draftKey) ?? "").slice(0, 65536);
		} catch {
			return "";
		}
	}
	saveDraft(text: string): boolean {
		try {
			this.storage?.setItem(this.draftKey, text.slice(0, 65536));
			return (
				this.storage !== undefined &&
				this.storage.getItem(this.draftKey) === text
			);
		} catch {
			return false; // The input remains in the page.
		}
	}
	pending(): PendingSend | undefined {
		return this.pendingSends()[0];
	}
	pendingSends(): PendingSend[] {
		try {
			const raw = this.storage?.getItem(this.pendingKey);
			if (!raw || raw.length > 1048576) return [];
			const value: unknown = JSON.parse(raw);
			const items: unknown[] = Array.isArray(value) ? value : [value];
			if (items.length > 20) return [];
			return items.flatMap((item) => {
				const send = decodePending(item);
				return send ? [send] : [];
			});
		} catch {
			return [];
		}
	}
	savePending(pending: PendingSend): boolean {
		const saved = this.pendingSends();
		const existing = saved.find((item) => item.id === pending.id);
		if (existing)
			return (
				existing.text === pending.text &&
				existing.sessionId === pending.sessionId
			);
		if (saved.length >= 20) return false;
		try {
			this.storage?.setItem(
				this.pendingKey,
				JSON.stringify([...saved, pending]),
			);
			return this.storage !== undefined;
		} catch {
			return false;
		}
	}
	clearPending(id?: string): void {
		try {
			if (id === undefined) this.storage?.removeItem(this.pendingKey);
			else
				this.storage?.setItem(
					this.pendingKey,
					JSON.stringify(this.pendingSends().filter((send) => send.id !== id)),
				);
		} catch {
			/* Unconfirmed IDs remain safe for an explicit retry. */
		}
	}
}

export function browserDraftStore(
	storage: () => StoragePort,
	agentId = "lina",
): DraftStore {
	try {
		return new DraftStore(storage(), agentId);
	} catch {
		return new DraftStore(undefined, agentId);
	}
}
