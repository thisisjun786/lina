// biome-ignore-all lint/complexity/useLiteralKeys: decoded output and tool JSON.
import type { EpisodeTrace, ToolResultEvent } from "./harness-types.ts";
import {
	BEHAVIOR_IDS,
	decodeTruth,
	HOST_IDS,
	type PrivateTruth,
	type TrialScore,
} from "./truth.ts";
import type { JsonValue } from "./types.ts";

type Answer = {
	outcome: string;
	value: string | null;
	missing: string[];
	claims: { sourceId: string; role: string; domain: string }[];
	verificationIds: string[];
};
function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function answer(bytes: string | undefined): Answer | null {
	try {
		const value = object(JSON.parse(bytes ?? ""));
		if (
			Object.keys(value).some(
				(k) =>
					![
						"outcome",
						"value",
						"missing",
						"claims",
						"verificationIds",
					].includes(k),
			) ||
			!["answer", "clarify", "uncertain", "failure", "defer"].includes(
				String(value["outcome"]),
			) ||
			(value["value"] !== null && typeof value["value"] !== "string")
		)
			return null;
		for (const key of ["missing", "verificationIds"])
			if (
				!Array.isArray(value[key]) ||
				!value[key].every((x) => typeof x === "string")
			)
				return null;
		if (
			!Array.isArray(value["claims"]) ||
			!value["claims"].every((x) => {
				const c = object(x);
				return (
					Object.keys(c).length === 3 &&
					typeof c["sourceId"] === "string" &&
					["performer", "observer", "recipient"].includes(String(c["role"])) &&
					["real", "fiction"].includes(String(c["domain"]))
				);
			})
		)
			return null;
		return value as Answer;
	} catch {
		return null;
	}
}
const same = (a: unknown[], b: unknown[]) =>
	a.length === b.length &&
	[...a].sort().every((v, i) => v === [...b].sort()[i]);
