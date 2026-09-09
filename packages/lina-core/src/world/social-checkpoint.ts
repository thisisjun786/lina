import { lifeDigest } from "./life-json.ts";
import { parseCheckpoint } from "./life-record-validation.ts";
import type { EngineCheckpoint } from "./life-types.ts";
import {
	parseEnsembleCheckpoint,
	socialRecord,
} from "./social-checkpoint-validation.ts";
import { decodeSocialValue, socialDataKey } from "./social-codec.ts";
import { assertSocialValue } from "./social-semantics.ts";
import type { CompiledSocialPack, EnsembleCheckpoint } from "./social-types.ts";
import { socialPredicateCategory } from "./social-views.ts";

export function validateSocialCheckpoint(
	value: EngineCheckpoint,
	pack: CompiledSocialPack,
): void {
	if (value.engineId === "empty") {
		parseCheckpoint(value);
		return;
	}
	const checkpoint = parseEnsembleCheckpoint(value),
		{ data } = checkpoint;
	if (
		data.worldId !== pack.worldId ||
		data.packVersion !== pack.packVersion ||
		data.schemaDigest !== pack.schemaDigest ||
		data.actionDigest !== pack.actionDigest ||
		checkpoint.ruleDigest !== pack.ruleDigest ||
		lifeDigest(data.cast) !== lifeDigest(pack.cast.map((c) => c.agentId))
	)
		throw Error("Social checkpoint compiler mismatch");
	for (const [introductions, ids] of [
		[data.predicateIntroductions, pack.predicates.map((p) => p.id)],
		[data.agentIntroductions, data.cast],
		[data.variableIntroductions, pack.variables.map((v) => v.id)],
	] as const)
		if (
			lifeDigest(introductions.map((i) => i.id).sort()) !==
			lifeDigest([...ids].sort())
		)
			throw Error("Incomplete social introductions");
	if (
		lifeDigest(Object.keys(data.variables).sort()) !==
		lifeDigest(pack.variables.map((v) => v.id).sort())
	)
		throw Error("Social checkpoint variables mismatch");
	for (const variable of pack.variables) {
		const current = data.variables[variable.id];
		if (typeof current !== variable.type)
			throw Error("Social variable type mismatch");
		if (typeof current === "number")
			assertSocialValue({ ...variable, type: "number" }, current);
	}
	for (const member of pack.cast)
		if (!member.active && !data.state.offstage.includes(member.agentId))
			throw Error("Retired social member must remain offstage");
	const history = decodeSocialValue(data.state.history);
	if (!Array.isArray(history)) throw Error("Invalid social history");
	const identity = new Map<number, string>();
	for (const [step, slice] of history.entries()) {
		const pairs = new Set<string>();
		for (const raw of slice) {
			const row = socialRecord(raw),
				predicate = pack.predicates.find(
					(p) => socialPredicateCategory(p.id) === row["category"],
				);
			if (!predicate || row["type"] !== "value")
				throw Error("Unknown social history predicate");
			const first = row["first"],
				second = row["second"];
			if (
				typeof first !== "string" ||
				!data.cast.includes(first) ||
				(predicate.direction === "undirected"
					? second !== undefined
					: typeof second !== "string" ||
						!data.cast.includes(second) ||
						second === first)
			)
				throw Error("Social history direction mismatch");
			assertSocialValue(predicate, row["value"] as number | boolean);
			const intro = Math.max(
				data.predicateIntroductions.find((i) => i.id === predicate.id)
					?.socialStep ?? 0,
				...data.agentIntroductions
					.filter((i) => i.id === first || i.id === second)
					.map((i) => i.socialStep),
			);
			if (step < intro || Number(row["timeHappened"]) < intro)
				throw Error("Social history predates introduction");
			if (
				row["duration"] !== undefined &&
				(predicate.policy.duration === null ||
					Number(row["duration"]) > predicate.policy.duration)
			)
				throw Error("Social history duration mismatch");
			const key = `${predicate.id}:${first}:${second ?? ""}`;
			if (pairs.has(key)) throw Error("Duplicate social history predicate");
			pairs.add(key);
			const id = Number(row["id"]),
				previous = identity.get(id);
			if (previous !== undefined && previous !== key)
				throw Error("Reused social history ID");
			identity.set(id, key);
		}
	}
	if (
		(data.state.iterators["rules"] ?? 0) <
			pack.definition.triggers.length + pack.definition.volitions.length ||
		(data.state.iterators["actions"] ?? 0) < pack.definition.actions.length
	)
		throw Error("Social static counter behind definitions");
	validateCache(checkpoint, pack);
}

function validateCache(
	checkpoint: EnsembleCheckpoint,
	pack: CompiledSocialPack,
): void {
	const cache = socialRecord(
		decodeSocialValue(checkpoint.data.state.volitionCache),
	);
	for (const rawSet of Object.values(cache))
		for (const [first, pairs] of Object.entries(socialRecord(rawSet))) {
			if (!checkpoint.data.cast.includes(first))
				throw Error("Unknown social cache actor");
			for (const [second, rawList] of Object.entries(socialRecord(pairs))) {
				if (!checkpoint.data.cast.includes(second) || !Array.isArray(rawList))
					throw Error("Unknown social cache target");
				for (const raw of rawList) {
					const row = socialRecord(raw);
					const predicate = pack.predicates.find(
						(p) => socialPredicateCategory(p.id) === row["category"],
					);
					if (!predicate || row["type"] !== "value")
						throw Error("Unknown social cache predicate");
				}
			}
		}
	for (const id of checkpoint.data.cast) socialDataKey(id);
}
