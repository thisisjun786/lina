import { isDeepStrictEqual } from "node:util";
import {
	parseSourceExposure,
	parseSourceOrigin,
	type SourceExposure,
	type SourceRequestOrigin,
} from "../../lina-core/src/source-policy-origin.ts";
import type { SessionSourceSink } from "../../lina-runtime/src/host.ts";
import { projectNativeEntry } from "../../lina-runtime/src/sdk-events.ts";
import type { SourceEntryAssociation } from "../../lina-runtime/src/sdk-port.ts";
import type { ProjectedEntry } from "./events.ts";
import {
	appendCodexJournal,
	type CodexNativeBinding,
	loadCodexJournal,
	readCodexContextBindings,
	readCodexSessionHeader,
} from "./identity.ts";

type Run = {
	requestId: string;
	nativeEpoch: number;
	threadId: string;
	turnId: string | null;
	status: string;
};
type Replay = (sink: SessionSourceSink) => void;
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): never {
	throw Error("Invalid managed source provenance");
}
const turnKey = (epoch: number, turnId: string) =>
	JSON.stringify([epoch, turnId]);

/** Correlation only: context_run/exposure remain the sole native lifecycle journal. */
export class CodexSourceProvenance {
	private readonly origins = new Map<string, SourceRequestOrigin>();
	private readonly receipts = new Map<string, SourceExposure>();
	private readonly turns = new Map<string, string>();
	private readonly runs = new Map<string, Run>();
	private readonly entries = new Map<string, ProjectedEntry>();
	private readonly associations = new Map<string, SourceEntryAssociation>();
	private readonly sessionId: string;
	private readonly bindings: Map<number, CodexNativeBinding>;

	constructor(
		private readonly file: string,
		private readonly workspace: string,
		private readonly sink: SessionSourceSink | undefined,
		private readonly reconciled: (entry: ProjectedEntry) => void,
	) {
		this.sessionId = readCodexSessionHeader(file, workspace).id;
		const bindings = new Map(
			readCodexContextBindings(file, workspace).map((b) => [b.nativeEpoch, b]),
		);
		this.bindings = bindings;
		const replay: Replay[] = [];
		const rows = loadCodexJournal(file);
		const managedIds = new Set(
			rows.flatMap((row) =>
				object(row) && row["type"] === "source_begin"
					? [parseSourceOrigin(row["origin"]).requestId]
					: [],
			),
		);
		// Validate the complete owned stream before any consumer sees recovered proof.
		for (const row of rows) {
			if (!object(row)) continue;
			if (row["type"] === "context_exposure") {
				const receipt = parseSourceExposure(row);
				this.receipts.set(receipt.id, receipt);
				if (
					receipt.source.kind === "bootstrap" ||
					managedIds.has(receipt.source.requestId)
				) {
					replay.push((s) => s.recordSourceExposure(receipt));
					if (receipt.outcome === "planned" && this.exposedRequest(receipt))
						replay.push((s) =>
							s.extendRequestSource(receipt.source.requestId, [receipt.id]),
						);
				}
			} else if (row["type"] === "source_begin") {
				if (Object.keys(row).length !== 3 || row["version"] !== 1) invalid();
				const origin = parseSourceOrigin(row["origin"]);
				const binding = bindings.get(origin.nativeEpoch);
				if (
					!binding?.nativeThreadId ||
					binding.contextPolicy?.purpose !== origin.purpose ||
					binding.contextPolicy.scopeDigest !== origin.scopeDigest
				)
					invalid();
				this.acceptOrigin(origin);
				replay.push((s) => s.registerRequestSource(origin));
			} else if (row["type"] === "context_run") {
				// The context owner validates exact shape, binding and lifecycle first.
				this.acceptRun(row as unknown as Run);
			} else if (
				row["type"] === "message" ||
				row["type"] === "custom_message"
			) {
				const entry = projectNativeEntry(row);
				if (!entry) invalid();
				const prior = this.entries.get(entry.entryId);
				if (prior && !isDeepStrictEqual(prior, row)) invalid();
				this.entries.set(entry.entryId, row as unknown as ProjectedEntry);
			} else if (row["type"] === "source_entry") {
				if (Object.keys(row).length !== 8) invalid();
				const { type: _type, ...proof } = row;
				const association = this.validateAssociation(proof);
				const previous = this.associations.get(association.entryId);
				if (previous && !isDeepStrictEqual(previous, association)) invalid();
				this.associations.set(association.entryId, association);
				const entry = projectNativeEntry(this.entries.get(association.entryId));
				if (!entry) invalid();
				replay.push((s) => s.appendSourceEntry(entry, association.requestId));
			} else if (
				typeof row["type"] === "string" &&
				row["type"].startsWith("source_")
			)
				invalid();
		}
		if (sink) {
			for (const write of replay) write(sink);
			// A crash can leave the entry or exact turn map durable before association.
			for (const entry of this.entries.values()) this.associate(entry);
		}
	}

