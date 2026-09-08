import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { openCheckedDatabase } from "../session-binding.ts";
import { AuthoringPersistence } from "./authoring-persistence.ts";
import { AuthoringRequests } from "./authoring-requests.ts";
import type { WorldAuthoringPort } from "./authoring-types.ts";
import { LifeModelReceipts } from "./autonomy-model-receipts.ts";
import { AutonomyPersistence } from "./autonomy-persistence.ts";
import type { WorldAutonomyPort } from "./autonomy-store-types.ts";
import type { AutonomySource, LifeStep } from "./autonomy-types.ts";
import { projectContext, validateContextLimits } from "./context.ts";
import { lifeDigest, revision } from "./life-json.ts";
import { LifePersistence } from "./life-persistence.ts";
import type {
	AdmissionReceipt,
	BindingSelection,
	IdentityPolicySnapshot,
	LifeCommit,
	LifeDefinition,
	LifeInput,
	LifeInputV2,
	LifePreview,
	LifeReceipt,
	LifeState,
	LifeViewLimits,
	PublicationScope,
	PublicationView,
	SideEffectIntent,
	WorldBinding,
} from "./life-types.ts";
import {
	parseBindingSelection,
	parseIdentityPolicy,
	parseLifeCommit,
	parseLifeDefinition,
	parseLifeInput,
} from "./life-validation.ts";
import { PublicationExecution } from "./publication.ts";
import {
	derivePublicationAncestry,
	PublicationAncestry,
	parsePublicationAncestry,
} from "./publication-ancestry.ts";
import {
	applyPublicationBudget,
	assertPublicationBudget,
	assertPublicationBudgetCurrent,
	freezePublicationBudget,
	parsePublicationBudget,
} from "./publication-budget.ts";
import { PublicationChains } from "./publication-chains.ts";
import { PublicationCursors } from "./publication-cursors.ts";
import { PublicationEvidence } from "./publication-evidence.ts";
import { PublicationFeed } from "./publication-feed.ts";
import { PublicationGrants } from "./publication-grants.ts";
import type { PublicationAuthority } from "./publication-input.ts";
import { PublicationInteractions } from "./publication-interactions.ts";
import { PublicationJobs } from "./publication-jobs.ts";
import { selectPublicationMaterial } from "./publication-material.ts";
import { PublicationPersistence } from "./publication-persistence.ts";
import { PublicationPosts } from "./publication-posts.ts";
import { selectPublicationReplyMaterial } from "./publication-reply-material.ts";
import { publicationReplyParent } from "./publication-reply-parents.ts";
import { PublicationReplyPosts } from "./publication-reply-posts.ts";
import { PublicationRuns } from "./publication-runs.ts";
import { auditPublicationJobSource } from "./publication-sources.ts";
import type {
	EventPublicationMaterial,
	PublicationJob,
	PublicationMaterial,
	PublicationSettings,
	PublicationSettingsInput,
	ReplyPublicationMaterial,
	ReplyPublicationPost,
} from "./publication-types.ts";
import { initializeWorldSchema } from "./schema.ts";
import { SocialPersistence } from "./social-persistence.ts";
import type { WorldSocialPort } from "./social-store-types.ts";
import { eventId, initialSnapshot, transition } from "./transition.ts";
import type {
	WorldContext,
	WorldContextLimits,
	WorldDefinition,
	WorldEvent,
	WorldProposal,
	WorldSnapshot,
} from "./types.ts";
import {
	id,
	integer,
	parseDefinition,
	parseProposal,
	text,
} from "./validation.ts";
import { projectPublication } from "./views.ts";
import { workSubjectAllowed } from "./work-ancestry.ts";
import { WorkPersistence } from "./work-persistence.ts";
import type { WorkEvidenceSnapshot, WorkSubject } from "./work-types.ts";

type WorldRow = { id: string; definition_json: string; state_json: string };
type EventRow = {
	world_id: string;
	idempotency_key: string;
	revision: number;
	event_json: string;
};
const WORLD_COLUMNS = "id, definition_json, state_json";
const EVENT_COLUMNS = "world_id, idempotency_key, revision, event_json";

function eventProposal(event: WorldEvent): WorldProposal {
	const {
		id: _id,
		revision: _revision,
		acceptedAt: _acceptedAt,
		origin: _origin,
		definitionVersion: _version,
		...proposal
	} = event;
	return parseProposal(proposal);
}
function readEvent(row: EventRow): WorldEvent {
	const value = JSON.parse(row.event_json) as WorldEvent;
	const proposal = eventProposal(value);
	integer(value.revision, "event revision", 1);
	integer(value.definitionVersion, "definition version", 1);
	text(value.acceptedAt, "acceptance time");
	if (
		!Number.isFinite(Date.parse(value.acceptedAt)) ||
		value.origin !== "fictional" ||
		value.id !== eventId(row.world_id, row.revision) ||
		value.revision !== row.revision ||
		proposal.worldId !== row.world_id ||
		proposal.idempotencyKey !== row.idempotency_key
	)
		throw Error("Corrupt world event provenance");
	return {
		...proposal,
		id: value.id,
		revision: value.revision,
		acceptedAt: value.acceptedAt,
		origin: value.origin,
		definitionVersion: value.definitionVersion,
	};
}
function stateJson(snapshot: WorldSnapshot): string {
	const { definition: _definition, ...state } = snapshot;
	return JSON.stringify(state);
}

