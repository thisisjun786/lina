/**
 * Deviation note: 017 L65 says "MODIFY core `context/types.ts`의 읽기 투영 계약".
 * This plan satisfies that contract with a NEW sibling module re-exported from
 * `context/index.ts` because `context-wire.ts:118-162` re-projects `WorkingState`
 * field-by-field and `context.test.ts` asserts exact shapes — adding fields to
 * `WorkingState` would silently drop on the wire and churn the row codec.
 * Same public contract, different file; movable later without changing callers.
 */

import { createHash } from "node:crypto";
import {
	WORKING_GOAL_MAX_CHARS,
	WORKING_ITEM_MAX_CHARS,
	WORKING_LIST_MAX_ITEMS,
	WORKING_SOURCES_MAX,
	type WorkingState,
} from "./types.ts";
import { validId } from "./validation.ts";

/** Identifies the instruction whose text was last projected. */
export interface InstructionRef {
	requestId: string;
	entryId: string;
	/** sha256 hex of the instruction text. */
	textDigest: string;
}

/** Read-only view separating "what the user asked" from "what the agent is working on". */
export interface ContextReadProjection {
	schemaVersion: 1;
	workingRevision: number;
	instructionRevision: number;
	instruction: InstructionRef | null;
	working: WorkingState;
	projectedAt: string;
}

const ALLOWED_KEYS = new Set([
	"schemaVersion",
	"workingRevision",
	"instructionRevision",
	"instruction",
	"working",
	"projectedAt",
]);

const WORKING_KEYS = new Set([
	"revision",
	"goal",
	"decisions",
	"openItems",
	"nextSteps",
	"sourceEntryIds",
]);

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

const ISO_8601_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
	const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	if (month === 2) return isLeap ? 29 : 28;
	if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
	return 31;
}

function isIso8601(value: string): boolean {
	const match = ISO_8601_PATTERN.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const offsetHour = match[7] ? Number(match[7]) : 0;
	const offsetMinute = match[8] ? Number(match[8]) : 0;

	if (month < 1 || month > 12) return false;
	if (day < 1 || day > daysInMonth(year, month)) return false;
	if (hour > 23) return false;
	if (minute > 59) return false;
	if (second > 59) return false;
	if (offsetHour > 23) return false;
	if (offsetMinute > 59) return false;

	return Number.isFinite(Date.parse(value));
}

function reject(message: string): never {
	throw new Error(message);
}

function parseBoundedStringList(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) reject(`invalid working ${field}`);
	if (value.length > WORKING_LIST_MAX_ITEMS) reject(`invalid working ${field}`);
	for (const item of value) {
		if (typeof item !== "string" || item.trim().length === 0)
			reject(`invalid working ${field}`);
		if (item.length > WORKING_ITEM_MAX_CHARS)
			reject(`invalid working ${field}`);
	}
	return [...(value as string[])];
}

function parseWorking(value: unknown): WorkingState {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		reject("invalid context read projection working");
	const obj = value as Partial<Record<keyof WorkingState, unknown>>;
	for (const key of Object.keys(obj)) {
		if (!WORKING_KEYS.has(key))
			reject(`unknown context read projection working field ${key}`);
	}
	const revision = obj.revision;
	if (!Number.isSafeInteger(revision) || (revision as number) < 0)
		reject("invalid context read projection working revision");
	const goal = obj.goal;
	if (typeof goal !== "string" || goal.length > WORKING_GOAL_MAX_CHARS)
		reject("invalid context read projection working goal");
	return {
		revision: revision as number,
		goal,
		decisions: parseBoundedStringList(obj.decisions, "decisions"),
		openItems: parseBoundedStringList(obj.openItems, "openItems"),
		nextSteps: parseBoundedStringList(obj.nextSteps, "nextSteps"),
		sourceEntryIds: parseSourceEntryIds(obj.sourceEntryIds),
	};
}

function parseSourceEntryIds(value: unknown): string[] {
	if (!Array.isArray(value)) reject("invalid working sourceEntryIds");
	if (value.length > WORKING_SOURCES_MAX)
		reject("invalid working sourceEntryIds");
	const ids = value.map((item) => validId(item, "working sourceEntryIds"));
	if (new Set(ids).size !== ids.length)
		reject("working sourceEntryIds must be unique");
	return ids;
}

