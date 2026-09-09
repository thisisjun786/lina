import type { DatabaseSync } from "node:sqlite";
import {
	array,
	canonicalLifeJson,
	digest,
	enumeration,
	identifier,
	identifiers,
	jsonBoundary,
	lifeDigest,
	nullableId,
	revision,
} from "./life-json.ts";
import type { AdmissionReceipt, LifeInput, LifeInputV3 } from "./life-types.ts";
import { parseLifeInput } from "./life-validation.ts";
import type { PublicationChainRef } from "./publication-chains.ts";
import {
	type PublicationEvidenceSnapshot,
	type PublicationInputSource,
	type PublicationInteractionAction,
	parsePublicationAction,
	parsePublicationPrincipal,
	parsePublicationRoots,
	publicationObservationId,
} from "./publication-input.ts";
import { parseReplyPublicationPost } from "./publication-reply-records.ts";
import type {
	PublicationPrincipal,
	PublicLifeReactionState,
	ReplyPublicationPost,
} from "./publication-types.ts";
import { fields } from "./validation.ts";

type Parent = {
	id: string;
	revision: number;
	audience: string[];
	roots: PublicationChainRef[];
};
export interface Access {
	/**
	 * Authenticate the original v2 post, ready/published job and exact attempt/material/decision
	 * against their owners, and prove the existing publication-${jobId} charge (actor, roots,
	 * created LIFE revision, frozen settings limits and cooldown=true). Never charge here.
	 * Return the original revision-1 post. Fresh admission also checks current complete
	 * visibility; historical reads authenticate frozen authority even after withdrawal.
	 * Must use this transaction and must not call back into interaction history.
	 */
	generated?(
		worldId: string,
		jobId: string,
		postId: string,
		historical: boolean,
	): ReplyPublicationPost | null;
	/** Resolves the principal and CURRENT parent visibility, including author policy. */
	parent(
		worldId: string,
		principal: PublicationPrincipal,
		postId: string,
	): Parent | null;
	agents(worldId: string, parent: Parent): string[];
	lifeRevision(worldId: string): number;
	settingsRevision(worldId: string): number;
	now(): number;
	reactionAllowed(worldId: string, reactionId: string): boolean;
	charge(
		worldId: string,
		key: string,
		roots: PublicationChainRef[],
		principal: PublicationPrincipal,
		lifeRevision: number,
		settingsRevision: number,
	): boolean;
	admit(input: LifeInputV3): AdmissionReceipt;
	input(worldId: string, inputId: string): LifeInput | null;
	createPost(interaction: PublicationInteraction): void;
}
export interface PublicationInteraction {
	version: 1 | 2;
	worldId: string;
	id: string;
	requestKey: string;
	principal: PublicationPrincipal;
	parentPostId: string;
	expectedPostRevision: number;
	action: PublicationInteractionAction;
	roots: PublicationChainRef[];
	audience: string[];
	createdAt: number;
	lifeRevision: number;
	settingsRevision: number;
	postId: string | null;
	processing: "queued" | "stopped";
	observationIds: string[];
	/** Present only on v2; receipt decoding enforces the version/metadata/action pairing. */
	generated?: GeneratedPublicationReference;
}
export interface GeneratedPublicationReference {
	jobId: string;
	attemptId: string;
	postRevision: number;
	postDigest: string;
	chargeKey: string;
}
type Result = {
	interaction: PublicationInteraction | null;
	postId: string | null;
	replayed: boolean;
	effective: boolean;
};
type Request = Pick<
	PublicationInteraction,
	| "worldId"
	| "requestKey"
	| "principal"
	| "parentPostId"
	| "expectedPostRevision"
	| "action"
>;
type LegacyReceipt = {
	version: 1;
	sequence: number;
	previousDigest: string | null;
	request: Request;
	parent: Parent;
	lifeRevision: number;
	settingsRevision: number;
	createdAt: number;
	agents: string[];
	interactionId: string | null;
	postId: string | null;
	processing: "queued" | "stopped" | null;
};
type GeneratedReceipt = Omit<LegacyReceipt, "version"> & {
	version: 2;
	generated: GeneratedPublicationReference;
};
type Receipt = LegacyReceipt | GeneratedReceipt;
type ReactionHead = {
	principalDigest: string;
	parentPostId: string;
	reactionId: string;
	active: boolean;
	interactionId: string;
};
type History = {
	count: number;
	digest: string | null;
	receipts: Map<string, Receipt>;
	interactions: Map<string, PublicationInteraction>;
	reactions: Map<string, ReactionHead>;
	reshares: Map<string, string>;
	observations: PublicationEvidenceSnapshot["records"];
};

