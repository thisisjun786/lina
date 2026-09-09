import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { AgentProfile } from "./types.ts";
import { boundedId } from "./validation.ts";
import type {
	AgentVisual,
	AvatarAdmission,
	GeneratedAvatarCandidate,
	VisualInput,
} from "./visual.ts";
import {
	AVATAR_ADMISSION_RECORDS,
	AVATAR_CANDIDATE_OUTPUT_RECORDS,
	AVATAR_FIRST_ATTEMPT_RECORDS,
	requireVisualHistorySpace,
} from "./visual-history-capacity.ts";
import { VisualIdentity } from "./visual-identity.ts";
import { VisualProfiles } from "./visual-profiles.ts";
import {
	integer,
	parseAgentVisual,
	parseAvatarAdmission,
	parseAvatarCandidate,
	parseVisualInput,
	requireVisualRecord,
	visualDigest,
} from "./visual-validation.ts";

/** SQL owner for visual snapshots and lineage. Caller owns the enclosing transaction. */
export class VisualPersistence {
	readonly identity: VisualIdentity;
	readonly profiles: VisualProfiles;
	constructor(
		private readonly db: DatabaseSync,
		private readonly profile: (id: string) => AgentProfile | undefined,
	) {
		this.identity = new VisualIdentity(db, this);
		this.profiles = new VisualProfiles(db, profile);
	}
	initialize(profile: AgentProfile, legacy = true): AgentVisual {
		const value: AgentVisual = {
			version: 1,
			agentId: profile.id,
			revision: 1,
			profileRevision: profile.revision,
			avatarPolicyRevision: 0,
			pinned: false,
			anchors: [],
			canonicalReferenceId: null,
			textIdentity: null,
			avatarPolicy: null,
			referenceLimits: null,
			maxHistoryRecords: null,
		};
		this.save(value);
		this.profiles.capture(profile, value.revision, true);
		if (legacy && profile.avatarId)
			this.db
				.prepare("INSERT INTO agent_avatar_legacy_sources VALUES(?,?,?)")
				.run(
					profile.id,
					profile.avatarId.toLowerCase(),
					JSON.stringify({
						kind: "profile",
						profileRevision: profile.revision,
					}),
				);
		return value;
	}
	get(id: string): AgentVisual {
		boundedId(id, "agent id");
		const r = this.db
			.prepare("SELECT revision,data FROM agent_visuals WHERE agent_id=?")
			.get(id);
		if (!r) throw Error("agent visual not found");
		const v = parseAgentVisual(JSON.parse(String(r["data"])));
		if (v.agentId !== id || v.revision !== r["revision"])
			throw Error("corrupt agent visual");
		return v;
	}
	at(id: string, revision: number): AgentVisual | undefined {
		integer(revision, 1);
		const r = this.db
			.prepare(
				"SELECT data,digest FROM agent_visual_history WHERE agent_id=? AND revision=?",
			)
			.get(id, revision);
		if (!r) return undefined;
		const v = parseAgentVisual(JSON.parse(String(r["data"])));
		if (
			v.agentId !== id ||
			v.revision !== revision ||
			visualDigest(v) !== r["digest"]
		)
			throw Error("corrupt visual history");
		return v;
	}
	history(id: string): AgentVisual[] {
		return this.db
			.prepare(
				"SELECT revision FROM agent_visual_history WHERE agent_id=? ORDER BY revision",
			)
			.all(id)
			.map((r) => requireVisualRecord(this.at(id, Number(r["revision"]))));
	}
	update(
		id: string,
		expectedRevision: number,
		input: VisualInput,
	): AgentVisual {
		const value = parseVisualInput(input),
			current = this.cas(id, expectedRevision);
		if (
			value.canonicalReferenceId &&
			!this.identity.reference(id, value.canonicalReferenceId)
		)
			throw Error("canonical reference not found");
		const {
			version: _v,
			agentId: _a,
			revision: _r,
			profileRevision: _p,
			avatarPolicyRevision: _ap,
			pinned: _pin,
			...old
		} = current;
		if (isDeepStrictEqual(value, old)) return current;
		const next = {
			...current,
			...value,
			revision: current.revision + 1,
			profileRevision: this.requireProfile(id).revision,
			avatarPolicyRevision:
				current.avatarPolicyRevision +
				(isDeepStrictEqual(current.avatarPolicy, value.avatarPolicy) ? 0 : 1),
		};
		this.save(next);
		return next;
	}
	cas(id: string, revision: number): AgentVisual {
		integer(revision, 1);
		const v = this.get(id);
		if (v.revision !== revision) throw Error("stale visual revision");
		return v;
	}
	advance(id: string, profileRevision: number): AgentVisual {
		const v = this.get(id);
		const next = { ...v, revision: v.revision + 1, profileRevision };
		this.save(next);
		return next;
	}
	pin(id: string, revision: number, pinned: boolean): AgentVisual {
		const v = this.cas(id, revision);
		if (v.pinned === pinned) return v;
		const next = {
			...v,
			pinned,
			revision: v.revision + 1,
			profileRevision: this.requireProfile(id).revision,
		};
		this.save(next);
		return next;
	}
	admit(id: string, value: AvatarAdmission): AvatarAdmission {
		const a = parseAvatarAdmission(value);
		if (a.agentId !== id) throw Error("avatar admission owner conflict");
		const old = this.admission(id, a.intentId);
		if (old) {
			if (!isDeepStrictEqual(old, a)) throw Error("avatar admission conflict");
			return old;
		}
		const v = this.cas(id, a.visualRevision),
			p = this.requireProfile(id);
		if (
			p.revision !== a.profileRevision ||
			v.avatarPolicyRevision !== a.avatarPolicyRevision ||
			v.avatarPolicy?.worldId !== a.worldId
		)
			throw Error("stale avatar admission policy");
		if (v.pinned && v.avatarPolicy.whilePinned === "skip")
			throw Error("avatar admission pinned");
		this.assertAdmission(a);
		if (
			!this.identity.identityAllowed(
				this.identity.frozen(id, a.visualRevision, a.profileRevision, a.grants),
				"provider",
			)
		)
			throw Error("avatar admission permission denied");
		if (v.referenceLimits === null)
			throw Error("reference limits not configured");
		this.requireHistorySpace(id, AVATAR_ADMISSION_RECORDS);
		const ordinal = Number(
			requireVisualRecord(
				this.db
					.prepare(
						"SELECT COALESCE(MAX(ordinal),0)+1 n FROM agent_avatar_admissions WHERE agent_id=?",
					)
					.get(id),
			)["n"],
		);
		this.db
			.prepare("INSERT INTO agent_avatar_admissions VALUES(?,?,?,?,?)")
			.run(id, a.intentId, ordinal, JSON.stringify(a), visualDigest(a));
		return a;
	}
	admission(id: string, intentId: string): AvatarAdmission | undefined {
		const r = this.db
			.prepare(
				"SELECT data,digest FROM agent_avatar_admissions WHERE agent_id=? AND intent_id=?",
			)
			.get(id, intentId);
		if (!r) return undefined;
		const a = parseAvatarAdmission(JSON.parse(String(r["data"])));
		if (
			a.agentId !== id ||
			a.intentId !== intentId ||
			visualDigest(a) !== r["digest"]
		)
			throw Error("corrupt avatar admission");
		return a;
	}
	latest(id: string): string | null {
		return (
			(this.db
				.prepare(
					"SELECT intent_id FROM agent_avatar_admissions WHERE agent_id=? ORDER BY ordinal DESC LIMIT 1",
				)
				.get(id)?.["intent_id"] as string) ?? null
		);
	}
	record(value: GeneratedAvatarCandidate): GeneratedAvatarCandidate {
		const c = parseAvatarCandidate(value),
			old = this.candidate(c.agentId, c.candidateId);
		if (old) {
			if (!isDeepStrictEqual(old, c)) throw Error("avatar candidate conflict");
			return old;
		}
		if (
			this.db
				.prepare(
					"SELECT 1 FROM agent_avatar_history WHERE agent_id=? AND intent_id=? AND attempt_id=?",
				)
				.get(c.agentId, c.intentId, c.attemptId)
		)
			throw Error("avatar candidate attempt conflict");
		const {
			version: _v,
			kind: _k,
			candidateId: _c,
			attemptId: _a,
			providerGenerationId: _p,
			artifact: _ar,
			avatar: _av,
			...admission
		} = c;
		if (!isDeepStrictEqual(this.admission(c.agentId, c.intentId), admission))
			throw Error("avatar candidate admission conflict");
		this.assertAdmission(admission);
		const slot = this.db
			.prepare(
				"SELECT state FROM agent_avatar_candidate_reservations WHERE agent_id=? AND intent_id=? AND attempt_id=?",
			)
			.get(c.agentId, c.intentId, c.attemptId);
		if (slot?.["state"] !== "reserved")
			this.reserveCandidate(c.agentId, c.intentId, c.attemptId);
		this.db
			.prepare(
				"UPDATE agent_avatar_candidate_reservations SET state='filled' WHERE agent_id=? AND intent_id=? AND attempt_id=?",
			)
			.run(c.agentId, c.intentId, c.attemptId);
		this.db
			.prepare("INSERT INTO agent_avatar_history VALUES(?,?,?,?,?,?)")
			.run(
				c.agentId,
				c.candidateId,
				c.intentId,
				c.attemptId,
				JSON.stringify(c),
				visualDigest(c),
			);
		return c;
	}
	candidate(
		id: string,
		candidateId: string,
	): GeneratedAvatarCandidate | undefined {
		const r = this.db
			.prepare(
				"SELECT intent_id,attempt_id,data,digest FROM agent_avatar_history WHERE agent_id=? AND candidate_id=?",
			)
			.get(id, candidateId);
		if (!r) return undefined;
		const c = parseAvatarCandidate(JSON.parse(String(r["data"])));
		if (
			c.agentId !== id ||
			c.candidateId !== candidateId ||
			c.intentId !== r["intent_id"] ||
			c.attemptId !== r["attempt_id"] ||
			visualDigest(c) !== r["digest"]
		)
			throw Error("corrupt avatar candidate");
		const reservation = this.db
			.prepare(
				"SELECT state FROM agent_avatar_candidate_reservations WHERE agent_id=? AND intent_id=? AND attempt_id=?",
			)
			.get(id, c.intentId, c.attemptId);
		if (reservation?.["state"] !== "filled")
			throw Error("missing filled candidate capacity reservation");
		return c;
	}
	candidates(id: string): GeneratedAvatarCandidate[] {
		return this.db
			.prepare(
				"SELECT candidate_id FROM agent_avatar_history WHERE agent_id=? ORDER BY rowid",
			)
			.all(id)
			.map((r) =>
				requireVisualRecord(this.candidate(id, String(r["candidate_id"]))),
			);
	}
	candidateAllowed(
		c: GeneratedAvatarCandidate,
		phase: "provider" | "destination",
	): boolean {
		const stored = this.candidate(c.agentId, c.candidateId);
		return Boolean(
			stored &&
				isDeepStrictEqual(stored, c) &&
				this.identity.identityAllowed(
					this.identity.frozen(
						c.agentId,
						c.visualRevision,
						c.profileRevision,
						c.grants,
					),
					phase,
				),
		);
	}
	assertAdmission(a: AvatarAdmission): void {
		const v = this.at(a.agentId, a.visualRevision);
		if (
			!v ||
			v.avatarPolicyRevision !== a.avatarPolicyRevision ||
			v.avatarPolicy?.worldId !== a.worldId ||
			!this.profiles.associated(v, a.profileRevision)
		)
			throw Error("invalid avatar historical policy");
		if (
			(a.source.kind === "avatar_wall" &&
				v.avatarPolicy.schedule?.kind !== "wall") ||
			(a.source.kind === "avatar_steps" &&
				v.avatarPolicy.schedule?.kind !== "steps") ||
			(a.source.kind === "avatar_event" &&
				!v.avatarPolicy.eventFamilyIds.includes(a.source.familyId))
		)
			throw Error("invalid avatar historical source");
		if (
			a.grants.some((g) => g.purpose.kind !== "avatar") ||
			!this.identity.identityAllowed(
				this.identity.frozen(
					a.agentId,
					a.visualRevision,
					a.profileRevision,
					a.grants,
				),
				"provider",
				true,
			)
		)
			throw Error("invalid avatar historical grants");
	}
	reserveCandidate(id: string, intentId: string, attemptId: string): void {
		boundedId(attemptId, "attempt");
		if (!this.admission(id, intentId))
			throw Error("avatar admission not found");
		const old = this.db
			.prepare(
				"SELECT state FROM agent_avatar_candidate_reservations WHERE agent_id=? AND intent_id=? AND attempt_id=?",
			)
			.get(id, intentId, attemptId);
		if (old?.["state"] === "reserved" || old?.["state"] === "filled") return;
		if (this.get(id).referenceLimits === null)
			throw Error("reference limits not configured");
		const hasSlot = this.db
			.prepare(
				"SELECT 1 FROM agent_avatar_candidate_reservations WHERE agent_id=? AND intent_id=?",
			)
			.get(id, intentId);
		// The first attempt adopts the admission reservation; retries retain their old row.
		this.requireHistorySpace(
			id,
			old
				? AVATAR_CANDIDATE_OUTPUT_RECORDS
				: hasSlot
					? AVATAR_FIRST_ATTEMPT_RECORDS
					: 0,
		);
		this.db
			.prepare(
				"INSERT INTO agent_avatar_candidate_reservations VALUES(?,?,?,'reserved') ON CONFLICT(agent_id,intent_id,attempt_id) DO UPDATE SET state='reserved'",
			)
			.run(id, intentId, attemptId);
	}
	releaseCandidate(id: string, intentId: string, attemptId: string): void {
		this.db
			.prepare(
				"UPDATE agent_avatar_candidate_reservations SET state='released' WHERE agent_id=? AND intent_id=? AND attempt_id=? AND state='reserved'",
			)
			.run(id, intentId, attemptId);
	}
	requireHistorySpace(id: string, extra: number): void {
		requireVisualHistorySpace(this.db, id, extra);
	}

	requireProfile(id: string): AgentProfile {
		const p = this.profile(id);
		if (!p) throw Error("agent not found");
		return p;
	}
	private save(value: AgentVisual): void {
		const v = parseAgentVisual(value);
		this.db
			.prepare("INSERT INTO agent_visual_history VALUES(?,?,?,?)")
			.run(v.agentId, v.revision, JSON.stringify(v), visualDigest(v));
		this.db
			.prepare(
				"INSERT INTO agent_visuals VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
			)
			.run(v.agentId, v.revision, JSON.stringify(v));
	}
}
