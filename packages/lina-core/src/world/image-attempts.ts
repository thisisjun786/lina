import type { DatabaseSync } from "node:sqlite";
import { parseImageCount } from "./image-accounting-validation.ts";
import type {
	ImageAttemptDelivery,
	ImageAttemptHistory,
	ImageAttemptObservation,
	ImageAttemptOperation,
	ImageAttemptSource,
	LifeImageAttempt,
	PrepareImageAttemptInput,
	RetryImageAttemptInput,
} from "./image-attempt-types.ts";
import {
	advanceAttempt,
	attemptIdFor,
	attemptRequestKey,
	imageAttemptUuid,
	parseAttemptDelivery,
	parseAttemptObservation,
	parseAttemptOperation,
	parseAttemptRequest,
	verifyAttemptIntent,
	verifyAttemptRequest,
	verifyRetryOutcome,
} from "./image-attempt-validation.ts";
import type { LifeImageIntent } from "./image-types.ts";
import {
	canonicalLifeJson,
	identifier,
	lifeDigest,
	MAX_LIFE_ITEMS,
	revision,
} from "./life-json.ts";
import { fields } from "./validation.ts";

export type {
	ImageAttemptDelivery,
	ImageAttemptHistory,
	ImageAttemptObservation,
	ImageAttemptSource,
	LifeImageAttempt,
	PrepareImageAttemptInput,
	RetryImageAttemptInput,
} from "./image-attempt-types.ts";
export { actualSourceLifeRevision } from "./image-attempt-validation.ts";
/** Schema8 composition and migration audit belong to WorldStore. */
export const IMAGE_ATTEMPTS_SCHEMA = `
CREATE TABLE life_image_attempts (
 world_id TEXT NOT NULL REFERENCES worlds(id), intent_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL, attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
 job_id TEXT UNIQUE, record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,attempt_id), UNIQUE(world_id,intent_id,attempt_number)
) STRICT;
CREATE TABLE life_image_attempt_history (
 world_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 request_key TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,attempt_id,revision), UNIQUE(world_id,request_key),
 FOREIGN KEY(world_id,attempt_id) REFERENCES life_image_attempts(world_id,attempt_id)
) STRICT;
CREATE TABLE life_image_attempt_heads (
 world_id TEXT NOT NULL, intent_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 PRIMARY KEY(world_id,intent_id),
 FOREIGN KEY(world_id,attempt_id) REFERENCES life_image_attempts(world_id,attempt_id)
) STRICT;
`;
type AttemptRow = {
	world_id: string;
	intent_id: string;
	attempt_id: string;
	attempt_number: number;
	job_id: string | null;
	record_json: string;
	digest: string;
};
type HistoryRow = {
	world_id: string;
	attempt_id: string;
	revision: number;
	request_key: string;
	record_json: string;
	digest: string;
};
type HeadRow = { world_id: string; intent_id: string; attempt_id: string };
type Loaded = {
	attempts: LifeImageAttempt[];
	histories: Map<string, ImageAttemptHistory[]>;
	heads: Map<string, LifeImageAttempt>;
};
const COLUMNS =
	"world_id,intent_id,attempt_id,attempt_number,job_id,record_json,digest";
const HISTORY_COLUMNS =
	"world_id,attempt_id,revision,request_key,record_json,digest";

/** Caller owns write and read transactions. Runtime verifies manifests/bytes before receipts.
 * Observing an existing fact grants no POST, asset-serving or destination authority. */
