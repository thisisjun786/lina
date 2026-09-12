import { createHash } from "node:crypto";
import type { OptionKey } from "./judgment.ts";
import { boundedId, boundedText } from "./validation.ts";

export const PERSONAL_CATALOG_ID = "personal.v1" as const;
export const PERSONAL_OPTION_KINDS = [
	"intention.adopt",
	"intention.activate",
	"intention.suspend",
	"intention.resume",
	"intention.cancel",
	"intention.complete",
	"task.start",
	"task.send",
	"task.interrupt",
	"task.handover",
	"inquire",
	"defer",
	"noop",
] as const;
export type PersonalOptionKind = (typeof PERSONAL_OPTION_KINDS)[number];
export const EFFECT_OWNERS = [
	"judgment_store",
	"task_manager",
	"host",
	"none",
] as const;
export type EffectOwner = (typeof EFFECT_OWNERS)[number];

export type PersonalPrecondition =
	| {
			kind: "intention.adopt";
			intentionKind: "user_commitment" | "autonomous_goal";
			sourceRef: string;
	  }
	| { kind: "intention.activate"; intentionId: string }
	| {
			kind: "intention.suspend" | "intention.resume";
			intentionId: string;
			acceptanceSourceRef: string;
			reason: string;
	  }
	| {
			kind: "intention.cancel";
			intentionId: string;
			acceptanceSourceRef: string;
			authorityRef: string;
			userConfirmationRef: string | null;
	  }
	| { kind: "intention.complete"; intentionId: string; outcomeRef: string }
	| {
			kind: "task.start";
			authorityRef: string;
			taskText: string;
			intentionId: string;
	  }
	| {
			kind: "task.send" | "task.interrupt" | "task.handover";
			taskId: string;
			ownerId: string;
			revision: number;
	  }
	| { kind: "inquire"; authorityRef: string }
	| { kind: "defer"; resumeCondition: string }
	| { kind: "noop"; reason: string };

export type CanonicalOption = {
	schemaVersion: 1;
	catalogId: typeof PERSONAL_CATALOG_ID;
	kind: PersonalOptionKind;
	actor: { agentId: string; scopeId: string };
	targetId: string | null;
	args: Record<string, string>;
	preconditions: PersonalPrecondition;
	effect: { owner: EffectOwner; scope: string };
	optionKey: OptionKey;
};

const owners: Record<PersonalOptionKind, EffectOwner> = {
	"intention.adopt": "judgment_store",
	"intention.activate": "judgment_store",
	"intention.suspend": "judgment_store",
	"intention.resume": "judgment_store",
	"intention.cancel": "judgment_store",
	"intention.complete": "judgment_store",
	"task.start": "task_manager",
	"task.send": "task_manager",
	"task.interrupt": "task_manager",
	"task.handover": "task_manager",
	inquire: "host",
	defer: "none",
	noop: "none",
};

function object(value: unknown, label: string): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		throw Error(`invalid ${label}`);
	return value as Record<string, unknown>;
}
function fields(
	row: Record<string, unknown>,
	keys: readonly string[],
	label: string,
): void {
	for (const key of Object.keys(row))
		if (!keys.includes(key)) throw Error(`unknown ${label} field ${key}`);
	for (const key of keys)
		if (!Object.hasOwn(row, key)) throw Error(`missing ${label} field ${key}`);
}
function optionKind(value: unknown): PersonalOptionKind {
	const text = boundedId(value, "option kind").toLowerCase();
	const kind = PERSONAL_OPTION_KINDS.find((kind) => kind === text);
	if (kind === undefined) throw Error("unknown personal.v1 option kind");
	return kind;
}
function target(value: unknown): string | null {
	const id = value === null ? null : boundedId(value, "target id").trim();
	if (id === "-") throw Error("reserved target id");
	return id;
}

export function normalizeOptionArgs(
	args: Record<string, string>,
): Record<string, string> {
	const row = object(args, "option args");
	return Object.fromEntries(
		Object.keys(row)
			.sort()
			.flatMap((key) => {
				boundedId(key, "option argument key");
				const value = row[key];
				if (typeof value !== "string") throw Error("invalid option argument");
				const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
				if (normalized === "") return [];
				boundedText(value, "option argument");
				return [[key, boundedText(normalized, "option argument")]];
			}),
	);
}

export function canonicalOptionKey(
	option: Omit<CanonicalOption, "optionKey">,
): OptionKey {
	const hash = createHash("sha256")
		.update(JSON.stringify(normalizeOptionArgs(option.args)))
		.digest("hex");
	return `${option.catalogId}:${optionKind(option.kind)}:${target(option.targetId) ?? "-"}:${hash}`;
}

