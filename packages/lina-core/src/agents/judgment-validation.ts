import { createHash } from "node:crypto";
import {
	ACCEPTED_BY,
	type Assessment,
	type AssessmentSet,
	EXCLUSION_STAGES,
	INTENTION_KINDS,
	INTENTION_RELATIONS,
	INTENTION_STATUSES,
	type IntentionRecord,
	type IntentionStatus,
	type IntentionTransition,
	type JsonObject,
	type JsonValue,
	type JudgmentSnapshotRef,
	MODULE_KINDS,
	type ModuleKind,
	type ObjectiveProfile,
	type ObjectiveProfileRef,
	type OptionAssessment,
	type ResolutionRecord,
	SEVERITIES,
	type SelectionSpec,
	SITUATIONS,
	STANCES,
} from "./judgment.ts";
import { boundedId, boundedText } from "./validation.ts";

const MAX_LIST = 256;

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
	value: unknown,
	keys: readonly string[],
	label: string,
	versioned = false,
): Record<string, unknown> {
	const row = object(value, label);
	if (versioned && row["schemaVersion"] !== 1)
		throw Error(`Unsupported ${label} schema version`);
	for (const key of Object.keys(row))
		if (!keys.includes(key)) throw Error(`unknown ${label} field ${key}`);
	for (const key of keys)
		if (!Object.hasOwn(row, key)) throw Error(`missing ${label} field ${key}`);
	return row;
}

function enumeration<T extends string>(
	value: unknown,
	values: readonly T[],
	label: string,
): T {
	const text = boundedId(value, label);
	const member = values.find((item) => item === text);
	if (member === undefined) throw Error(`invalid ${label}`);
	return member;
}

function revision(value: unknown, label: string, min = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
		throw Error(`invalid ${label}`);
	return value;
}

function finite(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw Error(`invalid ${label}`);
	return value;
}

function nullableId(value: unknown, label: string): string | null {
	return value === null ? null : boundedId(value, label);
}

function nullableText(value: unknown, label: string): string | null {
	return value === null ? null : boundedText(value, label);
}

function timestamp(value: unknown, label: string): string {
	const text = boundedText(value, label);
	if (!Number.isFinite(Date.parse(text))) throw Error(`invalid ${label}`);
	return text;
}

function list<T>(
	value: unknown,
	parse: (item: unknown) => T,
	label: string,
): T[] {
	if (!Array.isArray(value) || value.length > MAX_LIST)
		throw Error(`invalid ${label}`);
	return Array.from(value, parse);
}

/** Set-like lists canonicalize keys; semantic order (policy/ranking) is preserved. */
function uniqueSorted<T>(
	items: T[],
	key: (item: T) => string,
	label: string,
	sort = true,
): T[] {
	if (new Set(items.map(key)).size !== items.length)
		throw Error(`duplicate ${label}`);
	return sort
		? [...items].sort((a, b) =>
				key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
			)
		: items;
}

function strings(value: unknown, label: string, parse = boundedId): string[] {
	return uniqueSorted(
		list(value, (item) => parse(item, label), label),
		(item) => item,
		label,
	);
}

function moduleRecord<T>(
	value: unknown,
	parse: (item: unknown) => T,
	label: string,
): Record<ModuleKind, T> {
	const row = fields(value, MODULE_KINDS, label);
	return {
		clotho: parse(row["clotho"]),
		lachesis: parse(row["lachesis"]),
		atropos: parse(row["atropos"]),
	};
}

function jsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return boundedText(value, "JSON text");
	if (typeof value === "number") return finite(value, "JSON number");
	if (Array.isArray(value)) return list(value, jsonValue, "JSON array");
	return jsonObject(value);
}

function jsonObject(value: unknown): JsonObject {
	const row = object(value, "JSON object");
	return Object.fromEntries(
		Object.entries(row).map(([key, item]) => [
			boundedId(key, "JSON key"),
			jsonValue(item),
		]),
	);
}

export function judgmentDigest(value: unknown): string {
	const canonical = (item: unknown): unknown =>
		Array.isArray(item)
			? item.map(canonical)
			: item !== null && typeof item === "object"
				? Object.fromEntries(
						Object.keys(item)
							.sort()
							.map((key) => [
								key,
								canonical((item as Record<string, unknown>)[key]),
							]),
					)
				: item;
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}

