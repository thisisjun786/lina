import type { DatabaseSync } from "node:sqlite";
import type { FrozenVisualIdentity } from "../agents/visual.ts";
import {
	parseFrozenVisualIdentity,
	parseVisualPurpose,
} from "../agents/visual-validation.ts";
import type { LifeConfig } from "./authoring-types.ts";
import { freezeLifeImageMaterial } from "./image-brief.ts";
import { avatarIntentId } from "./image-policy.ts";
import type {
	LifeImageIntent,
	LifeImageSettings,
	LifeImageSource,
	PublishedImageMaterial,
} from "./image-types.ts";
import { parseLifeImageSource } from "./image-validation.ts";
import {
	array,
	canonicalLifeJson,
	identifier,
	jsonBoundary,
	lifeDigest,
	revision,
} from "./life-json.ts";
import { fields } from "./validation.ts";

export const IMAGE_INTENTS_SCHEMA = `
CREATE TABLE life_image_intents (
 world_id TEXT NOT NULL REFERENCES worlds(id), intent_id TEXT NOT NULL,
 intent_json TEXT NOT NULL CHECK(json_valid(intent_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,intent_id)
) STRICT;
`;
export interface FreezeImageIntentInput {
	worldId: string;
	agentId: string;
	source: LifeImageSource;
	visuals: FrozenVisualIdentity[];
	requestKey: string | null;
}
export interface ImageIntentSource {
	worldId: string;
	agentId: string;
	source: LifeImageSource;
	settingsRevision: number;
	configRevision: number;
	createdAtMs: number;
	createdLifeRevision: number;
}
type Row = {
	world_id: string;
	intent_id: string;
	intent_json: string;
	digest: string;
};
export function imageIntentId(
	input: Pick<
		FreezeImageIntentInput,
		"worldId" | "agentId" | "source" | "requestKey"
	>,
): string {
	if (input.requestKey !== null)
		return `life-image-${lifeDigest({ kind: "explicit", worldId: input.worldId, agentId: input.agentId, requestKey: input.requestKey })}`;
	if (input.source.kind !== "event_post")
		return avatarIntentId(input.worldId, input.agentId, input.source);
	return `life-image-${lifeDigest({ kind: "event_post", worldId: input.worldId, publicationId: input.source.publicationId })}`;
}

/** Immutable world intents. The caller owns SQLite transactions and current-effect authority. */
export class ImageIntents {
	constructor(
		private readonly db: DatabaseSync,
		private readonly source: {
			settings(worldId: string, at: number): LifeImageSettings;
			config(worldId: string, at: number): LifeConfig;
			/** Rebuild from actual original post or policy/slot/accepted event, never a full current world snapshot. */
			material(input: ImageIntentSource): PublishedImageMaterial | null;
		},
	) {}
	private parse(value: unknown): LifeImageIntent {
		jsonBoundary(value);
		fields(value, [
			"version",
			"intentId",
			"owner",
			"source",
			"material",
			"settingsRevision",
			"configRevision",
			"createdAtMs",
			"createdLifeRevision",
			"requestKey",
			"briefDigest",
		]);
		if (value.version !== 2) throw Error("Unsupported image intent version");
		fields(value.owner, ["kind", "worldId", "agentId"]);
		if (value.owner.kind !== "life")
			throw Error("Image intent requires LIFE ownership");
		const worldId = identifier(value.owner.worldId),
			agentId = identifier(value.owner.agentId),
			source = parseLifeImageSource(value.source);
		const provenance = {
			worldId,
			agentId,
			source,
			settingsRevision: revision(value.settingsRevision, 1),
			configRevision: revision(value.configRevision),
			createdAtMs: revision(value.createdAtMs),
			createdLifeRevision: revision(value.createdLifeRevision),
		};
		this.source.settings(worldId, provenance.settingsRevision);
		this.source.config(worldId, provenance.configRevision);
		const publication = this.source.material(provenance);
		fields(value.material, [
			"version",
			"purpose",
			"publication",
			"visuals",
			"prompt",
			"altText",
			"fingerprint",
			"digest",
		]);
		const purpose = parseVisualPurpose(value.material.purpose);
		if (
			source.kind === "event_post"
				? purpose.kind !== "life" ||
					purpose.worldId !== worldId ||
					purpose.recipientId !== source.recipientId
				: purpose.kind !== "avatar"
		)
			throw Error("Image intent destination mismatch");
		const material = freezeLifeImageMaterial({
			purpose,
			publication,
			visuals: array(value.material.visuals, parseFrozenVisualIdentity),
		});
		if (
			source.kind !== "event_post" &&
			material.visuals[0]?.agentId !== agentId
		)
			throw Error("Avatar image subject mismatch");
		if (
			lifeDigest(value.material) !== lifeDigest(material) ||
			value.briefDigest !== material.digest
		)
			throw Error("Corrupt frozen image material");
		const requestKey =
			value.requestKey === null ? null : identifier(value.requestKey);
		const intentId = imageIntentId({ worldId, agentId, source, requestKey });
		if (value.intentId !== intentId)
			throw Error("Image intent identity mismatch");
		return {
			version: 2,
			intentId,
			owner: { kind: "life", worldId, agentId },
			source,
			material,
			settingsRevision: provenance.settingsRevision,
			configRevision: provenance.configRevision,
			createdAtMs: provenance.createdAtMs,
			createdLifeRevision: provenance.createdLifeRevision,
			requestKey,
			briefDigest: material.digest,
		};
	}
	private decode(row: Row): LifeImageIntent {
		const result = this.parse(JSON.parse(row.intent_json));
		if (
			result.owner.worldId !== row.world_id ||
			result.intentId !== row.intent_id ||
			lifeDigest(result) !== row.digest
		)
			throw Error("Corrupt image intent record");
		return result;
	}
	get(worldId: string, intentId: string): LifeImageIntent | null {
		identifier(worldId);
		identifier(intentId);
		const row = this.db
			.prepare(
				"SELECT * FROM life_image_intents WHERE world_id=? AND intent_id=?",
			)
			.get(worldId, intentId) as Row | undefined;
		return row ? this.decode(row) : null;
	}
	list(worldId: string): LifeImageIntent[] {
		identifier(worldId);
		return (
			this.db
				.prepare(
					"SELECT * FROM life_image_intents WHERE world_id=? ORDER BY intent_id",
				)
				.all(worldId) as Row[]
		).map((row) => this.decode(row));
	}
	record(value: LifeImageIntent): LifeImageIntent {
		const checked = this.parse(value),
			existing = this.get(checked.owner.worldId, checked.intentId);
		if (existing) {
			if (lifeDigest(existing) !== lifeDigest(checked))
				throw Error("Image intent conflict");
			return existing;
		}
		this.db
			.prepare("INSERT INTO life_image_intents VALUES(?,?,?,?)")
			.run(
				checked.owner.worldId,
				checked.intentId,
				canonicalLifeJson(checked),
				lifeDigest(checked),
			);
		return checked;
	}
	validate(): void {
		for (const row of this.db
			.prepare("SELECT * FROM life_image_intents")
			.all() as Row[])
			this.decode(row);
	}
}