/** Registered by schema 7 in the caller's migration transaction. */
export const PUBLICATION_INTERACTIONS_SCHEMA: string = `
CREATE TABLE life_publication_interaction_state (
 world_id TEXT PRIMARY KEY REFERENCES worlds(id),
 receipt_count INTEGER NOT NULL CHECK(receipt_count BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}),
 digest TEXT NOT NULL
) STRICT;
CREATE TABLE life_publication_interaction_receipts (
 world_id TEXT NOT NULL REFERENCES worlds(id), principal_digest TEXT NOT NULL, request_key TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}),
 request_digest TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,principal_digest,request_key), UNIQUE(world_id,sequence)
) STRICT;
CREATE TABLE life_publication_interactions (
 world_id TEXT NOT NULL REFERENCES worlds(id), interaction_id TEXT NOT NULL,
 principal_digest TEXT NOT NULL, request_key TEXT NOT NULL,
 interaction_json TEXT NOT NULL CHECK(json_valid(interaction_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,interaction_id), UNIQUE(world_id,principal_digest,request_key),
 FOREIGN KEY(world_id,principal_digest,request_key)
 REFERENCES life_publication_interaction_receipts(world_id,principal_digest,request_key)
) STRICT;
CREATE TABLE life_publication_reaction_heads (
 world_id TEXT NOT NULL REFERENCES worlds(id), principal_digest TEXT NOT NULL,
 parent_post_id TEXT NOT NULL, reaction_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
 interaction_id TEXT NOT NULL, PRIMARY KEY(world_id,principal_digest,parent_post_id,reaction_id),
 FOREIGN KEY(world_id,interaction_id) REFERENCES life_publication_interactions(world_id,interaction_id)
) STRICT;
CREATE TABLE life_publication_observations (
 world_id TEXT NOT NULL REFERENCES worlds(id), input_id TEXT NOT NULL, interaction_id TEXT NOT NULL,
 agent_id TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,input_id), UNIQUE(world_id,interaction_id,agent_id),
 FOREIGN KEY(world_id,interaction_id) REFERENCES life_publication_interactions(world_id,interaction_id)
) STRICT;
`;

