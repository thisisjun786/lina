import { join } from "node:path";
import type {
	BotBinding,
	EntryInput,
} from "../../../lina-core/src/protocol.ts";
import {
	readSessionBinding,
	validateBinding,
} from "../../../lina-core/src/session-binding.ts";
import type { SourceEntry } from "../../../lina-core/src/source-policy.ts";
import { DurableStore } from "../../../lina-core/src/store.ts";
import { EngineStore } from "../../../lina-memory/src/engine/store.ts";
import type {
	EngineOptions,
	EngineRecord,
} from "../../../lina-memory/src/engine/types.ts";

export type PersonaSourceOwnerInput =
	| {
			stateRoot: string;
			botId: string;
			workspace: string;
			now?: () => number;
	  }
	| {
			binding: BotBinding;
			stateRoot: string;
			now?: () => number;
	  };

export type PersonaJournalReader = Pick<
	DurableStore,
	"entry" | "sourceEntry" | "entrySequence" | "revision" | "close"
> & {
	sourceEntry(entryId: string): (EntryInput & SourceEntry) | undefined;
};

export type PersonaMindReader = Pick<
	EngineStore,
	| "agentId"
	| "state"
	| "snapshot"
	| "currentRevision"
	| "currentRecords"
	| "reasoningCandidates"
	| "sourceInvalidated"
	| "close"
> & {
	reasoningCandidates(): EngineRecord[];
};

export class PersonaSourceOwner {
	private closed = false;
	constructor(
		private readonly ownedBinding: BotBinding,
		private readonly journalStore: DurableStore,
		private readonly mindStore: EngineStore,
	) {}
	binding(): BotBinding {
		this.assertOpen();
		return { ...this.ownedBinding };
	}
	journal(): PersonaJournalReader {
		this.assertOpen();
		return this.journalStore;
	}
	mind(): PersonaMindReader {
		this.assertOpen();
		return this.mindStore;
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.mindStore.close();
		this.journalStore.close();
	}
	private assertOpen(): void {
		if (this.closed) throw new Error("persona source owner is closed");
	}
}

function expectedIdentity(input: PersonaSourceOwnerInput): {
	stateRoot: string;
	binding: BotBinding;
	now?: () => number;
} {
	if (
		typeof input.stateRoot !== "string" ||
		input.stateRoot.trim().length === 0
	)
		throw new Error("invalid persona source owner");
	if ("binding" in input) {
		const binding = validateBinding(input.binding);
		const published = readSessionBinding(input.stateRoot);
		if (
			published.botId !== binding.botId ||
			published.workspace !== binding.workspace ||
			published.sessionId !== binding.sessionId
		)
			throw new Error("foreign binding owner");
		return {
			stateRoot: input.stateRoot,
			binding,
			...(input.now ? { now: input.now } : {}),
		};
	}
	if (typeof input.botId !== "string" || typeof input.workspace !== "string")
		throw new Error("invalid persona source owner");
	const binding = readSessionBinding(input.stateRoot);
	if (binding.botId !== input.botId || binding.workspace !== input.workspace)
		throw new Error("foreign binding owner");
	return {
		stateRoot: input.stateRoot,
		binding,
		...(input.now ? { now: input.now } : {}),
	};
}

/** Read-only journal/mind owner. Does not create leases, apps, or Codex sessions. */
export function openPersonaSourceOwner(
	input: PersonaSourceOwnerInput,
	options: { now?: () => number } = {},
): PersonaSourceOwner {
	const { stateRoot, binding, now } = expectedIdentity(input);
	const clock = options.now ?? now;
	const journal = DurableStore.openReadonly(
		join(stateRoot, "state.sqlite"),
		binding,
	);
	try {
		const mindOptions: EngineOptions = {
			lookup: (id) => journal.sourceEntry(id),
			sourceSequence: (id) => journal.entrySequence(id),
		};
		if (clock) mindOptions.now = clock;
		const mind = EngineStore.openReadonly(
			join(stateRoot, "mind.sqlite"),
			binding,
			mindOptions,
		);
		return new PersonaSourceOwner(binding, journal, mind);
	} catch (error) {
		journal.close();
		throw error;
	}
}
