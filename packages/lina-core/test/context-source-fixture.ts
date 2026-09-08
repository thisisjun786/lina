import type { EntryInput, RequestStatus } from "../src/protocol.ts";
import type { SourceEntry, SourcePolicy } from "../src/source-policy.ts";
import { entry, Fixture } from "./fixture.ts";

/** Synthetic trusted journal boundary; content/raw never supplies these fields. */
export class ContextSourceFixture extends Fixture {
	readonly journal = this.store();
	readonly policies = new Map<string, SourcePolicy>();
	readonly statuses = new Map<string, RequestStatus>();
	readonly users = new Map<string, string>();
	add(
		id: string,
		text = id,
		status: RequestStatus = "settled",
		scope: SourcePolicy["scope"] = "ordinary",
	) {
		this.journal.appendEntry(entry(id, { text, role: "user" }));
		this.policies.set(id, {
			version: 1,
			scope,
			sessionId: this.binding.sessionId,
			requestId: `request-${id}`,
			nativeEpoch: 1,
			scopeDigest: "a".repeat(64),
			policyRevision: 1,
			contextReceiptIds: [],
			materialKinds: [],
		});
		this.statuses.set(id, status);
		this.users.set(`request-${id}`, id);
		return id;
	}
	lookup = (id: string): (EntryInput & SourceEntry) | undefined => {
		const original = this.journal.entry(id);
		return (
			original && {
				...original,
				sourcePolicy: this.policies.get(id),
				requestStatus: this.statuses.get(id),
			}
		);
	};
	lookupRequest = (id: string) => this.lookup(this.users.get(id) ?? "");
	extend(id: string, scope: SourcePolicy["scope"] = "ordinary") {
		const current = this.policies.get(id);
		if (!current) throw Error("missing fixture source");
		this.policies.set(id, {
			...current,
			scope,
			policyRevision: current.policyRevision + 1,
			contextReceiptIds: [
				...current.contextReceiptIds,
				`receipt-${current.policyRevision}`,
			],
			materialKinds: scope === "mixed" ? ["disclosed-life"] : ["shared-growth"],
		});
	}
}