function parseInstructionRef(value: unknown): InstructionRef {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		reject("invalid context read projection instruction");
	const obj = value as Partial<Record<keyof InstructionRef, unknown>>;
	for (const key of Object.keys(obj)) {
		if (!["requestId", "entryId", "textDigest"].includes(key))
			reject(`unknown context read projection instruction field ${key}`);
	}
	const requestId = validId(
		obj.requestId,
		"context read projection instruction requestId",
	);
	const entryId = validId(
		obj.entryId,
		"context read projection instruction entryId",
	);
	const textDigest = obj.textDigest;
	if (typeof textDigest !== "string" || !/^[0-9a-f]{64}$/.test(textDigest))
		reject("invalid context read projection instruction textDigest");
	return { requestId, entryId, textDigest };
}

function sameInstruction(
	a: InstructionRef | null,
	b: InstructionRef | null,
): boolean {
	if (a === null && b === null) return true;
	if (a === null || b === null) return false;
	return (
		a.requestId === b.requestId &&
		a.entryId === b.entryId &&
		a.textDigest === b.textDigest
	);
}

function copyWorking(working: WorkingState): WorkingState {
	return {
		revision: working.revision,
		goal: working.goal,
		decisions: [...working.decisions],
		openItems: [...working.openItems],
		nextSteps: [...working.nextSteps],
		sourceEntryIds: [...working.sourceEntryIds],
	};
}

function validateInput(
	working: WorkingState,
	projectedAt: string,
	instruction: { requestId: string; entryId: string; text: string } | null,
): void {
	// Validate working against the same bounds the store uses.
	try {
		parseWorking(working);
		if (instruction !== null) {
			validId(instruction.requestId, "instruction requestId");
			validId(instruction.entryId, "instruction entryId");
		}
	} catch {
		reject("invalid context read projection input");
	}
	if (typeof projectedAt !== "string" || !isIso8601(projectedAt))
		reject("invalid context read projection input");
}

/**
 * Builds a read projection from a working state and an optional instruction.
 * `workingRevision` is always taken from `working.revision`; `instructionRevision`
 * advances whenever the instruction identity changes.
 */
export function buildContextReadProjection(input: {
	working: WorkingState;
	instruction: { requestId: string; entryId: string; text: string } | null;
	previous: ContextReadProjection | null;
	projectedAt: string;
}): ContextReadProjection {
	const { working, instruction, projectedAt } = input;
	const previous =
		input.previous === null ? null : parseContextReadProjection(input.previous);
	validateInput(working, projectedAt, instruction);

	let instructionRef: InstructionRef | null = null;
	if (instruction !== null) {
		instructionRef = {
			requestId: instruction.requestId,
			entryId: instruction.entryId,
			textDigest: sha256Hex(instruction.text),
		};
	}
	let instructionRevision = instructionRef === null ? 0 : 1;
	if (previous !== null)
		instructionRevision =
			previous.instructionRevision +
			(sameInstruction(previous.instruction, instructionRef) ? 0 : 1);
	if (!Number.isSafeInteger(instructionRevision))
		reject("invalid context read projection instructionRevision");

	return {
		schemaVersion: 1,
		workingRevision: working.revision,
		instructionRevision,
		instruction: instructionRef,
		working: copyWorking(working),
		projectedAt,
	};
}

/** Parses and validates a serialized read projection. */
export function parseContextReadProjection(
	value: unknown,
): ContextReadProjection {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		reject("invalid context read projection");
	const obj = value as Partial<Record<keyof ContextReadProjection, unknown>>;

	const schemaVersion = obj.schemaVersion;
	if (schemaVersion !== 1)
		reject("Unsupported context read projection schema version");

	for (const key of Object.keys(obj)) {
		if (!ALLOWED_KEYS.has(key))
			reject(`unknown context read projection field ${key}`);
	}

	const workingRevision = obj.workingRevision;
	if (!Number.isSafeInteger(workingRevision) || (workingRevision as number) < 0)
		reject("invalid context read projection workingRevision");

	const instructionRevision = obj.instructionRevision;
	if (
		!Number.isSafeInteger(instructionRevision) ||
		(instructionRevision as number) < 0
	)
		reject("invalid context read projection instructionRevision");

	const instructionRaw = obj.instruction;
	if (instructionRaw !== null && instructionRaw !== undefined)
		parseInstructionRef(instructionRaw);

	if ((instructionRevision as number) === 0 && instructionRaw !== null)
		reject("invalid context read projection instructionRevision");

	const projectedAt = obj.projectedAt;
	if (typeof projectedAt !== "string" || !isIso8601(projectedAt))
		reject("invalid context read projection projectedAt");

	const working = parseWorking(obj.working);
	if (working.revision !== workingRevision)
		reject("invalid context read projection workingRevision");

	return {
		schemaVersion: 1,
		workingRevision: workingRevision as number,
		instructionRevision: instructionRevision as number,
		instruction:
			instructionRaw === null ? null : parseInstructionRef(instructionRaw),
		working,
		projectedAt,
	};
}
