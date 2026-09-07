import {
	type LookupEntry,
	WORKING_GOAL_MAX_CHARS,
	WORKING_ITEM_MAX_CHARS,
	WORKING_LIST_MAX_ITEMS,
	WORKING_SOURCES_MAX,
	type WorkingFields,
	type WorkingState,
} from "./types.ts";

export interface WorkingRow {
	revision: number;
	goal: string;
	decisions: string;
	open_items: string;
	next_steps: string;
	source_entry_ids: string;
}

function stringList(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new Error(`invalid working ${field}`);
	if (!value.every((item): item is string => typeof item === "string"))
		throw new Error(`invalid working ${field}`);
	return value;
}

export function decodeWorkingRow(row: WorkingRow): WorkingState {
	return {
		revision: row.revision,
		goal: row.goal,
		decisions: stringList(JSON.parse(row.decisions), "decisions"),
		openItems: stringList(JSON.parse(row.open_items), "openItems"),
		nextSteps: stringList(JSON.parse(row.next_steps), "nextSteps"),
		sourceEntryIds: stringList(
			JSON.parse(row.source_entry_ids),
			"sourceEntryIds",
		),
	};
}

function boundedList(value: unknown, field: string): string[] {
	const list = stringList(value, field);
	if (list.length > WORKING_LIST_MAX_ITEMS)
		throw new Error(`working ${field} exceeds ${WORKING_LIST_MAX_ITEMS} items`);
	for (const item of list) {
		if (item.trim().length === 0)
			throw new Error(`working ${field} item must not be blank`);
		if (item.length > WORKING_ITEM_MAX_CHARS)
			throw new Error(
				`working ${field} item exceeds ${WORKING_ITEM_MAX_CHARS} characters`,
			);
	}
	return [...list];
}

const FIELD_KEYS = new Set([
	"goal",
	"decisions",
	"openItems",
	"nextSteps",
	"sourceEntryIds",
]);

/**
 * Validates a replacement of the working state. Every provided field replaces
 * the current value entirely; sourceEntryIds must resolve to real user entries.
 */
export function mergeWorkingFields(
	current: WorkingState,
	fields: WorkingFields,
	lookupEntry: LookupEntry,
): Omit<WorkingState, "revision"> {
	if (typeof fields !== "object" || fields === null || Array.isArray(fields))
		throw new Error("invalid working fields");
	for (const key of Object.keys(fields))
		if (!FIELD_KEYS.has(key)) throw new Error(`unknown working field ${key}`);
	const next = {
		goal: current.goal,
		decisions: current.decisions,
		openItems: current.openItems,
		nextSteps: current.nextSteps,
		sourceEntryIds: current.sourceEntryIds,
	};
	if (fields.goal !== undefined) {
		if (typeof fields.goal !== "string")
			throw new Error("invalid working goal");
		if (fields.goal.length > WORKING_GOAL_MAX_CHARS)
			throw new Error(
				`working goal exceeds ${WORKING_GOAL_MAX_CHARS} characters`,
			);
		next.goal = fields.goal;
	}
	if (fields.decisions !== undefined)
		next.decisions = boundedList(fields.decisions, "decisions");
	if (fields.openItems !== undefined)
		next.openItems = boundedList(fields.openItems, "openItems");
	if (fields.nextSteps !== undefined)
		next.nextSteps = boundedList(fields.nextSteps, "nextSteps");
	if (fields.sourceEntryIds !== undefined) {
		const ids = stringList(fields.sourceEntryIds, "sourceEntryIds");
		if (ids.length > WORKING_SOURCES_MAX)
			throw new Error(
				`working sourceEntryIds exceeds ${WORKING_SOURCES_MAX} references`,
			);
		if (new Set(ids).size !== ids.length)
			throw new Error("working sourceEntryIds must be unique");
		for (const id of ids) {
			if (lookupEntry(id)?.role !== "user")
				throw new Error(`working source is not a user entry: ${id}`);
		}
		next.sourceEntryIds = [...ids];
	}
	return next;
}
