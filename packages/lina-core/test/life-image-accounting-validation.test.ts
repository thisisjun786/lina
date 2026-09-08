import { expect, test } from "bun:test";
import { ImageAccounting } from "../src/world/image-accounting.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import {
	accountingFixture,
	output,
} from "./life-image-accounting-fixture.test.ts";

test.each([
	["worldId", "foreign"],
	["agentId", "foreign"],
	["intentId", "foreign"],
	["attemptId", "foreign"],
	["jobId", "00000000-0000-4000-8000-999999999999"],
	["kind", "avatar"],
	["sourceLifeRevision", 999],
	["settingsRevision", 2],
	["configRevision", 2],
	["frozenDigest", "e".repeat(64)],
] as const)(
	"reservation must match actual linked history for %s",
	(key, changed) => {
		const f = accountingFixture();
		try {
			const input = f.input();
			expect(() =>
				f.tx(() =>
					f.ledger.prepare({
						...input,
						binding: { ...input.binding, [key]: changed },
					}),
				),
			).toThrow();
			expect(f.ledger.usage("world").count.total).toBe(0);
		} finally {
			f.close();
		}
	},
);

test("strict JSON, safe integers and explicit byte bounds reject before any durable reservation", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		for (const changed of [
			{ ...input, outputBytes: 2_097_153 },
			{ ...input, outputBytes: 0 },
			{ ...input, outputBytes: 1.1 },
			{ ...input, metadataBytes: 262_145 },
			{ ...input, metadataBytes: 1 },
			{ ...input, manifestBytes: Number.MAX_SAFE_INTEGER + 1 },
			{ ...input, binding: { ...input.binding, sourceLifeRevision: -1 } },
			{
				...input,
				binding: {
					...input.binding,
					configRevision: Number.MAX_SAFE_INTEGER + 1,
				},
			},
			{ ...input, binding: { ...input.binding, frozenDigest: "not-a-digest" } },
			{ ...input, surprise: true },
			{ ...input, binding: { ...input.binding, surprise: true } },
		])
			expect(() => f.tx(() => f.ledger.prepare(changed))).toThrow();
		let accessorCalled = false;
		const getter = {
			...input,
			get outputBytes() {
				accessorCalled = true;
				return 1024;
			},
		};
		expect(() => f.tx(() => f.ledger.prepare(getter))).toThrow();
		expect(accessorCalled).toBe(false);
		expect(f.ledger.usage("world").storage.totalBytes).toBe(0);
	} finally {
		f.close();
	}
});

test("caller transaction rollback leaves no partial count or storage row", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		expect(() => f.ledger.prepare(input)).toThrow(/BEGIN IMMEDIATE/);
		f.db.exec(
			"CREATE TRIGGER reject_image_storage BEFORE INSERT ON life_image_storage BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END",
		);
		expect(() => f.tx(() => f.ledger.prepare(input))).toThrow(
			/synthetic disk failure/,
		);
		expect(f.ledger.usage("world").count.total).toBe(0);
		f.connect().ledger.validate();
	} finally {
		f.close();
	}
});

test.each([
	"digest",
	"json",
	"unknown_key",
	"unsafe_integer",
	"count_state",
	"storage_state",
	"missing_storage",
	"settings_history",
	"config_history",
	"attempt_history",
	"foreign_owner",
	"binding_digest",
] as const)("startup rejects %s corruption from real SQLite reopen", (kind) => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		if (kind === "digest")
			f.db.exec("UPDATE life_image_counts SET digest='bad'");
		if (kind === "json")
			f.db.exec("UPDATE life_image_counts SET record_json=' ' || record_json");
		if (kind === "binding_digest")
			f.db.exec("UPDATE life_image_counts SET binding_digest='bad'");
		if (kind === "missing_storage") f.db.exec("DELETE FROM life_image_storage");
		if (kind === "settings_history")
			f.db.exec("DELETE FROM fixture_authority WHERE kind='settings'");
		if (kind === "config_history")
			f.db.exec("DELETE FROM fixture_authority WHERE kind='config'");
		if (kind === "attempt_history")
			f.db.exec("DELETE FROM fixture_authority WHERE kind='attempt'");
		if (kind === "foreign_owner") {
			f.save("settings", "world", 1, { ...f.settings, worldId: "other" });
		}
		if (
			kind === "unknown_key" ||
			kind === "unsafe_integer" ||
			kind === "count_state"
		) {
			const record = JSON.parse(
				String(
					f.db.prepare("SELECT record_json FROM life_image_counts").get()?.[
						"record_json"
					],
				),
			);
			if (kind === "unknown_key") record.surprise = true;
			if (kind === "count_state") {
				record.state = "attempted";
				record.terminal = "failed";
			}
			if (kind === "unsafe_integer") {
				// Keep valid JSON while bypassing the application's safe-integer encoder.
				record.createdAtMs = 9007199254740992;
				f.db
					.prepare("UPDATE life_image_counts SET record_json=?")
					.run(JSON.stringify(record));
			} else
				f.db
					.prepare("UPDATE life_image_counts SET record_json=?,digest=?")
					.run(canonicalLifeJson(record), lifeDigest(record));
		}
		if (kind === "storage_state") {
			const record = {
				version: 1,
				outputState: "released",
				asset: null,
				metadata: null,
				manifest: null,
			};
			f.db
				.prepare("UPDATE life_image_storage SET record_json=?,digest=?")
				.run(canonicalLifeJson(record), lifeDigest(record));
		}
		expect(() => f.connect().ledger.validate()).toThrow();
	} finally {
		f.close();
	}
});

