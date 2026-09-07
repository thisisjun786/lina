import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { openCheckedDatabase } from "../session-binding.ts";
import { projectContext, validateContextLimits } from "./context.ts";
import { initializeWorldSchema } from "./schema.ts";
import { eventId, initialSnapshot, transition } from "./transition.ts";
import type {
	WorldContext,
	WorldContextLimits,
	WorldDefinition,
	WorldEvent,
	WorldProposal,
	WorldSnapshot,
} from "./types.ts";
import {
	id,
	integer,
	parseDefinition,
	parseProposal,
	text,
} from "./validation.ts";

type WorldRow = { id: string; definition_json: string; state_json: string };
type EventRow = {
	world_id: string;
	idempotency_key: string;
	revision: number;
	event_json: string;
};
const WORLD_COLUMNS = "id, definition_json, state_json";
const EVENT_COLUMNS = "world_id, idempotency_key, revision, event_json";

function eventProposal(event: WorldEvent): WorldProposal {
	const {
		id: _id,
		revision: _revision,
		acceptedAt: _acceptedAt,
		origin: _origin,
		definitionVersion: _version,
		...proposal
	} = event;
	return parseProposal(proposal);
}
function readEvent(row: EventRow): WorldEvent {
	const value = JSON.parse(row.event_json) as WorldEvent;
	const proposal = eventProposal(value);
	integer(value.revision, "event revision", 1);
	integer(value.definitionVersion, "definition version", 1);
	text(value.acceptedAt, "acceptance time");
	if (
		!Number.isFinite(Date.parse(value.acceptedAt)) ||
		value.origin !== "fictional" ||
		value.id !== eventId(row.world_id, row.revision) ||
		value.revision !== row.revision ||
		proposal.worldId !== row.world_id ||
		proposal.idempotencyKey !== row.idempotency_key
	)
		throw Error("Corrupt world event provenance");
	return {
		...proposal,
		id: value.id,
		revision: value.revision,
		acceptedAt: value.acceptedAt,
		origin: value.origin,
		definitionVersion: value.definitionVersion,
	};
}
function stateJson(snapshot: WorldSnapshot): string {
	const { definition: _definition, ...state } = snapshot;
	return JSON.stringify(state);
}