export function assessmentInputDigest(input: {
	snapshotDigest: string;
	objectiveRef: ObjectiveProfileRef;
	mechanismRevision: number;
}): string {
	return judgmentDigest({
		snapshotDigest: input.snapshotDigest,
		objectiveRef: input.objectiveRef,
		mechanismRevision: input.mechanismRevision,
	});
}
export function snapshotDigest(ref: JudgmentSnapshotRef): string {
	return judgmentDigest(ref);
}
export function intentionDigest(record: IntentionRecord): string {
	return judgmentDigest(record);
}

function objectiveProfileRef(value: unknown): ObjectiveProfileRef {
	const row = fields(
		value,
		["objectiveId", "revision", "digest"],
		"objective profile ref",
	);
	return {
		objectiveId: boundedId(row["objectiveId"], "objective id"),
		revision: revision(row["revision"], "objective revision", 1),
		digest: boundedId(row["digest"], "objective digest"),
	};
}

export function parseObjectiveProfileRef(value: unknown): ObjectiveProfileRef {
	return objectiveProfileRef(value);
}

export function parseObjectiveProfile(value: unknown): ObjectiveProfile {
	const row = fields(
		value,
		[
			"schemaVersion",
			"objectiveId",
			"moduleKind",
			"revision",
			"objective",
			"comparisonCriteria",
			"reconsiderationConditions",
		],
		"objective profile",
		true,
	);
	return {
		schemaVersion: 1,
		objectiveId: boundedId(row["objectiveId"], "objective id"),
		moduleKind: enumeration(row["moduleKind"], MODULE_KINDS, "module kind"),
		revision: revision(row["revision"], "objective revision", 1),
		objective: boundedText(row["objective"], "objective"),
		comparisonCriteria: strings(
			row["comparisonCriteria"],
			"comparison criteria",
			boundedText,
		),
		reconsiderationConditions: strings(
			row["reconsiderationConditions"],
			"reconsideration conditions",
			boundedText,
		),
	};
}

export function parseJudgmentSnapshotRef(value: unknown): JudgmentSnapshotRef {
	const row = fields(
		value,
		[
			"schemaVersion",
			"roundId",
			"agentId",
			"scopeId",
			"sourceRefs",
			"workingRevision",
			"instructionRevision",
			"policyRevision",
			"identityRevision",
			"domainRevisions",
			"intentionRevision",
			"objectiveProfileRefs",
			"observationRef",
			"frozenNeuralRef",
			"situation",
			"clockId",
			"sequence",
			"bindingGeneration",
		],
		"judgment snapshot ref",
		true,
	);
	const sourceRefs = uniqueSorted(
		list(
			row["sourceRefs"],
			(value) => {
				const source = fields(value, ["kind", "id", "revision"], "source ref");
				return {
					kind: boundedId(source["kind"], "source kind"),
					id: boundedId(source["id"], "source id"),
					revision: revision(source["revision"], "source revision"),
				};
			},
			"source refs",
		),
		(source) => JSON.stringify([source.kind, source.id, source.revision]),
		"source refs",
	);
	const domains = object(row["domainRevisions"], "domain revisions");
	return {
		schemaVersion: 1,
		roundId: boundedId(row["roundId"], "round id"),
		agentId: boundedId(row["agentId"], "agent id"),
		scopeId: boundedId(row["scopeId"], "scope id"),
		sourceRefs,
		workingRevision: revision(row["workingRevision"], "working revision"),
		instructionRevision: revision(
			row["instructionRevision"],
			"instruction revision",
		),
		policyRevision: revision(row["policyRevision"], "policy revision"),
		identityRevision: revision(row["identityRevision"], "identity revision"),
		domainRevisions: Object.fromEntries(
			Object.keys(domains)
				.sort()
				.map((key) => [
					boundedId(key, "domain id"),
					revision(domains[key], "domain revision"),
				]),
		),
		intentionRevision: revision(row["intentionRevision"], "intention revision"),
		objectiveProfileRefs: moduleRecord(
			row["objectiveProfileRefs"],
			objectiveProfileRef,
			"objective profile refs",
		),
		observationRef: nullableId(row["observationRef"], "observation ref"),
		frozenNeuralRef: nullableId(row["frozenNeuralRef"], "frozen neural ref"),
		situation: enumeration(row["situation"], SITUATIONS, "situation"),
		clockId: boundedId(row["clockId"], "clock id"),
		sequence: revision(row["sequence"], "sequence"),
		bindingGeneration: revision(row["bindingGeneration"], "binding generation"),
	};
}