	begin(origin: SourceRequestOrigin): void {
		if (!this.sink) return;
		const parsed = parseSourceOrigin(origin);
		const header = readCodexSessionHeader(this.file, this.workspace);
		if (
			header.nativeEpoch !== parsed.nativeEpoch ||
			!header.nativeThreadId ||
			header.contextTransition ||
			header.contextPolicy?.scopeDigest !== parsed.scopeDigest ||
			header.contextPolicy.purpose !== parsed.purpose
		)
			invalid();
		this.bindings.set(parsed.nativeEpoch, {
			nativeEpoch: parsed.nativeEpoch,
			nativeThreadId: header.nativeThreadId,
			contextPolicy: header.contextPolicy,
		});
		this.acceptOrigin(parsed);
		appendCodexJournal(this.file, {
			type: "source_begin",
			version: 1,
			origin: parsed,
		});
		this.sink.registerRequestSource(parsed);
	}
	exposure(receipt: SourceExposure): void {
		this.receipts.set(receipt.id, receipt);
		if (!this.sink) return;
		if (
			receipt.source.kind !== "bootstrap" &&
			!this.origins.has(receipt.source.requestId)
		)
			return;
		this.sink.recordSourceExposure(receipt);
		if (receipt.outcome === "planned" && this.exposedRequest(receipt))
			this.sink.extendRequestSource(receipt.source.requestId, [receipt.id]);
	}
	run(run: Run): void {
		this.acceptRun(run);
		if (!this.sink || !run.turnId || run.status !== "active") return;
		for (const entry of this.entries.values()) {
			if (
				entry.codex?.nativeEpoch === run.nativeEpoch &&
				entry.codex.turnId === run.turnId &&
				this.associate(entry)
			)
				this.reconciled(entry);
		}
	}
	entry(entry: ProjectedEntry): void {
		this.entries.set(entry.id, entry);
		this.associate(entry);
	}
	policy(entryId: string): SourceEntryAssociation | undefined {
		return this.sink ? this.associations.get(entryId) : undefined;
	}
	request(epoch: number, turnId: string): string | undefined {
		return this.turns.get(turnKey(epoch, turnId));
	}
	managed(requestId: string | undefined): boolean {
		return requestId !== undefined && this.origins.has(requestId);
	}
	/** Any native turn lacking an owned begin/map requires a clean managed epoch. */
	proven(epoch: number, thread: unknown): boolean {
		if (!object(thread) || !Array.isArray(thread["turns"])) return false;
		return (
			thread["turns"].every(
				(t) =>
					object(t) &&
					typeof t["id"] === "string" &&
					this.request(epoch, t["id"]) !== undefined,
			) &&
			[...this.runs.values()].every(
				(r) => r.nativeEpoch !== epoch || this.origins.has(r.requestId),
			)
		);
	}
	private acceptOrigin(origin: SourceRequestOrigin): void {
		if (origin.sessionId !== this.sessionId) invalid();
		const prior = this.origins.get(origin.requestId);
		if (prior) {
			if (!isDeepStrictEqual(prior, origin)) invalid();
			return;
		}
		const retained = [...this.receipts.values()].filter(
			(r) => r.nativeEpoch === origin.nativeEpoch,
		);
		if (
			!isDeepStrictEqual(
				retained.map((r) => r.id).sort(),
				[...origin.contextReceiptIds].sort(),
			) ||
			retained.some((r) => r.scopeDigest !== origin.scopeDigest)
		)
			invalid();
		this.origins.set(origin.requestId, origin);
	}
	private exposedRequest(receipt: SourceExposure): boolean {
		if (
			receipt.source.kind === "bootstrap" ||
			!this.origins.has(receipt.source.requestId)
		)
			return false;
		const origin = this.origins.get(receipt.source.requestId);
		if (
			origin?.nativeEpoch !== receipt.nativeEpoch ||
			origin.scopeDigest !== receipt.scopeDigest
		)
			invalid();
		if (
			receipt.outcome === "planned" &&
			this.runs.get(receipt.source.requestId)?.status === "settled"
		)
			invalid();
		return true;
	}
	private acceptRun(run: Run): void {
		const prior = this.runs.get(run.requestId);
		if (prior?.turnId && run.turnId !== prior.turnId) invalid();
		this.runs.set(run.requestId, run);
		const origin = this.origins.get(run.requestId);
		if (!origin) return;
		const binding = this.bindings.get(run.nativeEpoch);
		if (
			origin.nativeEpoch !== run.nativeEpoch ||
			binding?.nativeThreadId !== run.threadId
		)
			invalid();
		if (!run.turnId) return;
		const key = turnKey(run.nativeEpoch, run.turnId),
			previous = this.turns.get(key);
		if (previous && previous !== run.requestId) invalid();
		this.turns.set(key, run.requestId);
	}
	private validateAssociation(
		value: Record<string, unknown>,
	): SourceEntryAssociation {
		const origin =
			typeof value["requestId"] === "string"
				? this.origins.get(value["requestId"])
				: undefined;
		const entry =
			typeof value["entryId"] === "string"
				? this.entries.get(value["entryId"])
				: undefined;
		if (
			!origin ||
			!entry?.codex ||
			value["version"] !== 1 ||
			value["sessionId"] !== this.sessionId ||
			value["nativeEpoch"] !== origin.nativeEpoch ||
			value["scopeDigest"] !== origin.scopeDigest ||
			typeof value["turnId"] !== "string" ||
			!value["turnId"] ||
			entry.codex.nativeEpoch !== origin.nativeEpoch ||
			entry.codex.turnId !== value["turnId"] ||
			this.request(origin.nativeEpoch, value["turnId"]) !== origin.requestId ||
			entry.id !==
				`codex-v2:${origin.nativeEpoch}:${encodeURIComponent(entry.codex.turnId)}:${entry.message?.role}:${entry.codex.ordinal}`
		)
			invalid();
		return Object.freeze({
			version: 1,
			entryId: entry.id,
			sessionId: this.sessionId,
			requestId: origin.requestId,
			nativeEpoch: origin.nativeEpoch,
			scopeDigest: origin.scopeDigest,
			turnId: value["turnId"],
		});
	}
	private associate(entry: ProjectedEntry): boolean {
		if (!this.sink || !entry.codex || this.associations.has(entry.id))
			return false;
		const requestId = this.request(
			entry.codex.nativeEpoch ?? 0,
			entry.codex.turnId,
		);
		const origin = requestId ? this.origins.get(requestId) : undefined;
		if (!origin) return false;
		const association = this.validateAssociation({
			version: 1,
			entryId: entry.id,
			sessionId: this.sessionId,
			requestId: origin.requestId,
			nativeEpoch: origin.nativeEpoch,
			scopeDigest: origin.scopeDigest,
			turnId: entry.codex.turnId,
		});
		const input = projectNativeEntry(entry);
		if (!input) invalid();
		appendCodexJournal(this.file, { type: "source_entry", ...association });
		this.sink.appendSourceEntry(input, origin.requestId);
		this.associations.set(entry.id, association);
		return true;
	}
}
