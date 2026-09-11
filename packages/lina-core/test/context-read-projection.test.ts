import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	buildContextReadProjection,
	type ContextReadProjection,
	type InstructionRef,
	parseContextReadProjection,
	WORKING_GOAL_MAX_CHARS,
	WORKING_ITEM_MAX_CHARS,
	WORKING_LIST_MAX_ITEMS,
	WORKING_SOURCES_MAX,
	type WorkingState,
} from "../src/context/index.ts";
import { ContextStore } from "../src/context/store.ts";
import { appendContextEntry } from "./context-journal-fixture.ts";
import { entry, Fixture } from "./fixture.ts";

describe("ContextReadProjection", () => {
	let fixture: Fixture;
	let file: string;
	let store: ContextStore;

	const openStore = () => {
		const durable = fixture.store();
		return fixture.keep(
			new ContextStore(file, fixture.binding, (id) => durable.sourceEntry(id), {
				lookupRequest: (id) =>
					durable.sourceEntry(durable.request(id)?.entryId ?? ""),
			}),
		);
	};

	beforeEach(() => {
		fixture = new Fixture();
		file = join(fixture.dir, "context.sqlite");
		store = openStore();
	});

	afterEach(() => fixture.close());

	function makeInstruction(
		entryId: string,
		text: string,
	): {
		requestId: string;
		entryId: string;
		text: string;
	} {
		const requestId = appendContextEntry(
			fixture.store(),
			fixture.binding.sessionId,
			entry(entryId, { role: "user", text }),
		);
		return { requestId, entryId, text };
	}

	it("increments workingRevision when store working changes, keeps instructionRevision stable", () => {
		const instruction = makeInstruction("i1", "hello");
		const requestId = instruction.requestId;
		const projectedAt = "2026-09-10T00:00:00.000Z";
		const working = store.working();
		const p0 = buildContextReadProjection({
			working,
			instruction,
			previous: null,
			projectedAt,
		});
		expect(p0.workingRevision).toBe(working.revision);
		expect(p0.instructionRevision).toBe(1);

		const updated = store.updateWorking(
			p0.workingRevision,
			{ goal: "g2" },
			{ activeRequestId: requestId },
		);
		const p1 = buildContextReadProjection({
			working: updated,
			instruction,
			previous: p0,
			projectedAt,
		});
		expect(p1.workingRevision).toBe(p0.workingRevision + 1);
		expect(p1.instructionRevision).toBe(p0.instructionRevision);
	});

	it("increments instructionRevision when entryId changes, keeps workingRevision stable", () => {
		const instruction1 = makeInstruction("i1", "hello");
		const projectedAt = "2026-09-10T00:00:00.000Z";
		const working = store.working();
		const p0 = buildContextReadProjection({
			working,
			instruction: instruction1,
			previous: null,
			projectedAt,
		});
		const instruction2 = makeInstruction("i2", "hello");
		const p1 = buildContextReadProjection({
			working,
			instruction: instruction2,
			previous: p0,
			projectedAt,
		});
		expect(p1.instructionRevision).toBe(p0.instructionRevision + 1);
		expect(p1.workingRevision).toBe(p0.workingRevision);
	});

	it("increments instructionRevision when text changes for the same entry", () => {
		const instruction1 = makeInstruction("i1", "hello");
		const projectedAt = "2026-09-10T00:00:00.000Z";
		const working = store.working();
		const p0 = buildContextReadProjection({
			working,
			instruction: instruction1,
			previous: null,
			projectedAt,
		});
		const instruction2 = { ...instruction1, text: "world" };
		const p1 = buildContextReadProjection({
			working,
			instruction: instruction2,
			previous: p0,
			projectedAt,
		});
		expect(p1.instructionRevision).toBe(p0.instructionRevision + 1);
		expect(p1.workingRevision).toBe(p0.workingRevision);
	});

	it("starts instructionRevision at 0 when there is no instruction and no previous", () => {
		const working = store.working();
		const projectedAt = "2026-09-10T00:00:00.000Z";
		const p = buildContextReadProjection({
			working,
			instruction: null,
			previous: null,
			projectedAt,
		});
		expect(p.instructionRevision).toBe(0);
		expect(p.instruction).toBeNull();
	});

	it("copies working state so later mutation of the source arrays cannot leak in", () => {
		const working = store.working();
		const projectedAt = "2026-09-10T00:00:00.000Z";
		const p = buildContextReadProjection({
			working,
			instruction: null,
			previous: null,
			projectedAt,
		});
		working.decisions.push("mutation");
		working.openItems.push("mutation");
		working.nextSteps.push("mutation");
		working.sourceEntryIds.push("mutation");
		expect(p.working.decisions).not.toContain("mutation");
		expect(p.working.openItems).not.toContain("mutation");
		expect(p.working.nextSteps).not.toContain("mutation");
		expect(p.working.sourceEntryIds).not.toContain("mutation");
	});

	it("round-trips a golden projection through parseContextReadProjection byte-identically", () => {
		const working: WorkingState = {
			revision: 3,
			goal: "g",
			decisions: ["d1"],
			openItems: ["o1"],
			nextSteps: ["n1"],
			sourceEntryIds: ["s1"],
		};
		const instruction: InstructionRef = {
			requestId: "req-1",
			entryId: "e1",
			textDigest:
				"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		};
		const golden: ContextReadProjection = {
			schemaVersion: 1,
			workingRevision: 3,
			instructionRevision: 2,
			instruction,
			working,
			projectedAt: "2026-09-10T00:00:00.000Z",
		};
		const parsed = parseContextReadProjection(golden);
		expect(JSON.stringify(parsed)).toBe(JSON.stringify(golden));
	});

	it("rejects unsupported schemaVersion, workingRevision mismatch, and unknown fields", () => {
		const working: WorkingState = {
			revision: 3,
			goal: "g",
			decisions: [],
			openItems: [],
			nextSteps: [],
			sourceEntryIds: [],
		};
		const base = {
			schemaVersion: 1,
			workingRevision: 3,
			instructionRevision: 0,
			instruction: null,
			working,
			projectedAt: "2026-09-10T00:00:00.000Z",
		};
		expect(() =>
			parseContextReadProjection({ ...base, schemaVersion: 2 }),
		).toThrow(/Unsupported context read projection schema version/);
		expect(() =>
			parseContextReadProjection({ ...base, workingRevision: 4 }),
		).toThrow(/invalid context read projection workingRevision/);
		expect(() =>
			parseContextReadProjection({ ...base, unknownField: true }),
		).toThrow(/unknown context read projection field unknownField/);
	});

	it("rejects instruction non-null when instructionRevision is zero", () => {
		const working: WorkingState = {
			revision: 3,
			goal: "g",
			decisions: [],
			openItems: [],
			nextSteps: [],
			sourceEntryIds: [],
		};
		const instruction: InstructionRef = {
			requestId: "req-1",
			entryId: "e1",
			textDigest:
				"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		};
		expect(() =>
			parseContextReadProjection({
				schemaVersion: 1,
				workingRevision: 3,
				instructionRevision: 0,
				instruction,
				working,
				projectedAt: "2026-09-10T00:00:00.000Z",
			}),
		).toThrow(/invalid context read projection instructionRevision/);
	});

	it("rejects non-ISO projectedAt in builder and parser", () => {
		const working = store.working();
		const instruction = makeInstruction("i1", "hello");
		expect(() =>
			buildContextReadProjection({
				working,
				instruction,
				previous: null,
				projectedAt: "September 10, 2026",
			}),
		).toThrow(/invalid context read projection input/);
		expect(() =>
			parseContextReadProjection({
				schemaVersion: 1,
				workingRevision: working.revision,
				instructionRevision: 1,
				instruction: null,
				working,
				projectedAt: "September 10, 2026",
			}),
		).toThrow(/invalid context read projection projectedAt/);
		const iso = "2026-09-11T00:00:00.000Z";
		expect(() =>
			buildContextReadProjection({
				working,
				instruction,
				previous: null,
				projectedAt: iso,
			}),
		).not.toThrow();
		expect(() =>
			parseContextReadProjection({
				schemaVersion: 1,
				workingRevision: working.revision,
				instructionRevision: 1,
				instruction: null,
				working,
				projectedAt: iso,
			}),
		).not.toThrow();
	});

	it("builder validates working state against the same bounds as the store", () => {
		const instruction = makeInstruction("i1", "hello");
		const projectedAt = "2026-09-10T00:00:00.000Z";
		const base = store.working();
		expect(() =>
			buildContextReadProjection({
				working: { ...base, goal: "x".repeat(WORKING_GOAL_MAX_CHARS + 1) },
				instruction,
				previous: null,
				projectedAt,
			}),
		).toThrow(/invalid context read projection input/);
		expect(() =>
			buildContextReadProjection({
				working: {
					...base,
					decisions: Array.from(
						{ length: WORKING_LIST_MAX_ITEMS + 1 },
						(_, i) => `d${i}`,
					),
				},
				instruction,
				previous: null,
				projectedAt,
			}),
		).toThrow(/invalid context read projection input/);
		expect(() =>
			buildContextReadProjection({
				working: {
					...base,
					openItems: ["x".repeat(WORKING_ITEM_MAX_CHARS + 1)],
				},
				instruction,
				previous: null,
				projectedAt,
			}),
		).toThrow(/invalid context read projection input/);
		expect(() =>
			buildContextReadProjection({
				working: {
					...base,
					sourceEntryIds: Array.from(
						{ length: WORKING_SOURCES_MAX + 1 },
						(_, i) => `s${i}`,
					),
				},
				instruction,
				previous: null,
				projectedAt,
			}),
		).toThrow(/invalid context read projection input/);
	});

	it("builder output round-trips through parseContextReadProjection", () => {
		const instruction = makeInstruction("i1", "hello");
		const projectedAt = "2026-09-10T00:00:00.000Z";
		const built = buildContextReadProjection({
			working: store.working(),
			instruction,
			previous: null,
			projectedAt,
		});
		const roundTripped = parseContextReadProjection(
			JSON.parse(JSON.stringify(built)),
		);
		expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(built));
	});

	it("isIso8601 rejects impossible calendar dates and invalid time/offset components", () => {
		const instruction = makeInstruction("i1", "hello");
		const working = store.working();

		const rejected = [
			"2026-02-30T00:00:00.000Z",
			"2026-04-31T00:00:00.000Z",
			"2023-02-29T00:00:00.000Z",
			"2026-13-01T00:00:00.000Z",
			"2026-00-10T00:00:00.000Z",
			"2026-09-00T00:00:00.000Z",
			"2026-09-10T24:00:00.000Z",
			"2026-09-10T23:60:00.000Z",
			"2026-09-10T23:59:60.000Z",
			"2026-09-10T00:00:00.000+24:00",
		];
		for (const projectedAt of rejected) {
			expect(() =>
				buildContextReadProjection({
					working,
					instruction,
					previous: null,
					projectedAt,
				}),
			).toThrow(/invalid context read projection input/);
			expect(() =>
				parseContextReadProjection({
					schemaVersion: 1,
					workingRevision: working.revision,
					instructionRevision: 1,
					instruction: null,
					working,
					projectedAt,
				}),
			).toThrow(/invalid context read projection projectedAt/);
		}

		const accepted = [
			"2024-02-29T00:00:00.000Z",
			"2000-02-29T00:00:00.000Z",
			"2026-12-31T23:59:59.999Z",
			"2026-09-10T00:00:00+09:00",
		];
		for (const projectedAt of accepted) {
			const built = buildContextReadProjection({
				working,
				instruction,
				previous: null,
				projectedAt,
			});
			expect(built.projectedAt).toBe(projectedAt);
			const roundTripped = parseContextReadProjection(
				JSON.parse(JSON.stringify(built)),
			);
			expect(roundTripped.projectedAt).toBe(projectedAt);
		}
	});
});
