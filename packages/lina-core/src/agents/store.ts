import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { SourceLookup } from "../source-policy.ts";
import { AgentLearning } from "./agent-learning.ts";
import { initializeAgents } from "./agent-schema.ts";
import {
	assertLearnedProvenance,
	type LearnedProvenance,
} from "./learned-provenance.ts";
import { emptyLearningState } from "./learning-state.ts";
import type {
	AgentChange,
	AgentInput,
	AgentProfile,
	Dynamics,
	ReflectionInput,
} from "./types.ts";
import {
	boundedId,
	MAX_AGENTS,
	MOOD_TTL_MS,
	validateAgentInput,
	validatePatch,
	validateReflection,
} from "./validation.ts";
import type {
	AvatarAdmission,
	AvatarApplicationAuthority,
	AvatarApplyInput,
	AvatarAsset,
	AvatarCapacityInput,
	AvatarInventoryFile,
	FrozenVisualIdentity,
	GeneratedAvatarCandidate,
	ManualAvatarInput,
	VisualGrant,
	VisualInput,
	VisualPurpose,
	VisualReference,
} from "./visual.ts";
import { VisualApplications } from "./visual-applications.ts";
import { auditVisuals } from "./visual-audit.ts";
import { VisualCapacity } from "./visual-capacity.ts";
import { VisualPersistence } from "./visual-persistence.ts";
import { parseFrozenVisualIdentity } from "./visual-validation.ts";

const MAX_PENDING_CANDIDATES = 32;
const MAX_PROMOTED_VALUES = 16;

type ProfileRow = Omit<AgentProfile, "interests" | "avatarId"> & {
	interests: string;
	avatar_id: string | null;
};
type DynamicsRow = {
	revision: number;
	mood: string | null;
	interests: string;
	preferences: string;
	relationship: string;
	last_request_id: string | null;
};
type ChangeRow = {
	id: number;
	kind: AgentChange["kind"];
	created_at: string;
	source_entry_ids: string;
	summary: string;
};

function json<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new Error(`corrupt ${label}`);
	}
}
function clone<T>(value: T): T {
	return structuredClone(value);
}

export class AgentStore {
	private readonly db: DatabaseSync;
	private readonly now: () => number;
	private readonly learning: AgentLearning;
	private readonly visuals: VisualPersistence;
	private readonly visualApplications: VisualApplications;
	private readonly visualCapacity: VisualCapacity;
	private closed = false;

	constructor(path: string, now: () => number = Date.now) {
		if (
			typeof path !== "string" ||
			path.length === 0 ||
			typeof now !== "function"
		)
			throw new Error("invalid agent store arguments");
		this.now = now;
		this.db = new DatabaseSync(path);
		this.learning = new AgentLearning(this.db);
		this.visuals = new VisualPersistence(this.db, (id) => this.get(id));
		this.visualCapacity = new VisualCapacity(this.db);
		this.visualApplications = new VisualApplications(
			this.db,
			this.visuals,
			this.visualCapacity,
			(id) => this.get(id),
		);
		try {
			this.db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
			initializeAgents(
				this.db,
				() => this.auditData(),
				(value) => this.validateStoredDynamics(value),
				() => {
					for (const profile of this.list()) this.visuals.initialize(profile);
				},
				() =>
					auditVisuals(
						this.db,
						this.visuals,
						this.visualApplications,
						this.visualCapacity,
						this.list(),
					),
			);
			this.db.exec(
				"COMMIT; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
			);
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			this.db.close();
			throw error;
		}
	}

	list(): AgentProfile[] {
		this.assertOpen();
		return (
			this.db
				.prepare("SELECT * FROM agent_profiles ORDER BY id")
				.all() as unknown as ProfileRow[]
		).map((row) => this.decodeProfile(row));
	}

	get(id: string): AgentProfile | undefined {
		this.assertOpen();
		if (typeof id !== "string") return undefined;
		const row = this.db
			.prepare("SELECT * FROM agent_profiles WHERE id = ?")
			.get(id) as ProfileRow | undefined;
		return row ? this.decodeProfile(row) : undefined;
	}