function parseParent(value: unknown): Parent {
	jsonBoundary(value);
	fields(value, ["id", "revision", "audience", "roots"]);
	const parent: Parent = {
		id: identifier(value.id),
		revision: revision(value.revision, 1),
		audience: identifiers(value.audience),
		roots: parsePublicationRoots(value.roots),
	};
	if (!parent.audience.length || !parent.roots.length)
		throw Error("Missing publication parent audience or roots");
	return parent;
}
function parseRequest(value: unknown, generated = false): Request {
	jsonBoundary(value);
	fields(value, [
		"worldId",
		"requestKey",
		"principal",
		"parentPostId",
		"expectedPostRevision",
		"action",
	]);
	const request = {
		worldId: identifier(value.worldId),
		requestKey: identifier(value.requestKey),
		principal: parsePublicationPrincipal(value.principal),
		parentPostId: identifier(value.parentPostId),
		expectedPostRevision: revision(value.expectedPostRevision, 1),
		action: parsePublicationAction(value.action),
	};
	if ((request.action.kind === "generated_reply") !== generated)
		throw Error("Invalid publication interaction action admission");
	return request;
}
function parseGeneratedReference(
	value: unknown,
): GeneratedPublicationReference {
	fields(value, [
		"jobId",
		"attemptId",
		"postRevision",
		"postDigest",
		"chargeKey",
	]);
	const reference = {
		jobId: identifier(value.jobId),
		attemptId: identifier(value.attemptId),
		postRevision: revision(value.postRevision, 1),
		postDigest: digest(value.postDigest),
		chargeKey: identifier(value.chargeKey),
	};
	if (
		reference.postRevision !== 1 ||
		reference.chargeKey !== `publication-${reference.jobId}`
	)
		throw Error("Invalid generated publication reference");
	return reference;
}
/** All authored request fields come from the authenticated generated post, never the caller. */
function generatedFields(post: ReplyPublicationPost) {
	const { worldId, jobId, attemptId, id: postId, material } = post;
	return {
		request: parseRequest(
			{
				worldId,
				requestKey: `generated-reply-${lifeDigest({ worldId, jobId, attemptId, postId })}`,
				principal: { kind: "agent", agentId: post.author.agentId },
				parentPostId: material.source.parentPostId,
				expectedPostRevision: material.source.parentPostRevision,
				action: { kind: "generated_reply", segments: post.segments },
			},
			true,
		),
		parent: parseParent({
			id: material.source.parentPostId,
			revision: material.source.parentPostRevision,
			audience: material.audience,
			roots: material.parentRoots,
		}),
		postId,
		lifeRevision: post.createdLifeRevision,
		settingsRevision: material.settingsRevision,
		createdAt: post.createdAt,
		generated: {
			jobId,
			attemptId,
			postRevision: post.revision,
			postDigest: lifeDigest(post),
			chargeKey: `publication-${jobId}`,
		},
	};
}
function receiptKey(request: Request): string {
	return lifeDigest({
		principal: request.principal,
		requestKey: request.requestKey,
	});
}
function interactionId(request: Request): string {
	return `pubint-${lifeDigest({ worldId: request.worldId, principal: request.principal, requestKey: request.requestKey })}`;
}
function childPostId(request: Request): string | null {
	return request.action.kind === "reaction"
		? null
		: `pubpost-${lifeDigest({ interactionId: interactionId(request) })}`;
}
function stateKey(request: Request): string {
	return lifeDigest({
		principal: request.principal,
		parentPostId: request.parentPostId,
		reactionId:
			request.action.kind === "reaction" ? request.action.reactionId : null,
	});
}
function effective(request: Request, history: History): boolean {
	if (request.action.kind === "reaction")
		return (
			(history.reactions.get(stateKey(request))?.active ?? false) !==
			request.action.active
		);
	return (
		request.action.kind !== "reshare" ||
		!history.reshares.has(stateKey(request))
	);
}
function materialize(receipt: Receipt): PublicationInteraction | null {
	const id = receipt.interactionId;
	if (!id) return null;
	if (!receipt.processing)
		throw Error("Missing publication interaction processing state");
	return {
		version: receipt.version,
		...receipt.request,
		id,
		roots: receipt.parent.roots.map((root) => ({
			rootId: root.rootId,
			depth: revision(root.depth + 1, 1),
		})),
		audience: receipt.parent.audience,
		createdAt: receipt.createdAt,
		lifeRevision: receipt.lifeRevision,
		settingsRevision: receipt.settingsRevision,
		postId: receipt.postId,
		processing: receipt.processing,
		observationIds: receipt.agents.map((agent) =>
			publicationObservationId(receipt.request.worldId, id, agent),
		),
		...(receipt.version === 2 ? { generated: receipt.generated } : {}),
	};
}
function observation(
	interaction: PublicationInteraction,
	agent: string,
): LifeInputV3 {
	if (interaction.version === 2 && !interaction.generated)
		throw Error("Missing generated publication reference");
	const id = publicationObservationId(
		interaction.worldId,
		interaction.id,
		agent,
	);
	const source: PublicationInputSource = {
		kind: "publication_interaction",
		observationId: id,
		interactionId: interaction.id,
		postId:
			interaction.version === 2
				? identifier(interaction.postId)
				: interaction.parentPostId,
		postRevision:
			interaction.version === 2
				? revision(interaction.generated?.postRevision, 1)
				: interaction.expectedPostRevision,
		principal: interaction.principal,
		recipientAgentId: agent,
		action: interaction.action,
		roots: interaction.roots,
	};
	return {
		version: 3,
		worldId: interaction.worldId,
		id,
		sourceRevision: 1,
		payloadDigest: lifeDigest(source),
		source,
		consumedLifeRevision: null,
	};
}
function saved(row: Record<string, unknown>, column: string): unknown {
	const json = row[column];
	if (typeof json !== "string")
		throw Error("Invalid publication interaction JSON");
	const value: unknown = JSON.parse(json);
	if (
		canonicalLifeJson(value) !== json ||
		lifeDigest(value) !== digest(row["digest"])
	)
		throw Error("Corrupt publication interaction digest or JSON");
	return value;
}
function decodeReceipt(row: Record<string, unknown>): Receipt {
	const value = saved(row, "receipt_json");
	const generated =
		!!value &&
		typeof value === "object" &&
		"version" in value &&
		value.version === 2;
	fields(value, [
		"version",
		"sequence",
		"previousDigest",
		"request",
		"parent",
		"lifeRevision",
		"settingsRevision",
		"createdAt",
		"agents",
		"interactionId",
		"postId",
		"processing",
		...(generated ? ["generated" as const] : []),
	]);
	if (value.version !== 1 && value.version !== 2)
		throw Error("Unsupported publication interaction receipt version");
	const receipt: Receipt = {
		...(value.version === 2
			? {
					version: 2 as const,
					generated: parseGeneratedReference(value.generated),
				}
			: { version: 1 as const }),
		sequence: revision(value.sequence, 1),
		previousDigest:
			value.previousDigest === null ? null : digest(value.previousDigest),
		request: parseRequest(value.request, generated),
		parent: parseParent(value.parent),
		lifeRevision: revision(value.lifeRevision),
		settingsRevision: revision(value.settingsRevision, 1),
		createdAt: revision(value.createdAt),
		agents: identifiers(value.agents),
		interactionId: nullableId(value.interactionId),
		postId: nullableId(value.postId),
		processing:
			value.processing === null
				? null
				: enumeration(value.processing, ["queued", "stopped"]),
	};
	const request = receipt.request;
	if (
		request.worldId !== row["world_id"] ||
		lifeDigest(request.principal) !== row["principal_digest"] ||
		request.requestKey !== row["request_key"] ||
		lifeDigest(request) !== digest(row["request_digest"]) ||
		receipt.sequence !== row["sequence"] ||
		canonicalLifeJson(receipt) !== row["receipt_json"] ||
		receipt.parent.id !== request.parentPostId ||
		receipt.parent.revision !== request.expectedPostRevision
	)
		throw Error("Corrupt publication interaction receipt projection");
	return receipt;
}

