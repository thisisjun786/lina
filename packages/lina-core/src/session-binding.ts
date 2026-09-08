import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { BotBinding } from "./protocol.ts";

const NEW_FILE_FLAGS =
	constants.O_CREAT |
	constants.O_EXCL |
	constants.O_WRONLY |
	constants.O_NOFOLLOW;

function directory(path: string, create = false): string {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of absolute
		.slice(current.length)
		.split(sep)
		.filter(Boolean)) {
		current = join(current, part);
		let stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat && create) {
			try {
				mkdirSync(current, { mode: 0o700 });
			} catch (error) {
				if (
					!(
						error instanceof Error &&
						"code" in error &&
						error.code === "EEXIST"
					)
				)
					throw error;
			}
			stat = lstatSync(current);
		}
		if (!stat?.isDirectory() || stat.isSymbolicLink())
			throw new Error(`unsafe directory: ${current}`);
	}
	return absolute;
}

function filePath(path: string, required = false, singleLink = true): string {
	const absolute = resolve(path);
	directory(dirname(absolute));
	const stat = lstatSync(absolute, { throwIfNoEntry: false });
	if (
		(!stat && required) ||
		(stat && (!stat.isFile() || (singleLink && stat.nlink !== 1)))
	)
		throw new Error(`unsafe regular file: ${absolute}`);
	return absolute;
}

// Both the store and leases use the same filesystem boundary before SQLite opens.
export function openCheckedDatabase(path: string): {
	db: DatabaseSync;
	fresh: boolean;
} {
	directory(dirname(resolve(path)), true);
	const absolute = filePath(path);
	for (const suffix of ["-journal", "-wal", "-shm"])
		filePath(`${absolute}${suffix}`);
	const stat = lstatSync(absolute, { throwIfNoEntry: false });
	if (!stat) {
		const fd = openSync(absolute, NEW_FILE_FLAGS, 0o600);
		closeSync(fd);
	}
	return { db: new DatabaseSync(absolute), fresh: !stat || stat.size === 0 };
}

export function validateBinding(value: unknown): BotBinding {
	if (typeof value !== "object" || value === null)
		throw new Error("invalid binding");
	const object = value as Record<string, unknown>;
	if (object["version"] !== 1 || Object.keys(object).length !== 5)
		throw new Error("invalid binding version or fields");
	for (const key of ["botId", "sessionId", "sessionFile", "workspace"]) {
		if (typeof object[key] !== "string" || object[key].trim().length === 0)
			throw new Error(`invalid binding ${key}`);
	}
	// Every field was checked at this file boundary before narrowing.
	const binding = value as BotBinding;
	const workspace = directory(binding.workspace);
	const sessionFile = filePath(binding.sessionFile);
	if (workspace !== binding.workspace || sessionFile !== binding.sessionFile)
		throw new Error("binding paths must be canonical absolute paths");
	return { ...binding };
}

interface LeaseOwner {
	version: 1;
	botId: string;
	workspace: string;
	target: string;
	kind: "session" | "transcript" | "image";
}

const LEASE_SCHEMA =
	"CREATE TABLE lease_owner (id INTEGER PRIMARY KEY CHECK(id = 1), identity TEXT NOT NULL) STRICT";

function verifyOwner(db: DatabaseSync, owner: LeaseOwner): void {
	const tables = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all();
	if (
		tables.length !== 1 ||
		tables[0]?.["sql"] !== LEASE_SCHEMA ||
		db.prepare("PRAGMA user_version").get()?.["user_version"] !== 1
	)
		throw new Error("unknown lease schema");
	const rows = db.prepare("SELECT identity FROM lease_owner").all();
	const identity = rows[0]?.["identity"];
	if (
		rows.length !== 1 ||
		typeof identity !== "string" ||
		!isDeepStrictEqual(JSON.parse(identity), owner)
	)
		throw new Error("foreign lease owner");
}

