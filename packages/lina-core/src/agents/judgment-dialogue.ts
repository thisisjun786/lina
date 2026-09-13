import { validId } from "../context/validation.ts";
import {
	type Assessment,
	type DialogueSourceRef,
	type JudgmentSnapshotRef,
	MODULE_KINDS,
	type ModuleKind,
	type ObjectiveProfileRef,
	type ResolutionRecord,
	type RoundStatus,
	SITUATIONS,
	type Situation,
} from "./judgment.ts";
import {
	canonicalJson,
	judgmentDigest,
	parseAssessment,
	parseJudgmentSnapshotRef,
	parseObjectiveProfileRef,
	parseResolutionRecord,
	snapshotDigest,
} from "./judgment-validation.ts";
import { boundedId, boundedText } from "./validation.ts";

type DialogueProvenance = DialogueSourceRef & {
	roundId: string;
	snapshotDigest: string;
	objectiveProfileRefs: Record<ModuleKind, ObjectiveProfileRef>;
	assessmentDigests: Record<ModuleKind, string | null>;
	policyId: string;
	policyRevision: number;
};
/** JSON capability v2, stored in the unchanged v1 ledger DDL. Old readers reject
 * this version; legacy action v1 bodies/digests are never rewritten or decorated.
 * This is synthesis provenance, not response acceptance or action selection. */
export type DialogueResolutionRecord = DialogueProvenance & {
	schemaVersion: 2;
	mode: "dialogue";
	situation: Situation;
	recommendations: Record<ModuleKind, string | null>;
	alignment: "aligned" | "conflicted" | "incomplete";
	conflicts: Array<{ moduleKind: ModuleKind; reason: string }>;
	concessions: Array<{ moduleKind: ModuleKind; reason: string }>;
	synthesis: string;
	rationale: string;
	status: Exclude<RoundStatus, "open">;
	holdReason: string | null;
};
export type StoredResolutionRecord =
	| ResolutionRecord
	| DialogueResolutionRecord;
export type DialogueJudgmentRef = Omit<
	DialogueProvenance,
	"assessmentDigests"
> & {
	schemaVersion: 1;
	agentId: string;
	scopeId: string;
	assessmentDigests: Record<ModuleKind, string>;
	resolutionDigest: string;
	refDigest: string;
};

