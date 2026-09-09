import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInput } from "../src/agents/types.ts";
import { captureSourceProofs, type SourceEntry } from "../src/source-policy.ts";
export function learnedFixture() {
	const root = mkdtempSync(join(tmpdir(), "work-memory-native-learned-"));
	const entries = new Map<string, SourceEntry>();
	const lookup = (id: string) => entries.get(id);
	const episode = (requestId: string) => {
		for (const role of ["user", "assistant"] as const) {
			const entryId = `${requestId}-${role}`;
			entries.set(entryId, {
				entryId,
				role,
				text: "tea",
				requestStatus: "settled",
				sourcePolicy: {
					version: 1,
					scope: "ordinary",
					sessionId: "s",
					requestId,
					nativeEpoch: 1,
					scopeDigest: "a".repeat(64),
					policyRevision: 1,
					contextReceiptIds: [],
					materialKinds: [],
				},
			});
		}
		return {
			sourceProofs: captureSourceProofs(
				[`${requestId}-user`, `${requestId}-assistant`],
				lookup,
			),
			lookup,
		};
	};
	const revoke = (id: string) => {
		const entry = entries.get(`${id}-assistant`);
		if (!entry?.sourcePolicy) throw Error("fixture");
		entry.sourcePolicy = {
			...entry.sourcePolicy,
			scope: "mixed",
			policyRevision: entry.sourcePolicy.policyRevision + 1,
			materialKinds: ["disclosed-life"],
		};
	};
	const profile: AgentInput = {
		id: "lina",
		name: "Lina",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "authored",
		appearance: "silver eyes",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	};
	return {
		root,
		lookup,
		episode,
		revoke,
		profile,
		entries,
		source: (id: string) => ({
			entryId: `${id}-user`,
			role: "user" as const,
			text: "tea",
		}),
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}
