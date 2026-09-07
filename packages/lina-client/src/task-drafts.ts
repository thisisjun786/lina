export type TaskDraft = { input: string; owner?: string };
export type TaskStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};
const key = (id: string) => `lina.task-draft.v1.${id}`;
const SCOPE = "lina.task-scope.v1";

/** Device state only; failed writes keep the live draft and block destructive departure. */
export class TaskDraftStore {
	private readonly cache = new Map<string, TaskDraft | undefined>();
	private readonly dirty = new Set<string>();
	private readonly stored = new Set<string>();
	private selectedScope: "selected" | "all";
	constructor(private readonly storage?: TaskStorage) {
		try {
			this.selectedScope =
				storage?.getItem(SCOPE) === "all" ? "all" : "selected";
		} catch {
			this.selectedScope = "selected";
		}
	}
	get(id: string): TaskDraft | undefined {
		if (this.cache.has(id)) return this.cache.get(id);
		let draft: TaskDraft | undefined;
		try {
			const raw = this.storage?.getItem(key(id));
			const value: unknown =
				raw && raw.length <= 262144 ? JSON.parse(raw) : null;
			if (
				value &&
				typeof value === "object" &&
				"input" in value &&
				typeof value.input === "string" &&
				value.input.length <= 65536
			) {
				const owner = "owner" in value ? value.owner : undefined;
				if (
					owner === undefined ||
					(typeof owner === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(owner))
				)
					draft = { input: value.input, ...(owner ? { owner } : {}) };
			}
		} catch {
			/* Untrusted optional device state cannot replace validated server data. */
		}
		if (draft) this.stored.add(id);
		this.cache.set(id, draft);
		return draft;
	}
	set(id: string, draft: TaskDraft): boolean {
		this.get(id);
		if (!draft.input && !draft.owner) return this.delete(id);
		this.cache.set(id, { ...draft });
		this.dirty.add(id);
		return this.persist(id);
	}
	delete(id: string): boolean {
		if (!this.get(id) && !this.dirty.has(id)) return true;
		this.cache.set(id, undefined);
		if (!this.stored.has(id)) {
			this.dirty.delete(id);
			return true;
		}
		this.dirty.add(id);
		return this.persist(id);
	}
	private persist(id: string): boolean {
		if (!this.storage) return false;
		try {
			const draft = this.cache.get(id);
			if (draft) this.storage.setItem(key(id), JSON.stringify(draft));
			else this.storage.removeItem(key(id));
			if (draft) this.stored.add(id);
			else this.stored.delete(id);
			this.dirty.delete(id);
			return true;
		} catch {
			return false;
		}
	}
	flush(): boolean {
		for (const id of this.dirty) this.persist(id);
		return this.dirty.size === 0;
	}
	scope(): "selected" | "all" {
		return this.selectedScope;
	}
	setScope(scope: "selected" | "all"): void {
		this.selectedScope = scope;
		try {
			this.storage?.setItem(SCOPE, scope);
		} catch {
			/* The selected filter remains in memory. */
		}
	}
}
