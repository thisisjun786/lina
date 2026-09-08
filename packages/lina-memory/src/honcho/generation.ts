import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { openCheckedDatabase } from "../../../lina-core/src/session-binding.ts";
import type { SourceLookup } from "../../../lina-core/src/source-policy.ts";
import { HonchoOutbox } from "./outbox.ts";
import { generationDigest, generationOwner } from "./qualification.ts";
import type {
	BotBinding,
	GenerationOwner,
	HonchoConfig,
	HonchoIdentity,
} from "./types.ts";

/** The caller supplies its old root file. Only the canonical owner selects children. */
export function generationOutboxPath(
	rootPath: string,
	owner: GenerationOwner,
): string {
	return join(
		dirname(rootPath),
		"honcho-generations",
		generationDigest(owner),
		"honcho-outbox.sqlite",
	);
}

function holdOldOutbox(path: string, binding: BotBinding): void {
	if (!existsSync(path)) return;
	const { db } = openCheckedDatabase(path);
	let owner: {
		binding: BotBinding;
		identity: HonchoIdentity;
		ordinaryNamespace?: unknown;
	};
	try {
		const raw = db
			.prepare("SELECT value FROM meta WHERE key = 'owner'")
			.get()?.["value"];
		if (typeof raw !== "string") throw new Error("invalid old outbox owner");
		owner = JSON.parse(raw);
	} finally {
		db.close();
	}
	if (!isDeepStrictEqual(owner.binding, binding) || owner.ordinaryNamespace)
		throw new Error("foreign old outbox owner");
	// Always use the saved identity, even when the configured legacy destination changed.
	const outbox = new HonchoOutbox(path, binding, owner.identity);
	try {
		for (const part of [...outbox.next(100), ...outbox.unknown(100)])
			outbox.withhold(part.id, "legacy_unclassified");
	} finally {
		outbox.close();
	}
}

export function openGenerationOutbox(
	rootPath: string,
	binding: BotBinding,
	config: HonchoConfig,
	sourceLookup: SourceLookup,
): HonchoOutbox {
	const owner = generationOwner(binding, config);
	holdOldOutbox(rootPath, binding);
	const path = generationOutboxPath(rootPath, owner);
	return new HonchoOutbox(path, binding, owner.identity, {
		ordinaryNamespace: owner.ordinaryNamespace,
		sourceLookup,
	});
}