/**
 * Trusted SQL owner. Mutations require caller BEGIN IMMEDIATE and rollback on any error;
 * callbacks must use this same transaction. No model/provider work belongs here.
 * History audits frozen authority, never current visibility. The main post/grant owner
 * audits historical identity/authority; hashes cannot certify a coordinated DB rewrite.
 * This file keeps the receipt, outbox and projection replay together within its assigned scope.
 */
export class PublicationInteractions {
	constructor(
		private readonly db: DatabaseSync,
		private readonly access: Access,
	) {}

	/** Observe one already-created, already-paid generated child inside its publication commit. */
	generatedReply(worldId: string, jobId: string, postId: string): Result {
		if (!this.db.isTransaction)
			throw Error("Publication interaction requires caller transaction");
		const post = this.generatedPost(
			identifier(worldId),
			identifier(jobId),
			identifier(postId),
			false,
		);
		const derived = generatedFields(post);
		const history = this.history(worldId),
			prior = history.receipts.get(receiptKey(derived.request));
		if (prior) {
			if (
				prior.version !== 2 ||
				lifeDigest(prior.request) !== lifeDigest(derived.request) ||
				lifeDigest(prior.generated) !== lifeDigest(derived.generated)
			)
				throw Error("Generated publication delivery conflict");
			return {
				interaction: materialize(prior),
				postId: prior.postId,
				replayed: true,
				effective: true,
			};
		}
		const child = parseParent({
			id: post.id,
			revision: post.revision,
			audience: post.material.audience,
			roots: post.roots,
		});
		const agents = identifiers([
			...new Set(array(this.access.agents(worldId, child), identifier)),
		]).filter((agent) => agent !== post.author.agentId);
		const receipt: GeneratedReceipt = {
			version: 2,
			sequence: revision(history.count + 1, 1),
			previousDigest: history.digest,
			...derived,
			agents,
			interactionId: interactionId(derived.request),
			processing: "queued",
		};
		const interaction = materialize(receipt);
		if (!interaction) throw Error("Missing generated publication interaction");
		this.saveReceipt(receipt);
		this.saveInteraction(interaction, agents);
		return { interaction, postId, replayed: false, effective: true };
	}