/** Trusted application API. Bind agent views in the runtime; never expose this store as an agent tool. */
export class WorldStore
	implements WorldAuthoringPort, WorldSocialPort, WorldAutonomyPort
{
	private readonly db: DatabaseSync;
	private readonly autonomy: AutonomyPersistence;
	private readonly life: LifePersistence;
	private readonly social: SocialPersistence;
	private readonly author: AuthoringPersistence;
	private readonly suggestions: AuthoringRequests;
	private readonly work: WorkPersistence;
	private readonly publications: PublicationPersistence;
	private readonly publicationGrants: PublicationGrants;
	private readonly publicationJobs: PublicationJobs;
	private readonly publicationRuns: PublicationRuns;
	private readonly publicationExecution: PublicationExecution;
	private readonly publicationPosts: PublicationPosts;
	private readonly publicationFeedReader: PublicationFeed;
	private readonly publicationCursors: PublicationCursors;
	private readonly publicationChains: PublicationChains;
	private readonly publicationModels: LifeModelReceipts;
	private readonly publicationInteractions: PublicationInteractions;
	private readonly publicationReplyPosts: PublicationReplyPosts;
	private readonly publicationEvidence: PublicationEvidence;
	private readonly publicationAncestry: PublicationAncestry;
	private closed = false;
	readonly acquireLifeLease: WorldAutonomyPort["acquireLifeLease"] = (
		worldId,
		expectedRevision,
		owner,
		_nowMs,
		leaseMs,
	) =>
		this.transaction(() =>
			this.autonomy.acquireLease(worldId, expectedRevision, owner, leaseMs),
		);
	readonly lifeStatus: WorldAutonomyPort["lifeStatus"] = (worldId) =>
		this.transaction(() => this.autonomy.status(worldId), false);
	readonly invalidateLifeIdentity: WorldAutonomyPort["invalidateLifeIdentity"] =
		(worldId, current) =>
			this.transaction(() =>
				this.autonomy.invalidateIdentity(worldId, current),
			);
	readonly prepareLifeStep: WorldAutonomyPort["prepareLifeStep"] = (
		request,
		entropy,
	) => this.transaction(() => this.autonomy.prepare(request, entropy));
	readonly lifeStep: WorldAutonomyPort["lifeStep"] = (worldId, stepId) =>
		this.transaction(() => this.autonomy.get(worldId, stepId), false);
	readonly renewLifeLease: WorldAutonomyPort["renewLifeLease"] = (
		lease,
		_nowMs,
		leaseMs,
	) => this.transaction(() => this.autonomy.schedules.renew(lease, leaseMs));
	readonly releaseLifeLease: WorldAutonomyPort["releaseLifeLease"] = (lease) =>
		this.transaction(() => this.autonomy.schedules.release(lease));
	readonly prepareLifeModel: WorldAutonomyPort["prepareLifeModel"] = (
		lease,
		stepId,
		request,
	) =>
		this.transaction(() => this.autonomy.prepareModel(lease, stepId, request));
	readonly dispatchLifeModel: WorldAutonomyPort["dispatchLifeModel"] = (
		lease,
		stepId,
		requestId,
	) =>
		this.transaction(() =>
			this.autonomy.dispatchModel(lease, stepId, requestId),
		);
	readonly finishLifeModel: WorldAutonomyPort["finishLifeModel"] = (
		worldId,
		stepId,
		requestId,
		result,
	) =>
		this.transaction(() =>
			this.autonomy.finishModel(worldId, stepId, requestId, result),
		);
	readonly recordLifeIntention: WorldAutonomyPort["recordLifeIntention"] = (
		lease,
		stepId,
	) => this.transaction(() => this.autonomy.intention(lease, stepId));
	readonly recordLifeTarget: WorldAutonomyPort["recordLifeTarget"] = (
		lease,
		stepId,
	) => this.transaction(() => this.autonomy.target(lease, stepId));
	readonly prepareLifeObservations: WorldAutonomyPort["prepareLifeObservations"] =
		(lease, stepId, requestId) =>
			this.transaction(() =>
				this.autonomy.observations(lease, stepId, requestId),
			);
	readonly finishLifeStep: WorldAutonomyPort["finishLifeStep"] = (
		lease,
		stepId,
	) => this.transaction(() => this.autonomy.finish(lease, stepId));
	readonly acceptLifeStep: WorldAutonomyPort["acceptLifeStep"] = (
		lease,
		stepId,
		current,
	) => this.transaction(() => this.autonomy.accept(lease, stepId, current));
	readonly failLifeStep: WorldAutonomyPort["failLifeStep"] = (
		lease,
		stepId,
		reason,
	) => this.transaction(() => this.autonomy.fail(lease, stepId, reason));
	readonly advanceLifeSchedule: WorldAutonomyPort["advanceLifeSchedule"] = (
		lease,
		_nowMs,
		nextDue,
		skipped,
	) =>
		this.transaction(() =>
			this.autonomy.schedules.advance(lease, nextDue, skipped),
		);
	readonly prepareSocialResolution: WorldSocialPort["prepareSocialResolution"] =
		(...args) => this.transaction(() => this.social.prepare(...args));
	readonly socialResolution: WorldSocialPort["socialResolution"] = (...args) =>
		this.transaction(() => this.social.get(...args), false);
	readonly finishSocialResolution: WorldSocialPort["finishSocialResolution"] = (
		...args
	) => this.transaction(() => this.social.finish(...args));
	readonly acceptSocialResolution: WorldSocialPort["acceptSocialResolution"] = (
		worldId,
		requestId,
		identity,
	) =>
		this.transaction(() => {
			const parsed = parseIdentityPolicy(identity);
			return this.life.accept(
				this.social.commit(worldId, requestId, parsed),
				parsed,
			);
		});
	readonly draftWorld: WorldAuthoringPort["draftWorld"] = (...args) =>
		this.transaction(() => this.author.draftWorld(...args), true);
	readonly worldDraft: WorldAuthoringPort["worldDraft"] = (...args) =>
		this.transaction(() => this.author.worldDraft(...args), false);
	readonly worldDrafts: WorldAuthoringPort["worldDrafts"] = (...args) =>
		this.transaction(() => this.author.worldDrafts(...args), false);
	readonly worldCatalog: WorldAuthoringPort["worldCatalog"] = (...args) =>
		this.transaction(() => this.author.worldCatalog(...args), false);
	readonly editWorldDraft: WorldAuthoringPort["editWorldDraft"] = (...args) =>
		this.transaction(() => this.author.editWorldDraft(...args), true);
	readonly previewWorldDraft: WorldAuthoringPort["previewWorldDraft"] = (
		...args
	) => this.transaction(() => this.author.previewWorldDraft(...args), false);
	readonly activateWorldDraft: WorldAuthoringPort["activateWorldDraft"] = (
		...args
	) => this.transaction(() => this.author.activateWorldDraft(...args), true);
	readonly worldPack: WorldAuthoringPort["worldPack"] = (...args) =>
		this.transaction(() => this.author.worldPack(...args), false);
	readonly lifeConfig: WorldAuthoringPort["lifeConfig"] = (...args) =>
		this.transaction(() => this.author.lifeConfig(...args), false);
	readonly setLifeConfig: WorldAuthoringPort["setLifeConfig"] = (...args) =>
		this.transaction(() => {
			const previousPermission = this.work.snapshot(args[0]).permissionRevision;
			const config = this.author.setLifeConfig(...args);
			this.work.configure(config);
			if (
				this.work.snapshot(config.worldId).permissionRevision !==
				previousPermission
			)
				this.life.invalidateBindings(config.worldId);
			this.autonomy.configure(config.worldId, config.revision);
			return config;
		}, true);
	readonly grantWorldAuthor: WorldAuthoringPort["grantWorldAuthor"] = (
		...args
	) => this.transaction(() => this.author.grantWorldAuthor(...args), true);
	readonly worldAuthorGrant: WorldAuthoringPort["worldAuthorGrant"] = (
		...args
	) => this.transaction(() => this.author.worldAuthorGrant(...args), false);
	readonly revokeWorldAuthor: WorldAuthoringPort["revokeWorldAuthor"] = (
		...args
	) => this.transaction(() => this.author.revokeWorldAuthor(...args), true);
	readonly prepareWorldSuggestion: WorldAuthoringPort["prepareWorldSuggestion"] =
		(...args) =>
			this.transaction(() => this.suggestions.prepare(...args), true);
	readonly worldSuggestion: WorldAuthoringPort["worldSuggestion"] = (...args) =>
		this.transaction(() => this.suggestions.get(...args), false);
	readonly dispatchWorldSuggestion: WorldAuthoringPort["dispatchWorldSuggestion"] =
		(...args) =>
			this.transaction(() => this.suggestions.dispatch(...args), true);
	readonly finishWorldSuggestion: WorldAuthoringPort["finishWorldSuggestion"] =
		(...args) => this.transaction(() => this.suggestions.finish(...args), true);
	readonly failWorldSuggestion: WorldAuthoringPort["failWorldSuggestion"] = (
		...args
	) => this.transaction(() => this.suggestions.fail(...args), true);
	readonly abandonWorldSuggestion: WorldAuthoringPort["abandonWorldSuggestion"] =
		(...args) =>
			this.transaction(() => this.suggestions.abandon(...args), true);
	constructor(
		path: string,
		private readonly now: () => number = Date.now,
	) {
		if (typeof path !== "string" || !path.trim())
			throw Error("Explicit world database path required");
		this.db =
			path === ":memory:"
				? new DatabaseSync(path)
				: openCheckedDatabase(path).db;
		this.social = new SocialPersistence(this.db, {
			autonomy: (request, source, historical) =>
				this.autonomy.socialAuthority(request, source, historical),
			source: (worldId) => ({
				world: this.snapshot(worldId),
				life: this.life.snapshot(worldId),
			}),
			sourceAt: (worldId, lifeRevision) => {
				const life = this.life.snapshotAt(worldId, lifeRevision);
				return {
					life,
					world: this.rebuild(
						this.snapshot(worldId).definition,
						life.worldRevision,
					),
				};
			},
			pack: (worldId, version) => this.author.worldPack(worldId, version),
		});
		this.life = new LifePersistence(this.db, {
			autonomyState: (worldId) => this.autonomy.state(worldId),
			autonomyStateAt: (worldId, revision) =>
				this.autonomy.stateAt(worldId, revision),
			saveAutonomyState: (state) => this.autonomy.changeDefinition(state),
			pack: (worldId, version) => this.author.worldPack(worldId, version),
			assertSocialCommit: (commit, identity, source, historical) => {
				this.autonomy.assertCommit(commit, identity, source, historical);
				this.social.assertCommit(commit, identity, source, historical);
			},
			markSocialAccepted: (commit) => this.social.markAccepted(commit),
			assertActors: (proposal) => this.author.assertActors(proposal),
			snapshot: (worldId) => this.snapshot(worldId),
			snapshotAt: (worldId, revision) =>
				this.rebuild(this.snapshot(worldId).definition, revision),
			proposalAt: (worldId, revision) => {
				const row = this.db
					.prepare(
						`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ? AND revision = ?`,
					)
					.get(worldId, revision) as EventRow | undefined;
				if (!row) throw Error("Missing paired world event");
				return eventProposal(readEvent(row));
			},
			write: (proposal, next) => this.writeWorld(proposal, next),
		});
		this.author = new AuthoringPersistence(this.db, {
			exists: (worldId) => !!this.row(worldId),
			snapshot: (worldId) => this.snapshot(worldId),
			snapshotAt: (worldId, revision) =>
				this.rebuild(this.snapshot(worldId).definition, revision),
			create: (definition) => this.createWorld(definition),
			life: this.life,
		});
		this.autonomy = new AutonomyPersistence(
			this.db,
			{
				source: (worldId) => ({
					world: this.snapshot(worldId),
					life: this.life.snapshot(worldId),
				}),
				sourceAt: (worldId, revision) => {
					const life = this.life.snapshotAt(worldId, revision);
					return {
						life,
						world: this.rebuild(
							this.snapshot(worldId).definition,
							life.worldRevision,
						),
					};
				},
				worldAt: (worldId, revision) =>
					this.rebuild(this.snapshot(worldId).definition, revision),
				pack: (worldId, version) => this.author.worldPack(worldId, version),
				config: (worldId) => this.author.lifeConfig(worldId),
				configAt: (worldId, revision) =>
					this.author.lifeConfigAt(worldId, revision),
				inputs: (worldId) => this.life.inputs(worldId),
				work: (worldId, revision) => this.work.snapshot(worldId, revision),
				workAncestry: (worldId, revision) =>
					this.work.ancestry(worldId, revision),
				recordWorkStep: (step) => this.work.recordStep(step),
				recordPublicationStep: (step) => {
					this.publicationStepCharges(step, false);
					this.publicationAncestry.record(
						step.worldId,
						derivePublicationAncestry(step),
					);
				},
				workInputsAt: (worldId, workRevision, lifeRevision) =>
					this.work.inputsAt(worldId, workRevision, lifeRevision),
				publication: (source) => this.publicationEvidence.freeze(source),
				publicationBudget: (source) =>
					freezePublicationBudget(
						source,
						this.publicationChains.snapshot(source.pack.worldId),
						this.publications.settings(source.pack.worldId),
					),
				verifyPublicationBudget: (source, current) => {
					const budget = parsePublicationBudget(source.publicationBudget),
						worldId = source.pack.worldId;
					assertPublicationBudget(
						source,
						this.publicationChains.snapshot(worldId, budget.chain.revision),
						budget.settingsRevision === 0
							? null
							: this.publications.settingsAt(worldId, budget.settingsRevision),
					);
					if (current)
						assertPublicationBudgetCurrent(
							source,
							this.publicationChains.snapshot(worldId),
						);
				},
				verifyPublication: (source, snapshot) =>
					this.publicationEvidence.verify(source, snapshot),
				assertPublicationCurrent: (source, snapshot) =>
					this.publicationEvidence.assertCurrent(source, snapshot),
				publicationAncestry: (worldId, lifeRevision) =>
					this.publicationAncestry.list(worldId, lifeRevision),
				publicationInputsAt: (worldId, frontier, lifeRevision) => {
					const ids = new Set(
						this.publicationInteractions
							.observationSnapshot(worldId, frontier)
							.records.map((record) => record.inputId),
					);
					return this.life
						.inputs(worldId)
						.filter((input) => input.version === 3 && ids.has(input.id))
						.map((input) => ({
							...input,
							consumedLifeRevision:
								input.consumedLifeRevision !== null &&
								input.consumedLifeRevision <= lifeRevision
									? input.consumedLifeRevision
									: null,
						}));
				},
				accept: (commit, identity) => this.life.accept(commit, identity),
				social: (worldId, requestId, source) =>
					this.social.getAt(worldId, requestId, source),
			},
			this.now,
		);
		this.suggestions = new AuthoringRequests(this.db, this.author);
		this.work = new WorkPersistence(this.db, {
			assertWorld: (worldId) => {
				this.snapshot(worldId);
			},
			config: (worldId) => this.author.lifeConfig(worldId),
			configAt: (worldId, revision) =>
				this.author.lifeConfigAt(worldId, revision),
			inputs: (worldId) => this.life.inputs(worldId),
			admit: (input) => this.life.admit(input),
		});
		this.publications = new PublicationPersistence(
			this.db,
			(worldId) => this.life.definition(worldId),
			(worldId, version) => this.author.worldPack(worldId, version),
		);
		this.publicationGrants = new PublicationGrants(this.db, (worldId) => {
			const settings = this.publications.settings(worldId),
				config = this.author.lifeConfig(worldId);
			return settings && config.publication
				? {
						settingsRevision: settings.revision,
						recipientIds: config.publication.recipientIds,
					}
				: null;
		});
		this.publicationJobs = new PublicationJobs(this.db);
		this.publicationRuns = new PublicationRuns(this.db);
		this.publicationPosts = new PublicationPosts(this.db, this.publicationJobs);
		this.publicationChains = new PublicationChains(this.db);
		this.publicationInteractions = new PublicationInteractions(this.db, {
			generated: (...args) => this.generatedPublicationPost(...args),
			parent: (...args) => this.publicationFeedReader.parent(...args),
			agents: (worldId, parent) => {
				const active = this.currentPublicationAgents(worldId);
				return (this.publications.settings(worldId)?.agentRecipients ?? [])
					.filter(
						(mapping) =>
							active.includes(mapping.agentId) &&
							parent.audience.includes(mapping.recipientId) &&
							this.publicationFeedReader.parent(
								worldId,
								{ kind: "agent", agentId: mapping.agentId },
								parent.id,
							),
					)
					.map((mapping) => mapping.agentId);
			},
			lifeRevision: (worldId) => this.life.snapshot(worldId).revision,
			settingsRevision: (worldId) => {
				const settings = this.publications.settings(worldId);
				if (!settings) throw Error("Publication settings unavailable");
				return settings.revision;
			},
			now: this.now,
			reactionAllowed: (worldId, reactionId) =>
				this.publications.settings(worldId)?.reactionIds.includes(reactionId) ??
				false,
			charge: (
				worldId,
				key,
				roots,
				principal,
				lifeRevision,
				settingsRevision,
			) => {
				const settings = this.publications.settingsAt(
					worldId,
					settingsRevision,
				);
				return this.publicationChains.charge(
					worldId,
					key,
					roots,
					`actor-${lifeDigest(principal)}`,
					lifeRevision,
					{
						maxChainDepth: settings.maxChainDepth,
						maxActionsPerChain: settings.maxActionsPerChain,
						perAuthorCooldownSteps: settings.perAuthorCooldownSteps,
					},
					principal.kind === "agent",
				).charged;
			},
			admit: (input) => this.life.admit(input),
			input: (worldId, inputId) =>
				this.life.inputs(worldId).find((input) => input.id === inputId) ?? null,
			createPost: (interaction) => {
				this.publicationReplyPosts.create(interaction);
			},
		});
		this.publicationReplyPosts = new PublicationReplyPosts(this.db, {
			interaction: (worldId, id) =>
				this.publicationInteractions.get(worldId, id),
		});
		this.publicationEvidence = new PublicationEvidence({
			observations: (worldId, at) =>
				this.publicationInteractions.observationSnapshot(worldId, at),
			settingsRevision: (worldId, at) =>
				at === undefined
					? (this.publications.settings(worldId)?.revision ?? 0)
					: at === 0
						? 0
						: this.publications.settingsAt(worldId, at).revision,
			grant: (worldId, id, at) => {
				const grant =
					at === undefined
						? this.publicationGrants.get(worldId, id)
						: this.publicationGrants.at(worldId, id, at);
				return { id: grant.id, revision: grant.revision };
			},
			post: (worldId, id, at) => {
				const post = at
					? at.kind === "post"
						? this.publicationPosts.at(worldId, id, at.revision)
						: this.publicationReplyPosts.at(worldId, id, at.revision)
					: (this.publicationPosts.get(worldId, id) ??
						this.publicationReplyPosts.get(worldId, id));
				if (!post) throw Error("Missing publication source post");
				return "parentPostId" in post
					? {
							id: post.id,
							kind: "reply",
							revision: post.revision,
							parentId: post.parentPostId,
						}
					: {
							id: post.id,
							kind: "post",
							revision: post.revision,
							parentId:
								post.version === 2 ? post.material.source.parentPostId : null,
							...(post.version === 2
								? {
										grantIds: post.material.authority.grants.map(
											(grant) => grant.id,
										),
									}
								: {}),
						};
			},
			view: (source, authority) => {
				const reader = this.publicationFeedFor(source, authority);
				// This reader exists for one immutable authority proof inside the caller's transaction.
				// Principals authenticate separately, but equal recipients share the same parent visibility.
				const visibility = new Map<string, boolean>();
				return {
					visible: (principal, postId) => {
						try {
							const recipient = reader.recipient(
									source.pack.worldId,
									principal,
								),
								key = JSON.stringify([recipient, postId]);
							const cached = visibility.get(key);
							if (cached !== undefined) return cached;
							const allowed =
								reader.parent(source.pack.worldId, principal, postId) !== null;
							visibility.set(key, allowed);
							return allowed;
						} catch (error) {
							if (
								error instanceof Error &&
								error.message === "Publication principal forbidden"
							)
								return false;
							throw error;
						}
					},
				};
			},
		});
		this.publicationAncestry = new PublicationAncestry(this.db);
		this.publicationModels = new LifeModelReceipts(
			this.db,
			this.now,
			"publication",
		);
		this.publicationExecution = new PublicationExecution(
			this.publications,
			this.publicationJobs,
			this.publicationRuns,
			this.publicationModels,
			this.autonomy.schedules,
			{
				config: (worldId) => this.author.lifeConfig(worldId),
				configAt: (worldId, revision) =>
					this.author.lifeConfigAt(worldId, revision),
				activeAgents: (worldId) => this.currentPublicationAgents(worldId),
				auditSource: (job) => this.publicationJobSourceExists(job),
				effects: (worldId) => this.life.effects(worldId),
				material: (...args) => this.selectPublicationMaterial(...args),
				replyParents: (worldId) =>
					[
						...this.publicationPosts.list(worldId),
						...this.publicationReplyPosts.list(worldId),
					].map((post) => post.id),
				replyMaterial: (...args) =>
					this.selectPublicationReplyMaterial(...args),
				canPublish: (job) => this.chargePublicationPost(job, false),
				publish: (job) => {
					if (!this.chargePublicationPost(job, true)) return null;
					const post = this.publicationPosts.publish(
						job,
						this.now(),
						this.life.snapshot(job.worldId).revision,
						this.publicationEventRoots(job),
					);
					if (post.version === 2)
						this.publicationInteractions.generatedReply(
							job.worldId,
							job.id,
							post.id,
						);
					return post;
				},
				historical: (material) =>
					material.version === 2
						? this.selectPublicationReplyMaterial(
								material.worldId,
								material.source.parentPostId,
								material.authorAgentId,
								material.audience[0] ?? "",
								material.limits,
								material,
							)
						: this.selectPublicationMaterial(
								material.worldId,
								material.source.intentId,
								material.authorAgentId,
								material.audience,
								material.limits,
								material,
							),
			},
		);
		this.publicationFeedReader = this.publicationFeedFor();
		this.publicationCursors = new PublicationCursors(
			this.db,
			this.publicationFeedReader,
		);
		let transactionStarted = false;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
			this.db.exec("BEGIN IMMEDIATE");
			transactionStarted = true;
			initializeWorldSchema(
				this.db,
				() => this.auditWorld(),
				() => this.audit(false, false, false, false, false),
				() => this.audit(true, false, false, false, false),
				() => this.audit(true, true, false, false, false),
				() => this.audit(true, true, true, false, false),
				() => {
					for (const row of this.db.prepare("SELECT id FROM worlds").all())
						this.work.configure(this.author.lifeConfig(String(row["id"])));
				},
				() => this.audit(true, true, true, true, false),
				() => {
					for (const row of this.db
						.prepare(
							"SELECT world_id,step_id FROM life_steps WHERE accepted_life_revision IS NOT NULL ORDER BY world_id,accepted_life_revision",
						)
						.all()) {
						const worldId = String(row["world_id"]),
							step = this.autonomy.get(worldId, String(row["step_id"]));
						this.publicationAncestry.record(
							worldId,
							derivePublicationAncestry(step),
						);
					}
				},
			);
			this.audit();
			this.suggestions.recover();
			this.db.exec("COMMIT");
			transactionStarted = false;
			this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
		} catch (error) {
			if (transactionStarted) this.rollback();
			this.db.close();
			throw error;
		}
	}
	create(input: WorldDefinition): WorldSnapshot {
		const definition = parseDefinition(input);
		return this.transaction(() => this.createWorld(definition));
	}
	private createWorld(definition: WorldDefinition): WorldSnapshot {
		const existing = this.row(definition.id);
		if (existing) {
			if (!isDeepStrictEqual(JSON.parse(existing.definition_json), definition))
				throw Error("World definition conflict; definitions are immutable");
			return this.decode(existing);
		}
		const snapshot = initialSnapshot(definition);
		this.db
			.prepare(
				"INSERT INTO worlds (id, definition_json, state_json) VALUES (?, ?, ?)",
			)
			.run(definition.id, JSON.stringify(definition), stateJson(snapshot));
		this.db
			.prepare(
				"INSERT INTO world_definition_versions (world_id, version, definition_json) VALUES (?, ?, ?)",
			)
			.run(definition.id, definition.version, JSON.stringify(definition));
		return snapshot;
	}
	snapshot(worldId: string): WorldSnapshot {
		this.assertOpen();
		id(worldId);
		const row = this.row(worldId);
		if (!row) throw Error("Unknown world");
		return this.decode(row);
	}
	/** Trusted historical view for freezing an image/job brief after an accepted event. */
	snapshotAt(worldId: string, revision: number): WorldSnapshot {
		integer(revision, "historical revision");
		return this.transaction(() => {
			const current = this.snapshot(worldId);
			if (revision > current.revision) throw Error("Unknown world revision");
			return this.rebuild(current.definition, revision);
		}, false);
	}
	preview(input: WorldProposal): WorldSnapshot {
		const proposal = parseProposal(input);
		return transition(this.snapshot(proposal.worldId), proposal);
	}
	accept(input: WorldProposal): { event: WorldEvent; replayed: boolean } {
		const proposal = parseProposal(input);
		if (proposal.kind === "definition")
			throw Error("WORLD_CONFIRMATION_REQUIRED");
		return this.transaction(() => {
			const previous = this.db
				.prepare(
					`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ? AND idempotency_key = ?`,
				)
				.get(proposal.worldId, proposal.idempotencyKey) as EventRow | undefined;
			if (previous) {
				const event = readEvent(previous);
				this.life.legacyWrite(proposal.worldId, event.revision);
				if (!isDeepStrictEqual(eventProposal(event), proposal))
					throw Error("World idempotency key conflicts with accepted payload");
				return { event, replayed: true };
			}
			this.life.legacyWrite(proposal.worldId);
			this.author.assertActors(proposal);
			const next = transition(this.snapshot(proposal.worldId), proposal);
			const event = this.writeWorld(proposal, next);
			return { event, replayed: false };
		});
	}
	private writeWorld(proposal: WorldProposal, next: WorldSnapshot): WorldEvent {
		const event: WorldEvent = {
			...proposal,
			id: eventId(proposal.worldId, next.revision),
			revision: next.revision,
			acceptedAt: new Date(this.now()).toISOString(),
			origin: "fictional",
			definitionVersion: next.definition.version,
		};
		this.db
			.prepare(
				"INSERT INTO world_events (world_id, idempotency_key, revision, event_json) VALUES (?, ?, ?, ?)",
			)
			.run(
				proposal.worldId,
				proposal.idempotencyKey,
				event.revision,
				JSON.stringify(event),
			);
		if (proposal.kind === "definition") {
			this.db
				.prepare(
					"INSERT INTO world_definition_versions (world_id, version, definition_json) VALUES (?, ?, ?)",
				)
				.run(
					proposal.worldId,
					next.definition.version,
					JSON.stringify(next.definition),
				);
			this.db
				.prepare(
					"UPDATE worlds SET definition_json = ?, state_json = ? WHERE id = ?",
				)
				.run(
					JSON.stringify(next.definition),
					stateJson(next),
					proposal.worldId,
				);
		} else
			this.db
				.prepare("UPDATE worlds SET state_json = ? WHERE id = ?")
				.run(stateJson(next), proposal.worldId);
		return event;
	}
	prepareLife(input: LifeDefinition): LifeState {
		const definition = parseLifeDefinition(input);
		return this.transaction(() => this.life.prepare(definition));
	}
	isLifePrepared(worldId: string): boolean {
		id(worldId);
		return this.transaction(() => {
			this.snapshot(worldId);
			return this.life.prepared(worldId);
		}, false);
	}
	lifeDefinition(worldId: string): LifeDefinition {
		id(worldId);
		return this.transaction(() => this.life.definition(worldId), false);
	}
	lifeSnapshot(worldId: string): LifeState {
		id(worldId);
		return this.transaction(() => this.life.snapshot(worldId), false);
	}
	lifeSnapshotAt(worldId: string, revision: number): LifeState {
		id(worldId);
		integer(revision, "historical LIFE revision");
		return this.transaction(
			() => this.life.snapshotAt(worldId, revision),
			false,
		);
	}
	previewLife(input: LifeCommit, policy: IdentityPolicySnapshot): LifePreview {
		const commit = parseLifeCommit(input),
			identity = parseIdentityPolicy(policy);
		return this.transaction(() => this.life.preview(commit, identity), false);
	}
	acceptLife(input: LifeCommit, policy: IdentityPolicySnapshot): LifeReceipt {
		const commit = parseLifeCommit(input),
			identity = parseIdentityPolicy(policy);
		if (commit.version === 3)
			throw Error("Autonomous step acceptance required");
		return this.transaction(() => this.life.accept(commit, identity));
	}
	admitLifeInput(input: LifeInput): AdmissionReceipt {
		const parsed = parseLifeInput(input);
		if (parsed.version !== 1)
			throw Error("Trusted work or publication admission required");
		return this.transaction(() => this.life.admit(parsed));
	}
	/** Trusted source bridge only; never registered as a model tool or step-body field. */
	admitWorkInput(input: LifeInputV2): AdmissionReceipt {
		return this.transaction(() => {
			const receipt = this.work.admit(input);
			if (!receipt.replayed) {
				this.life.invalidateBindings(input.worldId);
				this.autonomy.invalidateWork(input.worldId);
			}
			return receipt;
		});
	}

	mintPublicationViewer(
		worldId: string,
		input: Parameters<PublicationGrants["mint"]>[1],
	) {
		return this.transaction(() => this.publicationGrants.mint(worldId, input));
	}
	revokePublicationViewer(
		worldId: string,
		grantId: string,
		input: Parameters<PublicationGrants["revoke"]>[2],
	) {
		return this.transaction(() => {
			const grant = this.publicationGrants.revoke(worldId, grantId, input);
			this.autonomy.invalidatePublication(worldId);
			return grant;
		});
	}
	authenticatePublicationViewer(worldId: string, token: string) {
		return this.transaction(
			() => this.publicationGrants.authenticate(worldId, token),
			false,
		);
	}
	publicationJob(worldId: string, jobId: string) {
		return this.transaction(
			() => this.publicationJobs.get(worldId, jobId),
			false,
		);
	}
	publicationModelRecords(worldId: string, jobId: string) {
		return this.transaction(() => {
			this.publicationJobs.get(worldId, jobId);
			return this.publicationModels.list(worldId, jobId);
		}, false);
	}
	/** Shared accounting and lease reads do not require or start autonomous simulation. */
	publicationExecutionStatus(worldId: string) {
		return this.transaction(
			() => ({
				usage: this.publicationModels.usage(
					worldId,
					this.author.lifeConfig(worldId),
				),
				schedule: this.autonomy.schedules.get(worldId),
			}),
			false,
		);
	}
	/** Final native step gateway rechecks current publication authority without starting work. */
	assertPublicationEvidenceCurrent(worldId: string, stepId: string): void {
		this.transaction(() => {
			this.autonomy.get(worldId, stepId, true);
		}, false);
	}
	beginPublicationRun(...args: Parameters<PublicationExecution["begin"]>) {
		return this.transaction(() => this.publicationExecution.begin(...args));
	}
	automaticPublicationInput(worldId: string) {
		return this.transaction(
			() => this.publicationExecution.automaticInput(worldId),
			false,
		);
	}
	freezePublicationJob(...args: Parameters<PublicationExecution["freeze"]>) {
		return this.transaction(() => this.publicationExecution.freeze(...args));
	}
	assertPublicationCurrent(
		...args: Parameters<PublicationExecution["assertCurrent"]>
	) {
		return this.transaction(
			() => this.publicationExecution.assertCurrent(...args),
			false,
		);
	}
	assertPublicationDispatch(
		...args: Parameters<PublicationExecution["assertDispatch"]>
	) {
		return this.transaction(
			() => this.publicationExecution.assertDispatch(...args),
			false,
		);
	}
	assertPublicationOutbound(
		...args: Parameters<PublicationExecution["assertOutbound"]>
	) {
		return this.transaction(
			() => this.publicationExecution.assertOutbound(...args),
			false,
		);
	}
	assertLifeModelOutbound(
		...args: Parameters<AutonomyPersistence["assertModelOutbound"]>
	) {
		return this.transaction(
			() => this.autonomy.assertModelOutbound(...args),
			false,
		);
	}
	preparePublicationModel(
		...args: Parameters<PublicationExecution["prepare"]>
	) {
		return this.transaction(() => this.publicationExecution.prepare(...args));
	}
	dispatchPublicationModel(
		...args: Parameters<PublicationExecution["dispatch"]>
	) {
		return this.transaction(() => this.publicationExecution.dispatch(...args));
	}
	finishPublicationModel(...args: Parameters<PublicationExecution["finish"]>) {
		return this.transaction(() => this.publicationExecution.finish(...args));
	}
	retryPublicationJob(...args: Parameters<PublicationExecution["retry"]>) {
		return this.transaction(() => this.publicationExecution.retry(...args));
	}
	failPublicationJob(...args: Parameters<PublicationExecution["fail"]>) {
		return this.transaction(() => this.publicationExecution.fail(...args));
	}
	advancePublicationRun(...args: Parameters<PublicationExecution["advance"]>) {
		return this.transaction(() => this.publicationExecution.advance(...args));
	}
	publicationRun(worldId: string, runId: string) {
		return this.transaction(
			() => this.publicationRuns.get(worldId, runId),
			false,
		);
	}
	pendingPublicationRuns(worldId: string) {
		return this.transaction(() => this.publicationRuns.pending(worldId), false);
	}
	completePublicationJob(
		...args: Parameters<PublicationExecution["complete"]>
	) {
		return this.transaction(() => this.publicationExecution.complete(...args));
	}
	withdrawPublicationPost(...args: Parameters<PublicationPosts["withdraw"]>) {
		return this.transaction(() => {
			const post = this.publicationPosts.get(args[0], args[1])
				? this.publicationPosts.withdraw(...args)
				: this.publicationReplyPosts.withdraw(...args);
			this.autonomy.invalidatePublication(args[0]);
			return post;
		});
	}
	replyToPublication(...args: Parameters<PublicationInteractions["reply"]>) {
		return this.transaction(() => {
			const result = this.publicationInteractions.reply(...args);
			this.autonomy.invalidatePublication(args[0]);
			return result;
		});
	}
	reactToPublication(...args: Parameters<PublicationInteractions["react"]>) {
		return this.transaction(() => {
			const result = this.publicationInteractions.react(...args);
			this.autonomy.invalidatePublication(args[0]);
			return result;
		});
	}
	resharePublication(...args: Parameters<PublicationInteractions["reshare"]>) {
		return this.transaction(() => {
			const result = this.publicationInteractions.reshare(...args);
			this.autonomy.invalidatePublication(args[0]);
			return result;
		});
	}
	publicationFeed(...args: Parameters<PublicationFeed["query"]>) {
		return this.transaction(
			() => this.publicationFeedReader.query(...args),
			false,
		);
	}
	publicationPost(...args: Parameters<PublicationFeed["post"]>) {
		return this.transaction(
			() => this.publicationFeedReader.post(...args),
			false,
		);
	}
	publicationReadCursor(...args: Parameters<PublicationCursors["get"]>) {
		return this.transaction(() => this.publicationCursors.get(...args), false);
	}
	setPublicationReadCursor(...args: Parameters<PublicationCursors["set"]>) {
		return this.transaction(() => this.publicationCursors.set(...args));
	}
	publicationSettings(worldId: string): PublicationSettings | null {
		return this.transaction(() => {
			this.snapshot(worldId);
			return this.publications.settings(worldId);
		}, false);
	}
	setPublicationSettings(
		worldId: string,
		expectedRevision: number,
		input: PublicationSettingsInput,
	): PublicationSettings {
		return this.transaction(() => {
			const settings = this.publications.setSettings(
				worldId,
				expectedRevision,
				input,
			);
			this.autonomy.invalidatePublication(worldId);
			return settings;
		});
	}
	/** Current agent authority; only worlds without an authored pack use legacy participants. */
	activePublicationAgents(worldId: string): string[] {
		return this.transaction(
			() => this.currentPublicationAgents(worldId),
			false,
		);
	}
	private currentPublicationAgents(worldId: string): string[] {
		const definition = this.life.definition(worldId);
		const pack = this.author.currentPack(worldId);
		return definition.participants.filter(
			(agentId) =>
				!pack ||
				pack.roles.some(
					(role) => role.agentId === agentId && role.status === "active",
				),
		);
	}
	/** Trusted publication job owner only. Feed handlers cannot choose an author or audience. */
	publicationMaterial(
		worldId: string,
		intentId: string,
		authorAgentId: string,
		recipientIds: string[],
		limits: LifeViewLimits,
	): EventPublicationMaterial | null {
		return this.transaction(() => {
			if (!this.currentPublicationAgents(worldId).includes(authorAgentId))
				return null;
			return this.selectPublicationMaterial(
				worldId,
				intentId,
				authorAgentId,
				recipientIds,
				limits,
			);
		}, false);
	}
	publicationReplyMaterial(
		worldId: string,
		parentPostId: string,
		authorAgentId: string,
		recipientId: string,
		limits: LifeViewLimits,
	): ReplyPublicationMaterial | null {
		return this.transaction(
			() =>
				this.selectPublicationReplyMaterial(
					worldId,
					parentPostId,
					authorAgentId,
					recipientId,
					limits,
				),
			false,
		);
	}
	private selectPublicationReplyMaterial(
		worldId: string,
		parentPostId: string,
		authorAgentId: string,
		recipientId: string,
		limits: LifeViewLimits,
		historical?: ReplyPublicationMaterial,
	): ReplyPublicationMaterial | null {
		for (const value of [worldId, parentPostId, authorAgentId, recipientId])
			id(value);
		const settings = historical
				? this.publications.settingsAt(worldId, historical.settingsRevision)
				: this.publications.settings(worldId),
			config = historical
				? this.author.lifeConfigAt(worldId, historical.configRevision)
				: this.author.lifeConfig(worldId);
		const life = historical
				? this.life.snapshotAt(worldId, historical.source.lifeRevision)
				: this.life.snapshot(worldId),
			world = this.rebuild(
				this.snapshot(worldId).definition,
				life.worldRevision,
			);
		const definition = historical
			? this.life.definitionRevision(worldId, historical.definitionRevision)
			: this.life.definition(worldId);
		const activeAgents = historical
			? this.publicationAgentsAt(world, definition)
			: this.currentPublicationAgents(worldId);
		if (
			!settings ||
			!activeAgents.includes(authorAgentId) ||
			!config.publication?.recipientIds.includes(recipientId) ||
			!settings.agentRecipients.some(
				(row) =>
					row.agentId === authorAgentId && row.recipientId === recipientId,
			)
		)
			return null;
		const feed = historical
			? this.publicationFeedFor(undefined, historical.authority, historical)
			: this.publicationFeedReader;
		const parent = publicationReplyParent(
			{
				posts: this.publicationPosts,
				replies: this.publicationReplyPosts,
				jobs: this.publicationJobs,
				interactions: this.publicationInteractions,
				grants: this.publicationGrants,
				feed,
			},
			worldId,
			parentPostId,
			authorAgentId,
			recipientId,
			settings.revision,
			historical?.authority,
		);
		if (!parent) return null;
		return selectPublicationReplyMaterial({
			world,
			life,
			definition,
			config,
			settings,
			activeAgents,
			agentId: authorAgentId,
			recipientId,
			work: this.work.snapshot(worldId, historical?.workRevision),
			workAncestryRevision: Math.max(
				0,
				...this.work
					.ancestry(worldId, historical?.workAncestryRevision)
					.map((row) => row.lifeRevision),
			),
			limits,
			parent,
		});
	}
	private publicationAgentsAt(
		world: WorldSnapshot,
		definition: LifeDefinition,
	): string[] {
		const row = this.db
			.prepare("SELECT version FROM world_packs WHERE world_id=? AND version=?")
			.get(world.definition.id, world.definition.version);
		if (!row) return definition.participants;
		const pack = this.author.worldPack(
			world.definition.id,
			world.definition.version,
		);
		return definition.participants.filter((agentId) =>
			pack.roles.some(
				(role) => role.agentId === agentId && role.status === "active",
			),
		);
	}
	private publicationStepCharges(step: LifeStep, historical: boolean): void {
		if (step.version !== 3) return;
		const budget = parsePublicationBudget(step.source.publicationBudget);
		if (!step.outcome) throw Error("Missing publication step outcome");
		for (const action of applyPublicationBudget(
			step,
			structuredClone(step.outcome.nextState),
		)) {
			if (!budget.limits) throw Error("Missing publication step limits");
			const args = [
				step.worldId,
				`pubcausal-${lifeDigest([step.id, action.kind, action.id])}`,
				action.roots,
				`life-${lifeDigest(step.worldId)}`,
				step.source.life.revision + 1,
				budget.limits,
				false,
			] as const;
			const charged = historical
				? this.publicationChains.hasCharge(...args)
				: this.publicationChains.charge(...args).charged;
			if (!charged) throw Error("Missing publication causal activity receipt");
		}
	}
	private publicationEventRoots(
		job: import("./publication-types.ts").PublicationJob,
	) {
		if (!job.material) throw Error("Missing publication material");
		if (job.material.version === 2)
			return job.material.parentRoots.map((root) => ({
				...root,
				depth: revision(root.depth + 1, 1),
			}));
		const eventId = job.material.source.eventId;
		const row = this.db
			.prepare(
				"SELECT step_id FROM life_steps WHERE world_id=? AND accepted_life_revision=?",
			)
			.get(job.worldId, job.material.source.lifeRevision);
		if (row) {
			const ancestry = this.publicationAncestry
				.list(job.worldId)
				.find((record) => record.kind === "event" && record.id === eventId);
			if (!ancestry) throw Error("Missing publication event ancestry");
			if (ancestry.roots.length)
				return ancestry.roots.map((root) => ({
					...root,
					depth: revision(root.depth + 1, 1),
				}));
		}

		return [
			{
				rootId: `chain-${lifeDigest({ worldId: job.worldId, eventId: job.material.source.eventId })}`,
				depth: 0,
			},
		];
	}
	private chargePublicationPost(
		job: import("./publication-types.ts").PublicationJob,
		write: boolean,
	): boolean {
		const settings = this.publications.settings(job.worldId);
		if (!settings) return false;
		const args = [
			job.worldId,
			`publication-${job.id}`,
			this.publicationEventRoots(job),
			`actor-${lifeDigest({ kind: "agent", agentId: job.authorAgentId })}`,
			this.life.snapshot(job.worldId).revision,
			{
				maxChainDepth: settings.maxChainDepth,
				maxActionsPerChain: settings.maxActionsPerChain,
				perAuthorCooldownSteps: settings.perAuthorCooldownSteps,
			},
			true,
		] as const;
		return write
			? this.publicationChains.charge(...args).charged
			: this.publicationChains.canCharge(...args);
	}
	/** The observation owner reuses this exact post and its existing charge, including on recovery. */
	private generatedPublicationPost(
		worldId: string,
		jobId: string,
		postId: string,
		historical: boolean,
	): ReplyPublicationPost | null {
		const post = historical
			? this.publicationPosts.at(worldId, postId, 1)
			: this.publicationPosts.get(worldId, postId);
		if (post?.version !== 2 || post.jobId !== jobId || post.withdrawn)
			return null;
		if (
			!historical &&
			!this.publicationFeedReader.content(
				worldId,
				{ kind: "agent", agentId: post.author.agentId },
				postId,
			)
		)
			return null;
		const job = this.publicationJobs.get(worldId, jobId);
		if (
			job.version !== 2 ||
			!["ready", "published"].includes(job.status) ||
			job.attemptId !== post.attemptId ||
			lifeDigest(job.material) !== lifeDigest(post.material)
		)
			return null;
		const settings = this.publications.settingsAt(
			worldId,
			post.material.settingsRevision,
		);
		if (
			!this.publicationChains.hasCharge(
				worldId,
				`publication-${job.id}`,
				post.roots,
				`actor-${lifeDigest({ kind: "agent", agentId: job.authorAgentId })}`,
				post.createdLifeRevision,
				{
					maxChainDepth: settings.maxChainDepth,
					maxActionsPerChain: settings.maxActionsPerChain,
					perAuthorCooldownSteps: settings.perAuthorCooldownSteps,
				},
				true,
			)
		)
			return null;
		return post;
	}
	private publicationReplyGrantMaterial(
		material: ReplyPublicationMaterial,
		authority?: PublicationAuthority,
	): ReplyPublicationMaterial | null {
		const settingsRevision =
			authority?.settingsRevision ??
			this.publications.settings(material.worldId)?.revision ??
			0;
		for (const original of material.authority.grants) {
			const ref = authority?.grants.find((grant) => grant.id === original.id);
			if (authority && !ref)
				throw Error("Missing generated reply grant reference");
			const grant = ref
				? this.publicationGrants.at(material.worldId, ref.id, ref.revision)
				: this.publicationGrants.get(material.worldId, original.id);
			if (
				grant.revoked ||
				grant.settingsRevision > settingsRevision ||
				!material.audience.includes(grant.recipientId)
			)
				return null;
		}
		return material;
	}
	/** Historical instances reuse the same audience/parent algorithm with exact frozen read ports. */
	private publicationFeedFor(
		source?: AutonomySource,
		authority?: PublicationAuthority,
		replyHistory?: ReplyPublicationMaterial,
	): PublicationFeed {
		if (!!(source || replyHistory) !== !!authority || (source && replyHistory))
			throw Error("Missing historical publication authority");
		if (source && !source.work)
			throw Error("Missing historical publication work evidence");
		const posts = new Map(authority?.posts.map((ref) => [ref.id, ref]) ?? []);
		const grants = new Map(authority?.grants.map((ref) => [ref.id, ref]) ?? []);
		const historical = !!(source || replyHistory);
		const replyWorld = replyHistory
			? this.rebuild(
					this.snapshot(replyHistory.worldId).definition,
					replyHistory.source.worldRevision,
				)
			: null;
		const activeAgents = (worldId: string): string[] => {
			return source
				? source.pack.life.participants.filter((agentId) =>
						source.pack.roles.some(
							(role) => role.agentId === agentId && role.status === "active",
						),
					)
				: replyHistory && replyWorld
					? this.publicationAgentsAt(
							replyWorld,
							this.life.definitionRevision(
								worldId,
								replyHistory.definitionRevision,
							),
						)
					: this.currentPublicationAgents(worldId);
		};
		const original = (worldId: string, id: string) => {
			if (!historical) return this.publicationPosts.get(worldId, id);
			const ref = posts.get(id);
			return ref?.kind === "post"
				? this.publicationPosts.at(worldId, id, ref.revision)
				: null;
		};
		const reply = (worldId: string, id: string) => {
			if (!historical) return this.publicationReplyPosts.get(worldId, id);
			const ref = posts.get(id);
			return ref?.kind === "reply"
				? this.publicationReplyPosts.at(worldId, id, ref.revision)
				: null;
		};
		return new PublicationFeed(
			{
				get: original,
				list: (worldId) =>
					historical
						? [...posts.values()]
								.filter((ref) => ref.kind === "post")
								.map((ref) =>
									this.publicationPosts.at(worldId, ref.id, ref.revision),
								)
						: this.publicationPosts.list(worldId),
			},
			{
				get: (worldId, id) => {
					if (!historical) return this.publicationGrants.get(worldId, id);
					const ref = grants.get(id);
					if (!ref)
						throw Error("Missing historical publication grant reference");
					return this.publicationGrants.at(worldId, id, ref.revision);
				},
			},
			{
				reactions: (worldId, principal, postId) =>
					historical
						? []
						: this.publicationInteractions.reactionState(
								worldId,
								principal,
								postId,
								this.publications.settings(worldId)?.reactionIds ?? [],
							),
				recipients: (worldId) => {
					if (source && source.pack.worldId !== worldId)
						throw Error("Historical publication world mismatch");
					const settings = authority
						? authority.settingsRevision === 0
							? null
							: this.publications.settingsAt(
									worldId,
									authority.settingsRevision,
								)
						: this.publications.settings(worldId);
					const config =
						source?.config ??
						(replyHistory
							? this.author.lifeConfigAt(worldId, replyHistory.configRevision)
							: this.author.lifeConfig(worldId));
					const active = activeAgents(worldId);
					return settings && config.publication
						? {
								revision: settings.revision,
								recipientIds: config.publication.recipientIds,
								agents: settings.agentRecipients.filter((mapping) =>
									active.includes(mapping.agentId),
								),
							}
						: null;
				},
				material: (material) =>
					// Reply claims were authenticated against the actual parent decision at
					// admission and recovery. The feed walks every ancestor independently;
					// calling the reply selector here would recursively re-enter this feed.
					material.version === 2
						? activeAgents(material.worldId).includes(material.authorAgentId)
							? this.publicationReplyGrantMaterial(material, authority)
							: null
						: this.selectPublicationMaterial(
								material.worldId,
								material.source.intentId,
								material.authorAgentId,
								material.audience,
								material.limits,
								source && authority
									? {
											configRevision: source.config.revision,
											settingsRevision: authority.settingsRevision,
											definitionRevision: source.life.definitionRevision,
											workRevision: source.work?.revision ?? 0,
											workAncestryRevision: source.life.revision,
											authorityWorldVersion: source.pack.version,
										}
									: replyHistory && replyWorld
										? {
												...replyHistory,
												authorityWorldVersion: replyWorld.definition.version,
											}
										: undefined,
							),
			},
			{
				posts: {
					get: reply,
					list: (worldId) =>
						historical
							? [...posts.values()]
									.filter((ref) => ref.kind === "reply")
									.map((ref) =>
										this.publicationReplyPosts.at(
											worldId,
											ref.id,
											ref.revision,
										),
									)
							: this.publicationReplyPosts.list(worldId),
				},
				interactions: this.publicationInteractions,
			},
		);
	}
	private publicationJobSourceExists(job: PublicationJob): void {
		auditPublicationJobSource(job, {
			life: this.life,
			posts: this.publicationPosts,
			replies: this.publicationReplyPosts,
			definitions: (worldId) =>
				this.db
					.prepare(
						"SELECT revision FROM life_config WHERE world_id=? ORDER BY revision",
					)
					.all(worldId)
					.map((row) =>
						this.life.definitionRevision(worldId, revision(row["revision"], 1)),
					),
			event: (worldId, worldRevision) => {
				const row = this.db
					.prepare(
						`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id=? AND revision=?`,
					)
					.get(worldId, worldRevision) as EventRow | undefined;
				if (!row) throw Error("Missing publication event");
				return readEvent(row);
			},
		});
	}
	private publicationFamily(
		worldId: string,
		intent: SideEffectIntent,
		event: WorldEvent,
	): string | null {
		const { envelope, receipt } = this.life.commitAt(
			worldId,
			intent.lifeRevision,
		);
		if (envelope.version !== 1)
			throw Error("Publication intent requires an activity commit");
		const commit = envelope.commit;
		if (commit.version !== 3) return null;
		const step = this.autonomy.get(worldId, commit.stepId);
		if (
			step.status !== "accepted" ||
			!step.receipt ||
			!step.outcome ||
			lifeDigest(step.receipt) !== lifeDigest(receipt) ||
			lifeDigest(step.outcome.commit) !== lifeDigest(commit) ||
			lifeDigest(commit.world) !== lifeDigest(eventProposal(event)) ||
			receipt?.eventId !== intent.payload.eventId ||
			receipt.worldRevision !== event.revision ||
			!commit.effects.some(
				(effect) => lifeDigest(effect) === lifeDigest(intent),
			)
		)
			throw Error(
				"Publication family provenance differs from its accepted step",
			);
		return step.decision.familyId;
	}
	private selectPublicationMaterial(
		worldId: string,
		intentId: string,
		authorAgentId: string,
		recipientIds: string[],
		limits: LifeViewLimits,
		historical?: Pick<
			PublicationMaterial,
			| "configRevision"
			| "settingsRevision"
			| "definitionRevision"
			| "workRevision"
			| "workAncestryRevision"
		> & { authorityWorldVersion?: number },
	): EventPublicationMaterial | null {
		id(worldId);
		id(intentId);
		id(authorAgentId);
		if (!Array.isArray(recipientIds) || !recipientIds.length)
			throw Error("Explicit publication audience required");
		for (const recipientId of recipientIds) id(recipientId);

		const config = historical
				? this.author.lifeConfigAt(worldId, historical.configRevision)
				: this.author.lifeConfig(worldId),
			settings = historical
				? this.publications.settingsAt(worldId, historical.settingsRevision)
				: this.publications.settings(worldId),
			definition = historical
				? this.life.definitionRevision(worldId, historical.definitionRevision)
				: this.life.definition(worldId),
			work = this.work.snapshot(worldId, historical?.workRevision),
			ancestry = this.work.ancestry(worldId, historical?.workAncestryRevision);
		if (
			!settings ||
			!config.publication ||
			!definition.participants.includes(authorAgentId) ||
			recipientIds.some(
				(recipient) => !config.publication?.recipientIds.includes(recipient),
			)
		)
			return null;
		const intent = this.life
			.effects(worldId)
			.find((effect) => effect.id === intentId);
		if (!intent) throw Error("Unknown publication intent");
		const life = this.life.snapshotAt(worldId, intent.lifeRevision);
		const world = this.rebuild(
			this.snapshot(worldId).definition,
			life.worldRevision,
		);
		const row = this.db
			.prepare(
				`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id=? AND revision=?`,
			)
			.get(worldId, life.worldRevision) as EventRow | undefined;
		if (!row) throw Error("Missing publication event");
		const event = readEvent(row);
		let familyId: string | null = null;
		if (settings.version === 2) {
			familyId = this.publicationFamily(worldId, intent, event);
			// A LIFE source has its own frozen pack authority. The settings' original
			// pack reference authenticates policy history, not a newer source's visibility.
			const pack = historical
				? this.author.worldPack(
						worldId,
						historical.authorityWorldVersion ?? settings.worldVersion,
					)
				: this.author.currentPack(worldId);
			if (
				!pack ||
				pack.schemaVersion !== 3 ||
				!pack.eventFamilies.some((family) => family.id === familyId)
			)
				familyId = null;
		}
		return selectPublicationMaterial({
			world,
			life,
			event,
			...(settings.version === 2
				? { eventRules: { familyId, rules: settings.eventRules } }
				: {}),
			intent,
			definitionRevision: definition.revision,
			workRevision: work.revision,
			workAncestryRevision: Math.max(
				0,
				...ancestry.map((row) => row.lifeRevision),
			),
			policy: definition.projection,
			authorAgentId,
			recipientIds,
			configRevision: config.revision,
			settingsRevision: settings.revision,
			workEvidenceDigest: lifeDigest(work),
			limits,
			workAllowed: (subject) => workSubjectAllowed(work, ancestry, subject),
		});
	}
	publication(
		scope: PublicationScope,
		limits: LifeViewLimits,
	): PublicationView {
		return this.transaction(() => {
			const world = this.snapshot(scope.worldId),
				life = this.life.snapshot(scope.worldId),
				definition = this.life.definition(scope.worldId);
			const events = this.db
				.prepare(
					`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id=? ORDER BY revision`,
				)
				.all(scope.worldId)
				.map((row) => readEvent(row as EventRow));
			return projectPublication(
				world,
				life,
				events,
				definition.projection,
				scope,
				limits,
				(subject) => this.work.allowed(scope.worldId, subject),
			);
		}, false);
	}
	workSubjectAllowed(worldId: string, subject: WorkSubject): boolean {
		return this.transaction(() => this.work.allowed(worldId, subject), false);
	}
	workEvidence(worldId: string): WorkEvidenceSnapshot {
		return this.transaction(() => this.work.snapshot(worldId), false);
	}
	lifeInputs(worldId: string): LifeInput[] {
		id(worldId);
		return this.transaction(() => this.life.inputs(worldId), false);
	}
	lifeEffects(worldId: string): SideEffectIntent[] {
		id(worldId);
		return this.transaction(() => this.life.effects(worldId), false);
	}
	worldBinding(agentId: string): WorldBinding | null {
		id(agentId);
		return this.transaction(() => this.life.binding(agentId), false);
	}
	setWorldBinding(
		agentId: string,
		expectedRevision: number,
		input: BindingSelection,
	): WorldBinding {
		id(agentId);
		integer(expectedRevision, "binding revision");
		const selection = parseBindingSelection(input);
		return this.transaction(() =>
			this.life.bind(agentId, expectedRevision, selection),
		);
	}
	context(
		worldId: string,
		agentId: string,
		limits: WorldContextLimits,
	): WorldContext {
		validateContextLimits(limits);
		return this.transaction(() => {
			const snapshot = this.snapshot(worldId);
			if (!snapshot.definition.agents.includes(agentId))
				throw Error("Unknown world agent");
			const rows = this.db
				.prepare(
					`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ? AND EXISTS (SELECT 1 FROM json_each(event_json, '$.audience') WHERE value = ?) ORDER BY revision DESC LIMIT ?`,
				)
				.all(worldId, agentId, limits.maxEvents + 1) as EventRow[];
			return projectContext(snapshot, agentId, rows.map(readEvent), limits);
		}, false);
	}
	/** Re-open audits atomic state against accepted events, without replaying any external effect. */
	private audit(
		includeAuthor = true,
		includeSocial = true,
		includeAutonomy = true,
		includeWork = true,
		includePublication = true,
	): void {
		this.auditWorld();
		const definitions = this.db
			.prepare(
				"SELECT world_id, version, definition_json FROM world_definition_versions",
			)
			.all() as Array<{
			world_id: string;
			version: number;
			definition_json: string;
		}>;
		const worlds = this.db
			.prepare(`SELECT ${WORLD_COLUMNS} FROM worlds`)
			.all() as WorldRow[];
		const referenced = new Set<string>();
		for (const world of worlds) {
			const entries = definitions
				.filter((row) => row.world_id === world.id)
				.sort((a, b) => a.version - b.version);
			if (!entries.length) throw Error("Missing initial world definition");
			referenced.add(`${world.id}:${entries[0]?.version}`);
			for (const raw of this.db
				.prepare(
					`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ? ORDER BY revision`,
				)
				.iterate(world.id)) {
				const event = readEvent(raw as EventRow);
				if (event.kind === "definition")
					referenced.add(`${world.id}:${event.definition.version}`);
			}
		}
		for (const row of definitions) {
			const definition = parseDefinition(JSON.parse(row.definition_json));
			integer(row.version, "definition registry version", 1);
			const world = worlds.find((item) => item.id === row.world_id);
			if (
				!world ||
				definition.id !== row.world_id ||
				definition.version !== row.version ||
				!referenced.has(`${row.world_id}:${row.version}`)
			)
				throw Error("Corrupt world definition registry");
		}
		this.life.audit();
		if (includeSocial) this.social.audit();
		if (includeAutonomy) this.autonomy.audit();
		if (includeWork) {
			for (const world of worlds) this.work.validate(world.id);
			this.work.validateSteps(this.autonomy.acceptedSteps());
		}
		if (includeAuthor) {
			this.author.audit();
			this.suggestions.audit();
		}
		if (includePublication) {
			this.publications.validate();
			this.publicationGrants.validate();
			this.publicationJobs.validate();
			this.publicationRuns.validate();
			this.publicationPosts.validate();
			this.publicationCursors.validate();
			this.publicationChains.validate();
			this.publicationInteractions.validate();
			this.publicationReplyPosts.validate();
			this.publicationAncestry.validate();
			for (const row of this.db.prepare("SELECT id FROM worlds").all()) {
				const worldId = String(row["id"]);
				this.publicationExecution.audit(worldId);
				const observationIds = new Set(
					this.publicationInteractions
						.observations(worldId)
						.map((row) => row.inputId),
				);
				if (
					this.life
						.inputs(worldId)
						.some(
							(input) => input.version === 3 && !observationIds.has(input.id),
						)
				)
					throw Error("Missing publication interaction observation graph");
				const generatedInteractions = new Map<string, string>();
				for (const interaction of this.publicationInteractions.list(worldId)) {
					if (interaction.version === 2) {
						const ref = interaction.generated;
						if (
							!ref ||
							!interaction.postId ||
							generatedInteractions.has(ref.jobId) ||
							!this.generatedPublicationPost(
								worldId,
								ref.jobId,
								interaction.postId,
								true,
							)
						)
							throw Error("Missing generated publication interaction owner");
						generatedInteractions.set(ref.jobId, interaction.postId);
						continue;
					}
					const settings = this.publications.settingsAt(
						worldId,
						interaction.settingsRevision,
					);
					const charged = this.publicationChains.hasCharge(
						worldId,
						interaction.id,
						interaction.roots,
						`actor-${lifeDigest(interaction.principal)}`,
						interaction.lifeRevision,
						{
							maxChainDepth: settings.maxChainDepth,
							maxActionsPerChain: settings.maxActionsPerChain,
							perAuthorCooldownSteps: settings.perAuthorCooldownSteps,
						},
						interaction.principal.kind === "agent",
					);
					if (charged !== (interaction.processing === "queued"))
						throw Error("Missing publication interaction activity receipt");
					if (
						interaction.postId &&
						!this.publicationReplyPosts.get(worldId, interaction.postId)
					)
						throw Error("Missing publication interaction post graph");
					const parent =
						this.publicationPosts.get(worldId, interaction.parentPostId) ??
						this.publicationReplyPosts.get(worldId, interaction.parentPostId);
					if (
						!parent ||
						interaction.expectedPostRevision > parent.revision ||
						lifeDigest(interaction.roots) !==
							lifeDigest(
								parent.roots.map((root) => ({
									...root,
									depth: revision(root.depth + 1, 1),
								})),
							)
					)
						throw Error("Corrupt publication interaction parent graph");
				}
				const expectedAncestry = parsePublicationAncestry(
					this.db
						.prepare(
							"SELECT step_id FROM life_steps WHERE world_id=? AND accepted_life_revision IS NOT NULL ORDER BY accepted_life_revision",
						)
						.all(worldId)
						.flatMap((row) => {
							const step = this.autonomy.get(worldId, String(row["step_id"]));
							this.publicationStepCharges(step, true);
							return derivePublicationAncestry(step);
						}),
				);
				if (
					lifeDigest(expectedAncestry) !==
					lifeDigest(this.publicationAncestry.list(worldId))
				)
					throw Error("Publication ancestry differs from accepted history");

				for (const job of this.publicationJobs.list(worldId)) {
					if (job.status !== "published") continue;
					const post = job.postId
						? this.publicationPosts.get(worldId, job.postId)
						: null;
					if (
						!post ||
						post.jobId !== job.id ||
						post.attemptId !== job.attemptId ||
						lifeDigest(post.roots) !==
							lifeDigest(this.publicationEventRoots(job))
					)
						throw Error("Missing publication delivery graph");
					if (
						job.version === 2 &&
						generatedInteractions.get(job.id) !== post.id
					)
						throw Error("Missing generated publication observation graph");
					const settings = this.publications.settingsAt(
						worldId,
						post.material.settingsRevision,
					);
					if (
						!this.publicationChains.hasCharge(
							worldId,
							`publication-${job.id}`,
							post.roots,
							`actor-${lifeDigest({ kind: "agent", agentId: job.authorAgentId })}`,
							post.createdLifeRevision,
							{
								maxChainDepth: settings.maxChainDepth,
								maxActionsPerChain: settings.maxActionsPerChain,
								perAuthorCooldownSteps: settings.perAuthorCooldownSteps,
							},
							true,
						)
					)
						throw Error("Missing publication activity receipt");
				}
			}
		}
	}
	private auditWorld(): void {
		const worlds = this.db
			.prepare(`SELECT ${WORLD_COLUMNS} FROM worlds ORDER BY id`)
			.all() as WorldRow[];
		if (this.db.prepare("PRAGMA foreign_key_check").all().length)
			throw Error("Corrupt world event references");
		for (const row of worlds) {
			const saved = this.decode(row);
			const rebuilt = this.rebuild(saved.definition);
			if (!isDeepStrictEqual(saved, rebuilt))
				throw Error("Corrupt world checkpoint");
		}
	}
	private rebuild(
		definition: WorldDefinition,
		revision?: number,
	): WorldSnapshot {
		const hasRegistry = !!this.db
			.prepare(
				"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'world_definition_versions'",
			)
			.get();
		const original = hasRegistry
			? (this.db
					.prepare(
						"SELECT definition_json FROM world_definition_versions WHERE world_id = ? ORDER BY version LIMIT 1",
					)
					.get(definition.id) as { definition_json: string } | undefined)
			: undefined;
		if (hasRegistry && !original)
			throw Error("Missing original world definition");
		let rebuilt = initialSnapshot(
			original
				? parseDefinition(JSON.parse(original.definition_json))
				: definition,
		);
		// Startup must inspect every stored row, including unsupported revisions.
		// Only an explicit historical lookup is allowed to bound the scan.
		const query = this.db.prepare(
			`SELECT ${EVENT_COLUMNS} FROM world_events WHERE world_id = ?${revision === undefined ? "" : " AND revision <= ?"} ORDER BY revision`,
		);
		const rows =
			revision === undefined
				? query.iterate(definition.id)
				: query.iterate(definition.id, revision);
		for (const row of rows) {
			const event = readEvent(row as EventRow);
			rebuilt = transition(rebuilt, eventProposal(event));
			if (event.definitionVersion !== rebuilt.definition.version)
				throw Error("Corrupt world definition version");
			if (event.kind === "definition") {
				const entry = this.db
					.prepare(
						"SELECT definition_json FROM world_definition_versions WHERE world_id = ? AND version = ?",
					)
					.get(definition.id, event.definitionVersion) as
					| { definition_json: string }
					| undefined;
				if (
					!entry ||
					!isDeepStrictEqual(
						parseDefinition(JSON.parse(entry.definition_json)),
						event.definition,
					)
				)
					throw Error("Corrupt world definition registry");
			}
			if (event.revision !== rebuilt.revision)
				throw Error("Corrupt world event revision");
		}
		if (revision !== undefined && rebuilt.revision !== revision)
			throw Error("Missing world event revision");
		return rebuilt;
	}
	private decode(row: WorldRow): WorldSnapshot {
		const definition = parseDefinition(JSON.parse(row.definition_json));
		if (row.id !== definition.id) throw Error("Corrupt world identity");
		return { ...JSON.parse(row.state_json), definition } as WorldSnapshot;
	}
	private row(worldId: string): WorldRow | undefined {
		return this.db
			.prepare(`SELECT ${WORLD_COLUMNS} FROM worlds WHERE id = ?`)
			.get(worldId) as WorldRow | undefined;
	}
	private transaction<T>(action: () => T, write = true): T {
		this.assertOpen();
		this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		try {
			const result = action();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.rollback();
			throw error;
		}
	}
	private rollback(): void {
		try {
			this.db.exec("ROLLBACK");
		} catch {
			/* SQLite may have aborted already; preserve the original failure. */
		}
	}
	private assertOpen(): void {
		if (this.closed) throw Error("World store is closed");
	}
	close(): void {
		if (this.closed) return;
		this.transaction(() => this.suggestions.close());
		this.db.close();
		this.closed = true;
	}
}