export class ImageAttempts {
	constructor(
		private readonly db: DatabaseSync,
		private readonly source: ImageAttemptSource,
		private readonly clock: () => number = Date.now,
	) {}
	private intent(worldId: string, intentId: string): LifeImageIntent {
		const intent = this.source.intent(worldId, intentId);
		if (
			!intent ||
			intent.owner.worldId !== worldId ||
			intent.intentId !== intentId
		)
			throw Error("Missing actual image intent");
		// Canonical JSON rejects executable/lossy callback data too. Historical parsing belongs to the actual intent owner.
		canonicalLifeJson(intent);
		return intent;
	}
	private route(
		request: Pick<PrepareImageAttemptInput, "owner" | "route">,
		current = false,
	): void {
		const settings = this.source.settings(
			request.owner.worldId,
			current ? undefined : request.route.settingsRevision,
		);
		if (
			!settings ||
			settings.worldId !== request.owner.worldId ||
			settings.revision !== request.route.settingsRevision ||
			settings.route.provider !== request.route.provider ||
			settings.route.model !== request.route.model
		)
			throw Error("Image attempt route/settings conflict");
	}
	private initial(
		operation: Extract<ImageAttemptOperation, { kind: "prepare" | "retry" }>,
		intent: LifeImageIntent,
		at: number,
		previous: LifeImageAttempt | null,
	): LifeImageAttempt {
		const request = operation.request;
		verifyAttemptRequest(request, intent);
		this.route(request);
		if (operation.kind === "retry") {
			if (
				!previous ||
				previous.attemptId !== operation.request.previousAttemptId
			)
				throw Error("Image retry prior/head conflict");
			verifyRetryOutcome(previous, operation.evidence, intent);
		} else if (previous)
			throw Error("Initial prepare cannot replace an image attempt");
		const attemptNumber = revision((previous?.attemptNumber ?? 0) + 1, 1);
		if (attemptNumber > MAX_LIFE_ITEMS)
			throw Error("Image attempt history capacity exceeded");
		return {
			version: 1,
			attemptId: attemptIdFor(
				request.owner.worldId,
				request.intentId,
				attemptNumber,
			),
			attemptNumber,
			owner: intent.owner,
			intentId: intent.intentId,
			intentDigest: lifeDigest(intent),
			briefDigest: intent.briefDigest,
			route: request.route,
			previousAttemptId: previous?.attemptId ?? null,
			createdAtMs: at,
			revision: 1,
			jobId: null,
			observation: null,
			delivery: { kind: "pending" },
		};
	}
	private historyEntry(row: HistoryRow): ImageAttemptHistory {
		const raw: unknown = JSON.parse(row.record_json);
		fields(raw, ["requestKey", "operation", "recordedAtMs", "result"]);
		const operation = parseAttemptOperation(raw.operation),
			requestKey = attemptRequestKey(operation, row.attempt_id);
		if (
			raw.requestKey !== requestKey ||
			row.request_key !== requestKey ||
			canonicalLifeJson(raw) !== row.record_json ||
			lifeDigest(raw) !== row.digest
		)
			throw Error("Corrupt image attempt history receipt");
		// result is not trusted here: load() recomputes every field through the operation history.
		return {
			requestKey,
			operation,
			recordedAtMs: revision(raw.recordedAtMs),
			result: raw.result as LifeImageAttempt,
		};
	}
	private load(worldId: string): Loaded {
		identifier(worldId);
		const rows = this.db
			.prepare(
				`SELECT ${COLUMNS} FROM life_image_attempts WHERE world_id=? ORDER BY intent_id,attempt_number`,
			)
			.all(worldId) as AttemptRow[];
		const historyRows = this.db
			.prepare(
				`SELECT ${HISTORY_COLUMNS} FROM life_image_attempt_history WHERE world_id=? ORDER BY attempt_id,revision`,
			)
			.all(worldId) as HistoryRow[];
		const heads = this.db
			.prepare(
				"SELECT world_id,intent_id,attempt_id FROM life_image_attempt_heads WHERE world_id=?",
			)
			.all(worldId) as HeadRow[];
		const grouped = new Map<string, HistoryRow[]>();
		for (const row of historyRows) {
			const group = grouped.get(row.attempt_id) ?? [];
			group.push(row);
			grouped.set(row.attempt_id, group);
		}
		const result: Loaded = {
			attempts: [],
			histories: new Map(),
			heads: new Map(),
		};
		const uuids = new Set<string>();
		for (const row of rows) {
			const intent = this.intent(worldId, identifier(row.intent_id)),
				history = grouped.get(row.attempt_id);
			if (!history?.length || history.length > MAX_LIFE_ITEMS)
				throw Error("Missing or excessive image attempt history");
			let current: LifeImageAttempt | null = null;
			let at = 0;
			const entries: ImageAttemptHistory[] = [];
			for (const [index, event] of history.entries()) {
				if (event.revision !== index + 1 || event.world_id !== worldId)
					throw Error("Corrupt image attempt history sequence");
				const entry = this.historyEntry(event);
				if (entry.recordedAtMs < at)
					throw Error("Regressed image attempt history clock");
				at = entry.recordedAtMs;
				if (current) current = advanceAttempt(current, entry.operation, intent);
				else {
					if (
						entry.operation.kind !== "prepare" &&
						entry.operation.kind !== "retry"
					)
						throw Error("Missing image attempt creation history");
					current = this.initial(
						entry.operation,
						intent,
						at,
						result.heads.get(intent.intentId) ?? null,
					);
				}
				if (canonicalLifeJson(current) !== canonicalLifeJson(entry.result))
					throw Error("Corrupt image attempt history result");
				entries.push({ ...entry, result: current });
			}
			if (
				!current ||
				row.attempt_id !== current.attemptId ||
				row.attempt_number !== current.attemptNumber ||
				row.job_id !== current.jobId ||
				row.record_json !== canonicalLifeJson(current) ||
				row.digest !== lifeDigest(current)
			)
				throw Error("Corrupt image attempt current record");
			verifyAttemptIntent(current, intent);
			this.route(current);
			if (current.jobId) {
				if (uuids.has(current.jobId)) throw Error("Duplicate image UUID link");
				uuids.add(current.jobId);
			}
			result.attempts.push(current);
			result.histories.set(current.attemptId, entries);
			result.heads.set(current.intentId, current);
			grouped.delete(row.attempt_id);
		}
		if (
			grouped.size ||
			heads.length !== result.heads.size ||
			heads.some(
				(head) =>
					result.heads.get(head.intent_id)?.attemptId !== head.attempt_id,
			)
		)
			throw Error("Missing, corrupt or orphan image attempt head/history");
		return result;
	}
	private transaction(): void {
		if (!this.db.isTransaction)
			throw Error("Image attempts require caller-owned transaction");
	}
	private replay(
		loaded: Loaded,
		operation: ImageAttemptOperation,
		attemptId: string,
	): LifeImageAttempt | null {
		const key = attemptRequestKey(operation, attemptId);
		for (const entries of loaded.histories.values())
			for (const entry of entries)
				if (entry.requestKey === key) {
					if (
						entry.result.attemptId !== attemptId ||
						lifeDigest(entry.operation) !== lifeDigest(operation)
					)
						throw Error("Image attempt request replay conflict");
					return entry.result;
				}
		return null;
	}
	private save(
		result: LifeImageAttempt,
		operation: ImageAttemptOperation,
		at: number,
	): LifeImageAttempt {
		if (result.revision > MAX_LIFE_ITEMS)
			throw Error("Image attempt history capacity exceeded");
		const requestKey = attemptRequestKey(operation, result.attemptId);
		const entry: ImageAttemptHistory = {
			requestKey,
			operation,
			recordedAtMs: at,
			result,
		};
		this.db
			.prepare(
				`INSERT INTO life_image_attempts(${COLUMNS}) VALUES(?,?,?,?,?,?,?) ON CONFLICT(world_id,attempt_id) DO UPDATE SET job_id=excluded.job_id,record_json=excluded.record_json,digest=excluded.digest`,
			)
			.run(
				result.owner.worldId,
				result.intentId,
				result.attemptId,
				result.attemptNumber,
				result.jobId,
				canonicalLifeJson(result),
				lifeDigest(result),
			);
		this.db
			.prepare(
				`INSERT INTO life_image_attempt_history(${HISTORY_COLUMNS}) VALUES(?,?,?,?,?,?)`,
			)
			.run(
				result.owner.worldId,
				result.attemptId,
				result.revision,
				requestKey,
				canonicalLifeJson(entry),
				lifeDigest(entry),
			);
		if (result.revision === 1)
			this.db
				.prepare(
					"INSERT INTO life_image_attempt_heads(world_id,intent_id,attempt_id) VALUES(?,?,?) ON CONFLICT(world_id,intent_id) DO UPDATE SET attempt_id=excluded.attempt_id",
				)
				.run(result.owner.worldId, result.intentId, result.attemptId);
		return result;
	}
	prepare(raw: PrepareImageAttemptInput): LifeImageAttempt {
		this.transaction();
		const request = parseAttemptRequest(raw, false),
			worldId = request.owner.worldId,
			loaded = this.load(worldId);
		const prior = loaded.heads.get(request.intentId) ?? null;
		const operation: ImageAttemptOperation = { kind: "prepare", request };
		// Request replay returns the original result even if an explicit retry moved the head.
		const original = [...loaded.histories.values()]
			.flat()
			.find((entry) => entry.requestKey === attemptRequestKey(operation, ""));
		if (original) {
			if (lifeDigest(original.operation) !== lifeDigest(operation))
				throw Error("Image attempt request replay conflict");
			return original.result;
		}
		const intent = this.intent(worldId, request.intentId);
		verifyAttemptRequest(request, intent);
		const at = this.time(loaded, prior);
		if (prior)
			return this.save(advanceAttempt(prior, operation, intent), operation, at);
		this.route(request, true);
		return this.save(this.initial(operation, intent, at, null), operation, at);
	}
	/** Returns the durable original prepare request so a replay cannot be rebuilt from changed settings. */
	prepareRequest(
		worldId: string,
		requestKey: string,
	): PrepareImageAttemptInput | null {
		const key = lifeDigest({ requestKey: identifier(requestKey) });
		for (const entries of this.load(worldId).histories.values())
			for (const entry of entries)
				if (entry.requestKey === key)
					return entry.operation.kind === "prepare"
						? structuredClone(entry.operation.request)
						: null;
		return null;
	}
	retry(raw: RetryImageAttemptInput): LifeImageAttempt {
		this.transaction();
		const request = parseAttemptRequest(raw, true),
			worldId = request.owner.worldId,
			loaded = this.load(worldId);
		const key = lifeDigest({ requestKey: request.requestKey });
		const original = [...loaded.histories.values()]
			.flat()
			.find((entry) => entry.requestKey === key);
		if (original) {
			if (
				original.operation.kind !== "retry" ||
				lifeDigest(original.operation.request) !== lifeDigest(request)
			)
				throw Error("Image retry request replay conflict");
			return original.result;
		}
		const prior = loaded.heads.get(request.intentId);
		if (!prior || prior.attemptId !== request.previousAttemptId)
			throw Error("Image retry prior/head conflict");
		const intent = this.intent(worldId, request.intentId);
		verifyAttemptRequest(request, intent);
		// Reject unknown and recoverable output before consulting any external owner.
		if (
			!prior.observation ||
			!["failed", "cancelled"].includes(prior.observation.state)
		)
			throw Error("Image retry requires known terminal outcome");
		if (prior.observation.resultFilename)
			throw Error("Image result requires artifact recovery");
		const actual = this.source.count(worldId, prior.attemptId);
		if (!actual) throw Error("Missing image retry accounting outcome");
		const operation: ImageAttemptOperation = {
			kind: "retry",
			request,
			evidence: parseImageCount(actual),
		};
		this.route(request, true);
		return this.save(
			this.initial(operation, intent, this.time(loaded, prior), prior),
			operation,
			this.time(loaded, prior),
		);
	}
	private time(loaded: Loaded, prior: LifeImageAttempt | null): number {
		const now = revision(this.clock()),
			entries = prior ? loaded.histories.get(prior.attemptId) : null;
		return Math.max(now, entries?.at(-1)?.recordedAtMs ?? 0);
	}
	private update(
		worldId: string,
		attemptId: string,
		operation: ImageAttemptOperation,
	): LifeImageAttempt {
		this.transaction();
		identifier(attemptId);
		const loaded = this.load(worldId),
			prior = loaded.attempts.find((a) => a.attemptId === attemptId);
		if (!prior) throw Error("Unknown image attempt");
		const replay = this.replay(loaded, operation, attemptId);
		if (replay) return replay;
		const next = advanceAttempt(
			prior,
			operation,
			this.intent(worldId, prior.intentId),
		);
		return this.save(next, operation, this.time(loaded, prior));
	}
	link(worldId: string, attemptId: string, jobId: string): LifeImageAttempt {
		return this.update(worldId, attemptId, {
			kind: "link",
			jobId: imageAttemptUuid(jobId),
		});
	}
	observe(
		worldId: string,
		attemptId: string,
		observation: ImageAttemptObservation,
	): LifeImageAttempt {
		return this.update(worldId, attemptId, {
			kind: "observe",
			observation: parseAttemptObservation(observation),
		});
	}
	recoverArtifact(
		worldId: string,
		attemptId: string,
		observation: ImageAttemptObservation,
	): LifeImageAttempt {
		return this.update(worldId, attemptId, {
			kind: "recover",
			observation: parseAttemptObservation(observation),
		});
	}
	acknowledge(
		worldId: string,
		attemptId: string,
		requestKey: string,
		delivery: ImageAttemptDelivery,
	): LifeImageAttempt {
		return this.update(worldId, attemptId, {
			kind: "acknowledge",
			requestKey: identifier(requestKey),
			delivery: parseAttemptDelivery(delivery),
		});
	}
	get(worldId: string, attemptId: string): LifeImageAttempt | null {
		identifier(attemptId);
		return (
			this.load(worldId).attempts.find((a) => a.attemptId === attemptId) ?? null
		);
	}
	head(worldId: string, intentId: string): LifeImageAttempt | null {
		identifier(intentId);
		return this.load(worldId).heads.get(intentId) ?? null;
	}
	list(worldId: string, intentId?: string): LifeImageAttempt[] {
		if (intentId !== undefined) identifier(intentId);
		return this.load(worldId).attempts.filter(
			(a) => intentId === undefined || a.intentId === intentId,
		);
	}
	history(worldId: string, attemptId: string): ImageAttemptHistory[] {
		identifier(attemptId);
		return this.load(worldId).histories.get(attemptId) ?? [];
	}
	validate(): void {
		const worlds = this.db
			.prepare(
				"SELECT world_id FROM life_image_attempts UNION SELECT world_id FROM life_image_attempt_history UNION SELECT world_id FROM life_image_attempt_heads",
			)
			.all() as { world_id: string }[];
		const linked = new Set<string>();
		for (const world of worlds)
			for (const attempt of this.load(String(world.world_id)).attempts)
				if (attempt.jobId) {
					if (linked.has(attempt.jobId)) throw Error("Duplicate image UUID");
					linked.add(attempt.jobId);
				}
	}
}
