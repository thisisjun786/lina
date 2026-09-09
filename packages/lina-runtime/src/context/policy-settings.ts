import type { DatabaseSync } from "node:sqlite";
import { openCheckedDatabase } from "../../../lina-core/src/session-binding.ts";
import {
	DEFAULT_RESOURCE_POLICY,
	parseResourcePolicy,
	type ResourcePolicy,
} from "../resources/policy.ts";
import {
	type ContextBudgetPolicy,
	DEFAULT_CONTEXT_POLICY,
	parseContextBudgetPolicy,
} from "./policy.ts";

const SCHEMA_VERSION = 1;
const SCHEMA =
	"CREATE TABLE engine_policy_settings (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), settings_json TEXT NOT NULL) STRICT";
const INPUT_KEYS = ["version", "memory"];
const MEMORY_KEYS = [
	"enabled",
	"maxSearchRounds",
	"maxVisits",
	"inputChars",
	"maxOutputTokens",
	"maxAttempts",
];

type MemoryPolicyInput = {
	version: 1;
	memory: {
		enabled: boolean;
		maxSearchRounds: number;
		maxVisits: number;
		inputChars: number;
		/**
		 * Internal conservative output cap candidate. The actual model route
		 * clamps the request; this is not a product spend budget.
		 */
		maxOutputTokens: number;
		maxAttempts: number;
	};
};

export type EnginePolicyInput =
	| MemoryPolicyInput
	| {
			version: 2;
			memory: MemoryPolicyInput["memory"];
			context: ContextBudgetPolicy;
	  }
	| {
			version: 3;
			memory: MemoryPolicyInput["memory"];
			context: ContextBudgetPolicy;
			resources: ResourcePolicy;
	  };

export type EnginePolicySnapshot = {
	version: 3;
	resources: ResourcePolicy;
	memory: MemoryPolicyInput["memory"];
	context: ContextBudgetPolicy;
} & {
	revision: number;
};

const DEFAULT_INPUT: EnginePolicyInput = Object.freeze({
	version: 1,
	memory: Object.freeze({
		enabled: true,
		maxSearchRounds: 1,
		maxVisits: 32,
		inputChars: 22000,
		maxOutputTokens: 1024,
		maxAttempts: 3,
	}),
});

function object(value: unknown, label: string): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null) ||
		Reflect.ownKeys(value).some((key) => typeof key !== "string")
	)
		throw new Error(`invalid ${label}`);
	return value as Record<string, unknown>;
}

function exactFields(
	value: Record<string, unknown>,
	keys: string[],
	label: string,
): void {
	const names = Object.getOwnPropertyNames(value);
	if (
		keys.some((key) => !Object.hasOwn(value, key)) ||
		names.some((key) => !keys.includes(key))
	)
		throw new Error(`invalid or unknown ${label} fields`);
}

function boundedInt(
	value: unknown,
	min: number,
	max: number,
	label: string,
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	)
		throw new Error(`invalid ${label}`);
	return value;
}

function validPolicyRevision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("invalid engine policy revision");
	return value;
}

function parseEnginePolicyInput(
	value: unknown,
): Omit<EnginePolicySnapshot, "revision"> {
	const input = object(value, "engine policy");
	exactFields(
		input,
		input["version"] === 3
			? [...INPUT_KEYS, "context", "resources"]
			: input["version"] === 2
				? [...INPUT_KEYS, "context"]
				: INPUT_KEYS,
		"engine policy",
	);
	if (
		input["version"] !== 1 &&
		input["version"] !== 2 &&
		input["version"] !== 3
	)
		throw new Error("unknown engine policy version");
	const memory = object(input["memory"], "engine policy memory");
	exactFields(memory, MEMORY_KEYS, "engine policy memory");
	if (typeof memory["enabled"] !== "boolean")
		throw new Error("invalid engine policy enabled");
	return {
		version: 3,
		resources: parseResourcePolicy(
			input["version"] === 3 ? input["resources"] : DEFAULT_RESOURCE_POLICY,
		),
		context: parseContextBudgetPolicy(
			input["version"] === 1 ? DEFAULT_CONTEXT_POLICY : input["context"],
		),
		memory: {
			enabled: memory["enabled"],
			maxSearchRounds: boundedInt(
				memory["maxSearchRounds"],
				0,
				8,
				"maxSearchRounds",
			),
			maxVisits: boundedInt(memory["maxVisits"], 1, 200, "maxVisits"),
			inputChars: boundedInt(memory["inputChars"], 1024, 32000, "inputChars"),
			maxOutputTokens: boundedInt(
				memory["maxOutputTokens"],
				1,
				1_048_576,
				"maxOutputTokens",
			),
			maxAttempts: boundedInt(memory["maxAttempts"], 1, 3, "maxAttempts"),
		},
	};
}

function freezeSnapshot(value: EnginePolicySnapshot): EnginePolicySnapshot {
	return Object.freeze({
		version: 3,
		resources: Object.freeze({ ...value.resources }),
		context: Object.freeze({ ...value.context }),
		revision: value.revision,
		memory: Object.freeze({ ...value.memory }),
	});
}

/** Detached revision-0 default. Does not open or create a database. */
export function defaultEnginePolicy(): EnginePolicySnapshot {
	return freezeSnapshot({
		revision: 0,
		...parseEnginePolicyInput(DEFAULT_INPUT),
	});
}

/** Fleet-owned saved engine policy. Default in-memory policy lives in defaultEnginePolicy. */
export class EnginePolicySettingsStore {
	private readonly db: DatabaseSync;
	private closed = false;

	constructor(path: string) {
		if (typeof path !== "string" || path.trim().length === 0)
			throw new Error("invalid engine policy path");
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
					"INSERT INTO engine_policy_settings (id, revision, settings_json) VALUES (1, 0, ?)",
				).run(JSON.stringify(parseEnginePolicyInput(DEFAULT_INPUT)));
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

	snapshot(): EnginePolicySnapshot {
		this.assertOpen();
		this.verifySchema();
		const rows = this.db
			.prepare("SELECT id, revision, settings_json FROM engine_policy_settings")
			.all();
		const row = rows[0];
		if (
			rows.length !== 1 ||
			row?.["id"] !== 1 ||
			typeof row["settings_json"] !== "string"
		)
			throw new Error("corrupt engine policy row");
		const revision = validPolicyRevision(row["revision"]);
		const parsed: unknown = JSON.parse(row["settings_json"]);
		return { revision, ...parseEnginePolicyInput(parsed) };
	}

	replace(
		expectedRevision: number,
		input: EnginePolicyInput,
	): EnginePolicySnapshot {
		this.assertOpen();
		validPolicyRevision(expectedRevision);
		const candidate = parseEnginePolicyInput(input);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const current = this.snapshot();
			if (current.revision !== expectedRevision)
				throw new Error("stale engine policy revision");
			if (input.version === 1) candidate.context = current.context;
			if (input.version !== 3) candidate.resources = current.resources;
			const revision = validPolicyRevision(current.revision + 1);
			const result = this.db
				.prepare(
					"UPDATE engine_policy_settings SET revision = ?, settings_json = ? WHERE id = 1 AND revision = ?",
				)
				.run(revision, JSON.stringify(candidate), expectedRevision);
			if (result.changes !== 1) throw new Error("stale engine policy revision");
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
		if (this.closed) throw new Error("engine policy store is closed");
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
			throw new Error("unknown engine policy schema");
	}
}
