import { parseAvatarSource } from "../agents/visual-validation.ts";
import type { LifeImageSettingsInput, LifeImageSource } from "./image-types.ts";
import {
	array,
	digest,
	enumeration,
	eventReference,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	revision,
} from "./life-json.ts";
import { fields, text } from "./validation.ts";

export function parseLifeImageSettings(value: unknown): LifeImageSettingsInput {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldVersion",
		"route",
		"eventRules",
		"avatarEventRules",
		"perAuthorCooldownSteps",
		"attachMode",
		"maxJobsPerVisit",
		"storage",
	]);
	if (value.version !== 1) throw Error("Unsupported image settings version");
	fields(value.route, ["provider", "model"]);
	text(value.route.provider, "image provider");
	text(value.route.model, "image model");
	fields(value.storage, [
		"maxActiveJobs",
		"maxArchivedJobs",
		"maxAssets",
		"maxTotalBytes",
	]);
	const settings: LifeImageSettingsInput = {
		version: 1,
		worldVersion:
			value.worldVersion === null ? null : revision(value.worldVersion, 1),
		route: { provider: value.route.provider, model: value.route.model },
		eventRules: keyed(
			array(value.eventRules, (row) => {
				fields(row, ["familyId", "agentIds", "trigger", "composition"]);
				return {
					familyId: identifier(row.familyId),
					agentIds: identifiers(row.agentIds),
					trigger: enumeration(row.trigger, ["event", "scene_change"]),
					composition: enumeration(row.composition, [
						"single_subject",
						"all_scene_subjects",
					]),
				};
			}),
			(row) => row.familyId,
		),
		avatarEventRules: keyed(
			array(value.avatarEventRules, (row) => {
				fields(row, ["familyId", "agentIds"]);
				return {
					familyId: identifier(row.familyId),
					agentIds: identifiers(row.agentIds),
				};
			}),
			(row) => row.familyId,
		),
		perAuthorCooldownSteps: revision(value.perAuthorCooldownSteps),
		attachMode: enumeration(value.attachMode, ["manual", "automatic"]),
		maxJobsPerVisit: revision(value.maxJobsPerVisit),
		storage: {
			maxActiveJobs: revision(value.storage.maxActiveJobs),
			maxArchivedJobs: revision(value.storage.maxArchivedJobs),
			maxAssets: revision(value.storage.maxAssets),
			maxTotalBytes: revision(value.storage.maxTotalBytes),
		},
	};
	if (
		settings.worldVersion === null &&
		(settings.eventRules.length || settings.avatarEventRules.length)
	)
		throw Error("Image event rules require an authored world version");
	return settings;
}

export function parseLifeImageSource(value: unknown): LifeImageSource {
	jsonBoundary(value);
	if (
		!value ||
		typeof value !== "object" ||
		!("kind" in value) ||
		value.kind !== "event_post"
	)
		return parseAvatarSource(value);
	fields(value, [
		"kind",
		"publicationId",
		"postRevision",
		"eventId",
		"worldRevision",
		"lifeRevision",
		"publicationMaterialId",
		"publicationMaterialDigest",
		"recipientId",
	]);
	return {
		kind: "event_post",
		publicationId: identifier(value.publicationId),
		postRevision: revision(value.postRevision, 1),
		eventId: eventReference(value.eventId),
		worldRevision: revision(value.worldRevision, 1),
		lifeRevision: revision(value.lifeRevision, 1),
		publicationMaterialId: identifier(value.publicationMaterialId),
		publicationMaterialDigest: digest(value.publicationMaterialDigest),
		recipientId: identifier(value.recipientId),
	};
}
