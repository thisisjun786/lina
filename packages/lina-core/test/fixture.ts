import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotBinding, EntryInput } from "../src/protocol.ts";
import { DurableStore } from "../src/store.ts";

export class Fixture {
	readonly dir = mkdtempSync(join(tmpdir(), "lina-core-"));
	readonly root = join(this.dir, "state");
	readonly file = join(this.dir, "store.sqlite");
	readonly binding: BotBinding = {
		version: 1,
		botId: "lina",
		sessionId: "session-1",
		sessionFile: join(this.dir, "session.jsonl"),
		workspace: join(this.dir, "workspace"),
	};
	private readonly resources: { close(): void }[] = [];

	constructor() {
		mkdirSync(this.binding.workspace);
		writeFileSync(this.binding.sessionFile, "");
	}

	keep<T extends { close(): void }>(resource: T): T {
		this.resources.push(resource);
		return resource;
	}

	store(): DurableStore {
		return this.keep(new DurableStore(this.file, this.binding));
	}

	close(): void {
		for (const resource of this.resources.reverse()) resource.close();
		rmSync(this.dir, { recursive: true, force: true });
	}
}

export function entry(id: string, patch: Partial<EntryInput> = {}): EntryInput {
	return {
		entryId: id,
		role: "assistant",
		text: `message ${id}`,
		timestamp: "2026-09-05T10:00:00.000Z",
		raw: { id, content: [{ type: "text", text: `message ${id}` }] },
		...patch,
	};
}