export function parseOptionAssessment(value: unknown): OptionAssessment {
	const row = fields(
		value,
		[
			"optionKey",
			"stance",
			"severity",
			"unavailableReason",
			"gain",
			"loss",
			"uncertainty",
			"evidenceRefs",
		],
		"option assessment",
	);
	const stance = enumeration(row["stance"], STANCES, "stance");
	const severity =
		row["severity"] === null
			? null
			: enumeration(row["severity"], SEVERITIES, "severity");
	const unavailableReason = nullableText(
		row["unavailableReason"],
		"unavailable reason",
	);
	if ((stance === "oppose") !== (severity !== null))
		throw Error("severity requires oppose stance");
	if ((stance === "unavailable") !== (unavailableReason !== null))
		throw Error("unavailable stance requires reason");
	return {
		optionKey: boundedId(row["optionKey"], "option key"),
		stance,
		severity,
		unavailableReason,
		gain: boundedText(row["gain"], "gain"),
		loss: boundedText(row["loss"], "loss"),
		uncertainty: boundedText(row["uncertainty"], "uncertainty"),
		evidenceRefs: strings(row["evidenceRefs"], "evidence refs"),
	};
}

export function parseAssessment(value: unknown): Assessment {
	const row = fields(
		value,
		[
			"schemaVersion",
			"moduleKind",
			"snapshotId",
			"snapshotDigest",
			"inputDigest",
			"objectiveRef",
			"mechanismRevision",
			"completeText",
			"evidenceRefs",
			"proposedOptionKeys",
			"objectiveAssessments",
			"recommendedOptionKeys",
			"detail",
			"diagnostics",
		],
		"assessment",
		true,
	);
	const moduleKind = enumeration(
		row["moduleKind"],
		MODULE_KINDS,
		"module kind",
	);
	const detail = fields(row["detail"], ["kind", "body"], "assessment detail");
	const kind = enumeration(
		detail["kind"],
		["forecasts", "values", "continuity"] as const,
		"assessment detail kind",
	);
	const expected = {
		clotho: "forecasts",
		lachesis: "values",
		atropos: "continuity",
	};
	if (kind !== expected[moduleKind])
		throw Error("assessment detail kind mismatch");
	const body = jsonObject(detail["body"]);
	const objectiveAssessments = uniqueSorted(
		list(
			row["objectiveAssessments"],
			parseOptionAssessment,
			"objective assessments",
		),
		(item) => item.optionKey,
		"assessment option keys",
	);
	const recommendedOptionKeys = strings(
		row["recommendedOptionKeys"],
		"recommended option keys",
	);
	const assessed = new Set(objectiveAssessments.map((item) => item.optionKey));
	if (recommendedOptionKeys.some((key) => !assessed.has(key)))
		throw Error("recommended option is not assessed");
	const result = {
		schemaVersion: 1 as const,
		moduleKind,
		snapshotId: boundedId(row["snapshotId"], "snapshot id"),
		snapshotDigest: boundedId(row["snapshotDigest"], "snapshot digest"),
		inputDigest: boundedId(row["inputDigest"], "input digest"),
		objectiveRef: objectiveProfileRef(row["objectiveRef"]),
		mechanismRevision: revision(row["mechanismRevision"], "mechanism revision"),
		completeText: boundedText(row["completeText"], "complete text"),
		evidenceRefs: strings(row["evidenceRefs"], "evidence refs"),
		proposedOptionKeys: strings(
			row["proposedOptionKeys"],
			"proposed option keys",
		),
		objectiveAssessments,
		recommendedOptionKeys,
		detail: { kind, body },
		diagnostics: jsonObject(row["diagnostics"]),
	};
	if (result.inputDigest !== assessmentInputDigest(result))
		throw Error("assessment input digest mismatch");
	switch (moduleKind) {
		case "clotho":
			return { ...result, moduleKind, detail: { kind: "forecasts", body } };
		case "lachesis":
			return { ...result, moduleKind, detail: { kind: "values", body } };
		case "atropos":
			return { ...result, moduleKind, detail: { kind: "continuity", body } };
	}
}

