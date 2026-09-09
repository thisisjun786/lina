import type { DatabaseSync } from "node:sqlite";
import type { WorldPack } from "./authoring-types.ts";
import {
	canonicalLifeJson,
	identifier,
	lifeDigest,
	revision,
} from "./life-json.ts";
import type { LifeDefinition } from "./life-types.ts";
import type {
	PublicationSettings,
	PublicationSettingsInput,
} from "./publication-types.ts";
import { parsePublicationSettings } from "./publication-validation.ts";

type SettingsRow = {
	world_id: string;
	revision: number;
	settings_json: string;
	digest: string;
};
/** World-owned publication state; caller owns the transaction. */
export class PublicationPersistence {
	constructor(
		private readonly db: DatabaseSync,
		private readonly definition: (worldId: string) => LifeDefinition,
		private readonly pack?: (worldId: string, version?: number) => WorldPack,
	) {}
	private ruleReferences(
		worldId: string,
		value: PublicationSettingsInput,
		historical: boolean,
	) {
		if (value.version === 1) return;
		const pack = this.pack?.(
			worldId,
			historical ? value.worldVersion : undefined,
		);
		if (
			!pack ||
			pack.schemaVersion !== 3 ||
			pack.version !== value.worldVersion
		)
			throw Error(
				"Future publication rules require the exact authored autonomous world version",
			);
		for (const rule of value.eventRules)
			if (
				!pack.eventFamilies.some((family) => family.id === rule.familyId) ||
				rule.authorAgentIds.some((id) => !pack.life.participants.includes(id))
			)
				throw Error("Unknown future publication family or participant");
	}
	private decode(row: SettingsRow): PublicationSettings {
		const value = parsePublicationSettings(JSON.parse(row.settings_json));
		if (row.digest !== lifeDigest(value))
			throw Error("Corrupt publication settings");
		this.ruleReferences(row.world_id, value, true);
		return {
			...value,
			worldId: identifier(row.world_id),
			revision: revision(row.revision, 1),
		};
	}
	settings(worldId: string): PublicationSettings | null {
		identifier(worldId);
		const head = this.db
			.prepare("SELECT * FROM life_publication_settings WHERE world_id=?")
			.get(worldId) as SettingsRow | undefined;
		const history = this.db
			.prepare(
				"SELECT * FROM life_publication_settings_history WHERE world_id=? ORDER BY revision",
			)
			.all(worldId) as SettingsRow[];
		let latest: PublicationSettings | null = null;
		for (const [index, row] of history.entries()) {
			latest = this.decode(row);
			if (latest.revision !== index + 1)
				throw Error("Corrupt publication settings history");
		}
		if (!head && !latest) return null;
		if (
			!head ||
			!latest ||
			lifeDigest(this.decode(head)) !== lifeDigest(latest)
		)
			throw Error("Missing or regressed publication settings head");
		return latest;
	}
	settingsAt(worldId: string, atRevision: number): PublicationSettings {
		identifier(worldId);
		revision(atRevision, 1);
		const row = this.db
			.prepare(
				"SELECT * FROM life_publication_settings_history WHERE world_id=? AND revision=?",
			)
			.get(worldId, atRevision) as SettingsRow | undefined;
		if (!row) throw Error("Missing historical publication settings");
		return this.decode(row);
	}
	setSettings(
		worldId: string,
		expectedRevision: number,
		input: PublicationSettingsInput,
	): PublicationSettings {
		identifier(worldId);
		revision(expectedRevision);
		const definition = this.definition(worldId),
			value = parsePublicationSettings(input);
		this.ruleReferences(worldId, value, false);
		if (
			value.agentRecipients.some(
				(r) => !definition.participants.includes(r.agentId),
			)
		)
			throw Error("Unknown publication participant");
		const current = this.settings(worldId);
		if ((current?.revision ?? 0) !== expectedRevision)
			throw Error("Publication settings revision conflict");
		if (current) {
			const { worldId: _world, revision: _revision, ...prior } = current;
			if (lifeDigest(prior) === lifeDigest(value)) return current;
		}
		const next = revision(expectedRevision + 1, 1),
			json = canonicalLifeJson(value),
			digest = lifeDigest(value);
		this.db
			.prepare(
				"INSERT INTO life_publication_settings_history(world_id,revision,settings_json,digest) VALUES(?,?,?,?)",
			)
			.run(worldId, next, json, digest);
		this.db
			.prepare(
				"INSERT INTO life_publication_settings(world_id,revision,settings_json,digest) VALUES(?,?,?,?) ON CONFLICT(world_id) DO UPDATE SET revision=excluded.revision,settings_json=excluded.settings_json,digest=excluded.digest",
			)
			.run(worldId, next, json, digest);
		return { ...value, worldId, revision: next };
	}
	validate(): void {
		for (const row of this.db
			.prepare(
				"SELECT world_id FROM life_publication_settings UNION SELECT world_id FROM life_publication_settings_history",
			)
			.all())
			this.settings(String(row["world_id"]));
	}
}