	create(input: AgentInput): AgentProfile {
		this.assertOpen();
		const value = validateAgentInput(input);
		return this.transaction(() => {
			if (
				(
					this.db.prepare("SELECT COUNT(*) AS n FROM agent_profiles").get() as {
						n: number;
					}
				).n >= MAX_AGENTS
			)
				throw new Error("agent capacity reached");
			if (this.get(value.id)) throw new Error("agent already exists");
			this.db
				.prepare(
					"INSERT INTO agent_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					value.id,
					value.name,
					value.role,
					value.personality,
					value.voice,
					value.profile,
					value.appearance,
					JSON.stringify(value.interests),
					value.avatarId,
					value.evolution,
					1,
				);
			this.db
				.prepare(
					"INSERT INTO agent_dynamics VALUES (?, 0, NULL, '[]', '[]', '[]', NULL)",
				)
				.run(value.id);
			this.visuals.initialize({ ...value, revision: 1 }, false);
			return { ...value, revision: 1 };
		});
	}

	update(
		id: string,
		expectedRevision: number,
		patch: Partial<Omit<AgentInput, "id">>,
	): AgentProfile {
		this.assertOpen();
		boundedId(id, "agent id");
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
			throw new Error("invalid profile revision");
		const fields = validatePatch(patch);
		return this.transaction(() => {
			const current = this.get(id);
			if (!current) throw new Error("agent not found");
			if (current.revision !== expectedRevision)
				throw new Error("stale profile revision");
			const next = {
				...current,
				...fields,
				revision: current.revision + 1,
			} as AgentProfile;
			const { revision: _revision, ...nextInput } = next;
			const checked = validateAgentInput(nextInput);
			this.db
				.prepare(
					"UPDATE agent_profiles SET name=?, role=?, personality=?, voice=?, profile=?, appearance=?, interests=?, avatar_id=?, evolution=?, revision=? WHERE id=? AND revision=?",
				)
				.run(
					checked.name,
					checked.role,
					checked.personality,
					checked.voice,
					checked.profile,
					checked.appearance,
					JSON.stringify(checked.interests),
					checked.avatarId,
					checked.evolution,
					next.revision,
					id,
					expectedRevision,
				);
			if ("avatarId" in fields || "appearance" in fields)
				this.visuals.advance(id, next.revision);
			this.visuals.profiles.capture(
				{ ...checked, revision: next.revision },
				this.visuals.get(id).revision,
			);
			if (Object.keys(fields).length === 1 && "avatarId" in fields)
				return { ...checked, revision: next.revision };
			this.db.prepare("DELETE FROM agent_candidates WHERE agent_id=?").run(id);
			this.addChange(id, "edit", [], "기본 설정 수정", null, null);
			this.learning.edit(id, this.dynamics(id));
			return { ...checked, revision: current.revision + 1 };
		});
	}

	dynamics(id: string): Dynamics {
		this.assertOpen();
		boundedId(id, "agent id");
		if (!this.get(id)) throw new Error("agent not found");
		return this.decodeDynamics(
			this.db
				.prepare("SELECT * FROM agent_dynamics WHERE agent_id=?")
				.get(id) as DynamicsRow,
		);
	}