/** Trusted application API. Bind agent views in the runtime; never expose this store as an agent tool. */
export class WorldStore {
	private readonly db: DatabaseSync;
	private closed = false;
	constructor(
		path: string,
		private readonly now: () => number = Date.now,
	) {
		if (typeof path !== "string" || !path.trim())
			throw Error("Explicit world database path required");
		this.db =
			path === ":memory:"
				? new DatabaseSync(path)
				: openCheckedDatabase(path).db;
		let transactionStarted = false;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
			this.db.exec("BEGIN IMMEDIATE");
			transactionStarted = true;
			initializeWorldSchema(this.db);
			this.audit();
			this.db.exec("COMMIT");
			transactionStarted = false;
			this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
		} catch (error) {
			if (transactionStarted) this.rollback();
			this.db.close();
			throw error;
		}
	}
	create(input: WorldDefinition): WorldSnapshot {
		const definition = parseDefinition(input);
		return this.transaction(() => {
			const existing = this.row(definition.id);
			if (existing) {
				if (
					!isDeepStrictEqual(JSON.parse(existing.definition_json), definition)
				)
					throw Error("World definition conflict; definitions are immutable");
				return this.decode(existing);
			}
			const snapshot = initialSnapshot(definition);
			this.db
				.prepare(
					"INSERT INTO worlds (id, definition_json, state_json) VALUES (?, ?, ?)",
				)
				.run(definition.id, JSON.stringify(definition), stateJson(snapshot));
			return snapshot;
		});
	}
	snapshot(worldId: string): WorldSnapshot {
		this.assertOpen();
		id(worldId);
		const row = this.row(worldId);
		if (!row) throw Error("Unknown world");
		return this.decode(row);
	}
	/** Trusted historical view for freezing an image/job brief after an accepted event. */
	snapshotAt(worldId: string, revision: number): WorldSnapshot {
		integer(revision, "historical revision");
		return this.transaction(() => {
			const current = this.snapshot(worldId);
			if (revision > current.revision) throw Error("Unknown world revision");
			return this.rebuild(current.definition, revision);
		}, false);
	}
	preview(input: WorldProposal): WorldSnapshot {
		const proposal = parseProposal(input);
		return transition(this.snapshot(proposal.worldId), proposal);
	}
	accept(input: WorldProposal): { event: WorldEvent; replayed: boolean } {
		const proposal = parseProposal(input);
		return this.transaction(() => {
			const previous = this.db
				.prepare(
					`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ? AND idempotency_key = ?`,
				)
				.get(proposal.worldId, proposal.idempotencyKey) as EventRow | undefined;
			if (previous) {
				const event = readEvent(previous);
				if (!isDeepStrictEqual(eventProposal(event), proposal))
					throw Error("World idempotency key conflicts with accepted payload");
				return { event, replayed: true };
			}
			const next = transition(this.snapshot(proposal.worldId), proposal);
			const event: WorldEvent = {
				...proposal,
				id: eventId(proposal.worldId, next.revision),
				revision: next.revision,
				acceptedAt: new Date(this.now()).toISOString(),
				origin: "fictional",
				definitionVersion: next.definition.version,
			};
			this.db
				.prepare(
					"INSERT INTO world_events (world_id, idempotency_key, revision, event_json) VALUES (?, ?, ?, ?)",
				)
				.run(
					proposal.worldId,
					proposal.idempotencyKey,
					event.revision,
					JSON.stringify(event),
				);
			this.db
				.prepare("UPDATE worlds SET state_json = ? WHERE id = ?")
				.run(stateJson(next), proposal.worldId);
			return { event, replayed: false };
		});
	}
	context(
		worldId: string,
		agentId: string,
		limits: WorldContextLimits,
	): WorldContext {
		validateContextLimits(limits);
		return this.transaction(() => {
			const snapshot = this.snapshot(worldId);
			if (!snapshot.definition.agents.includes(agentId))
				throw Error("Unknown world agent");
			const rows = this.db
				.prepare(
					`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ? AND EXISTS (SELECT 1 FROM json_each(event_json, '$.audience') WHERE value = ?) ORDER BY revision DESC LIMIT ?`,
				)
				.all(worldId, agentId, limits.maxEvents + 1) as EventRow[];
			return projectContext(snapshot, agentId, rows.map(readEvent), limits);
		}, false);
	}
	/** Re-open audits atomic state against accepted events, without replaying any external effect. */
	private audit(): void {
		const worlds = this.db
			.prepare(`SELECT ${WORLD_COLUMNS} FROM worlds ORDER BY id`)
			.all() as WorldRow[];
		if (this.db.prepare("PRAGMA foreign_key_check").all().length)
			throw Error("Corrupt world event references");
		for (const row of worlds) {
			const saved = this.decode(row);
			const rebuilt = this.rebuild(saved.definition);
			if (!isDeepStrictEqual(saved, rebuilt))
				throw Error("Corrupt world checkpoint");
		}
	}
	private rebuild(
		definition: WorldDefinition,
		revision?: number,
	): WorldSnapshot {
		let rebuilt = initialSnapshot(definition);
		// Startup must inspect every stored row, including unsupported revisions.
		// Only an explicit historical lookup is allowed to bound the scan.
		const query = this.db.prepare(
			`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ?${revision === undefined ? "" : " AND revision <= ?"} ORDER BY revision`,
		);
		const rows =
			revision === undefined
				? query.iterate(definition.id)
				: query.iterate(definition.id, revision);
		for (const row of rows) {
			const event = readEvent(row as EventRow);
			if (event.definitionVersion !== definition.version)
				throw Error("Corrupt world definition version");
			rebuilt = transition(rebuilt, eventProposal(event));
			if (event.revision !== rebuilt.revision)
				throw Error("Corrupt world event revision");
		}
		if (revision !== undefined && rebuilt.revision !== revision)
			throw Error("Missing world event revision");
		return rebuilt;
	}
	private decode(row: WorldRow): WorldSnapshot {
		const definition = parseDefinition(JSON.parse(row.definition_json));
		if (row.id !== definition.id) throw Error("Corrupt world identity");
		return { ...JSON.parse(row.state_json), definition } as WorldSnapshot;
	}
	private row(worldId: string): WorldRow | undefined {
		return this.db
			.prepare(`SELECT ${WORLD_COLUMNS} FROM worlds WHERE id = ?`)
			.get(worldId) as WorldRow | undefined;
	}
	private transaction<T>(action: () => T, write = true): T {
		this.assertOpen();
		this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		try {
			const result = action();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.rollback();
			throw error;
		}
	}
	private rollback(): void {
		try {
			this.db.exec("ROLLBACK");
		} catch {
			/* SQLite may have aborted already; preserve the original failure. */
		}
	}
	private assertOpen(): void {
		if (this.closed) throw Error("World store is closed");
	}
	close(): void {
		if (this.closed) return;
		this.db.close();
		this.closed = true;
	}
}
