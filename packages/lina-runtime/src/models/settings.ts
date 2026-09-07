import type { DatabaseSync } from "node:sqlite";
import { openCheckedDatabase } from "../../../lina-core/src/session-binding.ts";
import type { ModelSettings, ModelSettingsInput } from "./types.ts";
import {
	parseModelSettingsInput,
	validSettingsRevision,
} from "./validation.ts";

const SCHEMA_VERSION = 1;
const SCHEMA =
	"CREATE TABLE model_settings (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), settings_json TEXT NOT NULL) STRICT";

/** Fleet-owned saved settings. Runtime activation/effective revision lives in host. */
export class ModelSettingsStore {
	private readonly db: DatabaseSync;
	private closed = false;

	constructor(path: string) {
		if (typeof path !== "string" || path.trim().length === 0)
			throw new Error("invalid model settings path");
		const { db, fresh } = openCheckedDatabase(path);
		this.db = db;
		try {
			db.exec("BEGIN IMMEDIATE");
			const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
			const objects = db
				.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
				.all();
			if (fresh && version === 0 && objects.length === 0) {
				db.exec(SCHEMA);
				db.prepare(
					"INSERT INTO model_settings (id, revision, settings_json) VALUES (1, 0, ?)",
				).run(
					JSON.stringify({
						profiles: [],
						defaultProfileId: null,
						roles: {},
						agentRoles: {},
					}),
				);
				db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			}
			this.snapshot();
			db.exec("COMMIT; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
		} catch (error) {
			try {
				if (db.isTransaction) db.exec("ROLLBACK");
			} finally {
				db.close();
			}
			throw error;
		}
	}

	snapshot(): ModelSettings {
		this.assertOpen();
		this.verifySchema();
		const rows = this.db
			.prepare("SELECT id, revision, settings_json FROM model_settings")
			.all();
		const row = rows[0];
		if (
			rows.length !== 1 ||
			row?.["id"] !== 1 ||
			typeof row["settings_json"] !== "string"
		)
			throw new Error("corrupt model settings row");
		const revision = validSettingsRevision(row["revision"]);
		const parsed: unknown = JSON.parse(row["settings_json"]);
		return { revision, ...parseModelSettingsInput(parsed) };
	}

	replace(expectedRevision: number, input: ModelSettingsInput): ModelSettings {
		this.assertOpen();
		validSettingsRevision(expectedRevision);
		const candidate = parseModelSettingsInput(input);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const current = this.snapshot();
			if (current.revision !== expectedRevision)
				throw new Error("stale model settings revision");
			const revision = validSettingsRevision(current.revision + 1);
			const result = this.db
				.prepare(
					"UPDATE model_settings SET revision = ?, settings_json = ? WHERE id = 1 AND revision = ?",
				)
				.run(revision, JSON.stringify(candidate), expectedRevision);
			if (result.changes !== 1)
				throw new Error("stale model settings revision");
			this.db.exec("COMMIT");
			return { revision, ...candidate };
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		if (this.closed) return;
		this.db.close();
		this.closed = true;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("model settings store is closed");
	}

	private verifySchema(): void {
		const version = this.db.prepare("PRAGMA user_version").get()?.[
			"user_version"
		];
		const objects = this.db
			.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
			.all();
		if (
			version !== SCHEMA_VERSION ||
			objects.length !== 1 ||
			objects[0]?.["sql"] !== SCHEMA
		)
			throw new Error("unknown model settings schema");
	}
}
