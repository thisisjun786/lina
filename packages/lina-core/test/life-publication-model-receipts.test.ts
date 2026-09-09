import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LifeConfig } from "../src/world/authoring-types.ts";
import { LifeModelReceipts } from "../src/world/autonomy-model-receipts.ts";
import {
	parseLifeModelRequest,
	parsePreparedLifeModel,
} from "../src/world/autonomy-record-validation.ts";
import type {
	LifeModelRecord,
	PreparedLifeModelRequest,
} from "../src/world/autonomy-types.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { unconfigured } from "./life-authoring-fixture.ts";

// Frozen v1 wire bytes from the pre-publication contract, independent of the parser.
const V1_BYTES =
	'{"agentId":"lina","id":"request-one","input":"{}","lane":"actor","limits":{"maxInputBytes":4000,"maxInputTokens":40,"maxOutputBytes":3000,"maxOutputTokens":20,"timeoutMs":1000},"model":"synthetic","modelSettingsRevision":3,"provider":"local","stepId":"step-one","systemPrompt":"Synthetic fixture","version":1,"worldId":"test-world"}';
const WORLD = "test-world";
type Owner = "step" | "publication";

for (const owner of ["step", "publication"] as const) {
	const other: Owner = owner === "step" ? "publication" : "step";
	test(`already prepared ${owner} dispatch is blocked by newly unknown ${other} usage through actual reopen`, () => {
		const f = fixture();
		try {
			const first = prepared(owner, "prepared-first"),
				second = prepared(other, "unknown-second"),
				budget = config(200, 100);
			f.transaction(() => {
				f.ledger(owner).prepare(first, budget);
				f.ledger(other).prepare(second, budget);
				f.ledger(other).dispatch(WORLD, ownerId(other), second.request.id);
				f.ledger(other).finish(WORLD, ownerId(other), second.request.id, {
					status: "unknown",
				});
			});
			f.advance();
			f.reopen();
			expect(() =>
				f.transaction(() =>
					f
						.ledger(owner)
						.dispatch(WORLD, ownerId(owner), first.request.id, budget),
				),
			).toThrow(/uncertain/);
			expect(
				f.ledger(owner).get(WORLD, ownerId(owner), first.request.id).status,
			).toBe("prepared");
			expect(f.ledger(owner).usage(WORLD, budget).unknownRequests).toBe(1);
			f.transaction(() =>
				f
					.ledger(other)
					.finish(WORLD, ownerId(other), second.request.id, completed(second)),
			);
			expect(
				f.transaction(() =>
					f
						.ledger(owner)
						.dispatch(WORLD, ownerId(owner), first.request.id, budget),
				).dispatched,
			).toBe(true);
			expect(() =>
				f.ledger(owner).assertOutbound(first.request, budget),
			).not.toThrow();
		} finally {
			f.close();
		}
	});
	test(`${owner} final outbound rejects another retained unknown receipt and excludes only its own reservation`, () => {
		const f = fixture();
		try {
			const first = prepared(owner, "first"),
				second = prepared(other, "second"),
				budget = config(200, 100);
			f.transaction(() => {
				f.ledger(owner).prepare(first, budget);
				f.ledger(other).prepare(second, budget);
				f.ledger(owner).dispatch(WORLD, ownerId(owner), first.request.id);
			});
			expect(() =>
				f.ledger(owner).assertOutbound(first.request, budget),
			).not.toThrow();
			// A valid legacy multi-dispatch receipt can survive an upgrade. It still
			// fences any pending native send after the new startup audit.
			const prior = f
				.ledger(other)
				.get(WORLD, ownerId(other), second.request.id);
			overwrite(f.db, other, {
				...prior,
				status: "unknown",
				dispatchedAt: 1000,
				upstreamAttempts: null,
			});
			f.reopen();
			expect(() =>
				f.ledger(owner).assertOutbound(first.request, budget),
			).toThrow(/uncertain/);
		} finally {
			f.close();
		}
	});
	test(`${owner} dispatch rechecks reported shared spend after its reservation`, () => {
		const f = fixture();
		try {
			const first = prepared(owner, "first"),
				second = prepared(other, "second"),
				budget = config(80, 40);
			f.transaction(() => {
				f.ledger(owner).prepare(first, budget);
				f.ledger(other).prepare(second, budget);
				f.ledger(other).dispatch(WORLD, ownerId(other), second.request.id);
				f.ledger(other).finish(
					WORLD,
					ownerId(other),
					second.request.id,
					completed(second, 70, 10),
				);
			});
			expect(() =>
				f.transaction(() =>
					f
						.ledger(owner)
						.dispatch(WORLD, ownerId(owner), first.request.id, budget),
				),
			).toThrow(/budget/);
			expect(
				f.ledger(owner).get(WORLD, ownerId(owner), first.request.id).status,
			).toBe("prepared");
		} finally {
			f.close();
		}
	});
}
function prepared(owner: Owner, id = "request-one"): PreparedLifeModelRequest {
	const { stepId: _stepId, ...common } = JSON.parse(V1_BYTES);
	const request =
		owner === "step"
			? { ...common, id, stepId: "step-one" }
			: { ...common, id, version: 2, lane: "publication", jobId: "job-one" };
	return parsePreparedLifeModel({
		version: 1,
		request,
		inputDigest: lifeDigest(request),
		capabilityFingerprint: "a".repeat(64),
		nativeReference: `native-${id}`,
	});
}
function config(maxInputTokens = 40, maxOutputTokens = 20): LifeConfig {
	return {
		...unconfigured(),
		worldId: WORLD,
		revision: 1,
		usage: { maxInputTokens, maxOutputTokens, windowMs: 100, maxImages: 0 },
	};
}
function ownerId(owner: Owner) {
	return owner === "step" ? "step-one" : "job-one";
}
function fixture(publication = true) {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-model-"));
	const path = join(root, "world.sqlite");
	let db = new DatabaseSync(path),
		now = 1000;
	// Only this component's real fixed tables/owners: no fabricated WorldStore steps.
	db.exec(`PRAGMA foreign_keys = ON;
		CREATE TABLE life_steps(world_id TEXT NOT NULL, step_id TEXT NOT NULL, PRIMARY KEY(world_id,step_id)) STRICT;
		INSERT INTO life_steps VALUES('test-world','step-one');
		CREATE TABLE life_model_receipts(world_id TEXT NOT NULL, step_id TEXT NOT NULL, request_id TEXT NOT NULL,
		 record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
		 PRIMARY KEY(world_id,request_id), FOREIGN KEY(world_id,step_id) REFERENCES life_steps(world_id,step_id)) STRICT;`);
	if (publication)
		db.exec(`
		CREATE TABLE life_publication_jobs(world_id TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(world_id,job_id)) STRICT;
		INSERT INTO life_publication_jobs VALUES('test-world','job-one');
		CREATE TABLE life_publication_model_receipts(world_id TEXT NOT NULL, job_id TEXT NOT NULL, request_id TEXT NOT NULL,
		 record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
		 PRIMARY KEY(world_id,request_id), FOREIGN KEY(world_id,job_id) REFERENCES life_publication_jobs(world_id,job_id)) STRICT;`);
	const ledger = (owner: Owner) => new LifeModelReceipts(db, () => now, owner);
	return {
		get db() {
			return db;
		},
		ledger,
		advance() {
			now += 1000;
		},
		transaction<T>(fn: () => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const value = fn();
				db.exec("COMMIT");
				return value;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		reopen() {
			db.close();
			db = new DatabaseSync(path);
			db.exec("PRAGMA foreign_keys = ON");
			ledger("step").audit();
			if (publication) ledger("publication").audit();
		},
		connect() {
			const peer = new DatabaseSync(path);
			peer.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0");
			return peer;
		},
		close() {
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
function completed(
	p: PreparedLifeModelRequest,
	inputTokens = 7,
	outputTokens = 3,
) {
	return {
		status: "completed" as const,
		result: {
			version: 1 as const,
			requestId: p.request.id,
			inputDigest: p.inputDigest,
			capabilityFingerprint: p.capabilityFingerprint,
			nativeReference: p.nativeReference,
			provider: p.request.provider,
			model: p.request.model,
			threadId: "thread-one",
			turnId: "turn-one",
			text: "done",
			usage: {
				inputTokens,
				outputTokens,
				totalTokens: inputTokens + outputTokens,
			},
			upstreamAttempts: 1 as const,
		},
	};
}
function overwrite(db: DatabaseSync, owner: Owner, record: LifeModelRecord) {
	const table =
		owner === "step"
			? "life_model_receipts"
			: "life_publication_model_receipts";
	db.prepare(
		`UPDATE ${table} SET record_json=?,digest=? WHERE world_id=? AND request_id=?`,
	).run(
		canonicalLifeJson(record),
		lifeDigest(record),
		WORLD,
		record.prepared.request.id,
	);
}

test("v1 request and receipt bytes survive legacy SQLite audit/reopen unchanged", () => {
	const f = fixture(false);
	try {
		expect(canonicalLifeJson(parseLifeModelRequest(JSON.parse(V1_BYTES)))).toBe(
			V1_BYTES,
		);
		const saved = f.transaction(() =>
			f.ledger("step").prepare(prepared("step"), config()),
		);
		const before = f.db
			.prepare("SELECT record_json,digest FROM life_model_receipts")
			.get();
		f.reopen();
		expect(f.ledger("step").get(WORLD, "step-one", "request-one")).toEqual(
			saved,
		);
		expect(
			f.db.prepare("SELECT record_json,digest FROM life_model_receipts").get(),
		).toEqual(before);
		expect(f.ledger("step").usage(WORLD, config()).reservedInputTokens).toBe(
			40,
		);
	} finally {
		f.close();
	}
});

test("v2 strict request union rejects mixed ownership, lanes, versions and unknown fields", () => {
	const p = prepared("publication");
	expect(p.version).toBe(1);
	expect(p.request).toMatchObject({
		version: 2,
		jobId: "job-one",
		lane: "publication",
	});
	expect(Object.hasOwn(p.request, "stepId")).toBe(false);
	for (const value of [
		{ ...p.request, stepId: "step-one" },
		{ ...p.request, lane: "actor" },
		{ ...p.request, version: 1 },
		{ ...p.request, version: 3 },
		{ ...p.request, jobId: "" },
		{ ...p.request, command: "ignored" },
		{ ...JSON.parse(V1_BYTES), lane: "publication" },
		{ ...JSON.parse(V1_BYTES), jobId: "job-one" },
	])
		expect(() => parseLifeModelRequest(value)).toThrow();
});

for (const first of ["step", "publication"] as const) {
	const other = first === "step" ? "publication" : "step";
	test(`${first} reservation exhausts ${other} budget after reopen`, () => {
		const f = fixture();
		try {
			const p = prepared(first);
			f.transaction(() => f.ledger(first).prepare(p, config()));
			f.reopen();
			expect(f.ledger(other).usage(WORLD, config()).reservedInputTokens).toBe(
				40,
			);
			expect(() =>
				f.transaction(() =>
					f.ledger(other).prepare(prepared(other, "request-two"), config()),
				),
			).toThrow(/budget/);
			expect(f.ledger(other).list(WORLD)).toHaveLength(0);
		} finally {
			f.close();
		}
	});
	test(`${first} unknown blocks ${other} across window/config changes; completion releases exactly its reservation`, () => {
		const f = fixture();
		try {
			const a = prepared(first),
				b = prepared(other, "request-two");
			f.transaction(() => {
				f.ledger(first).prepare(a, config(80, 40));
				f.ledger(other).prepare(b, config(80, 40));
				f.ledger(first).dispatch(WORLD, ownerId(first), a.request.id);
				f.ledger(first).finish(WORLD, ownerId(first), a.request.id, {
					status: "unknown",
				});
			});
			f.advance();
			f.reopen();
			const next = { ...config(1000, 1000), revision: 2 };
			expect(f.ledger(other).usage(WORLD, next)).toMatchObject({
				reservedInputTokens: 80,
				reservedOutputTokens: 40,
				unknownRequests: 1,
			});
			expect(() =>
				f.transaction(() =>
					f.ledger(other).prepare(prepared(other, "request-three"), next),
				),
			).toThrow(/uncertain/);
			f.transaction(() =>
				f
					.ledger(first)
					.finish(WORLD, ownerId(first), a.request.id, completed(a)),
			);
			expect(f.ledger(other).usage(WORLD, next)).toMatchObject({
				inputTokens: 0,
				outputTokens: 0,
				reservedInputTokens: 40,
				reservedOutputTokens: 20,
				unknownRequests: 0,
			});
			f.transaction(() => {
				f.ledger(other).dispatch(WORLD, ownerId(other), b.request.id);
				f.ledger(other).finish(
					WORLD,
					ownerId(other),
					b.request.id,
					completed(b, 11, 5),
				);
			});
			f.reopen();
			expect(f.ledger(first).usage(WORLD, config(80, 40))).toMatchObject({
				inputTokens: 11,
				outputTokens: 5,
				reservedInputTokens: 0,
				reservedOutputTokens: 0,
				upstreamAttempts: 1,
			});
			expect(
				f.ledger(first).usage(WORLD, { ...next, usage: null }),
			).toMatchObject({
				inputTokens: 18,
				outputTokens: 8,
				upstreamAttempts: 2,
			});
		} finally {
			f.close();
		}
	});
	test(`${first} cannot accept the other request owner or reuse its world request ID`, () => {
		const f = fixture();
		try {
			expect(() =>
				f.transaction(() =>
					f.ledger(first).prepare(prepared(other), config(1000, 1000)),
				),
			).toThrow(/owner/);
			f.transaction(() =>
				f.ledger(first).prepare(prepared(first), config(1000, 1000)),
			);
			f.transaction(() =>
				f.ledger(first).cancelPrepared(WORLD, ownerId(first), "cancelled"),
			);
			f.reopen();
			expect(() =>
				f.transaction(() =>
					f.ledger(other).prepare(prepared(other), config(1000, 1000)),
				),
			).toThrow(/ownership|conflict/);
			expect(f.ledger(other).list(WORLD)).toHaveLength(0);
		} finally {
			f.close();
		}
	});
}

test("two SQLite connections cannot reserve the same last shared tokens", () => {
	const f = fixture(),
		peer = f.connect();
	try {
		f.transaction(() => {
			f.ledger("step").prepare(prepared("step"), config());
			expect(() => peer.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
		});
		peer.exec("BEGIN IMMEDIATE");
		try {
			expect(() =>
				new LifeModelReceipts(peer, () => 1000, "publication").prepare(
					prepared("publication", "request-two"),
					config(),
				),
			).toThrow(/budget/);
		} finally {
			peer.exec("ROLLBACK");
		}
		f.reopen();
		expect(
			f.ledger("publication").usage(WORLD, config()).reservedInputTokens,
		).toBe(40);
	} finally {
		peer.close();
		f.close();
	}
});

for (const owner of ["step", "publication"] as const) {
	for (const fault of [
		"digest",
		"branch",
		"missing-owner",
		"unsafe-usage",
	] as const) {
		test(`${owner} ${fault} corruption rejects real receipt audit on SQLite reopen`, () => {
			const f = fixture();
			try {
				const p = prepared(owner);
				const saved = f.transaction(() => f.ledger(owner).prepare(p, config()));
				const table =
					owner === "step"
						? "life_model_receipts"
						: "life_publication_model_receipts";
				if (fault === "digest")
					f.db.prepare(`UPDATE ${table} SET digest=?`).run("b".repeat(64));
				if (fault === "branch")
					overwrite(f.db, owner, {
						...saved,
						prepared: prepared(owner === "step" ? "publication" : "step"),
					});
				if (fault === "missing-owner") {
					f.db.exec("PRAGMA foreign_keys=OFF");
					f.db.exec(
						owner === "step"
							? "DELETE FROM life_steps"
							: "DELETE FROM life_publication_jobs",
					);
				}
				if (fault === "unsafe-usage") {
					f.transaction(() =>
						f.ledger(owner).dispatch(WORLD, ownerId(owner), p.request.id),
					);
					const done = f.transaction(() =>
						f
							.ledger(owner)
							.finish(WORLD, ownerId(owner), p.request.id, completed(p)),
					);
					// Valid JSON/digest, invalid integer usage must still fail parsing.
					const unsafe = JSON.stringify(done).replaceAll(
						'"inputTokens":7',
						'"inputTokens":7.5',
					);
					f.db
						.prepare(`UPDATE ${table} SET record_json=?,digest=?`)
						.run(unsafe, lifeDigest(JSON.parse(unsafe)));
				}
				expect(() => f.reopen()).toThrow();
			} finally {
				f.close();
			}
		});
	}
}

test("audit rejects request ID collisions injected across otherwise valid owner ledgers", () => {
	const f = fixture();
	try {
		f.transaction(() => {
			f.ledger("step").prepare(prepared("step"), config(1000, 1000));
			f.ledger("publication").prepare(
				prepared("publication", "request-two"),
				config(1000, 1000),
			);
		});
		const saved = f.ledger("publication").get(WORLD, "job-one", "request-two");
		const forged = { ...saved, prepared: prepared("publication") };
		f.db
			.prepare(
				"UPDATE life_publication_model_receipts SET request_id=?,record_json=?,digest=?",
			)
			.run("request-one", canonicalLifeJson(forged), lifeDigest(forged));
		expect(() => f.reopen()).toThrow(/ownership|conflict/);
	} finally {
		f.close();
	}
});

test("known publication table SQL errors never masquerade as a legacy absent table", () => {
	const f = fixture();
	try {
		f.db.exec(
			"ALTER TABLE life_publication_model_receipts RENAME COLUMN record_json TO broken_json",
		);
		expect(() => f.ledger("step").usage(WORLD, config())).toThrow();
		expect(() => f.reopen()).toThrow();
	} finally {
		f.close();
	}
});