export function parseAssessmentSet(value: unknown): AssessmentSet {
	const row = fields(
		value,
		["schemaVersion", "roundId", "snapshotDigest", "assessments"],
		"assessment set",
		true,
	);
	const roundId = boundedId(row["roundId"], "round id");
	const digest = boundedId(row["snapshotDigest"], "snapshot digest");
	const assessments = list(row["assessments"], parseAssessment, "assessments");
	if (
		assessments.length !== MODULE_KINDS.length ||
		assessments.some((item, index) => item.moduleKind !== MODULE_KINDS[index])
	)
		throw Error("assessment set requires each module in declared order");
	if (
		assessments.some(
			(item) => item.snapshotId !== roundId || item.snapshotDigest !== digest,
		)
	)
		throw Error("assessment set snapshot mismatch");
	return { schemaVersion: 1, roundId, snapshotDigest: digest, assessments };
}

export function parseResolutionRecord(value: unknown): ResolutionRecord {
	const row = fields(
		value,
		[
			"schemaVersion",
			"roundId",
			"policyId",
			"policyRevision",
			"situation",
			"order",
			"recommendations",
			"conflicts",
			"excluded",
			"abstentions",
			"ranking",
			"conceded",
			"status",
			"holdReason",
		],
		"resolution record",
		true,
	);
	const status = enumeration(
		row["status"],
		["resolved", "deferred", "held"] as const,
		"resolution status",
	);
	const holdReason = nullableText(row["holdReason"], "hold reason");
	if ((status !== "resolved") !== (holdReason !== null))
		throw Error("unresolved status requires hold reason");
	const order = uniqueSorted(
		list(
			row["order"],
			(item) => enumeration(item, MODULE_KINDS, "module order"),
			"module order",
		),
		(item) => item,
		"module order",
		false,
	);
	if (order.length !== MODULE_KINDS.length)
		throw Error("resolution order requires each module");
	return {
		schemaVersion: 1,
		roundId: boundedId(row["roundId"], "round id"),
		policyId: boundedId(row["policyId"], "policy id"),
		policyRevision: revision(row["policyRevision"], "policy revision"),
		situation: enumeration(row["situation"], SITUATIONS, "situation"),
		order,
		recommendations: moduleRecord(
			row["recommendations"],
			(item) => strings(item, "recommendation keys"),
			"recommendations",
		),
		conflicts: uniqueSorted(
			list(
				row["conflicts"],
				(value) => {
					const item = fields(value, ["optionKey", "stances"], "conflict");
					return {
						optionKey: boundedId(item["optionKey"], "option key"),
						stances: moduleRecord(
							item["stances"],
							(stance) => enumeration(stance, STANCES, "stance"),
							"conflict stances",
						),
					};
				},
				"conflicts",
			),
			(item) => item.optionKey,
			"conflicts",
		),
		excluded: uniqueSorted(
			list(
				row["excluded"],
				(value) => {
					const item = fields(
						value,
						["optionKey", "stage", "byModule", "reason"],
						"exclusion",
					);
					return {
						optionKey: boundedId(item["optionKey"], "option key"),
						stage: enumeration(
							item["stage"],
							EXCLUSION_STAGES,
							"exclusion stage",
						),
						byModule:
							item["byModule"] === null
								? null
								: enumeration(
										item["byModule"],
										MODULE_KINDS,
										"exclusion module",
									),
						reason: boundedText(item["reason"], "exclusion reason"),
					};
				},
				"exclusions",
			),
			(item) => item.optionKey,
			"exclusions",
		),
		abstentions: uniqueSorted(
			list(
				row["abstentions"],
				(value) => {
					const item = fields(
						value,
						["optionKey", "moduleKind", "reason"],
						"abstention",
					);
					return {
						optionKey: boundedId(item["optionKey"], "option key"),
						moduleKind: enumeration(
							item["moduleKind"],
							MODULE_KINDS,
							"module kind",
						),
						reason: boundedText(item["reason"], "abstention reason"),
					};
				},
				"abstentions",
			),
			(item) => JSON.stringify([item.optionKey, item.moduleKind]),
			"abstentions",
		),
		ranking: uniqueSorted(
			list(
				row["ranking"],
				(value) => {
					const item = fields(value, ["optionKey", "rank"], "ranking");
					return {
						optionKey: boundedId(item["optionKey"], "option key"),
						rank: revision(item["rank"], "rank", 1),
					};
				},
				"ranking",
			),
			(item) => item.optionKey,
			"ranking",
			false,
		),
		conceded: uniqueSorted(
			list(
				row["conceded"],
				(value) => {
					const item = fields(value, ["moduleKind", "optionKey"], "concession");
					return {
						moduleKind: enumeration(
							item["moduleKind"],
							MODULE_KINDS,
							"module kind",
						),
						optionKey: boundedId(item["optionKey"], "option key"),
					};
				},
				"concessions",
			),
			(item) => JSON.stringify([item.moduleKind, item.optionKey]),
			"concessions",
		),
		status,
		holdReason,
	};
}