test("settlement replay cannot change a terminal result or import identity", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		const original = f.tx(() => f.ledger.prepare(input));
		expect(f.tx(() => f.ledger.prepare(input))).toEqual(original);
		expect(() =>
			f.tx(() => f.ledger.prepare({ ...input, metadataBytes: 32768 })),
		).toThrow(/conflict/);
		f.tx(() => f.ledger.beforeSubmit(input.binding));
		f.tx(() =>
			f.ledger.settle(input.binding, {
				kind: "result",
				resultFilename: "result.png",
			}),
		);
		for (const observed of [
			{ kind: "unknown" },
			{ kind: "failed" },
			{ kind: "no_post" },
			{ kind: "result", resultFilename: "another.png" },
		] as const)
			expect(() =>
				f.tx(() => f.ledger.settle(input.binding, observed)),
			).toThrow(/conflict/);
		expect(() =>
			f.tx(() =>
				f.ledger.importOutput(
					input.binding,
					output("00000000-0000-4000-8000-999999999999"),
				),
			),
		).toThrow(/identity/);
		f.tx(() =>
			f.ledger.importOutput(input.binding, output(input.binding.jobId)),
		);
		expect(() => f.tx(() => f.ledger.abandonOutput(input.binding))).toThrow(
			/retained/,
		);
		for (const changed of [
			{ ...output(input.binding.jobId), sha256: "f".repeat(64) },
			{ ...output(input.binding.jobId), mime: "image/jpeg" as const },
		])
			expect(() =>
				f.tx(() => f.ledger.importOutput(input.binding, changed)),
			).toThrow(/conflict/);
		f.connect().ledger.validate();
	} finally {
		f.close();
	}
});

test("reads do not mutate accounting or trigger prepare/submit authority", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		const before = f.db.prepare("SELECT total_changes() AS n").get();
		for (let index = 0; index < 3; index++) {
			f.ledger.usage("world");
			f.ledger.get(input.binding);
			f.ledger.validate();
		}
		expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
	} finally {
		f.close();
	}
});

test("archived manifest provenance is immutable even when a corrupt row has a recomputed digest", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		f.tx(() =>
			f.ledger.recordManifest(input.binding, {
				sha256: "c".repeat(64),
				size: 1000,
			}),
		);
		f.tx(() => f.ledger.beforeSubmit(input.binding));
		f.tx(() => f.ledger.settle(input.binding, { kind: "failed" }));
		f.tx(() =>
			f.ledger.archive(
				input.binding,
				{ sha256: "d".repeat(64), size: 1000 },
				true,
			),
		);
		const row = JSON.parse(
			String(
				f.db.prepare("SELECT record_json FROM life_image_storage").get()?.[
					"record_json"
				],
			),
		);
		row.manifest.sha256 = "e".repeat(64);
		f.db
			.prepare("UPDATE life_image_storage SET record_json=?,digest=?")
			.run(canonicalLifeJson(row), lifeDigest(row));
		expect(() => f.connect().ledger.validate()).toThrow(/archive/);
	} finally {
		f.close();
	}
});

test("asynchronous attempt verifier cannot silently authorize a reservation", () => {
	const f = accountingFixture();
	try {
		const ledger = new ImageAccounting(
			f.db,
			{ ...f.source(f.db), verifyAttempt: () => Promise.resolve() },
			() => 1000,
		);
		const input = f.input();
		expect(() => f.tx(() => ledger.prepare(input))).toThrow(/synchronous/);
		expect(f.ledger.usage("world").count.total).toBe(0);
	} finally {
		f.close();
	}
});

test.each(["result.PNG", "scene 1.jpeg", "결과.png"])(
	"known output filename %s preserves the existing image-owner contract",
	(resultFilename) => {
		const f = accountingFixture();
		try {
			const input = f.input();
			f.tx(() => f.ledger.prepare(input));
			f.tx(() => f.ledger.beforeSubmit(input.binding));
			f.tx(() =>
				f.ledger.settle(input.binding, { kind: "result", resultFilename }),
			);
			expect(f.connect().ledger.get(input.binding).resultFilename).toBe(
				resultFilename,
			);
		} finally {
			f.close();
		}
	},
);

test("unsafe result filenames never turn an uncertain dispatch into a recoverable output", () => {
	const f = accountingFixture();
	try {
		const input = f.input();
		f.tx(() => f.ledger.prepare(input));
		f.tx(() => f.ledger.beforeSubmit(input.binding));
		for (const resultFilename of [
			"../result.png",
			"dir/result.png",
			"dir\\result.png",
			"image%2f.png",
			"x.png?secret",
			"a\u0000.png",
			`${"가".repeat(84)}.png`,
		])
			expect(() =>
				f.tx(() =>
					f.ledger.settle(input.binding, { kind: "result", resultFilename }),
				),
			).toThrow(/filename/);
		expect(f.ledger.get(input.binding).state).toBe("unknown");
		expect(f.ledger.usage("world").storage.outputBytes).toBe(2_097_152);
	} finally {
		f.close();
	}
});
