import { authoringText } from "./authoring-node-validation.ts";
import type { ReflectionProposal } from "./autonomy-types.ts";
import { nonnegative, unitInterval } from "./autonomy-validation.ts";
import {
	array,
	enumeration,
	finite,
	flag,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	nullableId,
} from "./life-json.ts";
import { parseClaimRef } from "./life-record-validation.ts";
import { fields } from "./validation.ts";
export function parseReflectionProposal(value: unknown): ReflectionProposal {
	jsonBoundary(value);
	fields(value, ["claims", "beliefs", "growth", "needs", "goals"]);
	return {
		claims: keyed(
			array(value.claims, (v) => {
				fields(v, ["id", "text", "supersedes"]);
				return {
					id: identifier(v.id),
					text: authoringText(v.text),
					supersedes: nullableId(v.supersedes),
				};
			}),
			(x) => x.id,
			false,
		),
		beliefs: keyed(
			array(value.beliefs, (v) => {
				fields(v, [
					"id",
					"claim",
					"stance",
					"confidence",
					"experienceIds",
					"supersedes",
				]);
				return {
					id: identifier(v.id),
					claim: parseClaimRef(v.claim),
					stance: enumeration(v.stance, [
						"believes",
						"disbelieves",
						"uncertain",
					]),
					confidence: enumeration(v.confidence, [
						"uncertain",
						"likely",
						"certain",
					]),
					experienceIds: identifiers(v.experienceIds),
					supersedes: nullableId(v.supersedes),
				};
			}),
			(x) => x.id,
			false,
		),
		growth: keyed(
			array(value.growth, (v): ReflectionProposal["growth"][number] => {
				if (!v || typeof v !== "object" || !("kind" in v))
					throw Error("Invalid reflection growth");
				if (v.kind === "trait") {
					fields(v, ["kind", "axisId", "next", "evidenceIds"]);
					return {
						kind: "trait",
						axisId: identifier(v.axisId),
						next: finite(v.next),
						evidenceIds: identifiers(v.evidenceIds),
					};
				}
				if (v.kind === "habit") {
					fields(v, ["kind", "habitId", "next", "evidenceIds"]);
					return {
						kind: "habit",
						habitId: identifier(v.habitId),
						next: flag(v.next),
						evidenceIds: identifiers(v.evidenceIds),
					};
				}
				throw Error("Unsupported reflection growth");
			}),
			(x) => (x.kind === "trait" ? `trait:${x.axisId}` : `habit:${x.habitId}`),
		),
		needs: keyed(
			array(value.needs, (v) => {
				fields(v, ["needId", "next", "experienceIds"]);
				return {
					needId: identifier(v.needId),
					next: finite(v.next),
					experienceIds: identifiers(v.experienceIds),
				};
			}),
			(x) => x.needId,
		),
		goals: keyed(
			array(value.goals, (v) => {
				fields(v, [
					"id",
					"description",
					"priority",
					"familyIds",
					"progress",
					"status",
					"experienceIds",
				]);
				return {
					id: identifier(v.id),
					description: authoringText(v.description),
					priority: nonnegative(v.priority),
					familyIds: identifiers(v.familyIds),
					progress: unitInterval(v.progress),
					status: enumeration(v.status, ["active", "completed", "abandoned"]),
					experienceIds: identifiers(v.experienceIds),
				};
			}),
			(x) => x.id,
		),
	};
}