export function parseSelectionSpec(value: unknown): SelectionSpec {
	const row = fields(
		value,
		[
			"schemaVersion",
			"roundId",
			"snapshotDigest",
			"assessmentSetDigest",
			"objectiveProfileRefs",
			"resolutionDigest",
			"policyId",
			"policyRevision",
			"situation",
			"lambda",
			"candidates",
			"eligibleDigest",
			"specDigest",
		],
		"selection spec",
		true,
	);
	const candidates = uniqueSorted(
		list(
			row["candidates"],
			(value) => {
				const item = fields(
					value,
					["optionKey", "p0", "b"],
					"selection candidate",
				);
				const p0 = finite(item["p0"], "p0");
				if (p0 < 0) throw Error("invalid p0");
				return {
					optionKey: boundedId(item["optionKey"], "option key"),
					p0,
					b: item["b"] === null ? null : finite(item["b"], "bias"),
				};
			},
			"selection candidates",
		),
		(item) => item.optionKey,
		"selection candidates",
		false,
	);
	for (const [index, candidate] of candidates.entries()) {
		const previous = candidates[index - 1];
		if (previous && previous.optionKey > candidate.optionKey)
			throw Error("unsorted selection candidates");
	}
	if (
		!candidates.some((item) => item.p0 > 0) ||
		Math.abs(candidates.reduce((sum, item) => sum + item.p0, 0) - 1) > 1e-12
	)
		throw Error("invalid selection mass");
	const lambda = finite(row["lambda"], "lambda");
	if (lambda < 0) throw Error("invalid lambda");
	const result: SelectionSpec = {
		schemaVersion: 1,
		roundId: boundedId(row["roundId"], "round id"),
		snapshotDigest: boundedId(row["snapshotDigest"], "snapshot digest"),
		assessmentSetDigest: boundedId(
			row["assessmentSetDigest"],
			"assessment set digest",
		),
		objectiveProfileRefs: moduleRecord(
			row["objectiveProfileRefs"],
			objectiveProfileRef,
			"objective profile refs",
		),
		resolutionDigest: boundedId(row["resolutionDigest"], "resolution digest"),
		policyId: boundedId(row["policyId"], "policy id"),
		policyRevision: revision(row["policyRevision"], "policy revision"),
		situation: enumeration(row["situation"], SITUATIONS, "situation"),
		lambda,
		candidates,
		eligibleDigest: boundedId(row["eligibleDigest"], "eligible digest"),
		specDigest: boundedId(row["specDigest"], "spec digest"),
	};
	if (
		result.eligibleDigest !==
		judgmentDigest(
			candidates.filter((item) => item.p0 > 0).map((item) => item.optionKey),
		)
	)
		throw Error("eligible digest mismatch");
	if (
		result.specDigest !== judgmentDigest({ ...result, specDigest: undefined })
	)
		throw Error("selection spec digest mismatch");
	return result;
}

export const INTENTION_TRANSITIONS: Record<
	IntentionStatus,
	readonly IntentionStatus[]
> = {
	proposed: ["adopted", "cancelled"],
	adopted: ["active", "suspended", "cancelled"],
	active: ["suspended", "completed", "cancelled"],
	suspended: ["active", "cancelled"],
	completed: [],
	cancelled: [],
};

export function parseIntentionTransition(value: unknown): IntentionTransition {
	const row = fields(
		value,
		["from", "to", "reason", "evidenceRef", "at"],
		"intention transition",
	);
	return {
		from: enumeration(row["from"], INTENTION_STATUSES, "transition from"),
		to: enumeration(row["to"], INTENTION_STATUSES, "transition to"),
		reason: boundedText(row["reason"], "transition reason"),
		evidenceRef: nullableId(row["evidenceRef"], "transition evidence ref"),
		at: timestamp(row["at"], "transition at"),
	};
}

