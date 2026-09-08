import type {
	BehaviorSourceStamp,
	PersonalBehavior,
} from "../agents/behavior-types.ts";
import {
	array,
	digest,
	enumeration,
	finite,
	flag,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	revision,
} from "./life-json.ts";
import type {
	IdentityPolicySnapshot,
	IdentityProfilePolicy,
} from "./life-types.ts";
import { fields } from "./validation.ts";

const PROFILE_FIELDS = [
	"agentId",
	"profileRevision",
	"evolution",
	"lockedTraitIds",
	"lockedHabitIds",
	"lockedAttitudeIds",
];

export function parsePersonalBehavior(value: unknown): PersonalBehavior {
	fields(value, ["traits", "habits"]);
	return {
		traits: keyed(
			array(value.traits, (row) => {
				fields(row, ["axisId", "value"]);
				return { axisId: identifier(row.axisId), value: finite(row.value) };
			}),
			(row) => row.axisId,
		),
		habits: keyed(
			array(value.habits, (row) => {
				fields(row, ["habitId", "value"]);
				return { habitId: identifier(row.habitId), value: flag(row.value) };
			}),
			(row) => row.habitId,
		),
	};
}
export function parseBehaviorSourceStamp(value: unknown): BehaviorSourceStamp {
	fields(value, [
		"digest",
		"receiptRevision",
		"profileRevision",
		"definitionRevision",
		"projectionRevision",
	]);
	return {
		digest: digest(value.digest),
		receiptRevision: revision(value.receiptRevision, 1),
		profileRevision: revision(value.profileRevision, 1),
		definitionRevision: revision(value.definitionRevision, 1),
		projectionRevision: revision(value.projectionRevision, 1),
	};
}
function profile(value: Record<string, unknown>): IdentityProfilePolicy {
	return {
		agentId: identifier(value["agentId"]),
		profileRevision: revision(value["profileRevision"], 1),
		evolution: enumeration(value["evolution"], ["manual", "adaptive"]),
		lockedTraitIds: identifiers(value["lockedTraitIds"]),
		lockedHabitIds: identifiers(value["lockedHabitIds"]),
		lockedAttitudeIds: identifiers(value["lockedAttitudeIds"]),
	};
}
export function parseIdentityPolicy(value: unknown): IdentityPolicySnapshot {
	jsonBoundary(value);
	fields(value, ["version", "profiles"]);
	if (value.version === 1)
		return {
			version: 1,
			profiles: keyed(
				array(value.profiles, (row) => {
					fields(row, PROFILE_FIELDS);
					return profile(row);
				}),
				(row) => row.agentId,
			),
		};
	if (value.version !== 2) throw Error("Unsupported identity policy version");
	return {
		version: 2,
		profiles: keyed(
			array(value.profiles, (row) => {
				fields(row, [...PROFILE_FIELDS, "personalBehavior", "sourceStamp"]);
				const base = profile(row);
				const personalBehavior =
					row["personalBehavior"] === null
						? null
						: parsePersonalBehavior(row["personalBehavior"]);
				const sourceStamp =
					row["sourceStamp"] === null
						? null
						: parseBehaviorSourceStamp(row["sourceStamp"]);
				if (
					(personalBehavior === null) !== (sourceStamp === null) ||
					(sourceStamp && sourceStamp.profileRevision !== base.profileRevision)
				)
					throw Error("Personal behavior source anchor mismatch");
				return { ...base, personalBehavior, sourceStamp };
			}),
			(row) => row.agentId,
		),
	};
}
