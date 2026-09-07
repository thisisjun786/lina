import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { AgentStore } from "../agents/store.ts";
import type { AgentInput, AgentProfile } from "../agents/types.ts";
import { MAX_AGENTS, validateAgentInput } from "../agents/validation.ts";
import { openCheckedDatabase } from "../session-binding.ts";
import {
	assertAnswerCapacity,
	assertFollowups,
	cloneChapters,
	emptyChapters,
	emptyUserAnswers,
	field,
	fillUnspecified,
	isUuid,
	newAgentId,
	newUuid,
	object,
	parseAnswerText,
	parseChapterId,
	parseChapterStatus,
	parseChapterText,
	parseInterviewMode,
	parseProposal,
	parseUserAnswers,
	requireRevision,
	unspecifiedProfile,
} from "./helpers.ts";
import { formatAuthoredExtension, formatUserContext } from "./prompt.ts";
import type {
	ActiveExtension,
	AddAnswerInput,
	AgentDraft,
	ApplyRequest,
	ApplyResult,
	Chapter,
	ChapterId,
	CreateDraftInput,
	OnboardingBoundary,
	OnboardingSnapshot,
	PatchDraftInput,
	SaveUserInput,
	UserConfirmed,
	UserState,
} from "./types.ts";
import {
	CHAPTER_IDS,
	CURRENT_FOCUS_TTL_MS,
	MAX_ANSWERS_PER_CHAPTER,
	MAX_AUTOMATIC_FOLLOWUPS,
	MAX_DRAFT_BYTES,
	MAX_DRAFTS,
} from "./types.ts";

const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS onboarding_user (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, draft_json TEXT NOT NULL, confirmed_json TEXT, shared_agent_ids_json TEXT NOT NULL) STRICT",
	"CREATE TABLE IF NOT EXISTS onboarding_drafts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, target_agent_id TEXT, base_revision INTEGER, mode TEXT NOT NULL, profile_json TEXT NOT NULL, chapters_json TEXT NOT NULL, applied_revision INTEGER) STRICT",
	"CREATE TABLE IF NOT EXISTS onboarding_extensions (agent_id TEXT PRIMARY KEY, profile_revision INTEGER NOT NULL, chapters_json TEXT NOT NULL, apply_id TEXT NOT NULL) STRICT",
	"CREATE TABLE IF NOT EXISTS onboarding_intents (id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, draft_revision INTEGER NOT NULL, status TEXT NOT NULL, compiled_profile_json TEXT NOT NULL, chapters_json TEXT NOT NULL, expected_profile_revision INTEGER, expected_user_revision INTEGER NOT NULL, share_user INTEGER NOT NULL, agent_id TEXT NOT NULL, payload_hash TEXT NOT NULL, applied_profile_revision INTEGER) STRICT",
].join(";");

type IntentStatus =
	| "prepared"
	| "profile_applied"
	| "extension_written"
	| "complete"
	| "failed";
type IntentRow = {
	id: string;
	draft_id: string;
	draft_revision: number;
	status: IntentStatus;
	compiled_profile_json: string;
	chapters_json: string;
	expected_profile_revision: number | null;
	expected_user_revision: number;
	share_user: number;
	agent_id: string;
	payload_hash: string;
	applied_profile_revision: number | null;
};
type DraftRow = {
	id: string;
	revision: number;
	target_agent_id: string | null;
	base_revision: number | null;
	mode: string;
	profile_json: string;
	chapters_json: string;
	applied_revision: number | null;
};
export type InterviewPrepare =
	| { kind: "capped"; draft: AgentDraft; question: string; proposal: string }
	| { kind: "call"; draft: AgentDraft };