function fields(
	value: unknown,
	keys: readonly string[],
	label: string,
	version?: number,
): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		throw Error(`invalid ${label}`);
	const row = value as Record<string, unknown>;
	if (version !== undefined && row["schemaVersion"] !== version)
		throw Error(`Unsupported ${label} schema version`);
	for (const key of Object.keys(row))
		if (!keys.includes(key)) throw Error(`unknown ${label} field ${key}`);
	for (const key of keys)
		if (!Object.hasOwn(row, key)) throw Error(`missing ${label} field ${key}`);
	return row;
}
function member<T extends string>(
	value: unknown,
	values: readonly T[],
	label: string,
): T {
	const found = values.find((item) => item === value);
	if (found === undefined) throw Error(`invalid ${label}`);
	return found;
}
function digest(value: unknown): string {
	const parsed = boundedId(value, "dialogue digest");
	if (!/^[a-f0-9]{64}$/.test(parsed)) throw Error("invalid dialogue digest");
	return parsed;
}
function modules<T>(
	value: unknown,
	parse: (value: unknown) => T,
): Record<ModuleKind, T> {
	const row = fields(value, MODULE_KINDS, "dialogue modules");
	return {
		clotho: parse(row["clotho"]),
		lachesis: parse(row["lachesis"]),
		atropos: parse(row["atropos"]),
	};
}
function policyRevision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw Error("invalid dialogue policy revision");
	return value;
}
function reasons(value: unknown): DialogueResolutionRecord["conflicts"] {
	if (!Array.isArray(value) || value.length > 256)
		throw Error("invalid dialogue reasons");
	return Array.from(value, (item) => {
		const row = fields(item, ["moduleKind", "reason"], "dialogue reason");
		return {
			moduleKind: member(row["moduleKind"], MODULE_KINDS, "module kind"),
			reason: boundedText(row["reason"], "dialogue reason"),
		};
	});
}
const PROVENANCE_KEYS = [
	"roundId",
	"snapshotDigest",
	"objectiveProfileRefs",
	"assessmentDigests",
	"policyId",
	"policyRevision",
	"requestId",
	"requestDigest",
	"sourceDigest",
] as const;
function provenance(row: Record<string, unknown>): DialogueProvenance {
	return {
		roundId: boundedId(row["roundId"], "round id"),
		snapshotDigest: digest(row["snapshotDigest"]),
		objectiveProfileRefs: modules(
			row["objectiveProfileRefs"],
			parseObjectiveProfileRef,
		),
		assessmentDigests: modules(row["assessmentDigests"], (value) =>
			value === null ? null : digest(value),
		),
		policyId: boundedId(row["policyId"], "policy id"),
		policyRevision: policyRevision(row["policyRevision"]),
		requestId: validId(row["requestId"], "request id"),
		requestDigest: digest(row["requestDigest"]),
		sourceDigest: digest(row["sourceDigest"]),
	};
}
export function parseDialogueResolutionRecord(
	value: unknown,
): DialogueResolutionRecord {
	const row = fields(
		value,
		[
			"schemaVersion",
			"mode",
			...PROVENANCE_KEYS,
			"situation",
			"recommendations",
			"alignment",
			"conflicts",
			"concessions",
			"synthesis",
			"rationale",
			"status",
			"holdReason",
		],
		"dialogue resolution",
		2,
	);
	const result: DialogueResolutionRecord = {
		schemaVersion: 2,
		mode: member(row["mode"], ["dialogue"], "dialogue mode"),
		...provenance(row),
		situation: member(row["situation"], SITUATIONS, "situation"),
		recommendations: modules(row["recommendations"], (value) =>
			value === null ? null : boundedText(value, "dialogue recommendation"),
		),
		alignment: member(
			row["alignment"],
			["aligned", "conflicted", "incomplete"],
			"dialogue alignment",
		),
		conflicts: reasons(row["conflicts"]),
		concessions: reasons(row["concessions"]),
		synthesis: boundedText(row["synthesis"], "dialogue synthesis"),
		rationale: boundedText(row["rationale"], "dialogue rationale"),
		status: member(
			row["status"],
			["resolved", "held", "deferred"],
			"resolution status",
		),
		holdReason:
			row["holdReason"] === null
				? null
				: boundedText(row["holdReason"], "hold reason"),
	};
	if ((result.status !== "resolved") !== (result.holdReason !== null))
		throw Error("unresolved status requires hold reason");
	const incomplete = MODULE_KINDS.some(
		(m) => result.assessmentDigests[m] === null,
	);
	if (
		incomplete !== (result.alignment === "incomplete") ||
		(incomplete && result.status === "resolved")
	)
		throw Error("invalid incomplete dialogue status");
	for (const m of MODULE_KINDS)
		if (
			(result.assessmentDigests[m] === null) !==
			(result.recommendations[m] === null)
		)
			throw Error("dialogue recommendation assessment mismatch");
	if (
		result.alignment === "aligned" &&
		(result.conflicts.length || result.concessions.length)
	)
		throw Error("aligned dialogue has no conflicts or concessions");
	if (result.alignment === "conflicted" && result.conflicts.length === 0)
		throw Error("conflicted dialogue requires reasons");
	return result;
}
/** Explicit union parser; parseResolutionRecord remains the exact action-v1 parser. */
export function parseStoredResolutionRecord(
	value: unknown,
): StoredResolutionRecord {
	return value !== null &&
		typeof value === "object" &&
		"schemaVersion" in value &&
		value.schemaVersion === 2
		? parseDialogueResolutionRecord(value)
		: parseResolutionRecord(value);
}

/** Pure historical binding. Current objective/intention checks belong only at
 * the owner write boundary, never here or in reference restoration. */
