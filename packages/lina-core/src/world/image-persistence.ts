import type { DatabaseSync } from "node:sqlite";
import type { WorldPack } from "./authoring-types.ts";
import type {
	LifeImageSettings,
	LifeImageSettingsInput,
} from "./image-types.ts";
import { parseLifeImageSettings } from "./image-validation.ts";
import {
	canonicalLifeJson,
	identifier,
	lifeDigest,
	revision,
} from "./life-json.ts";
import type { LifeDefinition } from "./life-types.ts";

type SettingsRow = {
	world_id: string;
	revision: number;
	settings_json: string;
	digest: string;
};

/** Image settings belong to the world; transaction and prior-owner audit stay in WorldStore. */
export class ImagePersistence {
	constructor(
		private readonly db: DatabaseSync,
		private readonly source: {
			definition(worldId: string): LifeDefinition;
			pack(worldId: string, version?: number): WorldPack | null;
		},
	) {}
	private references(
		worldId: string,
		value: LifeImageSettingsInput,
		historical: boolean,
	): void {
		const pack = this.source.pack(
			worldId,
			historical ? (value.worldVersion ?? undefined) : undefined,
		);
		if (value.worldVersion === null) {
			// A legacy configuration remains historical after the world is authored later.
			if (!historical && pack)
				throw Error("Image settings require the active authored world version");
			return;
		}
		if (!pack || pack.version !== value.worldVersion)
			throw Error("Unknown image settings world version");
		for (const rule of [...value.eventRules, ...value.avatarEventRules]) {
			if (
				pack.schemaVersion !== 3 ||
				!pack.eventFamilies.some((f) => f.id === rule.familyId) ||
				rule.agentIds.some((id) => !pack.life.participants.includes(id))
			)
				throw Error("Unknown image rule family or participant");
		}
	}
	private decode(row: SettingsRow): LifeImageSettings {
		const value = parseLifeImageSettings(JSON.parse(row.settings_json));
		identifier(row.world_id);
		if (lifeDigest(value) !== row.digest)
			throw Error("Corrupt image settings digest");
		this.references(row.world_id, value, true);
		return {
			...value,
			worldId: row.world_id,
			revision: revision(row.revision, 1),
		};
	}
	settings(worldId: string): LifeImageSettings | null {
		identifier(worldId);
		const history = this.db
			.prepare(
				"SELECT * FROM life_image_settings_history WHERE world_id=? ORDER BY revision",
			)
			.all(worldId) as SettingsRow[];
		const head = this.db
			.prepare("SELECT * FROM life_image_settings WHERE world_id=?")
			.get(worldId) as SettingsRow | undefined;
		let latest: LifeImageSettings | null = null;
		for (const [index, row] of history.entries()) {
			latest = this.decode(row);
			if (latest.revision !== index + 1)
				throw Error("Corrupt image settings history");
		}
		if (!head && !latest) return null;
		if (
			!head ||
			!latest ||
			lifeDigest(this.decode(head)) !== lifeDigest(latest)
		)
			throw Error("Missing or regressed image settings head");
		return latest;
	}
	settingsAt(worldId: string, atRevision: number): LifeImageSettings {
		identifier(worldId);
		revision(atRevision, 1);
		const row = this.db
			.prepare(
				"SELECT * FROM life_image_settings_history WHERE world_id=? AND revision=?",
			)
			.get(worldId, atRevision) as SettingsRow | undefined;
		if (!row) throw Error("Missing historical image settings");
		return this.decode(row);
	}
	currentSettings(worldId: string): LifeImageSettings {
		const settings = this.settings(worldId);
		if (!settings) throw Error("Image settings are not configured");
		this.references(worldId, settings, false);
		return settings;
	}
	setSettings(
		worldId: string,
		expectedRevision: number,
		input: LifeImageSettingsInput,
	): LifeImageSettings {
		identifier(worldId);
		revision(expectedRevision);
		this.source.definition(worldId);
		const value = parseLifeImageSettings(input);
		this.references(worldId, value, false);
		const current = this.settings(worldId);
		if ((current?.revision ?? 0) !== expectedRevision)
			throw Error("Image settings revision conflict");
		if (current) {
			const { worldId: _world, revision: _revision, ...prior } = current;
			if (lifeDigest(prior) === lifeDigest(value)) return current;
		}
		const next = revision(expectedRevision + 1, 1),
			json = canonicalLifeJson(value),
			digest = lifeDigest(value);
		this.db
			.prepare(
				"INSERT INTO life_image_settings_history(world_id,revision,settings_json,digest) VALUES(?,?,?,?)",
			)
			.run(worldId, next, json, digest);
		this.db
			.prepare(
				"INSERT INTO life_image_settings(world_id,revision,settings_json,digest) VALUES(?,?,?,?) ON CONFLICT(world_id) DO UPDATE SET revision=excluded.revision,settings_json=excluded.settings_json,digest=excluded.digest",
			)
			.run(worldId, next, json, digest);
		return { ...value, worldId, revision: next };
	}
	validate(): void {
		for (const row of this.db
			.prepare(
				"SELECT world_id FROM life_image_settings UNION SELECT world_id FROM life_image_settings_history",
			)
			.all())
			this.settings(String(row["world_id"]));
	}
}