export type ExtensionState = {
	status: "none" | "active" | "stale";
	extension: ActiveExtension | null;
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
function payloadHash(profile: AgentInput): string {
	return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}
export class OnboardingStore {
	private readonly db: DatabaseSync;
	private readonly now: () => number;
	private readonly onBoundary: (name: OnboardingBoundary) => void;
	private closed = false;
	constructor(
		path: string,
		options: {
			now?: () => number;
			onBoundary?: (name: OnboardingBoundary) => void;
		} = {},
	) {
		if (typeof path !== "string" || path.length === 0)
			throw new Error("invalid onboarding store path");
		this.now = options.now ?? Date.now;
		this.onBoundary = options.onBoundary ?? (() => {});
		this.db =
			path === ":memory:"
				? new DatabaseSync(":memory:")
				: openCheckedDatabase(path).db;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
			this.assertNoForeignTables();
			for (const sql of SCHEMA.split(";")) if (sql.trim()) this.db.exec(sql);
			this.verifySchema();
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
	snapshot(): OnboardingSnapshot {
		this.assertOpen();
		return {
			user: this.user(),
			drafts: (
				this.db
					.prepare("SELECT * FROM onboarding_drafts ORDER BY id")
					.all() as DraftRow[]
			).map((row) => this.decodeDraft(row)),
		};
	}
	user(): UserState {
		this.assertOpen();
		const row = this.db
			.prepare("SELECT * FROM onboarding_user WHERE id=1")
			.get() as
			| {
					revision: number;
					draft_json: string;
					confirmed_json: string | null;
					shared_agent_ids_json: string;
			  }
			| undefined;
		if (!row)
			return {
				revision: 0,
				draft: emptyUserAnswers(),
				confirmed: null,
				sharedAgentIds: [],
			};
		return {
			revision: row.revision,
			draft: parseUserAnswers(json(row.draft_json, "user draft")),
			confirmed: row.confirmed_json
				? this.decodeConfirmed(json(row.confirmed_json, "user confirmed"))
				: null,
			sharedAgentIds: this.decodeIds(
				json(row.shared_agent_ids_json, "shared agents"),
			),
		};
	}
	saveUser(
		input: SaveUserInput,
		existingAgentIds: ReadonlySet<string>,
	): UserState {
		this.assertOpen();
		const revision = requireRevision(input.revision);
		const answers = parseUserAnswers(input.answers);
		if (typeof input.confirm !== "boolean") throw new Error("invalid confirm");
		const shared = this.checkedShare(input.sharedAgentIds, existingAgentIds);
		return this.transaction(() => {
			const current = this.user();
			if (current.revision !== revision) throw new Error("stale user revision");
			const confirmed: UserConfirmed | null = input.confirm
				? {
						answers: {
							address: answers.address.trim(),
							context: answers.context.trim(),
							interests: answers.interests.trim(),
							communication: answers.communication.trim(),
							boundaries: answers.boundaries.trim(),
							currentFocus: answers.currentFocus.trim(),
						},
						confirmedAt: this.now(),
						currentFocusExpiresAt: this.now() + CURRENT_FOCUS_TTL_MS,
					}
				: current.confirmed;
			const next: UserState = {
				revision: current.revision + 1,
				draft: answers,
				confirmed,
				sharedAgentIds: shared,
			};
			this.writeUser(next);
			return next;
		});
	}
	userContextFor(agentId: string): string {
		this.assertOpen();
		const user = this.user();
		if (!user.confirmed || !user.sharedAgentIds.includes(agentId)) return "";
		return formatUserContext(user.confirmed.answers, {
			now: this.now(),
			expiresAt: user.confirmed.currentFocusExpiresAt,
			confirmedAt: user.confirmed.confirmedAt,
			revision: user.revision,
		});
	}
	authoredContextFor(
		agentId: string,
		profileRevision: number | undefined,
	): string {
		this.assertOpen();
		const state = this.extensionState(agentId, profileRevision);
		if (state.status !== "active" || !state.extension) return "";
		return formatAuthoredExtension(state.extension.chapters);
	}
	extensionState(
		agentId: string,
		profileRevision: number | undefined,
	): ExtensionState {
		this.assertOpen();
		const extension = this.extension(agentId);
		if (!extension) return { status: "none", extension: null };
		const intent = this.db
			.prepare("SELECT status FROM onboarding_intents WHERE id=?")
			.get(extension.applyId) as { status: string } | undefined;
		if (intent?.status !== "complete")
			return { status: "none", extension: null };
		if (
			profileRevision === undefined ||
			extension.profileRevision !== profileRevision
		)
			return { status: "stale", extension };
		return { status: "active", extension };
	}
	createDraft(
		input: CreateDraftInput,
		deps: { agents: AgentStore; presets: AgentInput[]; existingCount: number },
		options?: { fresh: boolean },
	): AgentDraft {
		this.assertOpen();
		const mode = parseInterviewMode(input.mode);
		const target = input.targetAgentId ?? null;
		if (target !== null && typeof target !== "string")
			throw new Error("invalid targetAgentId");
		if (target && input.presetId)
			throw new Error("invalid create draft fields");
		return this.transaction(() => {
			if (target) {
				const agent = deps.agents.get(target);
				if (!agent) throw new Error("agent not found");
				const open = this.unappliedDraft(target);
				if (open && open.baseRevision === agent.revision && !options?.fresh) {
					if (open.mode === mode) return open;
					return this.patchDraftUnlocked(open, {
						revision: open.revision,
						mode,
					});
				}
				const { revision, ...profile } = agent;
				const ext = this.extension(agent.id);
				let chapters = emptyChapters();
				let staleExtension = false;
				const priorChapters = open?.chapters ?? ext?.chapters;
				if (priorChapters) {
					chapters = cloneChapters(priorChapters);
					if (open || ext?.profileRevision !== revision) {
						staleExtension = true;
						for (const id of CHAPTER_IDS) {
							if (chapters[id].status === "confirmed")
								chapters[id].status = "proposed";
						}
					}
				}
				return this.insertDraft({
					targetAgentId: agent.id,
					baseRevision: revision,
					mode,
					profile,
					chapters,
					staleExtension,
				});
			}
			if (
				deps.existingCount >= MAX_AGENTS ||
				deps.agents.list().length >= MAX_AGENTS
			)
				throw new Error("agent capacity reached");
			if (input.presetId) {
				const preset = deps.presets.find((item) => item.id === input.presetId);
				if (!preset) throw new Error("unknown preset");
				const { id: _id, ...rest } = preset;
				return this.insertDraft({
					targetAgentId: null,
					baseRevision: null,
					mode,
					profile: validateAgentInput({ ...rest, id: newAgentId() }),
					chapters: emptyChapters(),
				});
			}
			return this.insertDraft({
				targetAgentId: null,
				baseRevision: null,
				mode,
				profile: unspecifiedProfile(newAgentId()),
				chapters: emptyChapters(),
			});
		});
	}
	getDraft(id: string): AgentDraft | undefined {
		this.assertOpen();
		if (typeof id !== "string") return undefined;
		const row = this.db
			.prepare("SELECT * FROM onboarding_drafts WHERE id=?")
			.get(id) as DraftRow | undefined;
		return row ? this.decodeDraft(row) : undefined;
	}
	patchDraft(id: string, input: PatchDraftInput): AgentDraft {
		this.assertOpen();
		object(
			input as unknown,
			new Set(["revision", "mode", "profile", "chapter"]),
			"draft patch",
		);
		return this.transaction(() => {
			const draft = this.requireDraft(id);
			this.assertEditable(id);
			return this.patchDraftUnlocked(draft, input);
		});
	}
	addAnswer(id: string, input: AddAnswerInput): AgentDraft {
		this.assertOpen();
		object(
			input as unknown,
			new Set(["revision", "chapter", "text", "answerId"]),
			"answer",
		);
		const chapterId = parseChapterId(input.chapter);
		const text = parseAnswerText(input.text);
		if (!isUuid(input.answerId)) throw new Error("invalid answerId");
		return this.transaction(() => {
			const draft = this.requireDraft(id);
			const existing = draft.chapters[chapterId].answers.find(
				(answer) => answer.id === input.answerId,
			);
			if (existing) {
				if (existing.text !== text) throw new Error("answer conflict");
				return draft;
			}
			this.assertEditable(id);
			if (draft.revision !== requireRevision(input.revision))
				throw new Error("stale draft revision");
			const chapter = draft.chapters[chapterId];
			assertAnswerCapacity(chapter.answers.length + 1);
			chapter.answers.push({ id: input.answerId, text });
			chapter.proposal = null;
			if (chapter.status === "confirmed") chapter.status = "proposed";
			draft.revision += 1;
			this.writeDraft(draft);
			return draft;
		});
	}
	prepareInterview(
		id: string,
		revision: number,
		chapter: ChapterId,
		deepen: boolean,
	): InterviewPrepare {
		this.assertOpen();
		const chapterId = parseChapterId(chapter);
		if (typeof deepen !== "boolean") throw new Error("invalid deepen");
		const draft = this.requireDraft(id);
		if (draft.revision !== requireRevision(revision))
			throw new Error("stale draft revision");
		this.assertEditable(id);
		const current = draft.chapters[chapterId];
		if (!deepen && current.followups >= MAX_AUTOMATIC_FOLLOWUPS)
			return {
				kind: "capped",
				draft,
				question: "",
				proposal: current.proposal?.text ?? "",
			};
		if (current.answers.length === 0)
			throw new Error("invalid interview answers");
		return { kind: "call", draft };
	}
	commitInterview(
		id: string,
		revision: number,
		chapter: ChapterId,
		deepen: boolean,
		proposal: unknown,
	): AgentDraft {
		this.assertOpen();
		const chapterId = parseChapterId(chapter);
		if (typeof deepen !== "boolean") throw new Error("invalid deepen");
		return this.transaction(() => {
			const draft = this.requireDraft(id);
			this.assertEditable(id);
			if (draft.revision !== requireRevision(revision))
				throw new Error("stale draft revision");
			const current = draft.chapters[chapterId];
			const parsed = parseProposal(
				proposal,
				current.answers.map((answer) => answer.id),
			);
			if (!deepen && current.followups >= MAX_AUTOMATIC_FOLLOWUPS)
				throw new Error("stale interview followups");
			current.proposal = parsed;
			current.text = current.proposal.text;
			current.status = "proposed";
			if (!deepen) current.followups = assertFollowups(current.followups + 1);
			draft.revision += 1;
			this.writeDraft(draft);
			return draft;
		});
	}
	applyDraft(
		id: string,
		input: ApplyRequest,
		agents: AgentStore,
		options?: {
			candidate: { profile: AgentInput; chapters: Record<ChapterId, string> };
		},
	): ApplyResult {
		this.assertOpen();
		object(
			input as unknown,
			new Set(["revision", "shareUser", "userRevision"]),
			"apply",
		);
		const revision = requireRevision(input.revision);
		const userRevision = requireRevision(input.userRevision);
		if (typeof input.shareUser !== "boolean")
			throw new Error("invalid shareUser");
		const existing = this.intentFor(id, revision);
		if (existing) {
			if (
				options &&
				(JSON.stringify(fillUnspecified(options.candidate.profile)) !==
					existing.compiled_profile_json ||
					CHAPTER_IDS.some(
						(key) =>
							this.decodeChapters(
								json(existing.chapters_json, "intent chapters"),
							)[key].text !== options.candidate.chapters[key],
					))
			)
				throw new Error("candidate conflict");
			if (existing.share_user !== (input.shareUser ? 1 : 0))
				throw new Error("apply conflict: shareUser mismatch");
			if (existing.status === "complete") return { agentId: existing.agent_id };
			if (existing.status !== "failed")
				return this.continueApply(existing, input, agents);
		}
		if (this.user().revision !== userRevision)
			throw new Error("stale user revision");
		const other = this.unresolvedIntent(id);
		if (other && other.draft_revision !== revision)
			throw new Error("apply conflict: draft locked");
		const draft = this.requireDraft(id);
		if (draft.revision !== revision) throw new Error("stale draft revision");
		if (options) {
			const candidate = options.candidate;
			const profile = validateAgentInput(candidate.profile);
			if (profile.id !== draft.profile.id)
				throw new Error("immutable profile id");
			object(candidate.chapters, new Set(CHAPTER_IDS), "candidate chapters");
			draft.profile = profile;
			for (const key of CHAPTER_IDS) {
				const text = parseChapterText(candidate.chapters[key]);
				draft.chapters[key] = {
					...draft.chapters[key],
					text,
					status: text.trim() ? "confirmed" : "deferred",
					proposal: null,
				};
			}
		}
		for (const chapterId of CHAPTER_IDS) {
			const status = draft.chapters[chapterId].status;
			if (status !== "confirmed" && status !== "deferred")
				throw new Error("chapters must be confirmed or deferred");
		}
		formatAuthoredExtension(draft.chapters);
		const compiled = fillUnspecified(draft.profile);
		const intent: IntentRow = {
			id: newUuid(),
			draft_id: id,
			draft_revision: revision,
			status: "prepared",
			compiled_profile_json: JSON.stringify(compiled),
			chapters_json: JSON.stringify(draft.chapters),
			expected_profile_revision: draft.targetAgentId
				? draft.baseRevision
				: null,
			expected_user_revision: userRevision,
			share_user: input.shareUser ? 1 : 0,
			agent_id: compiled.id,
			payload_hash: payloadHash(compiled),
			applied_profile_revision: null,
		};
		this.transaction(() => this.writeIntent(intent));
		this.onBoundary("intent-prepared");
		return this.continueApply(intent, input, agents);
	}
	close(): void {
		if (!this.closed) {
			this.db.close();
			this.closed = true;
		}
	}
	private continueApply(
		intent: IntentRow,
		input: ApplyRequest,
		agents: AgentStore,
	): ApplyResult {
		const compiled = validateAgentInput(
			json(intent.compiled_profile_json, "compiled profile"),
		);
		if (intent.status === "prepared") {
			if (this.user().revision !== requireRevision(input.userRevision))
				throw new Error("stale user revision");
			let applied: AgentProfile;
			try {
				applied = agents.applyAuthored(
					compiled,
					intent.expected_profile_revision,
					intent.id,
				);
			} catch (error) {
				this.transaction(() => {
					intent.status = "failed";
					this.writeIntent(intent);
				});
				throw error;
			}
			intent.status = "profile_applied";
			intent.applied_profile_revision = applied.revision;
			this.transaction(() => this.writeIntent(intent));
			this.onBoundary("profile-applied");
		}
		if (intent.status === "profile_applied") {
			const current = agents.get(intent.agent_id);
			const expected = intent.applied_profile_revision;
			if (!current || expected === null || current.revision !== expected) {
				this.transaction(() => {
					intent.status = "failed";
					this.writeIntent(intent);
				});
				throw new Error("stale authored extension conflict");
			}
			const chapters = this.decodeChapters(
				json(intent.chapters_json, "intent chapters"),
			);
			this.transaction(() => {
				this.db
					.prepare(
						"INSERT INTO onboarding_extensions(agent_id, profile_revision, chapters_json, apply_id) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET profile_revision=excluded.profile_revision, chapters_json=excluded.chapters_json, apply_id=excluded.apply_id",
					)
					.run(intent.agent_id, expected, JSON.stringify(chapters), intent.id);
				intent.status = "extension_written";
				this.writeIntent(intent);
			});
			this.onBoundary("extension-written");
		}
		if (intent.status === "extension_written") {
			const current = agents.get(intent.agent_id);
			if (
				!current ||
				intent.applied_profile_revision === null ||
				current.revision !== intent.applied_profile_revision
			) {
				this.transaction(() => {
					intent.status = "failed";
					this.writeIntent(intent);
				});
				throw new Error("stale authored extension conflict");
			}
			this.transaction(() => {
				const user = this.user();
				if (user.revision !== requireRevision(input.userRevision))
					throw new Error("stale user revision");
				const wantShare = intent.share_user === 1;
				const hasShare = user.sharedAgentIds.includes(intent.agent_id);
				if (wantShare !== hasShare) {
					user.sharedAgentIds = wantShare
						? [...user.sharedAgentIds, intent.agent_id]
						: user.sharedAgentIds.filter((id) => id !== intent.agent_id);
					user.revision += 1;
					this.writeUser(user);
				}
				intent.status = "complete";
				this.finishDraft(intent);
				this.writeIntent(intent);
			});
			this.onBoundary("share-applied");
		}
		if (intent.status !== "complete") throw new Error("stale apply incomplete");
		return { agentId: intent.agent_id };
	}
	private finishDraft(intent: IntentRow): void {
		const draft = this.requireDraft(intent.draft_id);
		draft.profile = validateAgentInput(
			json(intent.compiled_profile_json, "compiled profile"),
		);
		draft.chapters = this.decodeChapters(
			json(intent.chapters_json, "intent chapters"),
		);
		draft.targetAgentId = intent.agent_id;
		draft.appliedRevision = intent.applied_profile_revision;
		draft.baseRevision = intent.applied_profile_revision;
		draft.revision += 1;
		this.writeDraft(draft);
	}
	private patchDraftUnlocked(
		draft: AgentDraft,
		input: PatchDraftInput,
	): AgentDraft {
		if (draft.revision !== requireRevision(input.revision))
			throw new Error("stale draft revision");
		const hasMode = input.mode !== undefined;
		const hasProfile = input.profile !== undefined;
		const hasChapter = input.chapter !== undefined;
		if (!hasMode && !hasProfile && !hasChapter) throw new Error("empty patch");
		if (hasMode) draft.mode = parseInterviewMode(input.mode);
		if (hasProfile) {
			const profile = validateAgentInput(input.profile);
			if (profile.id !== draft.profile.id)
				throw new Error("immutable profile id");
			draft.profile = profile;
		}
		if (hasChapter) {
			const chapter = input.chapter;
			if (!chapter) throw new Error("invalid chapter");
			object(chapter, new Set(["id", "text", "status"]), "chapter patch");
			const id = parseChapterId(chapter.id);
			if (
				chapter.status !== "confirmed" &&
				chapter.status !== "deferred" &&
				chapter.status !== "proposed"
			)
				throw new Error("invalid chapter status");
			draft.chapters[id].text = parseChapterText(chapter.text);
			draft.chapters[id].status = chapter.status;
			draft.chapters[id].proposal = null;
		}
		draft.revision += 1;
		this.writeDraft(draft);
		return draft;
	}
	private insertDraft(value: {
		targetAgentId: string | null;
		baseRevision: number | null;
		mode: AgentDraft["mode"];
		profile: AgentInput;
		chapters: Record<ChapterId, Chapter>;
		staleExtension?: boolean;
	}): AgentDraft {
		const count = (
			this.db.prepare("SELECT COUNT(*) AS n FROM onboarding_drafts").get() as {
				n: number;
			}
		).n;
		if (count >= MAX_DRAFTS) throw new Error("draft capacity reached");
		const draft: AgentDraft = {
			id: newUuid(),
			revision: 1,
			targetAgentId: value.targetAgentId,
			baseRevision: value.baseRevision,
			mode: value.mode,
			profile: validateAgentInput(value.profile),
			chapters: cloneChapters(value.chapters),
			appliedRevision: null,
			staleExtension: value.staleExtension === true,
		};
		this.writeDraft(draft);
		return draft;
	}
	private writeUser(user: UserState): void {
		this.db
			.prepare(
				"INSERT INTO onboarding_user(id, revision, draft_json, confirmed_json, shared_agent_ids_json) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, draft_json=excluded.draft_json, confirmed_json=excluded.confirmed_json, shared_agent_ids_json=excluded.shared_agent_ids_json",
			)
			.run(
				user.revision,
				JSON.stringify(user.draft),
				user.confirmed ? JSON.stringify(user.confirmed) : null,
				JSON.stringify(user.sharedAgentIds),
			);
	}
	private writeDraft(draft: AgentDraft): void {
		const encoded =
			JSON.stringify(draft.profile) + JSON.stringify(draft.chapters);
		if (Buffer.byteLength(encoded, "utf8") > MAX_DRAFT_BYTES)
			throw new Error("draft exceeds 100000 bytes");
		this.db
			.prepare(
				"INSERT INTO onboarding_drafts(id, revision, target_agent_id, base_revision, mode, profile_json, chapters_json, applied_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, target_agent_id=excluded.target_agent_id, base_revision=excluded.base_revision, mode=excluded.mode, profile_json=excluded.profile_json, chapters_json=excluded.chapters_json, applied_revision=excluded.applied_revision",
			)
			.run(
				draft.id,
				draft.revision,
				draft.targetAgentId,
				draft.baseRevision,
				draft.mode,
				JSON.stringify(draft.profile),
				JSON.stringify(draft.chapters),
				draft.appliedRevision,
			);
	}
	private writeIntent(intent: IntentRow): void {
		this.db
			.prepare(
				"INSERT INTO onboarding_intents(id, draft_id, draft_revision, status, compiled_profile_json, chapters_json, expected_profile_revision, expected_user_revision, share_user, agent_id, payload_hash, applied_profile_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, applied_profile_revision=excluded.applied_profile_revision",
			)
			.run(
				intent.id,
				intent.draft_id,
				intent.draft_revision,
				intent.status,
				intent.compiled_profile_json,
				intent.chapters_json,
				intent.expected_profile_revision,
				intent.expected_user_revision,
				intent.share_user,
				intent.agent_id,
				intent.payload_hash,
				intent.applied_profile_revision,
			);
	}
	private requireDraft(id: string): AgentDraft {
		const draft = this.getDraft(id);
		if (!draft) throw new Error("draft not found");
		return draft;
	}
	private assertEditable(draftId: string): void {
		if (this.unresolvedIntent(draftId))
			throw new Error("apply conflict: draft locked");
	}
	private unresolvedIntent(draftId: string): IntentRow | undefined {
		return this.db
			.prepare(
				"SELECT * FROM onboarding_intents WHERE draft_id=? AND status NOT IN ('complete', 'failed') ORDER BY rowid DESC LIMIT 1",
			)
			.get(draftId) as IntentRow | undefined;
	}
	private intentFor(draftId: string, revision: number): IntentRow | undefined {
		return this.db
			.prepare(
				"SELECT * FROM onboarding_intents WHERE draft_id=? AND draft_revision=? ORDER BY rowid DESC LIMIT 1",
			)
			.get(draftId, revision) as IntentRow | undefined;
	}
	private unappliedDraft(targetAgentId: string): AgentDraft | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM onboarding_drafts WHERE target_agent_id=? AND applied_revision IS NULL ORDER BY revision DESC, id DESC LIMIT 1",
			)
			.get(targetAgentId) as DraftRow | undefined;
		return row ? this.decodeDraft(row) : undefined;
	}
	private extension(agentId: string): ActiveExtension | undefined {
		const row = this.db
			.prepare("SELECT * FROM onboarding_extensions WHERE agent_id=?")
			.get(agentId) as
			| {
					agent_id: string;
					profile_revision: number;
					chapters_json: string;
					apply_id: string;
			  }
			| undefined;
		if (!row) return undefined;
		return {
			agentId: row.agent_id,
			profileRevision: row.profile_revision,
			chapters: this.decodeChapters(
				json(row.chapters_json, "extension chapters"),
			),
			applyId: row.apply_id,
		};
	}
	private decodeDraft(row: DraftRow): AgentDraft {
		return {
			id: row.id,
			revision: row.revision,
			targetAgentId: row.target_agent_id,
			baseRevision: row.base_revision,
			mode: parseInterviewMode(row.mode),
			profile: validateAgentInput(json(row.profile_json, "draft profile")),
			chapters: this.decodeChapters(json(row.chapters_json, "draft chapters")),
			appliedRevision: row.applied_revision,
			staleExtension: this.draftIsStale(
				row.target_agent_id,
				row.base_revision,
				row.applied_revision,
			),
		};
	}
	private draftIsStale(
		targetAgentId: string | null,
		baseRevision: number | null,
		appliedRevision: number | null,
	): boolean {
		if (!targetAgentId || appliedRevision !== null) return false;
		const ext = this.extension(targetAgentId);
		return !!ext && ext.profileRevision !== baseRevision;
	}
	private decodeChapters(value: unknown): Record<ChapterId, Chapter> {
		const input = object(value, new Set(CHAPTER_IDS), "chapters");
		if (Object.keys(input).length !== CHAPTER_IDS.length)
			throw new Error("corrupt chapters");
		const chapters = emptyChapters();
		for (const id of CHAPTER_IDS) chapters[id] = this.decodeChapter(input[id]);
		return chapters;
	}
	private decodeChapter(value: unknown): Chapter {
		const input = object(
			value,
			new Set(["status", "text", "followups", "answers", "proposal"]),
			"chapter",
		);
		const answersValue = field(input, "answers");
		if (
			!Array.isArray(answersValue) ||
			answersValue.length > MAX_ANSWERS_PER_CHAPTER
		)
			throw new Error("corrupt chapter answers");
		const answers = answersValue.map((item) => {
			const row = object(item, new Set(["id", "text"]), "chapter answer");
			if (
				typeof field(row, "id") !== "string" ||
				!isUuid(field(row, "id") as string)
			)
				throw new Error("corrupt chapter answer");
			return {
				id: field(row, "id") as string,
				text: parseAnswerText(field(row, "text")),
			};
		});
		return {
			status: parseChapterStatus(field(input, "status")),
			text: parseChapterText(field(input, "text")),
			followups: assertFollowups(field(input, "followups") as number),
			answers,
			proposal:
				field(input, "proposal") === null
					? null
					: parseProposal(
							field(input, "proposal"),
							answers.map((answer) => answer.id),
						),
		};
	}
	private decodeConfirmed(value: unknown): UserConfirmed {
		const input = object(
			value,
			new Set(["answers", "confirmedAt", "currentFocusExpiresAt"]),
			"confirmed",
		);
		if (
			!Number.isSafeInteger(field(input, "confirmedAt")) ||
			!Number.isSafeInteger(field(input, "currentFocusExpiresAt"))
		)
			throw new Error("corrupt confirmed");
		return {
			answers: parseUserAnswers(field(input, "answers")),
			confirmedAt: field(input, "confirmedAt") as number,
			currentFocusExpiresAt: field(input, "currentFocusExpiresAt") as number,
		};
	}
	private decodeIds(value: unknown): string[] {
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
			throw new Error("corrupt shared agents");
		return value as string[];
	}
	private checkedShare(ids: string[], existing: ReadonlySet<string>): string[] {
		if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
			throw new Error("invalid sharedAgentIds");
		if (ids.some((id) => !existing.has(id))) throw new Error("unknown agent");
		return [...new Set(ids)];
	}
	private verifySchema(): void {
		const expected: Record<string, string[]> = {
			onboarding_user: [
				"id",
				"revision",
				"draft_json",
				"confirmed_json",
				"shared_agent_ids_json",
			],
			onboarding_drafts: [
				"id",
				"revision",
				"target_agent_id",
				"base_revision",
				"mode",
				"profile_json",
				"chapters_json",
				"applied_revision",
			],
			onboarding_extensions: [
				"agent_id",
				"profile_revision",
				"chapters_json",
				"apply_id",
			],
			onboarding_intents: [
				"id",
				"draft_id",
				"draft_revision",
				"status",
				"compiled_profile_json",
				"chapters_json",
				"expected_profile_revision",
				"expected_user_revision",
				"share_user",
				"agent_id",
				"payload_hash",
				"applied_profile_revision",
			],
		};
		for (const [table, columns] of Object.entries(expected)) {
			const actual = (
				this.db.prepare(`PRAGMA table_info(${table})`).all() as {
					name: string;
				}[]
			).map((row) => row.name);
			if (!isDeepStrictEqual(actual, columns))
				throw new Error("unknown onboarding schema");
		}
	}
	private assertNoForeignTables(): void {
		const owned = new Set([
			"onboarding_user",
			"onboarding_drafts",
			"onboarding_extensions",
			"onboarding_intents",
		]);
		const tables = (
			this.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'",
				)
				.all() as { name: string }[]
		).map((row) => row.name);
		if (tables.some((table) => !owned.has(table)))
			throw new Error("foreign onboarding database schema");
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
		if (this.closed) throw new Error("onboarding store is closed");
	}
}