export function validateDialogueResolution(
	record: DialogueResolutionRecord,
	snapshot: JudgmentSnapshotRef,
	assessments: Assessment[],
): void {
	if (
		record.roundId !== snapshot.roundId ||
		record.snapshotDigest !== snapshotDigest(snapshot) ||
		record.policyId !== snapshot.policyId ||
		record.policyRevision !== snapshot.policyRevision ||
		record.situation !== snapshot.situation ||
		canonicalJson(record.objectiveProfileRefs) !==
			canonicalJson(snapshot.objectiveProfileRefs)
	)
		throw Error("dialogue snapshot mismatch");
	if (
		!snapshot.sourceRefs.some(
			(source) => source.kind === "request" && source.id === record.requestId,
		)
	)
		throw Error("dialogue request source mismatch");
	const expected = snapshot.dialogueSource;
	if (!expected) throw Error("dialogue source provenance missing");
	if (
		record.requestId !== expected.requestId ||
		record.requestDigest !== expected.requestDigest ||
		record.sourceDigest !== expected.sourceDigest
	)
		throw Error("dialogue source digest mismatch");
	const seen = new Set<ModuleKind>();
	for (const assessment of assessments) {
		const m = assessment.moduleKind;
		if (seen.has(m)) throw Error("duplicate dialogue assessment");
		seen.add(m);
		if (
			assessment.proposedOptionKeys.length ||
			assessment.objectiveAssessments.length ||
			assessment.recommendedOptionKeys.length
		)
			throw Error("dialogue forbids action assessments");
		if (
			assessment.snapshotId !== record.roundId ||
			assessment.snapshotDigest !== record.snapshotDigest ||
			canonicalJson(assessment.objectiveRef) !==
				canonicalJson(record.objectiveProfileRefs[m])
		)
			throw Error("dialogue assessment snapshot mismatch");
		if (record.assessmentDigests[m] !== judgmentDigest(assessment))
			throw Error("dialogue assessment digest mismatch");
	}
	for (const m of MODULE_KINDS)
		if (seen.has(m) !== (record.assessmentDigests[m] !== null))
			throw Error("missing dialogue assessment");
}
export function buildDialogueResolution(
	input: Omit<
		DialogueResolutionRecord,
		| "schemaVersion"
		| "mode"
		| "roundId"
		| "snapshotDigest"
		| "objectiveProfileRefs"
		| "assessmentDigests"
		| "policyId"
		| "policyRevision"
		| "situation"
	> & { snapshot: JudgmentSnapshotRef; assessments: Assessment[] },
): DialogueResolutionRecord {
	const {
		snapshot: rawSnapshot,
		assessments: rawAssessments,
		...synthesis
	} = input;
	const snapshot = parseJudgmentSnapshotRef(rawSnapshot);
	const assessments = rawAssessments.map(parseAssessment);
	const assessmentDigest = (module: ModuleKind) => {
		const found = assessments.find((a) => a.moduleKind === module);
		return found ? judgmentDigest(found) : null;
	};
	const result = parseDialogueResolutionRecord({
		...synthesis,
		schemaVersion: 2,
		mode: "dialogue",
		roundId: snapshot.roundId,
		snapshotDigest: snapshotDigest(snapshot),
		objectiveProfileRefs: snapshot.objectiveProfileRefs,
		assessmentDigests: {
			clotho: assessmentDigest("clotho"),
			lachesis: assessmentDigest("lachesis"),
			atropos: assessmentDigest("atropos"),
		},
		policyId: snapshot.policyId,
		policyRevision: snapshot.policyRevision,
		situation: snapshot.situation,
	});
	validateDialogueResolution(result, snapshot, assessments);
	return result;
}
export function parseDialogueJudgmentRef(value: unknown): DialogueJudgmentRef {
	const row = fields(
		value,
		[
			"schemaVersion",
			...PROVENANCE_KEYS,
			"agentId",
			"scopeId",
			"resolutionDigest",
			"refDigest",
		],
		"dialogue judgment ref",
		1,
	);
	const result: DialogueJudgmentRef = {
		schemaVersion: 1,
		...provenance(row),
		agentId: boundedId(row["agentId"], "agent id"),
		scopeId: boundedId(row["scopeId"], "scope id"),
		assessmentDigests: modules(row["assessmentDigests"], digest),
		resolutionDigest: digest(row["resolutionDigest"]),
		refDigest: digest(row["refDigest"]),
	};
	if (result.refDigest !== judgmentDigest({ ...result, refDigest: undefined }))
		throw Error("dialogue ref digest mismatch");
	return result;
}
export function buildDialogueJudgmentRef(input: {
	snapshot: JudgmentSnapshotRef;
	assessments: Assessment[];
	resolution: DialogueResolutionRecord;
}): DialogueJudgmentRef {
	const snapshot = parseJudgmentSnapshotRef(input.snapshot);
	const record = parseDialogueResolutionRecord(input.resolution);
	validateDialogueResolution(
		record,
		snapshot,
		input.assessments.map(parseAssessment),
	);
	if (record.status !== "resolved")
		throw Error("dialogue ref requires resolved synthesis");
	const value = {
		schemaVersion: 1,
		roundId: record.roundId,
		snapshotDigest: record.snapshotDigest,
		objectiveProfileRefs: record.objectiveProfileRefs,
		assessmentDigests: record.assessmentDigests,
		policyId: record.policyId,
		policyRevision: record.policyRevision,
		requestId: record.requestId,
		requestDigest: record.requestDigest,
		sourceDigest: record.sourceDigest,
		agentId: snapshot.agentId,
		scopeId: snapshot.scopeId,
		resolutionDigest: judgmentDigest(record),
	};
	return parseDialogueJudgmentRef({
		...value,
		refDigest: judgmentDigest(value),
	});
}
