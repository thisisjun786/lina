import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { AgentProfile } from "./types.ts";
import { boundedId, validateAgentInput } from "./validation.ts";
import type {
	AgentVisual,
	AvatarApplicationAuthority,
	AvatarApplicationReceipt,
	AvatarApplyInput,
	AvatarAsset,
	AvatarAuthority,
	ManualAvatarInput,
	ManualAvatarReceipt,
} from "./visual.ts";
import { assertManualAvatarAncestry } from "./visual-authority-history.ts";
import type { VisualCapacity } from "./visual-capacity.ts";
import type { VisualPersistence } from "./visual-persistence.ts";
import {
	avatarAutomaticRequestKey,
	bool,
	exact,
	hash,
	integer,
	parseAvatarApply,
	parseAvatarAsset,
	requireVisualRecord,
	visualDigest,
} from "./visual-validation.ts";

type PinInput = {
	requestKey: string;
	expectedRevision: number;
	pinned: boolean;
};
/** Application receipts precede every freshness check; repeated restoration is a new operation. */
export class VisualApplications {
	constructor(
		private readonly db: DatabaseSync,
		private readonly visuals: VisualPersistence,
		private readonly capacity: VisualCapacity,
		private readonly profile: (id: string) => AgentProfile | undefined,
	) {}
	apply(
		id: string,
		value: AvatarApplyInput,
		authority: AvatarApplicationAuthority,
	): AvatarApplicationReceipt {
		const input = parseAvatarApply(value),
			old = this.receipt<AvatarApplicationReceipt>(
				id,
				input.requestKey,
				"generated",
				input,
			);
		if (old) return old;
		if (
			!authority ||
			typeof authority.validateCandidate !== "function" ||
			(input.mode === "automatic"
				? authority.kind !== "automatic"
				: authority.kind !== "owner")
		)
			throw Error("avatar caller authority denied");
		const p = this.casProfile(id, input.expectedProfileRevision),
			v = this.visuals.cas(id, input.expectedVisualRevision);
		const c = this.visuals.candidate(id, input.candidateId);
		if (!c) throw Error("avatar candidate not found");
		if (input.mode === "automatic") {
			if (input.requestKey !== avatarAutomaticRequestKey(c))
				throw Error("invalid automatic avatar operation key");
			if (v.pinned) throw Error("avatar pinned");
			if (v.revision !== c.visualRevision || p.revision !== c.profileRevision)
				throw Error("stale automatic avatar fence");
			if (
				v.avatarPolicyRevision !== c.avatarPolicyRevision ||
				v.avatarPolicy?.worldId !== c.worldId ||
				v.avatarPolicy.applyMode !== "automatic"
			)
				throw Error("automatic avatar policy denied");
			if (this.visuals.latest(id) !== c.intentId)
				throw Error("avatar is not latest admitted intent");
		}
		if (!this.visuals.candidateAllowed(c, "destination"))
			throw Error("avatar destination permission denied");
		if (!this.capacity.has(c.avatar))
			throw Error("avatar retained asset capacity missing");
		// No await between the trusted current world/work/bytes check and SQLite writes.
		if (authority.validateCandidate(structuredClone(c), input.mode) !== true)
			throw Error("avatar current authority denied");
		const next = this.writeAvatar(p, c.avatar.sha256),
			visual = this.visuals.advance(id, next.revision);
		this.visuals.profiles.capture(next, visual.revision);
		const receipt: AvatarApplicationReceipt = {
			version: 1,
			agentId: id,
			requestKey: input.requestKey,
			payloadDigest: visualDigest(input),
			candidateId: c.candidateId,
			mode: input.mode,
			avatarId: c.avatar.sha256,
			profile: next,
			visual,
		};
		this.saveReceipt(id, input.requestKey, "generated", input, receipt);
		const publication: AvatarAuthority = {
			version: 1,
			id: visualDigest({ agentId: id, requestKey: input.requestKey }),
			agentId: id,
			sha256: c.avatar.sha256,
			kind: "generated",
			requestKey: input.requestKey,
			candidate: c,
		};
		this.addAuthority(publication);
		return receipt;
	}
	manual(
		id: string,
		value: ManualAvatarInput,
		verifyAsset: (asset: AvatarAsset) => boolean,
	): ManualAvatarReceipt {
		const input = this.parseManual(value),
			old = this.receipt<ManualAvatarReceipt>(
				id,
				input.requestKey,
				"manual",
				input,
			);
		if (old) return old;
		const p = this.casProfile(id, input.expectedProfileRevision);
		this.visuals.cas(id, input.expectedVisualRevision);
		if (
			typeof verifyAsset !== "function" ||
			verifyAsset(structuredClone(input.asset)) !== true
		)
			throw Error("manual avatar authority denied");
		if (!this.capacity.has(input.asset))
			throw Error("manual avatar retained capacity missing");
		if (input.source.kind === "restore") {
			const original = this.authority(input.source.authorityId);
			if (
				!original ||
				original.agentId !== id ||
				original.sha256 !== input.asset.sha256 ||
				original.kind === "generated" ||
				!this.active(original.id)
			)
				throw Error("manual restore authority denied");
			if (!isDeepStrictEqual(original.asset, input.asset))
				throw Error("manual restore authority asset conflict");
			this.assertManualAncestry(original);
		}
		const next = this.writeAvatar(p, input.asset.sha256),
			visual = this.visuals.advance(id, next.revision);
		this.visuals.profiles.capture(next, visual.revision);
		const a: AvatarAuthority = {
			version: 1,
			id: visualDigest({ agentId: id, requestKey: input.requestKey }),
			agentId: id,
			sha256: input.asset.sha256,
			kind: "manual",
			requestKey: input.requestKey,
			source: input.source,
			asset: input.asset,
		};
		this.addAuthority(a);
		const receipt: ManualAvatarReceipt = {
			version: 1,
			agentId: id,
			requestKey: input.requestKey,
			payloadDigest: visualDigest(input),
			authorityId: a.id,
			profile: next,
			visual,
		};
		this.saveReceipt(id, input.requestKey, "manual", input, receipt);
		return receipt;
	}
	legacy(
		id: string,
		value: AvatarAsset,
		verifyAsset: (asset: AvatarAsset) => boolean,
	): AvatarAuthority {
		const asset = parseAvatarAsset(value);
		const row = this.db
			.prepare(
				"SELECT source_json FROM agent_avatar_legacy_sources WHERE agent_id=? AND sha256=?",
			)
			.get(id, asset.sha256);
		if (!row) throw Error("legacy avatar source not captured");
		if (
			typeof verifyAsset !== "function" ||
			verifyAsset(structuredClone(asset)) !== true ||
			!this.capacity.has(asset)
		)
			throw Error("legacy avatar verified capacity missing");
		const source = this.legacySource(JSON.parse(String(row["source_json"])));
		const a: AvatarAuthority = {
			version: 1,
			id: visualDigest({ agentId: id, sha256: asset.sha256, source }),
			agentId: id,
			sha256: asset.sha256,
			kind: "legacy",
			source,
			asset,
		};
		this.addAuthority(a);
		return a;
	}
	seed(
		id: string,
		value: AvatarAsset,
		sourceId: string,
		verifyAsset: (asset: AvatarAsset) => boolean,
	): AvatarAuthority {
		const asset = parseAvatarAsset(value);
		boundedId(sourceId, "seed source");
		if (
			typeof verifyAsset !== "function" ||
			verifyAsset(structuredClone(asset)) !== true ||
			!this.capacity.has(asset)
		)
			throw Error("seed avatar verified capacity missing");
		const source = { kind: "seed" as const, sourceId },
			old = this.db
				.prepare(
					"SELECT source_json FROM agent_avatar_legacy_sources WHERE agent_id=? AND sha256=?",
				)
				.get(id, asset.sha256);
		if (
			old &&
			!isDeepStrictEqual(JSON.parse(String(old["source_json"])), source)
		)
			throw Error("legacy avatar source conflict");
		if (!old)
			this.db
				.prepare("INSERT INTO agent_avatar_legacy_sources VALUES(?,?,?)")
				.run(id, asset.sha256, JSON.stringify(source));
		return this.legacy(id, asset, verifyAsset);
	}
	private legacySource(
		value: unknown,
	): Extract<AvatarAuthority, { kind: "legacy" }>["source"] {
		if ((value as { kind?: unknown })?.kind === "profile") {
			const s = exact(value, "kind,profileRevision");
			return {
				kind: "profile",
				profileRevision: integer(s["profileRevision"], 1),
			};
		}
		const s = exact(value, "kind,sourceId");
		if (s["kind"] !== "seed") throw Error("invalid legacy avatar source");
		return { kind: "seed", sourceId: boundedId(s["sourceId"], "seed source") };
	}
	pin(id: string, value: PinInput): AgentVisual {
		const v = exact(value, "requestKey,expectedRevision,pinned"),
			input = {
				requestKey: boundedId(v["requestKey"], "request key"),
				expectedRevision: integer(v["expectedRevision"], 1),
				pinned: bool(v["pinned"]),
			};
		const old = this.receipt<AgentVisual>(id, input.requestKey, "pin", input);
		if (old) return old;
		const visual = this.visuals.pin(id, input.expectedRevision, input.pinned);
		this.saveReceipt(id, input.requestKey, "pin", input, visual);
		return visual;
	}
	authorities(sha256: string): AvatarAuthority[] {
		hash(sha256);
		return this.db
			.prepare(
				"SELECT id FROM agent_avatar_authorities WHERE sha256=? AND revoked=0 ORDER BY id",
			)
			.all(sha256)
			.map((r) => {
				const authority = requireVisualRecord(this.authority(String(r["id"])));
				if (authority.kind !== "generated")
					this.assertManualAncestry(authority);
				return authority;
			});
	}
	assertManualAncestry(authority: AvatarAuthority): void {
		assertManualAvatarAncestry(authority, (id) => this.authority(id));
	}
	authority(id: string): AvatarAuthority | undefined {
		const r = this.db
			.prepare(
				"SELECT agent_id,sha256,data,digest,revoked FROM agent_avatar_authorities WHERE id=?",
			)
			.get(id);
		if (!r) return undefined;
		const value = JSON.parse(String(r["data"])) as AvatarAuthority;
		if (
			value.id !== id ||
			value.agentId !== r["agent_id"] ||
			value.sha256 !== r["sha256"] ||
			visualDigest(value) !== r["digest"] ||
			![0, 1].includes(Number(r["revoked"]))
		)
			throw Error("corrupt avatar authority");
		return value;
	}
	revoke(id: string, authorityId: string): boolean {
		const a = this.authority(authorityId);
		if (!a || a.agentId !== id) throw Error("avatar authority not found");
		return (
			Number(
				this.db
					.prepare(
						"UPDATE agent_avatar_authorities SET revoked=1 WHERE id=? AND revoked=0",
					)
					.run(authorityId).changes,
			) > 0
		);
	}
	receipt<T>(
		id: string,
		key: string,
		kind: string,
		input: unknown,
	): T | undefined {
		const r = this.db
			.prepare(
				"SELECT kind,payload_digest,input_json,outcome_json FROM agent_avatar_receipts WHERE agent_id=? AND request_key=?",
			)
			.get(id, key);
		if (!r) return undefined;
		if (
			r["kind"] !== kind ||
			r["payload_digest"] !== visualDigest(input) ||
			!isDeepStrictEqual(JSON.parse(String(r["input_json"])), input)
		)
			throw Error("avatar operation conflict");
		const outcome = JSON.parse(String(r["outcome_json"]));
		if (kind !== "pin")
			this.visuals.profiles.assertOutcome(
				outcome.profile,
				outcome.visual.revision,
			);
		if (kind === "manual")
			this.assertManualAncestry(
				requireVisualRecord(this.authority(outcome.authorityId)),
			);
		return outcome as T;
	}
	private parseManual(value: unknown): ManualAvatarInput {
		const v = exact(
				value,
				"requestKey,expectedProfileRevision,expectedVisualRevision,asset,source",
			),
			source = v["source"] as ManualAvatarInput["source"];
		if (source?.kind === "upload") exact(source, "kind");
		else {
			exact(source, "kind,authorityId");
			if (source.kind !== "restore")
				throw Error("invalid manual avatar source");
			boundedId(source.authorityId, "authority id");
		}
		return {
			requestKey: boundedId(v["requestKey"], "request key"),
			expectedProfileRevision: integer(v["expectedProfileRevision"], 1),
			expectedVisualRevision: integer(v["expectedVisualRevision"], 1),
			asset: parseAvatarAsset(v["asset"]),
			source: structuredClone(source),
		};
	}
	private active(id: string): boolean {
		return (
			this.db
				.prepare("SELECT revoked FROM agent_avatar_authorities WHERE id=?")
				.get(id)?.["revoked"] === 0
		);
	}
	private casProfile(id: string, revision: number): AgentProfile {
		const p = this.profile(id);
		if (!p) throw Error("agent not found");
		if (p.revision !== revision) throw Error("stale profile revision");
		return p;
	}
	private writeAvatar(p: AgentProfile, sha256: string): AgentProfile {
		const next = { ...p, avatarId: sha256, revision: p.revision + 1 },
			{ revision: _revision, ...input } = next;
		validateAgentInput(input);
		this.db
			.prepare(
				"UPDATE agent_profiles SET avatar_id=?,revision=? WHERE id=? AND revision=?",
			)
			.run(sha256, next.revision, p.id, p.revision);
		return next;
	}
	private saveReceipt(
		id: string,
		key: string,
		kind: string,
		input: unknown,
		outcome: unknown,
	): void {
		this.db
			.prepare("INSERT INTO agent_avatar_receipts VALUES(?,?,?,?,?,?)")
			.run(
				id,
				key,
				kind,
				visualDigest(input),
				JSON.stringify(input),
				JSON.stringify(outcome),
			);
	}
	private addAuthority(a: AvatarAuthority): void {
		const old = this.authority(a.id);
		if (old) {
			if (!isDeepStrictEqual(old, a)) throw Error("avatar authority conflict");
			return;
		}
		this.db
			.prepare("INSERT INTO agent_avatar_authorities VALUES(?,?,?,?,?,0)")
			.run(a.id, a.agentId, a.sha256, JSON.stringify(a), visualDigest(a));
	}
}