	reply(
		worldId: string,
		principal: PublicationPrincipal,
		parentPostId: string,
		input: { requestKey: string; expectedPostRevision: number; text: string },
	): Result {
		jsonBoundary(input);
		fields(input, ["requestKey", "expectedPostRevision", "text"]);
		return this.mutate({
			worldId,
			principal,
			parentPostId,
			requestKey: input.requestKey,
			expectedPostRevision: input.expectedPostRevision,
			action: { kind: "reply", text: input.text },
		});
	}
	react(
		worldId: string,
		principal: PublicationPrincipal,
		parentPostId: string,
		input: {
			requestKey: string;
			expectedPostRevision: number;
			reactionId: string;
			active: boolean;
		},
	): Result {
		jsonBoundary(input);
		fields(input, [
			"requestKey",
			"expectedPostRevision",
			"reactionId",
			"active",
		]);
		return this.mutate({
			worldId,
			principal,
			parentPostId,
			requestKey: input.requestKey,
			expectedPostRevision: input.expectedPostRevision,
			action: {
				kind: "reaction",
				reactionId: input.reactionId,
				active: input.active,
			},
		});
	}
	reshare(
		worldId: string,
		principal: PublicationPrincipal,
		parentPostId: string,
		input: { requestKey: string; expectedPostRevision: number },
	): Result {
		jsonBoundary(input);
		fields(input, ["requestKey", "expectedPostRevision"]);
		return this.mutate({
			worldId,
			principal,
			parentPostId,
			requestKey: input.requestKey,
			expectedPostRevision: input.expectedPostRevision,
			action: { kind: "reshare" },
		});
	}
	get(worldId: string, id: string): PublicationInteraction {
		const interaction = this.history(identifier(worldId)).interactions.get(
			identifier(id),
		);
		if (!interaction) throw Error("Publication interaction unavailable");
		return interaction;
	}
	list(worldId: string): PublicationInteraction[] {
		return [...this.history(identifier(worldId)).interactions.values()];
	}
	/** Caller authorizes current visibility and supplies the configured vocabulary. No writes. */
	reactionState(
		worldId: string,
		principal: PublicationPrincipal,
		postId: string,
		reactionIds: string[],
	): PublicLifeReactionState[] {
		jsonBoundary(principal);
		jsonBoundary(reactionIds);
		const actor = parsePublicationPrincipal(principal),
			parentPostId = identifier(postId),
			ids = identifiers(reactionIds),
			history = this.history(identifier(worldId));
		return ids.map((reactionId) => ({
			reactionId,
			active:
				history.reactions.get(
					lifeDigest({ principal: actor, parentPostId, reactionId }),
				)?.active ?? false,
		}));
	}
	observations(worldId: string): PublicationEvidenceSnapshot["records"] {
		return this.history(identifier(worldId)).observations;
	}
	/** Complete historical membership; permission filtering belongs to the snapshot owner. */
	observationSnapshot(
		worldId: string,
		atRevision?: number,
	): {
		revision: number;
		records: PublicationEvidenceSnapshot["records"];
	} {
		const history = this.history(identifier(worldId));
		const cutoff =
			atRevision === undefined ? history.count : revision(atRevision);
		if (cutoff > history.count)
			throw Error("Unknown publication observation revision");
		const selected = new Set(
			[...history.receipts.values()]
				.filter(
					(receipt) =>
						receipt.sequence <= cutoff && receipt.interactionId !== null,
				)
				.map((receipt) => receipt.interactionId),
		);
		return {
			revision: cutoff,
			records: history.observations.filter((record) =>
				selected.has(record.source.interactionId),
			),
		};
	}
	validate(): void {
		for (const row of this.db
			.prepare(`
			SELECT world_id FROM life_publication_interaction_state
			UNION SELECT world_id FROM life_publication_interaction_receipts
			UNION SELECT world_id FROM life_publication_interactions
			UNION SELECT world_id FROM life_publication_reaction_heads
			UNION SELECT world_id FROM life_publication_observations
		`)
			.iterate())
			this.history(identifier(row["world_id"]));
	}

