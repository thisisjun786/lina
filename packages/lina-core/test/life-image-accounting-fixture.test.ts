import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LifeConfig } from "../src/world/authoring-types.ts";
import {
	IMAGE_ACCOUNTING_SCHEMA,
	ImageAccounting,
} from "../src/world/image-accounting.ts";
import type {
	ImageAccountingBinding,
	ImageAccountingSource,
} from "../src/world/image-accounting-types.ts";
import type { LifeImageSettings } from "../src/world/image-types.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";

export function accountingFixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-image-accounting-"));
	const path = join(root, "world.sqlite");
	let now = 1000;
	const handles: DatabaseSync[] = [];
	const open = () => {
		const db = new DatabaseSync(path);
		db.exec(
			"PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0",
		);
		handles.push(db);
		return db;
	};
	const db = open();
	db.exec(`CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT;
	CREATE TABLE fixture_authority(kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id,revision)) STRICT;
	INSERT INTO worlds(id) VALUES('world'),('other');`);
	db.exec(IMAGE_ACCOUNTING_SCHEMA);
	const settings: LifeImageSettings = {
		version: 1,
		worldId: "world",
		revision: 1,
		worldVersion: null,
		route: { provider: "synthetic", model: "image" },
		eventRules: [],
		avatarEventRules: [],
		perAuthorCooldownSteps: 0,
		attachMode: "manual",
		maxJobsPerVisit: 1,
		storage: {
			maxActiveJobs: 8,
			maxArchivedJobs: 8,
			maxAssets: 8,
			maxTotalBytes: 30_000_000,
		},
	};
	const config: LifeConfig = {
		version: 1,
		worldId: "world",
		revision: 1,
		clock: null,
		run: { mode: "manual" },
		models: null,
		limits: null,
		usage: {
			windowMs: 1000,
			maxInputTokens: 0,
			maxOutputTokens: 0,
			maxImages: 2,
		},
		publication: null,
		images: { mode: "manual", maxPerStep: 2 },
		avatars: { mode: "manual", intervalMs: null, maxPerWindow: 2 },
	};
	const save = (kind: string, id: string, revision: number, value: unknown) =>
		db
			.prepare(
				"INSERT OR REPLACE INTO fixture_authority(kind,id,revision,value) VALUES(?,?,?,?)",
			)
			.run(kind, id, revision, canonicalLifeJson(value));
	const load = (
		connection: DatabaseSync,
		kind: string,
		id: string,
		revision?: number,
	): unknown => {
		const row =
			revision === undefined
				? connection
						.prepare(
							"SELECT value FROM fixture_authority WHERE kind=? AND id=? ORDER BY revision DESC LIMIT 1",
						)
						.get(kind, id)
				: connection
						.prepare(
							"SELECT value FROM fixture_authority WHERE kind=? AND id=? AND revision=?",
						)
						.get(kind, id, revision);
		return row ? JSON.parse(String(row["value"])) : null;
	};
	const source = (connection: DatabaseSync): ImageAccountingSource => ({
		settings: (worldId, revision) =>
			load(
				connection,
				"settings",
				worldId,
				revision,
			) as LifeImageSettings | null,
		config: (worldId, revision) =>
			load(connection, "config", worldId, revision) as LifeConfig | null,
		verifyAttempt(binding, phase) {
			const actual = load(connection, "attempt", binding.attemptId, 1);
			if (!actual || lifeDigest(actual) !== lifeDigest(binding))
				throw Error("Unknown or mismatched actual intent/attempt");
			if (
				phase === "submit" &&
				load(connection, "revoked", binding.attemptId, 1)
			)
				throw Error("Current authority revoked");
			if (
				phase === "zero" &&
				!load(connection, "preflight", binding.attemptId, 1)
			)
				throw Error("Missing owned preflight evidence");
		},
	});
	const connect = () => {
		const connection = open();
		return {
			db: connection,
			ledger: new ImageAccounting(connection, source(connection), () => now),
		};
	};
	for (const worldId of ["world", "other"]) {
		save("settings", worldId, 1, { ...settings, worldId });
		save("config", worldId, 1, { ...config, worldId });
	}
	const ledger = new ImageAccounting(db, source(db), () => now);
	let serial = 0;
	const input = (overrides: Partial<ImageAccountingBinding> = {}) => {
		serial++;
		const binding: ImageAccountingBinding = {
			worldId: "world",
			agentId: "lina",
			intentId: `intent-${serial}`,
			attemptId: `attempt-${serial}`,
			jobId: `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
			kind: "event",
			sourceLifeRevision: serial,
			settingsRevision: 1,
			configRevision: 1,
			frozenDigest: "a".repeat(64),
			...overrides,
		};
		save("attempt", binding.attemptId, 1, binding);
		return {
			binding,
			outputBytes: 2 * 1024 * 1024,
			metadataBytes: 16_384,
			manifestBytes: 8192,
		};
	};
	return {
		db,
		source,
		ledger,
		path,
		settings,
		config,
		save,
		input,
		connect,
		time(value: number) {
			now = value;
		},
		tx<T>(action: () => T, connection = db): T {
			connection.exec("BEGIN IMMEDIATE");
			try {
				const result = action();
				connection.exec("COMMIT");
				return result;
			} catch (error) {
				connection.exec("ROLLBACK");
				throw error;
			}
		},
		close() {
			for (const handle of handles) if (handle.isOpen) handle.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export const output = (id: string, size = 1024) => ({
	id,
	sha256: "b".repeat(64),
	mime: "image/png" as const,
	size,
});