function parsePrecondition(
	value: unknown,
	kind: PersonalOptionKind,
): PersonalPrecondition {
	const row: Record<string, unknown> & {
		kind?: unknown;
		intentionKind?: unknown;
		userConfirmationRef?: unknown;
		revision?: unknown;
	} = object(value, "personal precondition");
	if (row.kind !== kind) throw Error("precondition kind mismatch");
	const check = (...keys: string[]) =>
		fields(row, ["kind", ...keys], "personal precondition");
	const id = (key: string) => boundedId(row[key], key);
	const text = (key: string) => boundedText(row[key], key);
	switch (kind) {
		case "intention.adopt": {
			check("intentionKind", "sourceRef");
			const intentionKind = row.intentionKind;
			if (
				intentionKind !== "user_commitment" &&
				intentionKind !== "autonomous_goal"
			)
				throw Error("invalid adoption intention kind");
			return { kind, intentionKind, sourceRef: id("sourceRef") };
		}
		case "intention.activate":
			check("intentionId");
			return { kind, intentionId: id("intentionId") };
		case "intention.suspend":
		case "intention.resume":
			check("intentionId", "acceptanceSourceRef", "reason");
			return {
				kind,
				intentionId: id("intentionId"),
				acceptanceSourceRef: id("acceptanceSourceRef"),
				reason: text("reason"),
			};
		case "intention.cancel":
			check(
				"intentionId",
				"acceptanceSourceRef",
				"authorityRef",
				"userConfirmationRef",
			);
			return {
				kind,
				intentionId: id("intentionId"),
				acceptanceSourceRef: id("acceptanceSourceRef"),
				authorityRef: id("authorityRef"),
				userConfirmationRef:
					row.userConfirmationRef === null ? null : id("userConfirmationRef"),
			};
		case "intention.complete":
			check("intentionId", "outcomeRef");
			return {
				kind,
				intentionId: id("intentionId"),
				outcomeRef: id("outcomeRef"),
			};
		case "task.start":
			check("authorityRef", "taskText", "intentionId");
			return {
				kind,
				authorityRef: id("authorityRef"),
				taskText: text("taskText"),
				intentionId: id("intentionId"),
			};
		case "task.send":
		case "task.interrupt":
		case "task.handover": {
			check("taskId", "ownerId", "revision");
			const revision = row.revision;
			if (
				typeof revision !== "number" ||
				!Number.isSafeInteger(revision) ||
				revision < 0
			)
				throw Error("invalid task revision");
			return { kind, taskId: id("taskId"), ownerId: id("ownerId"), revision };
		}
		case "inquire":
			check("authorityRef");
			return { kind, authorityRef: id("authorityRef") };
		case "defer":
			check("resumeCondition");
			return { kind, resumeCondition: text("resumeCondition") };
		case "noop":
			check("reason");
			return { kind, reason: text("reason") };
	}
}

export function parseCanonicalOption(value: unknown): CanonicalOption {
	const row: Record<string, unknown> &
		Partial<Record<keyof CanonicalOption, unknown>> = object(
		value,
		"canonical option",
	);
	if (row.schemaVersion !== 1)
		throw Error("Unsupported canonical option schema version");
	fields(
		row,
		[
			"schemaVersion",
			"catalogId",
			"kind",
			"actor",
			"targetId",
			"args",
			"preconditions",
			"effect",
			"optionKey",
		],
		"canonical option",
	);
	if (row.catalogId !== PERSONAL_CATALOG_ID)
		throw Error("unsupported option catalog");
	const kind = optionKind(row.kind);
	const preconditions = parsePrecondition(row.preconditions, kind);
	const actor: Record<string, unknown> &
		Partial<Record<keyof CanonicalOption["actor"], unknown>> = object(
		row.actor,
		"option actor",
	);
	fields(actor, ["agentId", "scopeId"], "option actor");
	const effect: Record<string, unknown> &
		Partial<Record<keyof CanonicalOption["effect"], unknown>> = object(
		row.effect,
		"option effect",
	);
	fields(effect, ["owner", "scope"], "option effect");
	if (effect.owner !== owners[kind])
		throw Error("option effect owner mismatch");
	const args = object(row.args, "option args");
	// normalizeOptionArgs validates each value at this unknown-data boundary.
	const result: CanonicalOption = {
		schemaVersion: 1,
		catalogId: PERSONAL_CATALOG_ID,
		kind,
		actor: {
			agentId: boundedId(actor.agentId, "agent id"),
			scopeId: boundedId(actor.scopeId, "scope id"),
		},
		targetId: target(row.targetId),
		args: normalizeOptionArgs(args as Record<string, string>),
		preconditions,
		effect: {
			owner: owners[kind],
			scope: boundedId(effect.scope, "effect scope"),
		},
		optionKey: boundedId(row.optionKey, "option key"),
	};
	if (result.optionKey !== canonicalOptionKey(result))
		throw Error("canonical option key mismatch");
	return result;
}

export function buildCanonicalOption(
	input: Omit<
		CanonicalOption,
		"schemaVersion" | "catalogId" | "optionKey" | "effect"
	>,
): CanonicalOption {
	const kind = optionKind(input.kind);
	const option = {
		schemaVersion: 1 as const,
		catalogId: PERSONAL_CATALOG_ID,
		kind,
		actor: input.actor,
		targetId: input.targetId,
		args: input.args,
		preconditions: input.preconditions,
		// The Host supplies the actor's scope; the catalog selects its effect owner.
		effect: { owner: owners[kind], scope: input.actor.scopeId },
	};
	return parseCanonicalOption({
		...option,
		optionKey: canonicalOptionKey(option),
	});
}
