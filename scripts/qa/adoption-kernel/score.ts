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
		seed: truth.seed,
		variant: truth.variant,
		subcase: truth.subcase,
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
	if (trace.status !== "complete") {
		result.incomplete = true;
		result.reasons.push("episode did not complete");
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
				effects.some(
					(x, index) =>
						x.tool === "calculate" &&
						args(x)["op"] === e.operation &&
						args(x)["left"] === e.operands[0] &&
						args(x)["right"] === e.operands[1] &&
						x.receipt.status === "completed" &&
						String(output(x)["value"]) === e.value &&
						e.lookupKeys.every((key, operandIndex) =>
							effects
								.slice(0, index)
								.some(
									(lookup) =>
										lookup.tool === "lookup" &&
										args(lookup)["key"] === key &&
										lookup.receipt.status === "completed" &&
										output(lookup)["value"] === e.operands[operandIndex],
								),
						),
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
			const original = effects.find(
				(x) =>
					x.effectId === `${truth.episodeId}:prelude:0` &&
					x.tool === "submit" &&
					x.receipt.status === "completed",
			);
			const originalItems = original ? output(original)["items"] : null;
			const missing = Array.isArray(originalItems)
				? e.required.filter((item) => !originalItems.includes(item))
				: [];
			const extra = Array.isArray(originalItems)
				? originalItems.filter((item) => !e.required.includes(String(item)))
				: [];
			const failed = effects.findIndex(
				(x, index) =>
					original !== undefined &&
					index > effects.indexOf(original) &&
					x.tool === "check" &&
					x.receipt.status === "completed" &&
					args(x)["submissionId"] === original.effectId &&
					x.receipt.quality.status === "fail" &&
					missing.length === 1 &&
					extra.length === 0 &&
					output(x)["submissionId"] === original.effectId &&
					output(x)["pass"] === false &&
					Array.isArray(output(x)["missing"]) &&
					same(output(x)["missing"] as unknown[], missing) &&
					Array.isArray(output(x)["extra"]) &&
					same(output(x)["extra"] as unknown[], extra),
			);
			result.quality =
				failed >= 0 &&
				a?.outcome === "answer" &&
				knownVerification &&
				effects.some(
					(x, i) =>
						i > failed &&
						original !== undefined &&
						args(x)["taskKey"] === args(original)["taskKey"] &&
						x.receipt.status === "completed" &&
						x.tool === "submit" &&
						same((output(x)["items"] as JsonValue[]) ?? [], e.required) &&
						effects
							.slice(i + 1)
							.some(
								(check) =>
									check.tool === "check" &&
									check.receipt.status === "completed" &&
									args(check)["submissionId"] === x.effectId &&
									check.receipt.quality.status === "pass" &&
									a.verificationIds.includes(check.effectId),
							),
				);
			break;
		}
		case "B10":
			result.quality =
				a?.outcome === "defer" &&
				a.value === null &&
				submits.length === 1 &&
				submits[0]?.receipt.status === "unknown";
			break;
		case "B11":
			result.quality =
				correct &&
				knownVerification &&
				later.some(
					(x, index) =>
						x.tool === "submit" &&
						x.receipt.status === "completed" &&
						same((output(x)["items"] as JsonValue[]) ?? [], e.required) &&
						later
							.slice(index + 1)
							.some(
								(check) =>
									check.tool === "check" &&
									check.receipt.status === "completed" &&
									args(check)["submissionId"] === x.effectId &&
									output(check)["submissionId"] === x.effectId &&
									output(check)["pass"] === true &&
									Array.isArray(output(check)["missing"]) &&
									(output(check)["missing"] as unknown[]).length === 0 &&
									Array.isArray(output(check)["extra"]) &&
									(output(check)["extra"] as unknown[]).length === 0 &&
									check.receipt.quality.status === "pass" &&
									a?.verificationIds.includes(check.effectId),
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
		const originalId = `${truth.episodeId}:prelude:0`;
		const checkId = `${truth.episodeId}:prelude:1`;
		const original = effects.find(
			(x) =>
				x.effectId === originalId &&
				x.tool === "submit" &&
				x.receipt.status === "completed",
		);
		const check = effects.find(
			(x) =>
				x.effectId === checkId &&
				x.tool === "check" &&
				x.receipt.status === "completed",
		);
		const items = original ? output(original)["items"] : null;
		const missing = Array.isArray(items)
			? e.learningRequired.filter((item) => !items.includes(item))
			: [];
		const grounded =
			original &&
			check &&
			e.learnedRule &&
			args(original)["method"] === e.learnedRule.method &&
			Array.isArray(args(original)["items"]) &&
			same(args(original)["items"] as unknown[], e.learningRequired) &&
			missing.length === 1 &&
			Array.isArray(items) &&
			items.every((item) => e.learningRequired.includes(String(item))) &&
			args(check)["submissionId"] === originalId &&
			output(check)["submissionId"] === originalId &&
			output(check)["pass"] === false &&
			check.receipt.quality.status === "fail" &&
			Array.isArray(output(check)["missing"]) &&
			same(output(check)["missing"] as unknown[], missing) &&
			Array.isArray(output(check)["extra"]) &&
			(output(check)["extra"] as unknown[]).length === 0;
		const relation =
			e.learnedRule &&
			(truth.row === "B11"
				? e.taskCondition === e.learnedRule.when
				: e.taskCondition !== e.learnedRule.when);
		result.uptake = Boolean(
			grounded &&
				relation &&
				trace.adoptions.some((adoption) => {
					let rule: Record<string, unknown>;
					try {
						rule = object(JSON.parse(adoption.condition));
					} catch {
						return false;
					}
					return (
						adoption.kind === "understanding" &&
						adoption.status === "active" &&
						Object.keys(rule).length === 2 &&
						rule["method"] === e.learnedRule?.method &&
						rule["when"] === e.learnedRule?.when &&
						trace.steps.some(
							(step) =>
								step.stage < e.finalStage &&
								step.kernel.status === "adopted" &&
								step.kernel.decisionId === adoption.sourceDecisionId,
						) &&
						adoption.refs.some((ref) =>
							trace.bridges.some(
								(bridge) =>
									bridge.evidenceId === ref.id &&
									bridge.revision === ref.revision &&
									bridge.owner === "check" &&
									bridge.effectId === checkId,
							),
						) &&
						trace.requests.some((request) => {
							if (
								request.stage !== e.finalStage ||
								!request.input.adoptionIds.includes(adoption.id)
							)
								return false;
							let body: Record<string, unknown>;
							try {
								body = object(
									JSON.parse(request.input.messages[1]?.content ?? ""),
								);
							} catch {
								return false;
							}
							const derived = body["derived"],
								raw = body["raw"];
							if (!Array.isArray(derived) || !Array.isArray(raw)) return false;
							const supplied = derived.some((value) => {
								const item = object(value);
								return (
									item["id"] === adoption.id &&
									item["revision"] === adoption.revision &&
									item["condition"] === adoption.condition &&
									item["kind"] === "understanding"
								);
							});
							return (
								supplied &&
								raw.some((value) => {
									const item = object(value);
									if (
										item["owner"] !== "user" ||
										!e.sources.includes(String(item["sourceId"])) ||
										typeof item["text"] !== "string"
									)
										return false;
									try {
										const task = object(JSON.parse(item["text"]));
										return (
											task["method"] === e.learnedRule?.method &&
											task["condition"] === e.taskCondition &&
											Array.isArray(task["required"]) &&
											same(task["required"] as unknown[], e.required)
										);
									} catch {
										return false;
									}
								})
							);
						})
					);
				}),
		);
	}
	if (truth.row === "B13" && trace.mode !== "baseline") {
		const stale = (
			id: string,
			revision: number,
			seen = new Set<string>(),
		): boolean => {
			if (id === e.sourceEvidenceId && revision === 1) return true;
			const key = `${id}:${revision}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return trace.adoptions.some(
				(candidate) =>
					candidate.id === id &&
					candidate.revision === revision &&
					candidate.refs.some((ref) => stale(ref.id, ref.revision, seen)),
			);
		};
		const finalInputs = trace.requests.filter((r) => r.stage === e.finalStage);
		const clean =
			finalInputs.length > 0 &&
			finalInputs.every((r) =>
				r.input.adoptionIds.every((id) => {
					const candidates = trace.adoptions.filter((a) => a.id === id);
					return (
						candidates.length > 0 &&
						candidates.every((a) => !stale(a.id, a.revision))
					);
				}),
			);
		result.uptake =
			clean &&
			trace.adoptions.some(
				(adoption) =>
					adoption.kind === "plan" &&
					adoption.refs.some(
						(ref) => ref.id === e.sourceEvidenceId && ref.revision === 1,
					) &&
					trace.requests.some(
						(r) =>
							r.stage < e.finalStage &&
							r.input.adoptionIds.includes(adoption.id),
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
	const batchSeeds = new Set(
		trials.filter((t) => t.mode === "kernel").map((t) => t.seed),
	);
	if (batchSeeds.size !== 1) missing.push("batch-seed");
	for (const id of BEHAVIOR_IDS) {
		const items = trials.filter((t) => t.row === id && t.mode === "kernel");
		const subcases = id === "B15" ? ["visible", "omitted"] : ["main"];
		let valid =
			items.length === 4 * subcases.length &&
			new Set(items.map((t) => t.episodeId)).size === items.length;
		let passing = 0;
		for (let variant = 0; variant < 4; variant++) {
			let pass = true;
			for (const subcase of subcases) {
				const selected = items.filter(
					(t) => t.variant === variant && t.subcase === subcase,
				);
				if (selected.length !== 1 || selected[0]?.incomplete) {
					valid = false;
					pass = false;
					continue;
				}
				const trial = selected[0];
				if (!trial?.quality || trial.uptake === false) pass = false;
				if (["B11", "B12", "B13"].includes(id) && trial?.uptake !== true) {
					valid = false;
					pass = false;
				}
			}
			if (pass) passing++;
		}
		if (!valid) missing.push(id);
		scores.push((100 * passing) / 4);
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