function holdLease(path: string, owner: LeaseOwner): { close(): void } {
	if (!owner.botId.trim()) throw new Error("invalid lease owner");
	const { db, fresh } = openCheckedDatabase(path);
	try {
		// WAL does not provide reader exclusion; a lease must use rollback journals.
		if (db.prepare("PRAGMA journal_mode").get()?.["journal_mode"] !== "delete")
			throw new Error("unsupported lease journal mode");
		db.exec(
			"PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; BEGIN EXCLUSIVE",
		);
		if (fresh) {
			db.exec(LEASE_SCHEMA);
			db.prepare("INSERT INTO lease_owner VALUES (1, ?)").run(
				JSON.stringify(owner),
			);
			db.exec("PRAGMA user_version = 1");
		} else verifyOwner(db, owner);
		// Immutable ownership is durable BEFORE the lifetime transaction starts.
		db.exec("COMMIT; BEGIN EXCLUSIVE");
		verifyOwner(db, owner);
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		db.close();
		throw error;
	}
	let closed = false;
	return {
		close() {
			if (closed) return;
			try {
				db.exec("ROLLBACK");
			} finally {
				db.close();
				closed = true;
			}
		},
	};
}

function atomicBinding(file: string, binding: BotBinding): void {
	const temporary = join(dirname(file), `.binding-${randomUUID()}.tmp`);
	const fd = openSync(temporary, NEW_FILE_FLAGS, 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(binding)}\n`);
		fsyncSync(fd);
		// Atomic no-replace publication prevents overwriting even a racing manifest.
		linkSync(temporary, file);
	} finally {
		closeSync(fd);
		unlinkSync(temporary);
	}
	const dir = openSync(
		dirname(file),
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}

export interface SessionLease {
	root: string;
	readBinding(): BotBinding | undefined;
	bind(binding: BotBinding): void;
	close(): void;
}

/** Reuse the same process-lifetime SQLite lock without inventing a conversation binding. */
export function acquireImageLease(
	root: string,
	worldId: string,
	agentId: string,
): { close(): void } {
	if (!worldId.trim() || !agentId.trim())
		throw Error("Invalid image lease owner");
	const target = directory(root, true);
	return holdLease(join(target, "image-owner.sqlite"), {
		version: 1,
		botId: JSON.stringify({ worldId, agentId }),
		workspace: target,
		target,
		kind: "image",
	});
}

export function acquireSessionLease(
	stateRoot: string,
	botId: string,
	workspace: string,
): SessionLease {
	const root = directory(stateRoot, true);
	const canonicalWorkspace = directory(workspace);
	// Publication may leave a staging hardlink after a crash; its JSON is complete.
	const manifest = filePath(join(root, "binding.json"), false, false);
	const lease = holdLease(join(root, "owner.sqlite"), {
		version: 1,
		botId,
		workspace: canonicalWorkspace,
		target: root,
		kind: "session",
	});
	let closed = false;
	let fixed: BotBinding | undefined;
	function assertOpen(): void {
		if (closed) throw new Error("session lease is closed");
	}
	function owned(binding: BotBinding): BotBinding {
		if (binding.botId !== botId || binding.workspace !== canonicalWorkspace)
			throw new Error("foreign binding owner");
		if (fixed && !isDeepStrictEqual(fixed, binding))
			throw new Error("fixed binding conflict");
		return binding;
	}
	function readBinding(): BotBinding | undefined {
		assertOpen();
		filePath(manifest, false, false);
		if (!lstatSync(manifest, { throwIfNoEntry: false })) {
			if (fixed) throw new Error("fixed binding is missing");
			return undefined;
		}
		fixed = owned(
			validateBinding(JSON.parse(readFileSync(manifest, "utf8")) as unknown),
		);
		return { ...fixed };
	}
	try {
		readBinding();
	} catch (error) {
		lease.close();
		throw error;
	}
	return {
		root,
		readBinding,
		bind(binding) {
			assertOpen();
			const candidate = owned(validateBinding(binding));
			const existing = readBinding();
			if (existing) {
				if (!isDeepStrictEqual(existing, candidate))
					throw new Error("fixed binding conflict");
				return;
			}
			atomicBinding(manifest, candidate);
			fixed = candidate;
		},
		close() {
			if (!closed) {
				lease.close();
				closed = true;
			}
		},
	};
}

export function acquireTranscriptLease(
	file: string,
	botId: string,
	workspace: string,
): { close(): void } {
	const target = filePath(file, true);
	return holdLease(`${target}.lina-lease.sqlite`, {
		version: 1,
		botId,
		workspace: directory(workspace),
		target,
		kind: "transcript",
	});
}
