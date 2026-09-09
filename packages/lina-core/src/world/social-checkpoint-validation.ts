import { scalar } from "./authoring-node-validation.ts";
import {
	array,
	digest,
	identifier,
	jsonBoundary,
	keyed,
	lifeDigest,
	revision,
} from "./life-json.ts";
import {
	decodeSocialValue,
	parseSocialEncodedValue,
	socialDataKey,
} from "./social-codec.ts";
import type {
	EnsembleCheckpoint,
	EnsembleState,
	SocialIntroduction,
} from "./social-types.ts";
import { fields, integer } from "./validation.ts";

export function socialRecord(value: unknown): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		throw Error("Invalid social record");
	return value as Record<string, unknown>;
}
export function socialCounterMap(value: unknown): Record<string, number> {
	const record = socialRecord(value);
	if (Object.keys(record).length > 4096)
		throw Error("Social counter capacity exceeded");
	return Object.fromEntries(
		Object.entries(record).map(([key, number]) => [
			socialDataKey(key),
			revision(number),
		]),
	);
}
function introductions(value: unknown): SocialIntroduction[] {
	return keyed(
		array(value, (item) => {
			fields(item, ["id", "socialStep", "worldRevision"]);
			return {
				id: identifier(item.id),
				socialStep: revision(item.socialStep),
				worldRevision: revision(item.worldRevision),
			};
		}),
		(x) => x.id,
	);
}
function orderedIds(value: unknown): string[] {
	return keyed(array(value, identifier), (x) => x, false);
}

export function parseEnsembleState(value: unknown): EnsembleState {
	fields(value, [
		"history",
		"step",
		"offstage",
		"eliminated",
		"iterators",
		"noRepeat",
		"volitionCache",
		"cachePositions",
	]);
	return {
		history: parseSocialEncodedValue(value.history),
		step: revision(value.step),
		offstage: orderedIds(value.offstage),
		eliminated: orderedIds(value.eliminated),
		iterators: socialCounterMap(value.iterators),
		noRepeat: socialCounterMap(value.noRepeat),
		volitionCache: parseSocialEncodedValue(value.volitionCache),
		cachePositions: socialCounterMap(value.cachePositions),
	};
}

/** Structural owner checks run even before a compiled pack is available at DB decode. */
function validateStateOwners(checkpoint: EnsembleCheckpoint): void {
	const { state, cast } = checkpoint.data;
	const history = decodeSocialValue(state.history);
	if (
		!Array.isArray(history) ||
		history.length !== state.step + 1 ||
		Object.keys(history).length !== history.length
	)
		throw Error("Social history step mismatch");
	let count = 0,
		maxId = 0;
	for (const [step, slice] of history.entries()) {
		if (!Array.isArray(slice) || Object.keys(slice).length !== slice.length)
			throw Error("Invalid social history slice");
		const ids = new Set<number>();
		for (const raw of slice) {
			if (++count > 4096) throw Error("Social history capacity exceeded");
			const fact = socialRecord(raw);
			const allowed = [
				"category",
				"type",
				"first",
				"second",
				"value",
				"id",
				"timeHappened",
				"duration",
				"origin",
				"isActive",
			];
			if (
				Object.keys(fact).some((k) => !allowed.includes(k)) ||
				!["category", "type", "first", "value", "id", "timeHappened"].every(
					(k) => Object.hasOwn(fact, k),
				)
			)
				throw Error("Invalid social history fields");
			if (
				typeof fact["category"] !== "string" ||
				!/^p_(?:[a-f0-9]{2}){1,128}$/.test(fact["category"])
			)
				throw Error("Invalid social predicate category");
			identifier(fact["type"]);
			identifier(fact["first"]);
			if (fact["second"] !== undefined) identifier(fact["second"]);
			if (
				!cast.includes(String(fact["first"])) ||
				(fact["second"] !== undefined && !cast.includes(String(fact["second"])))
			)
				throw Error("Unknown social history agent");
			if (
				typeof fact["value"] !== "boolean" &&
				typeof fact["value"] !== "number"
			)
				throw Error("Invalid social history value");
			const id = revision(fact["id"], 1);
			integer(fact["timeHappened"], "social history time", 0, step);
			if (ids.has(id)) throw Error("Duplicate social history id");
			ids.add(id);
			maxId = Math.max(maxId, id);
			if (fact["duration"] !== undefined)
				integer(fact["duration"], "social duration", 0, 4096);
			if (fact["origin"] !== undefined && typeof fact["origin"] !== "string")
				throw Error("Invalid social history origin");
			if (
				fact["isActive"] !== undefined &&
				typeof fact["isActive"] !== "boolean"
			)
				throw Error("Invalid social history activity");
		}
	}
	if (
		typeof state.iterators["socialRecords"] !== "number" ||
		state.iterators["socialRecords"] < maxId
	)
		throw Error("Social history counter behind retained IDs");
	if (
		state.offstage.some(
			(id) => !cast.includes(id) || state.eliminated.includes(id),
		) ||
		state.eliminated.some((id) => !cast.includes(id))
	)
		throw Error("Invalid social inactive cast");
	const cache = socialRecord(decodeSocialValue(state.volitionCache));
	const positions = new Map<string, number>();
	for (const [key, rawSet] of Object.entries(cache)) {
		socialDataKey(key);
		for (const [first, rawPairs] of Object.entries(socialRecord(rawSet))) {
			identifier(first);
			if (!cast.includes(first)) throw Error("Unknown social cache actor");
			for (const [second, list] of Object.entries(socialRecord(rawPairs))) {
				identifier(second);
				if (!cast.includes(second)) throw Error("Unknown social cache target");
				if (!Array.isArray(list) || Object.keys(list).length !== list.length)
					throw Error("Invalid social volition list");
				positions.set(key + first + second, list.length);
				for (const raw of list) {
					const entry = socialRecord(raw);
					const allowed = [
						"category",
						"type",
						"first",
						"second",
						"intentType",
						"weight",
						"englishInfluences",
					];
					if (
						Object.keys(entry).some((key) => !allowed.includes(key)) ||
						![
							"category",
							"type",
							"first",
							"intentType",
							"weight",
							"englishInfluences",
						].every((key) => Object.hasOwn(entry, key)) ||
						entry["first"] !== first ||
						(entry["second"] !== undefined && entry["second"] !== second) ||
						typeof entry["intentType"] !== "boolean" ||
						entry["type"] !== "value" ||
						typeof entry["category"] !== "string"
					)
						throw Error("Invalid social cache fields");
					if (
						typeof entry["weight"] !== "number" ||
						!Number.isFinite(entry["weight"])
					)
						throw Error("Invalid social cache weight");
					const influences = entry["englishInfluences"];
					if (
						!Array.isArray(influences) ||
						Object.keys(influences).length !== influences.length
					)
						throw Error("Invalid social cache influences");
					for (const influence of influences) {
						if (
							!Array.isArray(influence) ||
							influence.length !== 0 ||
							Object.keys(influence).length !== 4 ||
							!["englishRule", "ruleName", "weight", "origin"].every((key) =>
								Object.hasOwn(influence, key),
							) ||
							typeof Reflect.get(influence, "englishRule") !== "string" ||
							typeof Reflect.get(influence, "ruleName") !== "string" ||
							typeof Reflect.get(influence, "weight") !== "number" ||
							!Number.isFinite(Reflect.get(influence, "weight")) ||
							(Reflect.get(influence, "origin") !== undefined &&
								typeof Reflect.get(influence, "origin") !== "string")
						)
							throw Error("Invalid social cache influence metadata");
					}
				}
			}
		}
	}
	for (const [key, position] of Object.entries(state.cachePositions)) {
		const length = positions.get(key);
		if (length === undefined || position > length)
			throw Error("Invalid social cache cursor");
	}
}