	private mutate(value: Request): Result {
		if (!this.db.isTransaction)
			throw Error("Publication interaction requires caller transaction");
		const request = parseRequest(value);
		const visible = this.access.parent(
			request.worldId,
			request.principal,
			request.parentPostId,
		);
		if (!visible) throw Error("Publication interaction parent unavailable");
		const parent = parseParent(visible);
		if (parent.id !== request.parentPostId)
			throw Error("Publication interaction parent mismatch");
		const history = this.history(request.worldId),
			prior = history.receipts.get(receiptKey(request));
		if (prior) {
			if (lifeDigest(prior.request) !== lifeDigest(request))
				throw Error("Publication interaction request conflict");
			return {
				interaction: materialize(prior),
				postId: prior.postId,
				replayed: true,
				effective: prior.interactionId !== null,
			};
		}
		if (parent.revision !== request.expectedPostRevision)
			throw Error("Publication interaction revision conflict");
		if (
			request.action.kind === "reaction" &&
			!this.access.reactionAllowed(request.worldId, request.action.reactionId)
		)
			throw Error("Publication reaction unavailable");
		const changed = effective(request, history);
		const receipt: Receipt = {
			version: 1,
			sequence: revision(history.count + 1, 1),
			previousDigest: history.digest,
			request,
			parent,
			lifeRevision: revision(this.access.lifeRevision(request.worldId)),
			settingsRevision: revision(
				this.access.settingsRevision(request.worldId),
				1,
			),
			createdAt: revision(this.access.now()),
			agents: [],
			interactionId: changed ? interactionId(request) : null,
			postId: changed
				? childPostId(request)
				: request.action.kind === "reshare"
					? (history.reshares.get(stateKey(request)) ?? null)
					: null,
			processing: changed ? "stopped" : null,
		};
		let interaction = materialize(receipt);
		if (interaction) {
			if (
				this.access.charge(
					request.worldId,
					interaction.id,
					interaction.roots,
					request.principal,
					receipt.lifeRevision,
					receipt.settingsRevision,
				)
			) {
				receipt.processing = "queued";
				receipt.agents = identifiers([
					...new Set(
						array(this.access.agents(request.worldId, parent), identifier),
					),
				]);
			}
			interaction = materialize(receipt);
		}
		this.saveReceipt(receipt);
		if (interaction) this.saveInteraction(interaction, receipt.agents);
		return {
			interaction,
			postId: receipt.postId,
			replayed: false,
			effective: changed,
		};
	}

	private saveReceipt(receipt: Receipt): void {
		const { request } = receipt,
			hash = lifeDigest(receipt);
		this.db
			.prepare(`INSERT INTO life_publication_interaction_receipts
			(world_id,principal_digest,request_key,sequence,request_digest,receipt_json,digest) VALUES(?,?,?,?,?,?,?)`)
			.run(
				request.worldId,
				lifeDigest(request.principal),
				request.requestKey,
				receipt.sequence,
				lifeDigest(request),
				canonicalLifeJson(receipt),
				hash,
			);
		this.db
			.prepare(`INSERT INTO life_publication_interaction_state(world_id,receipt_count,digest) VALUES(?,?,?)
			ON CONFLICT(world_id) DO UPDATE SET receipt_count=excluded.receipt_count,digest=excluded.digest`)
			.run(request.worldId, receipt.sequence, hash);
	}
	private saveInteraction(
		interaction: PublicationInteraction,
		agents: string[],
	): void {
		this.db
			.prepare(`INSERT INTO life_publication_interactions
			(world_id,interaction_id,principal_digest,request_key,interaction_json,digest) VALUES(?,?,?,?,?,?)`)
			.run(
				interaction.worldId,
				interaction.id,
				lifeDigest(interaction.principal),
				interaction.requestKey,
				canonicalLifeJson(interaction),
				lifeDigest(interaction),
			);
		if (interaction.action.kind === "reaction") {
			this.db
				.prepare(`INSERT INTO life_publication_reaction_heads
				(world_id,principal_digest,parent_post_id,reaction_id,active,interaction_id) VALUES(?,?,?,?,?,?)
				ON CONFLICT(world_id,principal_digest,parent_post_id,reaction_id)
				DO UPDATE SET active=excluded.active,interaction_id=excluded.interaction_id`)
				.run(
					interaction.worldId,
					lifeDigest(interaction.principal),
					interaction.parentPostId,
					interaction.action.reactionId,
					Number(interaction.action.active),
					interaction.id,
				);
		} else if (interaction.version === 1) this.access.createPost(interaction);
		for (const agent of agents) {
			const input = observation(interaction, agent);
			this.db
				.prepare(`INSERT INTO life_publication_observations
				(world_id,input_id,interaction_id,agent_id,input_json,digest) VALUES(?,?,?,?,?,?)`)
				.run(
					input.worldId,
					input.id,
					interaction.id,
					agent,
					canonicalLifeJson(input),
					lifeDigest(input),
				);
			const admitted = this.access.admit(input);
			jsonBoundary(admitted);
			fields(admitted, ["worldId", "inputId", "payloadDigest", "replayed"]);
			if (
				admitted.worldId !== input.worldId ||
				admitted.inputId !== input.id ||
				admitted.payloadDigest !== input.payloadDigest ||
				admitted.replayed !== false
			)
				throw Error("Publication observation admission mismatch");
			this.checkInput(input);
		}
	}