	modelDynamics(id: string, lookup: SourceLookup) {
		return this.learning.model(id, this.dynamics(id), lookup, this.now());
	}
	applyReflection(
		id: string,
		input: ReflectionInput,
		validSource: (entryId: string) => boolean,
		provenance?: LearnedProvenance,
	): Dynamics {
		this.assertOpen();
		boundedId(id, "agent id");
		if (typeof validSource !== "function")
			throw new Error("invalid source validator");
		const value = validateReflection(input);
		if (provenance)
			assertLearnedProvenance(
				provenance,
				value.requestId,
				value.sourceEntryIds,
			);
		return this.transaction(() => {
			const profile = this.get(id);
			if (!profile) throw new Error("agent not found");
			const current = this.dynamics(id);
			if (value.profileRevision !== profile.revision)
				throw new Error("stale profile revision");
			if (profile.evolution === "manual") return current;
			if (
				this.db
					.prepare(
						"SELECT 1 FROM agent_receipts WHERE agent_id=? AND request_id=?",
					)
					.get(id, value.requestId)
			) {
				if (provenance) this.learning.receipt(id, value, provenance);
				return current;
			}
			if (value.dynamicsRevision !== current.revision)
				throw new Error("stale dynamics revision");
			if (value.sourceEntryIds.some((entryId) => !validSource(entryId)))
				throw new Error("reflection source is not a valid user entry");
			if (provenance)
				return this.applyQualifiedReflection(id, value, current, provenance);
			const interests = this.confirmCandidates(
				id,
				"interest",
				value.interests ?? [],
				current.interests,
				value.requestId,
			);
			const preferences = this.confirmCandidates(
				id,
				"preference",
				value.preferences ?? [],
				current.preferences,
				value.requestId,
			);
			const next: Dynamics = {
				revision: current.revision + 1,
				mood: value.mood
					? { ...value.mood, expiresAt: this.now() + MOOD_TTL_MS }
					: current.mood,
				interests,
				preferences,
				relationship: this.confirmCandidates(
					id,
					"relationship",
					value.relationship ?? [],
					current.relationship,
					value.requestId,
				),
				lastRequestId: value.requestId,
			};
			const visibleChanged = !isDeepStrictEqual(
				{
					mood: current.mood,
					interests: current.interests,
					preferences: current.preferences,
					relationship: current.relationship,
				},
				{
					mood: next.mood,
					interests: next.interests,
					preferences: next.preferences,
					relationship: next.relationship,
				},
			);
			if (!visibleChanged) {
				next.revision = current.revision;
				this.saveDynamics(id, next);
				this.learning.save(id, emptyLearningState(), "legacy", current, next);
				this.db
					.prepare("INSERT INTO agent_receipts VALUES (?, ?)")
					.run(id, value.requestId);
				return next;
			}
			this.saveDynamics(id, next);
			this.learning.save(id, emptyLearningState(), "legacy", current, next);
			this.db
				.prepare("INSERT INTO agent_receipts VALUES (?, ?)")
				.run(id, value.requestId);
			this.addChange(
				id,
				"reflection",
				value.sourceEntryIds,
				"대화에서 배운 변화",
				JSON.stringify(current),
				JSON.stringify(next),
			);
			return next;
		});
	}

	pendingGrowth(id: string): {
		interests: string[];
		preferences: string[];
		relationship: string[];
	} {
		this.assertOpen();
		boundedId(id, "agent id");
		const result = {
			interests: [] as string[],
			preferences: [] as string[],
			relationship: [] as string[],
		};
		const rows = this.db
			.prepare(
				"SELECT kind,value FROM agent_candidates WHERE agent_id=? ORDER BY rowid DESC LIMIT 96",
			)
			.all(id) as { kind: string; value: string }[];
		for (const row of rows) {
			const items =
				row.kind === "interest"
					? result.interests
					: row.kind === "preference"
						? result.preferences
						: result.relationship;
			if (items.length < 6) items.push(row.value);
		}
		return result;
	}

	changes(id: string): AgentChange[] {
		this.assertOpen();
		boundedId(id, "agent id");
		return (
			this.db
				.prepare(
					"SELECT id,kind,created_at,source_entry_ids,summary FROM agent_changes WHERE agent_id=? ORDER BY id DESC LIMIT 50",
				)
				.all(id) as unknown as ChangeRow[]
		).map((row) => ({
			id: row.id,
			kind: row.kind,
			createdAt: row.created_at,
			sourceEntryIds: json<string[]>(row.source_entry_ids, "change sources"),
			summary: row.summary,
		}));
	}

	revert(id: string, changeId: number, expectedRevision: number): Dynamics {
		this.assertOpen();
		boundedId(id, "agent id");
		if (
			!Number.isSafeInteger(changeId) ||
			changeId < 1 ||
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0
		)
			throw new Error("invalid revert arguments");
		return this.transaction(() => {
			const current = this.dynamics(id);
			if (current.revision !== expectedRevision)
				throw new Error("stale dynamics revision");
			const row = this.db
				.prepare("SELECT * FROM agent_changes WHERE id=? AND agent_id=?")
				.get(changeId, id) as
				| (ChangeRow & { before_state: string | null })
				| undefined;
			if (row?.kind !== "reflection" || !row.before_state)
				throw new Error("change is not revertible");
			if (
				this.db
					.prepare(
						"SELECT 1 FROM agent_changes WHERE agent_id=? AND target_change_id=?",
					)
					.get(id, changeId)
			)
				throw new Error("change already reverted");
			const restored = json<Dynamics>(row.before_state, "dynamics snapshot");
			restored.revision = current.revision + 1;
			this.saveDynamics(id, restored);
			this.learning.revert(id, changeId, current, restored);
			this.addChange(
				id,
				"revert",
				[],
				"대화에서 배운 변화 되돌림",
				JSON.stringify(current),
				JSON.stringify(restored),
				changeId,
			);
			return this.dynamics(id);
		});
	}