export function parseEnsembleCheckpoint(value: unknown): EnsembleCheckpoint {
	jsonBoundary(value);
	fields(value, [
		"version",
		"engineId",
		"engineRevision",
		"ruleDigest",
		"encodingVersion",
		"dataDigest",
		"data",
	]);
	if (
		value.version !== 1 ||
		value.engineId !== "ensemble" ||
		value.engineRevision !== "8b74bdec-lina-1" ||
		value.encodingVersion !== 1
	)
		throw Error("Unsupported social checkpoint version");
	const data = value.data;
	fields(data, [
		"worldId",
		"packVersion",
		"worldRevision",
		"lifeRevision",
		"simulationTime",
		"compilerRevision",
		"schemaDigest",
		"actionDigest",
		"cast",
		"variables",
		"predicateIntroductions",
		"agentIntroductions",
		"variableIntroductions",
		"state",
		"rng",
	]);
	if (data.compilerRevision !== 1)
		throw Error("Unsupported social checkpoint compiler");
	fields(data.rng, ["algorithm", "seed", "state", "drawIndex"]);
	if (data.rng.algorithm !== "lcg32-v1")
		throw Error("Unsupported social random algorithm");
	integer(data.rng.seed, "social seed", 0, 0xffffffff);
	integer(data.rng.state, "social RNG", 0, 0xffffffff);
	const result: EnsembleCheckpoint = {
		version: 1,
		engineId: "ensemble",
		engineRevision: "8b74bdec-lina-1",
		encodingVersion: 1,
		ruleDigest: digest(value.ruleDigest),
		dataDigest: digest(value.dataDigest),
		data: {
			worldId: identifier(data.worldId),
			packVersion: revision(data.packVersion, 1),
			worldRevision: revision(data.worldRevision),
			lifeRevision: revision(data.lifeRevision),
			simulationTime: revision(data.simulationTime),
			compilerRevision: 1,
			schemaDigest: digest(data.schemaDigest),
			actionDigest: digest(data.actionDigest),
			cast: orderedIds(data.cast),
			variables: Object.fromEntries(
				Object.entries(socialRecord(data.variables)).map(([key, value]) => [
					identifier(key),
					scalar(value),
				]),
			),
			predicateIntroductions: introductions(data.predicateIntroductions),
			agentIntroductions: introductions(data.agentIntroductions),
			variableIntroductions: introductions(data.variableIntroductions),
			state: parseEnsembleState(data.state),
			rng: {
				algorithm: "lcg32-v1",
				seed: data.rng.seed,
				state: data.rng.state,
				drawIndex: revision(data.rng.drawIndex),
			},
		},
	};
	if (result.dataDigest !== lifeDigest(result.data))
		throw Error("Social checkpoint data digest mismatch");
	for (const intro of [
		...result.data.predicateIntroductions,
		...result.data.agentIntroductions,
		...result.data.variableIntroductions,
	])
		if (
			intro.socialStep > result.data.state.step ||
			intro.worldRevision > result.data.worldRevision
		)
			throw Error("Social introduction is in the future");
	validateStateOwners(result);
	return result;
}
