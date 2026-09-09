import type { DatabaseSync } from "node:sqlite";
import { parseAvatarPolicy } from "../agents/visual-validation.ts";
import type { LifeConfig } from "./authoring-types.ts";
import { resolveAvatarPolicy } from "./image-policy.ts";
import type { LifeImageSettings, ResolvedAvatarPolicy } from "./image-types.ts";
import {
	canonicalLifeJson,
	identifier,
	lifeDigest,
	revision,
} from "./life-json.ts";
import { fields } from "./validation.ts";

export const IMAGE_POLICIES_SCHEMA = `
CREATE TABLE life_image_avatar_policies (
 world_id TEXT NOT NULL REFERENCES worlds(id), policy_id TEXT NOT NULL,
 policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,policy_id)
) STRICT;
`;
type Row = {
	world_id: string;
	policy_id: string;
	policy_json: string;
	digest: string;
};

/** Stores frozen world provenance. Runtime separately verifies the original AgentStore-owned policy. */
export class ImagePolicies {
	constructor(
		private readonly db: DatabaseSync,
		private readonly source: {
			configAt(worldId: string, at: number): LifeConfig;
			settingsAt(worldId: string, at: number): LifeImageSettings;
			participants(worldId: string, worldVersion: number | null): string[];
		},
	) {}
	private decode(row: Row): ResolvedAvatarPolicy {
		const value: unknown = JSON.parse(row.policy_json);
		fields(value, [
			"version",
			"id",
			"digest",
			"worldId",
			"agentId",
			"avatarPolicyRevision",
			"policy",
			"configRevision",
			"avatars",
			"usage",
			"imageSettingsRevision",
			"worldVersion",
			"scheduleKey",
		]);
		const worldId = identifier(value.worldId),
			agentId = identifier(value.agentId);
		const expected = resolveAvatarPolicy({
			worldId,
			agentId,
			avatarPolicyRevision: revision(value.avatarPolicyRevision, 1),
			policy: parseAvatarPolicy(value.policy),
			config: this.source.configAt(worldId, revision(value.configRevision)),
			settings: this.source.settingsAt(
				worldId,
				revision(value.imageSettingsRevision, 1),
			),
		});
		if (
			row.world_id !== worldId ||
			row.policy_id !== expected.id ||
			row.digest !== lifeDigest(expected) ||
			lifeDigest(value) !== lifeDigest(expected) ||
			!this.source
				.participants(worldId, expected.worldVersion)
				.includes(agentId)
		)
			throw Error("Corrupt resolved avatar policy");
		return expected;
	}
	get(worldId: string, policyId: string): ResolvedAvatarPolicy {
		identifier(worldId);
		identifier(policyId);
		const row = this.db
			.prepare(
				"SELECT * FROM life_image_avatar_policies WHERE world_id=? AND policy_id=?",
			)
			.get(worldId, policyId) as Row | undefined;
		if (!row) throw Error("Missing resolved avatar policy");
		return this.decode(row);
	}
	record(value: ResolvedAvatarPolicy): ResolvedAvatarPolicy {
		const row = {
			world_id: value.worldId,
			policy_id: value.id,
			policy_json: canonicalLifeJson(value),
			digest: lifeDigest(value),
		};
		const checked = this.decode(row);
		const existing = this.db
			.prepare(
				"SELECT * FROM life_image_avatar_policies WHERE world_id=? AND policy_id=?",
			)
			.get(value.worldId, value.id) as Row | undefined;
		if (existing) {
			if (lifeDigest(this.decode(existing)) !== lifeDigest(checked))
				throw Error("Resolved avatar policy conflict");
			return checked;
		}
		this.db
			.prepare("INSERT INTO life_image_avatar_policies VALUES(?,?,?,?)")
			.run(row.world_id, row.policy_id, row.policy_json, row.digest);
		return checked;
	}
	validate(): void {
		for (const row of this.db
			.prepare("SELECT * FROM life_image_avatar_policies")
			.all() as Row[])
			this.decode(row);
	}
}