function validateTransition(
	transition: IntentionTransition,
	acceptanceSourceRef: string,
): void {
	const { from, to, evidenceRef } = transition;
	if (!INTENTION_TRANSITIONS[from].includes(to))
		throw Error(`invalid intention transition: ${from} -> ${to}`);
	if (to === "completed" && evidenceRef === null)
		throw Error("completed intention requires outcome ref");
	if (
		(to === "cancelled" || to === "suspended") &&
		evidenceRef !== acceptanceSourceRef
	)
		throw Error("intention change requires original acceptance ref");
}

export function parseIntentionRecord(value: unknown): IntentionRecord {
	const row = fields(
		value,
		[
			"schemaVersion",
			"intentionId",
			"agentId",
			"scopeId",
			"revision",
			"kind",
			"purposeRef",
			"text",
			"acceptance",
			"priority",
			"deadline",
			"completionCondition",
			"abortConditions",
			"relatedIntentions",
			"status",
			"history",
		],
		"intention record",
		true,
	);
	const acceptance = fields(
		row["acceptance"],
		["sourceRef", "acceptedBy", "policyRevision", "acceptedAt"],
		"intention acceptance",
	);
	const sourceRef = boundedId(acceptance["sourceRef"], "acceptance source ref");
	const history = list(
		row["history"],
		parseIntentionTransition,
		"intention history",
	);
	const recordRevision = revision(row["revision"], "intention revision");
	const status = enumeration(
		row["status"],
		INTENTION_STATUSES,
		"intention status",
	);
	if (history.length !== recordRevision)
		throw Error("intention history revision mismatch");
	let previous: IntentionStatus = "proposed";
	for (const transition of history) {
		if (transition.from !== previous)
			throw Error("noncontiguous intention history");
		validateTransition(transition, sourceRef);
		previous = transition.to;
	}
	if (previous !== status) throw Error("intention history status mismatch");
	return {
		schemaVersion: 1,
		intentionId: boundedId(row["intentionId"], "intention id"),
		agentId: boundedId(row["agentId"], "agent id"),
		scopeId: boundedId(row["scopeId"], "scope id"),
		revision: recordRevision,
		kind: enumeration(row["kind"], INTENTION_KINDS, "intention kind"),
		purposeRef: boundedId(row["purposeRef"], "purpose ref"),
		text: boundedText(row["text"], "intention text"),
		acceptance: {
			sourceRef,
			acceptedBy: enumeration(
				acceptance["acceptedBy"],
				ACCEPTED_BY,
				"accepted by",
			),
			policyRevision: revision(
				acceptance["policyRevision"],
				"acceptance policy revision",
			),
			acceptedAt: timestamp(acceptance["acceptedAt"], "accepted at"),
		},
		priority: revision(row["priority"], "intention priority"),
		deadline:
			row["deadline"] === null
				? null
				: timestamp(row["deadline"], "intention deadline"),
		completionCondition: boundedText(
			row["completionCondition"],
			"completion condition",
		),
		abortConditions: strings(
			row["abortConditions"],
			"abort conditions",
			boundedText,
		),
		relatedIntentions: uniqueSorted(
			list(
				row["relatedIntentions"],
				(value) => {
					const item = fields(
						value,
						["intentionId", "relation"],
						"related intention",
					);
					return {
						intentionId: boundedId(item["intentionId"], "related intention id"),
						relation: enumeration(
							item["relation"],
							INTENTION_RELATIONS,
							"intention relation",
						),
					};
				},
				"related intentions",
			),
			(item) => JSON.stringify([item.intentionId, item.relation]),
			"related intentions",
		),
		status,
		history,
	};
}

export function transitionIntention(
	record: IntentionRecord,
	transition: Omit<IntentionTransition, "from">,
): IntentionRecord {
	const entry = parseIntentionTransition({
		from: record.status,
		...transition,
	});
	validateTransition(entry, record.acceptance.sourceRef);
	if (record.history.length >= MAX_LIST)
		throw Error("invalid intention history");
	return {
		...record,
		revision: record.revision + 1,
		status: entry.to,
		history: [...record.history, entry],
	};
}