	private history(worldId: string): History {
		if (!this.db.prepare("SELECT id FROM worlds WHERE id=?").get(worldId))
			throw Error("Unknown publication interaction world");
		const history: History = {
			count: 0,
			digest: null,
			receipts: new Map(),
			interactions: new Map(),
			reactions: new Map(),
			reshares: new Map(),
			observations: [],
		};
		for (const row of this.db
			.prepare(`SELECT world_id,principal_digest,request_key,sequence,request_digest,receipt_json,digest
			FROM life_publication_interaction_receipts WHERE world_id=? ORDER BY sequence`)
			.iterate(worldId)) {
			const receipt = decodeReceipt(row);
			if (
				receipt.sequence !== history.count + 1 ||
				receipt.previousDigest !== history.digest
			)
				throw Error("Missing or reordered publication interaction receipt");
			this.replayReceipt(receipt, history);
			history.count = receipt.sequence;
			history.digest = digest(row["digest"]);
			history.receipts.set(receiptKey(receipt.request), receipt);
		}
		this.checkProjections(worldId, history);
		return history;
	}
	private replayReceipt(receipt: Receipt, history: History): void {
		if (receipt.version === 2) this.checkGeneratedReceipt(receipt, history);
		const request = receipt.request,
			changed = effective(request, history);
		const expectedPost =
			receipt.version === 2
				? receipt.postId
				: changed
					? childPostId(request)
					: request.action.kind === "reshare"
						? (history.reshares.get(stateKey(request)) ?? null)
						: null;
		if (
			receipt.interactionId !== (changed ? interactionId(request) : null) ||
			receipt.postId !== expectedPost ||
			(changed ? receipt.processing === null : receipt.processing !== null) ||
			(receipt.processing !== "queued" && receipt.agents.length !== 0)
		)
			throw Error("Forged publication interaction or noop receipt");
		const interaction = materialize(receipt);
		if (!interaction) return;
		const row = this.db
			.prepare(`SELECT world_id,interaction_id,principal_digest,request_key,interaction_json,digest
			FROM life_publication_interactions WHERE world_id=? AND interaction_id=?`)
			.get(request.worldId, interaction.id);
		if (
			!row ||
			row["principal_digest"] !== lifeDigest(request.principal) ||
			row["request_key"] !== request.requestKey ||
			canonicalLifeJson(saved(row, "interaction_json")) !==
				canonicalLifeJson(interaction)
		)
			throw Error("Missing or corrupt publication interaction");
		history.interactions.set(interaction.id, interaction);
		if (request.action.kind === "reaction")
			history.reactions.set(stateKey(request), {
				principalDigest: lifeDigest(request.principal),
				parentPostId: request.parentPostId,
				reactionId: request.action.reactionId,
				active: request.action.active,
				interactionId: interaction.id,
			});
		if (request.action.kind === "reshare" && interaction.postId)
			history.reshares.set(stateKey(request), interaction.postId);
		this.checkObservations(interaction, receipt.agents, history);
	}
	private generatedPost(
		worldId: string,
		jobId: string,
		postId: string,
		historical: boolean,
	): ReplyPublicationPost {
		const value = this.access.generated?.(worldId, jobId, postId, historical);
		if (!value)
			throw Error("Missing trusted generated publication source or charge");
		const post = parseReplyPublicationPost(value);
		if (
			post.worldId !== worldId ||
			post.jobId !== jobId ||
			post.id !== postId ||
			post.revision !== 1 ||
			post.withdrawn
		)
			throw Error("Generated publication source identity mismatch");
		return post;
	}
	private checkGeneratedReceipt(
		receipt: GeneratedReceipt,
		history: History,
	): void {
		const post = this.generatedPost(
			receipt.request.worldId,
			receipt.generated.jobId,
			identifier(receipt.postId),
			true,
		);
		const expected = generatedFields(post);
		const actual = {
			request: receipt.request,
			parent: receipt.parent,
			postId: receipt.postId,
			lifeRevision: receipt.lifeRevision,
			settingsRevision: receipt.settingsRevision,
			createdAt: receipt.createdAt,
			generated: receipt.generated,
		};
		if (
			lifeDigest(actual) !== lifeDigest(expected) ||
			receipt.processing !== "queued" ||
			receipt.agents.includes(post.author.agentId) ||
			[...history.receipts.values()].some(
				(prior) =>
					prior.version === 2 &&
					(prior.postId === post.id || prior.generated.jobId === post.jobId),
			)
		)
			throw Error("Forged generated publication receipt or duplicate owner");
	}
	private checkInput(original: LifeInputV3): void {
		const current = this.access.input(original.worldId, original.id);
		if (!current) throw Error("Missing admitted publication input");
		const parsed = parseLifeInput(current);
		if (
			canonicalLifeJson({ ...parsed, consumedLifeRevision: null }) !==
			canonicalLifeJson(original)
		)
			throw Error("Mismatched admitted publication input owner or payload");
	}
	private checkObservations(
		interaction: PublicationInteraction,
		agents: string[],
		history: History,
	): void {
		const rows = this.db
			.prepare(`SELECT world_id,input_id,interaction_id,agent_id,input_json,digest
			FROM life_publication_observations WHERE world_id=? AND interaction_id=? ORDER BY agent_id`)
			.all(interaction.worldId, interaction.id);
		if (rows.length !== agents.length)
			throw Error("Missing or duplicate publication observation");
		for (const [index, row] of rows.entries()) {
			const agent = agents[index];
			if (!agent) throw Error("Unexpected publication observation agent");
			const expected = observation(interaction, agent);
			const input = parseLifeInput(saved(row, "input_json"));
			if (
				input.version !== 3 ||
				row["agent_id"] !== agent ||
				row["input_id"] !== expected.id ||
				canonicalLifeJson(input) !== canonicalLifeJson(expected)
			)
				throw Error("Corrupt publication observation owner or payload");
			this.checkInput(expected);
			history.observations.push({ inputId: input.id, source: input.source });
		}
	}
	private checkProjections(worldId: string, history: History): void {
		const head = this.db
			.prepare(
				"SELECT receipt_count,digest FROM life_publication_interaction_state WHERE world_id=?",
			)
			.get(worldId);
		if (
			history.count
				? !head ||
					revision(head["receipt_count"], 1) !== history.count ||
					digest(head["digest"]) !== history.digest
				: !!head
		)
			throw Error("Missing or regressed publication interaction receipt state");
		const count = this.db
			.prepare(`SELECT
			(SELECT count(*) FROM life_publication_interactions WHERE world_id=?) AS interactions,
			(SELECT count(*) FROM life_publication_observations WHERE world_id=?) AS observations`)
			.get(worldId, worldId);
		if (
			count?.["interactions"] !== history.interactions.size ||
			count?.["observations"] !== history.observations.length
		)
			throw Error("Orphan publication interaction or observation");
		const rows = this.db
			.prepare(`SELECT principal_digest,parent_post_id,reaction_id,active,interaction_id
			FROM life_publication_reaction_heads WHERE world_id=?`)
			.all(worldId);
		if (rows.length !== history.reactions.size)
			throw Error("Missing publication reaction head");
		for (const row of rows) {
			const interaction = history.interactions.get(
				identifier(row["interaction_id"]),
			);
			const expected =
				interaction && history.reactions.get(stateKey(interaction));
			if (
				!expected ||
				digest(row["principal_digest"]) !== expected.principalDigest ||
				identifier(row["parent_post_id"]) !== expected.parentPostId ||
				identifier(row["reaction_id"]) !== expected.reactionId ||
				row["active"] !== Number(expected.active) ||
				row["interaction_id"] !== expected.interactionId
			)
				throw Error("Mismatched publication reaction head");
		}
	}
}