	applyAuthored(
		input: AgentInput,
		expectedRevision: number | null,
		receiptId: string,
	): AgentProfile {
		this.assertOpen();
		const value = validateAgentInput(input);
		if (
			typeof receiptId !== "string" ||
			receiptId.length === 0 ||
			receiptId.includes("\u0000")
		)
			throw new Error("invalid authored receipt");
		if (
			expectedRevision !== null &&
			(!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
		)
			throw new Error("invalid profile revision");
		const payloadHash = createHash("sha256")
			.update(JSON.stringify(value))
			.digest("hex");
		return this.transaction(() => {
			const existing = this.db
				.prepare(
					"SELECT payload_hash, profile_json FROM agent_authored_receipts WHERE receipt_id=?",
				)
				.get(receiptId) as
				| { payload_hash: string; profile_json: string }
				| undefined;
			if (existing) {
				if (existing.payload_hash !== payloadHash)
					throw new Error("authored receipt conflict");
				return json<AgentProfile>(existing.profile_json, "authored receipt");
			}
			if (expectedRevision === null) {
				if (
					(
						this.db
							.prepare("SELECT COUNT(*) AS n FROM agent_profiles")
							.get() as { n: number }
					).n >= MAX_AGENTS
				)
					throw new Error("agent capacity reached");
				if (this.get(value.id)) throw new Error("agent already exists");
				this.db
					.prepare(
						"INSERT INTO agent_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						value.id,
						value.name,
						value.role,
						value.personality,
						value.voice,
						value.profile,
						value.appearance,
						JSON.stringify(value.interests),
						value.avatarId,
						value.evolution,
						1,
					);
				this.db
					.prepare(
						"INSERT INTO agent_dynamics VALUES (?, 0, NULL, '[]', '[]', '[]', NULL)",
					)
					.run(value.id);
				const created: AgentProfile = { ...value, revision: 1 };
				this.visuals.initialize(created, false);
				this.db
					.prepare("INSERT INTO agent_authored_receipts VALUES (?, ?, ?, ?)")
					.run(receiptId, value.id, payloadHash, JSON.stringify(created));
				return created;
			}
			const current = this.get(value.id);
			if (!current) throw new Error("agent not found");
			if (current.revision !== expectedRevision)
				throw new Error("stale profile revision");
			const next: AgentProfile = {
				...value,
				revision: current.revision + 1,
			};
			this.db
				.prepare(
					"UPDATE agent_profiles SET name=?, role=?, personality=?, voice=?, profile=?, appearance=?, interests=?, avatar_id=?, evolution=?, revision=? WHERE id=? AND revision=?",
				)
				.run(
					value.name,
					value.role,
					value.personality,
					value.voice,
					value.profile,
					value.appearance,
					JSON.stringify(value.interests),
					value.avatarId,
					value.evolution,
					next.revision,
					value.id,
					expectedRevision,
				);
			if (
				current.appearance !== next.appearance ||
				current.avatarId !== next.avatarId
			)
				this.visuals.advance(value.id, next.revision);
			this.visuals.profiles.capture(next, this.visuals.get(value.id).revision);
			this.db
				.prepare("DELETE FROM agent_candidates WHERE agent_id=?")
				.run(value.id);
			this.addChange(value.id, "edit", [], "기본 설정 수정", null, null);
			this.learning.edit(value.id, this.dynamics(value.id));
			this.db
				.prepare("INSERT INTO agent_authored_receipts VALUES (?, ?, ?, ?)")
				.run(receiptId, value.id, payloadHash, JSON.stringify(next));
			return next;
		});
	}

	visual(id: string) {
		this.assertOpen();
		return this.visuals.get(id);
	}
	visualAt(id: string, revision: number) {
		this.assertOpen();
		return this.visuals.at(id, revision);
	}
	visualHistory(id: string) {
		this.assertOpen();
		return this.visuals.history(id);
	}
	updateVisual(id: string, expectedRevision: number, input: VisualInput) {
		this.assertOpen();
		return this.transaction(() =>
			this.visuals.update(id, expectedRevision, input),
		);
	}
	registerVisualReference(
		id: string,
		expectedProfileRevision: number,
		expectedVisualRevision: number,
		reference: VisualReference,
	) {
		this.assertOpen();
		return this.transaction(() =>
			this.visuals.identity.register(
				id,
				expectedProfileRevision,
				expectedVisualRevision,
				reference,
			),
		);
	}
	visualReference(id: string, referenceId: string) {
		this.assertOpen();
		return this.visuals.identity.reference(id, referenceId);
	}
	visualReferences(id: string) {
		this.assertOpen();
		return this.visuals.identity.references(id);
	}
	putVisualGrant(
		id: string,
		expectedVisualRevision: number,
		grant: VisualGrant,
	) {
		this.assertOpen();
		return this.transaction(() =>
			this.visuals.identity.putGrant(id, expectedVisualRevision, grant),
		);
	}
	visualGrants(id: string) {
		this.assertOpen();
		return this.visuals.identity.grants(id);
	}
	visualGrantAt(id: string, grantId: string, revision: number) {
		this.assertOpen();
		return this.visuals.identity.grantAt(id, grantId, revision);
	}
	freezeVisualIdentity(id: string, purpose: VisualPurpose) {
		this.assertOpen();
		return this.visuals.identity.freeze(id, purpose);
	}
	validateFrozenVisualIdentity(value: FrozenVisualIdentity): void {
		this.assertOpen();
		const frozen = parseFrozenVisualIdentity(value);
		if (!this.visuals.identity.identityAllowed(frozen, "provider", true))
			throw Error("invalid historical visual identity");
	}
	visualIdentityAllowed(
		value: FrozenVisualIdentity,
		phase: "provider" | "destination",
	) {
		this.assertOpen();
		return this.visuals.identity.identityAllowed(
			parseFrozenVisualIdentity(value),
			phase,
		);
	}
	admitAvatarIntent(id: string, admission: AvatarAdmission) {
		this.assertOpen();
		return this.transaction(() => this.visuals.admit(id, admission));
	}
	avatarAdmission(id: string, intentId: string) {
		this.assertOpen();
		return this.visuals.admission(id, intentId);
	}
	latestAvatarIntent(id: string) {
		this.assertOpen();
		return this.visuals.latest(id);
	}
	recordAvatarCandidate(candidate: GeneratedAvatarCandidate) {
		this.assertOpen();
		return this.transaction(() => this.visuals.record(candidate));
	}
	avatarCandidate(id: string, candidateId: string) {
		this.assertOpen();
		return this.visuals.candidate(id, candidateId);
	}
	avatarHistory(id: string) {
		this.assertOpen();
		return this.visuals.candidates(id);
	}
	avatarCandidateAllowed(
		candidate: GeneratedAvatarCandidate,
		phase: "provider" | "destination",
	) {
		this.assertOpen();
		return this.visuals.candidateAllowed(candidate, phase);
	}
	applyAvatarOnce(
		id: string,
		input: AvatarApplyInput,
		authority: AvatarApplicationAuthority,
	) {
		this.assertOpen();
		return this.transaction(() =>
			this.visualApplications.apply(id, input, authority),
		);
	}
	applyManualAvatarOnce(
		id: string,
		input: ManualAvatarInput,
		verifyAsset: (asset: AvatarAsset) => boolean,
	) {
		this.assertOpen();
		return this.transaction(() =>
			this.visualApplications.manual(id, input, verifyAsset),
		);
	}
	registerSeedAvatar(
		id: string,
		asset: AvatarAsset,
		sourceId: string,
		verifyAsset: (asset: AvatarAsset) => boolean,
	) {
		this.assertOpen();
		return this.transaction(() =>
			this.visualApplications.seed(id, asset, sourceId, verifyAsset),
		);
	}
	registerLegacyAvatar(
		id: string,
		asset: AvatarAsset,
		verifyAsset: (asset: AvatarAsset) => boolean,
	) {
		this.assertOpen();
		return this.transaction(() =>
			this.visualApplications.legacy(id, asset, verifyAsset),
		);
	}
	setAvatarPinned(
		id: string,
		input: { requestKey: string; expectedRevision: number; pinned: boolean },
	) {
		this.assertOpen();
		return this.transaction(() => this.visualApplications.pin(id, input));
	}
	avatarAuthorities(sha256: string) {
		this.assertOpen();
		return this.visualApplications.authorities(sha256);
	}
	revokeAvatarAuthority(id: string, authorityId: string) {
		this.assertOpen();
		return this.transaction(() =>
			this.visualApplications.revoke(id, authorityId),
		);
	}
	syncAvatarInventory(files: AvatarInventoryFile[]) {
		this.assertOpen();
		return this.transaction(() => this.visualCapacity.sync(files));
	}
	avatarCapacity() {
		this.assertOpen();
		return this.visualCapacity.usage();
	}
	avatarCapacityReservation(id: string) {
		this.assertOpen();
		return this.visualCapacity.get(id);
	}
	reserveAvatarCandidate(id: string, intentId: string, attemptId: string) {
		this.assertOpen();
		return this.transaction(() =>
			this.visuals.reserveCandidate(id, intentId, attemptId),
		);
	}
	reserveAvatarCapacity(input: AvatarCapacityInput) {
		this.assertOpen();
		return this.transaction(() => {
			const receipt = this.visualCapacity.reserve(input);
			if (
				receipt.state === "reserved" &&
				receipt.owner.kind === "generated" &&
				this.visuals.admission(receipt.owner.agentId, receipt.owner.intentId)
			)
				this.visuals.reserveCandidate(
					receipt.owner.agentId,
					receipt.owner.intentId,
					receipt.owner.attemptId,
				);
			return receipt;
		});
	}
	settleAvatarCapacity(id: string, asset: AvatarInventoryFile) {
		this.assertOpen();
		return this.transaction(() => this.visualCapacity.settle(id, asset));
	}
	releaseAvatarCapacity(id: string) {
		this.assertOpen();
		return this.transaction(() => {
			const receipt = this.visualCapacity.release(id);
			if (receipt.state === "released" && receipt.owner.kind === "generated")
				this.visuals.releaseCandidate(
					receipt.owner.agentId,
					receipt.owner.intentId,
					receipt.owner.attemptId,
				);
			return receipt;
		});
	}

	close(): void {
		if (!this.closed) {
			this.db.close();
			this.closed = true;
		}
	}

	private applyQualifiedReflection(
		id: string,
		input: ReflectionInput,
		current: Dynamics,
		provenance: LearnedProvenance,
	): Dynamics {
		assertLearnedProvenance(provenance, input.requestId, input.sourceEntryIds);
		this.db
			.prepare("INSERT INTO agent_receipts VALUES(?,?)")
			.run(id, input.requestId);
		const state = this.learning.propose(id, input, provenance, this.now());
		const next: Dynamics = {
			revision: current.revision,
			mood: state.mood?.value ?? null,
			interests: state.values.interests.map((v) => v.value),
			preferences: state.values.preferences.map((v) => v.value),
			relationship: state.values.relationship.map((v) => v.value),
			lastRequestId: input.requestId,
		};
		const visible = (v: Dynamics) => ({
			mood: v.mood,
			interests: v.interests,
			preferences: v.preferences,
			relationship: v.relationship,
		});
		let changeId: number | null = null;
		if (!isDeepStrictEqual(visible(current), visible(next))) {
			next.revision++;
			this.addChange(
				id,
				"reflection",
				input.sourceEntryIds,
				"대화에서 배운 변화",
				JSON.stringify(current),
				JSON.stringify(next),
			);
			changeId = Number(
				this.db.prepare("SELECT last_insert_rowid() id").get()?.["id"],
			);
		}
		this.learning.save(id, state, "reflection", current, next, changeId);
		this.saveDynamics(id, next);
		if (!this.learning.proofs(id, input.requestId, provenance.lookup))
			throw Error("stale learned prompt ancestry");
		assertLearnedProvenance(provenance, input.requestId, input.sourceEntryIds);
		return next;
	}
	private auditData(): void {
		for (const profile of this.list()) {
			if (
				!this.db
					.prepare("SELECT 1 FROM agent_dynamics WHERE agent_id=?")
					.get(profile.id)
			)
				throw Error("missing agent dynamics");
			const { revision, ...input } = profile;
			validateAgentInput(input);
			if (!Number.isSafeInteger(revision) || revision < 1)
				throw Error("invalid agent revision");
		}
		for (const row of this.db
			.prepare(
				"SELECT agent_id,revision,mood,interests,preferences,relationship,last_request_id FROM agent_dynamics",
			)
			.iterate()) {
			if (!this.get(String(row["agent_id"])))
				throw Error("orphan agent dynamics");
			this.validateStoredDynamics({
				revision: row["revision"],
				mood: row["mood"] === null ? null : JSON.parse(String(row["mood"])),
				interests: JSON.parse(String(row["interests"])),
				preferences: JSON.parse(String(row["preferences"])),
				relationship: JSON.parse(String(row["relationship"])),
				lastRequestId: row["last_request_id"],
			});
		}
		for (const row of this.db
			.prepare(
				"SELECT kind,source_entry_ids,before_state,after_state FROM agent_changes",
			)
			.iterate()) {
			if (!["edit", "reflection", "revert"].includes(String(row["kind"])))
				throw Error("invalid agent change kind");
			const sources = JSON.parse(String(row["source_entry_ids"]));
			if (
				!Array.isArray(sources) ||
				sources.some((v) => typeof v !== "string" || !v.trim())
			)
				throw Error("invalid agent change sources");
			for (const k of ["before_state", "after_state"])
				if (row[k] !== null)
					this.validateStoredDynamics(JSON.parse(String(row[k])));
		}
		if (
			this.db
				.prepare("SELECT 1 FROM sqlite_schema WHERE name='agent_candidates'")
				.get()
		)
			for (const row of this.db
				.prepare("SELECT agent_id,kind,value,request_ids FROM agent_candidates")
				.iterate()) {
				if (
					!["interest", "preference", "relationship"].includes(
						String(row["kind"]),
					)
				)
					throw Error("invalid candidate kind");
				boundedId(row["value"], "candidate value");
				const ids = JSON.parse(String(row["request_ids"]));
				if (
					!Array.isArray(ids) ||
					!ids.length ||
					new Set(ids).size !== ids.length
				)
					throw Error("invalid candidate requests");
				for (const id of ids) {
					boundedId(id, "candidate request");
					if (
						!this.db
							.prepare(
								"SELECT 1 FROM agent_receipts WHERE agent_id=? AND request_id=?",
							)
							.get(String(row["agent_id"]), id)
					)
						throw Error("orphan candidate receipt");
				}
			}
	}
	private validateStoredDynamics(value: unknown): void {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw Error("invalid dynamics snapshot");
		const v = value as Dynamics;
		if (
			v.mood !== null &&
			(!v.mood || typeof v.mood !== "object" || Array.isArray(v.mood))
		)
			throw Error("invalid persisted mood");
		if (
			Object.keys(v).sort().join(",") !==
				"interests,lastRequestId,mood,preferences,relationship,revision" ||
			!Number.isSafeInteger(v.revision) ||
			v.revision < 0
		)
			throw Error("invalid dynamics snapshot");
		validateReflection({
			profileRevision: 1,
			dynamicsRevision: v.revision,
			requestId: v.lastRequestId ?? "validation",
			sourceEntryIds: ["validation"],
			interests: v.interests,
			preferences: v.preferences,
			relationship: v.relationship,
			...(v.mood
				? { mood: { label: v.mood.label, reason: v.mood.reason } }
				: {}),
		});
		if (
			v.mood &&
			(!Number.isSafeInteger(v.mood.expiresAt) ||
				v.mood.expiresAt < 0 ||
				Object.keys(v.mood).sort().join(",") !== "expiresAt,label,reason")
		)
			throw Error("invalid persisted mood");
	}
	private decodeProfile(row: ProfileRow): AgentProfile {
		return {
			id: row.id,
			name: row.name,
			role: row.role,
			personality: row.personality,
			voice: row.voice,
			profile: row.profile,
			appearance: row.appearance,
			interests: json(row.interests, "profile interests"),
			avatarId: row.avatar_id,
			evolution: row.evolution,
			revision: row.revision,
		};
	}
	private decodeDynamics(row: DynamicsRow): Dynamics {
		const mood = row.mood ? json<Dynamics["mood"]>(row.mood, "mood") : null;
		return {
			revision: row.revision,
			mood: mood && mood.expiresAt <= this.now() ? null : mood,
			interests: json(row.interests, "interests"),
			preferences: json(row.preferences, "preferences"),
			relationship: json(row.relationship, "relationship"),
			lastRequestId: row.last_request_id,
		};
	}
	private saveDynamics(id: string, value: Dynamics): void {
		this.db
			.prepare(
				"UPDATE agent_dynamics SET revision=?,mood=?,interests=?,preferences=?,relationship=?,last_request_id=? WHERE agent_id=?",
			)
			.run(
				value.revision,
				value.mood ? JSON.stringify(value.mood) : null,
				JSON.stringify(value.interests),
				JSON.stringify(value.preferences),
				JSON.stringify(value.relationship),
				value.lastRequestId,
				id,
			);
	}
	private addChange(
		id: string,
		kind: AgentChange["kind"],
		sources: string[],
		summary: string,
		beforeState: string | null,
		afterState: string | null,
		targetChangeId: number | null = null,
	): void {
		this.db
			.prepare(
				"INSERT INTO agent_changes(agent_id,kind,created_at,source_entry_ids,summary,before_state,after_state,target_change_id) VALUES(?,?,?,?,?,?,?,?)",
			)
			.run(
				id,
				kind,
				new Date(this.now()).toISOString(),
				JSON.stringify(sources),
				summary,
				beforeState,
				afterState,
				targetChangeId,
			);
	}
	private confirmCandidates(
		id: string,
		kind: string,
		values: string[],
		existing: string[],
		requestId: string,
	): string[] {
		const result = [...existing];
		for (const value of values) {
			if (result.includes(value)) continue;
			const normalized = value.trim().toLocaleLowerCase();
			const row = this.db
				.prepare(
					"SELECT request_ids FROM agent_candidates WHERE agent_id=? AND kind=? AND value=?",
				)
				.get(id, kind, normalized) as { request_ids: string } | undefined;
			const ids = row
				? json<string[]>(row.request_ids, "candidate requests")
				: [];
			if (!ids.includes(requestId)) ids.push(requestId);
			if (ids.length >= 2) {
				if (result.length >= MAX_PROMOTED_VALUES) result.shift();
				result.push(normalized);
				this.db
					.prepare(
						"DELETE FROM agent_candidates WHERE agent_id=? AND kind=? AND value=?",
					)
					.run(id, kind, normalized);
			} else if (row)
				this.db
					.prepare(
						"UPDATE agent_candidates SET request_ids=? WHERE agent_id=? AND kind=? AND value=?",
					)
					.run(JSON.stringify(ids), id, kind, normalized);
			else {
				const count = (
					this.db
						.prepare(
							"SELECT COUNT(*) AS count FROM agent_candidates WHERE agent_id=? AND kind=?",
						)
						.get(id, kind) as { count: number }
				).count;
				if (count >= MAX_PENDING_CANDIDATES)
					this.db
						.prepare(
							"DELETE FROM agent_candidates WHERE rowid = (SELECT rowid FROM agent_candidates WHERE agent_id=? AND kind=? ORDER BY rowid ASC LIMIT 1)",
						)
						.run(id, kind);
				this.db
					.prepare("INSERT INTO agent_candidates VALUES (?, ?, ?, ?)")
					.run(id, kind, normalized, JSON.stringify(ids));
			}
		}
		return result;
	}
	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return clone(result);
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private assertOpen(): void {
		if (this.closed) throw new Error("agent store is closed");
	}
}