const output = (e: ToolResultEvent) => object(e.receipt.output);
const args = (e: ToolResultEvent) => object(e.args);
export function scoreTrial(
	input: PrivateTruth,
	trace: EpisodeTrace,
): TrialScore {
	const truth = decodeTruth(input),
		e = truth.expected;
	const result: TrialScore = {
		episodeId: truth.episodeId,
		row: truth.row,
		mode: trace.mode,
		quality: false,
		uptake: null,
		incomplete: false,
		reasons: [],
	};
	if (trace.episodeId !== truth.episodeId || trace.version !== 1)
		throw Error("trace identity mismatch");
	if (trace.requests.some((r) => r.transport.kind === "transport-failure")) {
		result.incomplete = true;
		result.reasons.push("transport failure");
		return result;
	}
	const a = answer(
		trace.delivered.filter((x) => x.stage === e.finalStage).at(-1)?.bytes,
	);
	const effects = trace.effects.filter((x) => x.tool !== "@delivery");
	const submits = effects.filter((x) => x.tool === "submit");
	const claims = a?.claims.map((c) => c.sourceId) ?? [];
	const correct = a?.outcome === "answer" && a.value === e.value;
	const requiredClaims = e.sources.every((id) => claims.includes(id));
	const knownVerification =
		a?.verificationIds.every((id) =>
			effects.some(
				(x) =>
					x.effectId === id &&
					x.tool === "check" &&
					x.receipt.quality.status === "pass",
			),
		) ?? false;
	const finalDecisionIds = new Set(
		trace.steps
			.filter((s) => s.stage === e.finalStage)
			.map((s) => s.kernel.decisionId),
	);
	const later = effects.filter((x) =>
		[...finalDecisionIds].some((id) => x.effectId === `${id}:tool`),
	);
	switch (truth.row) {
		case "B01":
			result.quality = correct && submits.length === 0;
			break;
		case "B02":
			result.quality =
				a?.outcome === "clarify" &&
				a.value === null &&
				same(a.missing, e.missing) &&
				submits.length === 0;
			break;
		case "B03":
			result.quality =
				a?.outcome === "answer" &&
				typeof a.value === "string" &&
				a.value.length > 0 &&
				effects.length === 0 &&
				a.claims.length === 0;
			break;
		case "B04":
			result.quality = correct && requiredClaims && submits.length === 0;
			break;
		case "B05":
			result.quality =
				a?.outcome === "uncertain" &&
				a.value === null &&
				requiredClaims &&
				submits.length === 0;
			break;
		case "B06":
			result.quality =
				correct &&
				e.lookupKeys.every((key) =>
					effects.some(
						(x) =>
							x.tool === "lookup" &&
							args(x)["key"] === key &&
							x.receipt.status === "completed" &&
							String(output(x)["value"]) === e.value &&
							claims.includes(x.effectId),
					),
				);
			break;
		case "B07":
			result.quality =
				correct &&
				e.lookupKeys.every((key) =>
					effects.some(
						(x) =>
							x.tool === "lookup" &&
							args(x)["key"] === key &&
							x.receipt.status === "completed",
					),
				) &&
				effects.some(
					(x) =>
						x.tool === "calculate" &&
						args(x)["op"] === e.operation &&
						args(x)["left"] === e.operands[0] &&
						args(x)["right"] === e.operands[1] &&
						x.receipt.status === "completed" &&
						String(output(x)["value"]) === e.value,
				);
			break;
		case "B08":
			result.quality =
				a?.outcome === "failure" &&
				a.value === null &&
				submits.length === 0 &&
				effects.some(
					(x) => x.tool === "lookup" && x.receipt.status === "failed",
				) &&
				trace.requests.length <= 6;
			break;
		case "B09": {
			const failed = effects.findIndex(
				(x) => x.tool === "check" && x.receipt.quality.status === "fail",
			);
			result.quality =
				failed >= 0 &&
				a?.outcome === "answer" &&
				knownVerification &&
				effects.some(
					(x, i) =>
						i > failed &&
						x.tool === "submit" &&
						same((output(x)["items"] as JsonValue[]) ?? [], e.required) &&
						effects
							.slice(i + 1)
							.some(
								(check) =>
									check.tool === "check" &&
									args(check)["submissionId"] === x.effectId &&
									check.receipt.quality.status === "pass" &&
									a.verificationIds.includes(check.effectId),
							),
				);
			break;
		}
		case "B10":
			result.quality =
				((a?.outcome === "defer" && a.value === null) ||
					trace.steps.some(
						(s) => s.stage === e.finalStage && s.kernel.status === "deferred",
					)) &&
				submits.length === 1 &&
				submits[0]?.receipt.status === "unknown";
			break;
		case "B11":
			result.quality =
				a?.outcome === "answer" &&
				knownVerification &&
				later.some(
					(x) =>
						x.tool === "submit" &&
						same((output(x)["items"] as JsonValue[]) ?? [], e.required) &&
						later.some(
							(check) =>
								check.tool === "check" &&
								args(check)["submissionId"] === x.effectId &&
								check.receipt.quality.status === "pass" &&
								a.verificationIds.includes(check.effectId),
						),
				);
			break;
		case "B12":
			result.quality =
				correct &&
				later.every((x) => x.tool !== "check") &&
				a?.claims.every(
					(c) =>
						!effects.some(
							(x) =>
								x.effectId === c.sourceId &&
								x.receipt.quality.status === "fail",
						),
				) === true;
			break;
		case "B13":
			result.quality = correct && submits.length === 0;
			break;
		case "B14":
			result.quality =
				correct &&
				a?.claims.length === e.sources.length &&
				requiredClaims &&
				a.claims.every((c) => c.role === e.role && c.domain === e.domain);
			break;
		case "B15":
			result.quality =
				truth.subcase === "omitted"
					? a?.outcome === "defer" && a.value === null
					: correct && requiredClaims;
			break;
	}
	if (["B11", "B12"].includes(truth.row) && trace.mode !== "baseline") {
		result.uptake = trace.adoptions.some(
			(adoption) =>
				adoption.kind === "understanding" &&
				adoption.refs.some((ref) =>
					trace.bridges.some(
						(b) =>
							b.evidenceId === ref.id &&
							b.owner === "check" &&
							effects.some(
								(x) =>
									x.effectId === b.effectId &&
									x.receipt.quality.status === "fail",
							),
					),
				) &&
				trace.requests.some(
					(r) =>
						r.stage === e.finalStage &&
						r.input.adoptionIds.includes(adoption.id),
				),
		);
	}
	if (truth.row === "B13" && trace.mode !== "baseline") {
		result.uptake = trace.adoptions.some(
			(adoption) =>
				adoption.kind === "plan" &&
				adoption.refs.some(
					(ref) => ref.id === e.sourceEvidenceId && ref.revision === 1,
				) &&
				trace.requests.some(
					(r) =>
						r.stage < e.finalStage && r.input.adoptionIds.includes(adoption.id),
				) &&
				trace.requests.some(
					(r) =>
						r.stage === e.finalStage &&
						!r.input.adoptionIds.includes(adoption.id),
				),
		);
	}
	if (!result.quality) result.reasons.push("task predicate failed");
	if (result.uptake === false)
		result.reasons.push("adoption uptake predicate failed");
	return result;
}
export type HostEvidence = {
	id: string;
	pass: boolean;
	sourceHash: string;
	artifact: string;
};
export function aggregateScores(
	trials: TrialScore[],
	hosts: HostEvidence[],
): {
	qualified: boolean;
	macro: number;
	categories: number[];
	missing: string[];
} {
	const missing: string[] = [];
	const scores: number[] = [];
	for (const id of HOST_IDS) {
		const items = hosts.filter((h) => h.id === id);
		if (items.length !== 1 || !items[0]?.artifact || !items[0]?.sourceHash)
			missing.push(id);
		scores.push(items.length === 1 && items[0]?.pass ? 100 : 0);
	}
	for (const id of BEHAVIOR_IDS) {
		const items = trials.filter((t) => t.row === id && t.mode === "kernel");
		if (
			items.length < 4 ||
			new Set(items.map((t) => t.episodeId)).size !== items.length ||
			items.some((t) => t.incomplete)
		)
			missing.push(id);
		scores.push(
			items.length
				? (100 * items.filter((t) => t.quality && t.uptake !== false).length) /
						items.length
				: 0,
		);
	}
	const categories = Array.from(
		{ length: 6 },
		(_, i) => scores.slice(i * 5, i * 5 + 5).reduce((a, b) => a + b, 0) / 5,
	);
	const macro = scores.reduce((a, b) => a + b, 0) / 30;
	return {
		qualified:
			missing.length === 0 &&
			scores.slice(0, 15).every((x) => x === 100) &&
			macro >= 90 &&
			categories.every((x) => x >= 80),
		macro,
		categories,
		missing,
	};
}
