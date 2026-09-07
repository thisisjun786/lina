import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { WorldPack } from "./authoring-types.ts";
import {
	canonicalLifeJson,
	digest,
	identifier,
	lifeDigest,
	revision,
} from "./life-json.ts";
import { currentDisclosurePolicy } from "./life-knowledge.ts";
import type {
	IdentityPolicySnapshot,
	LifeCommit,
	LifeState,
} from "./life-types.ts";
import { parseLifeCommit, parseLifeState } from "./life-validation.ts";
import { validateSocialResult } from "./social.ts";
import { socialResolutionCommit } from "./social-commit.ts";
import { compileSocialPack } from "./social-compile.ts";
import { inspectSocialIntent } from "./social-intent-validation.ts";
import type {
	SocialExtensionInput,
	SocialPreparedResolution,
	SocialPrepareRequest,
} from "./social-store-types.ts";
import { parseSocialPrepareRequest } from "./social-store-validation.ts";
import type {
	SocialBootstrap,
	SocialPolicyReference,
	SocialResolution,
	SocialResolveInput,
} from "./social-types.ts";
import {
	parseSocialResolution,
	parseSocialResolveInput,
} from "./social-validation.ts";
import type { WorldSnapshot } from "./types.ts";
import { fields, integer } from "./validation.ts";

type Source = { world: WorldSnapshot; life: LifeState };
type Access = {
	source(worldId: string): Source;
	sourceAt(worldId: string, lifeRevision: number): Source;
	pack(worldId: string, version: number): WorldPack;
};
type BootstrapRow = {
	world_id: string;
	bootstrap_json: string;
	digest: string;
};
type ResolutionRow = {
	world_id: string;
	request_id: string;
	request_digest: string;
	input_digest: string;
	input_json: string;
	result_json: string | null;
	result_digest: string | null;
	accepted_life_revision: number | null;
};

function bootstrap(worldId: string, seed: number): SocialBootstrap {
	integer(seed, "social seed", 0, 0xffffffff);
	const body = {
		version: 1 as const,
		worldId,
		algorithm: "lcg32-v1" as const,
		seed,
	};
	return { ...body, digest: lifeDigest(body) };
}
function unchanged(input: SocialExtensionInput): SocialResolution {
	const draws =
		input.checkpoint.engineId === "empty"
			? 0
			: input.checkpoint.data.rng.drawIndex;
	const body = {
		version: 1 as const,
		requestId: input.requestId,
		inputDigest: lifeDigest(input),
		previousCheckpointDigest: lifeDigest(input.checkpoint),
		kind: "unchanged" as const,
		outcome: "extension_required" as const,
		effects: [] as [],
		checkpoint: input.checkpoint,
		trace: {
			rootActionId: null,
			terminalActionId: null,
			bindings: {},
			candidateIds: [],
			triggerIds: [],
			drawsBefore: draws,
			drawsAfter: draws,
			rejection: "extension_required",
		},
	};
	return { ...body, resultDigest: lifeDigest(body) };
}

/** Internal SQL owner; every mutation runs within WorldStore's one transaction. No worker executes here. */
export class SocialPersistence {
	constructor(
		private readonly db: DatabaseSync,
		private readonly access: Access,
	) {}
	private row(worldId: string, requestId: string): ResolutionRow | undefined {
		return this.db
			.prepare(
				"SELECT * FROM world_social_resolutions WHERE world_id = ? AND request_id = ?",
			)
			.get(worldId, requestId) as ResolutionRow | undefined;
	}
	private seed(worldId: string): SocialBootstrap | null {
		const row = this.db
			.prepare("SELECT * FROM world_social_bootstraps WHERE world_id = ?")
			.get(worldId) as BootstrapRow | undefined;
		if (!row) return null;
		const value: unknown = JSON.parse(row.bootstrap_json);
		fields(value, ["version", "worldId", "algorithm", "seed", "digest"]);
		integer(value.seed, "social seed", 0, 0xffffffff);
		const expected = bootstrap(identifier(value.worldId), value.seed);
		if (
			row.world_id !== worldId ||
			expected.worldId !== worldId ||
			!isDeepStrictEqual(value, expected) ||
			row.digest !== expected.digest
		)
			throw Error("Corrupt social bootstrap");
		return expected;
	}
	private input(
		request: SocialPrepareRequest,
		source: Source,
		seed: SocialBootstrap | null,
	): SocialResolveInput | SocialExtensionInput {
		const { world, life } = source;
		const pack = this.access.pack(request.worldId, world.definition.version);
		if (pack.schemaVersion !== 2)
			throw Error("Social engine is not configured for this world pack");
		if (
			world.definition.id !== request.worldId ||
			life.worldId !== request.worldId ||
			life.worldRevision !== world.revision ||
			life.definitionRevision !== pack.life.revision ||
			!isDeepStrictEqual(pack.world, world.definition)
		)
			throw Error("Social source mismatch");
		const rulePack = compileSocialPack(pack),
			inspection = inspectSocialIntent(request.intent, rulePack);
		const response = request.targetResponse;
		if (
			(inspection.intent.targetAgentId === null && response !== null) ||
			(inspection.intent.targetAgentId !== null &&
				(!response ||
					response.intentId !== inspection.intent.id ||
					response.agentId !== inspection.intent.targetAgentId))
		)
			throw Error("Social target response mismatch");
		if (request.simulationTime < world.simulationTime)
			throw Error("Social time cannot go backwards");
		const policies: SocialPolicyReference[] = [];
		for (const primitive of inspection.intent.primitives)
			if (primitive.kind === "reveal") {
				const policy = currentDisclosurePolicy(primitive.claim, pack.life);
				if (!policy) throw Error("Missing social disclosure policy");
				if (
					!policies.some(
						(x) =>
							x.claim.kind === primitive.claim.kind &&
							x.claim.id === primitive.claim.id,
					)
				)
					policies.push({
						claim: primitive.claim,
						definitionRevision: pack.life.revision,
						projectionRevision: pack.life.projection.revision,
						policyDigest: lifeDigest(policy),
					});
			}
		const common = {
			version: 1 as const,
			requestId: request.requestId,
			world,
			life,
			identity: request.identity,
			checkpoint: life.checkpoint,
			rulePack,
			targetResponse: response,
			simulationTime: request.simulationTime,
			policies,
			limits: request.limits,
		};
		if (inspection.kind === "extension")
			return {
				...common,
				kind: "extension",
				intent: inspection.intent,
				bootstrap: null,
			};
		if (
			life.checkpoint.engineId === "ensemble" &&
			(!seed || seed.seed !== life.checkpoint.data.rng.seed)
		)
			throw Error("Social checkpoint bootstrap mismatch");
		return parseSocialResolveInput({
			...common,
			intent: inspection.intent,
			bootstrap: life.checkpoint.engineId === "empty" ? seed : null,
		});
	}
	prepare(
		value: SocialPrepareRequest,
		entropy: () => number,
	): SocialPreparedResolution {
		const request = parseSocialPrepareRequest(value),
			requestDigest = lifeDigest(request);
		const prior = this.row(request.worldId, request.requestId);
		if (prior) {
			if (prior.request_digest !== requestDigest)
				throw Error("Social request idempotency conflict");
			return this.decode(prior);
		}
		const source = this.access.source(request.worldId),
			savedSeed = this.seed(request.worldId);
		// Fully validate the known request before drawing entropy or inserting any row.
		let input = this.input(
			request,
			source,
			savedSeed ?? bootstrap(request.worldId, 0),
		);
		if (!("kind" in input) && !savedSeed) {
			const chosen = bootstrap(request.worldId, entropy());
			this.db
				.prepare(
					"INSERT INTO world_social_bootstraps (world_id, bootstrap_json, digest) VALUES (?, ?, ?)",
				)
				.run(request.worldId, canonicalLifeJson(chosen), chosen.digest);
			input = this.input(request, source, chosen);
		}
		const result = "kind" in input ? unchanged(input) : null;
		this.db
			.prepare(
				"INSERT INTO world_social_resolutions (world_id, request_id, request_digest, input_digest, input_json, result_json, result_digest, accepted_life_revision) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
			)
			.run(
				request.worldId,
				request.requestId,
				requestDigest,
				lifeDigest(input),
				canonicalLifeJson({ request, input }),
				result === null ? null : canonicalLifeJson(result),
				result?.resultDigest ?? null,
			);
		return this.get(request.worldId, request.requestId);
	}
	get(worldId: string, requestId: string): SocialPreparedResolution {
		identifier(worldId);
		identifier(requestId);
		const row = this.row(worldId, requestId);
		if (!row) throw Error("Unknown social resolution");
		return this.decode(row);
	}
	private decode(
		row: ResolutionRow,
		source?: Source,
	): SocialPreparedResolution {
		const value: unknown = JSON.parse(row.input_json);
		fields(value, ["request", "input"]);
		const request = parseSocialPrepareRequest(value.request);
		if (
			!value.input ||
			typeof value.input !== "object" ||
			!("life" in value.input)
		)
			throw Error("Corrupt social source input");
		const savedLife = parseLifeState(value.input.life);
		const previous =
			source ?? this.access.sourceAt(request.worldId, savedLife.revision);
		const input = this.input(request, previous, this.seed(request.worldId));
		if (
			row.world_id !== request.worldId ||
			row.request_id !== request.requestId ||
			row.request_digest !== lifeDigest(request) ||
			row.input_digest !== lifeDigest(input) ||
			!isDeepStrictEqual(value.input, input)
		)
			throw Error("Corrupt social request provenance");
		let result: SocialResolution | null = null;
		if (row.result_json !== null) {
			result = parseSocialResolution(JSON.parse(row.result_json));
			if ("kind" in input) {
				if (!isDeepStrictEqual(result, unchanged(input)))
					throw Error("Corrupt social extension receipt");
			} else validateSocialResult(input, result);
			if (digest(row.result_digest) !== result.resultDigest)
				throw Error("Corrupt social result digest");
		} else if (
			row.result_digest !== null ||
			row.accepted_life_revision !== null ||
			"kind" in input
		)
			throw Error("Incomplete social result provenance");
		if (row.accepted_life_revision !== null) {
			revision(row.accepted_life_revision, 1);
			if (
				result?.kind !== "advanced" ||
				row.accepted_life_revision !== input.life.revision + 1
			)
				throw Error("Corrupt social accepted revision");
		}
		return {
			version: 1,
			worldId: row.world_id,
			requestId: row.request_id,
			requestDigest: row.request_digest,
			inputDigest: row.input_digest,
			input,
			result,
			acceptedLifeRevision: row.accepted_life_revision,
		};
	}
	private assertCurrent(
		input: SocialResolveInput | SocialExtensionInput,
	): void {
		const current = this.access.source(input.world.definition.id);
		if (
			!isDeepStrictEqual(current.world, input.world) ||
			!isDeepStrictEqual(current.life, input.life)
		)
			throw Error("Stale social source boundary");
	}
	finish(
		worldId: string,
		requestId: string,
		value: SocialResolution,
	): SocialPreparedResolution {
		const prepared = this.get(worldId, requestId),
			result = parseSocialResolution(value);
		if (prepared.result !== null) {
			if (!isDeepStrictEqual(prepared.result, result))
				throw Error("Social result idempotency conflict");
			return prepared;
		}
		if ("kind" in prepared.input)
			throw Error("Social extension has no worker result");
		this.assertCurrent(prepared.input);
		validateSocialResult(prepared.input, result);
		if (result.kind !== "advanced")
			throw Error("Known social request requires an advanced result");
		const changed = this.db
			.prepare(
				"UPDATE world_social_resolutions SET result_json = ?, result_digest = ? WHERE world_id = ? AND request_id = ? AND result_json IS NULL",
			)
			.run(canonicalLifeJson(result), result.resultDigest, worldId, requestId);
		if (changed.changes !== 1)
			throw Error("Social result compare-and-set conflict");
		return this.get(worldId, requestId);
	}
	commit(
		worldId: string,
		requestId: string,
		identity: IdentityPolicySnapshot,
	): LifeCommit {
		const prepared = this.get(worldId, requestId);
		if (
			"kind" in prepared.input ||
			!prepared.result ||
			prepared.result.kind !== "advanced"
		)
			throw Error("Social resolution is not acceptable");
		if (!isDeepStrictEqual(identity, prepared.input.identity))
			throw Error("Social identity policy conflict");
		if (prepared.acceptedLifeRevision === null)
			this.assertCurrent(prepared.input);
		return parseLifeCommit(
			socialResolutionCommit(prepared.input, prepared.result),
		);
	}
	assertCommit(
		commit: LifeCommit,
		identity: IdentityPolicySnapshot,
		source: Source,
		historical: boolean,
	): void {
		if (commit.version === 1) return;
		const row = this.row(commit.world.worldId, commit.socialResolutionId);
		if (!row) throw Error("LIFE social receipt is missing");
		const prepared = this.decode(row, source);
		if (
			"kind" in prepared.input ||
			!prepared.result ||
			prepared.result.kind !== "advanced" ||
			!isDeepStrictEqual(identity, prepared.input.identity) ||
			!isDeepStrictEqual(
				commit,
				parseLifeCommit(
					socialResolutionCommit(prepared.input, prepared.result),
				),
			) ||
			(historical
				? prepared.acceptedLifeRevision !== commit.expectedLifeRevision + 1
				: prepared.acceptedLifeRevision !== null)
		)
			throw Error("LIFE social receipt does not authorize this commit");
	}
	markAccepted(commit: LifeCommit): void {
		if (commit.version !== 2) return;
		const changed = this.db
			.prepare(
				"UPDATE world_social_resolutions SET accepted_life_revision = ? WHERE world_id = ? AND request_id = ? AND accepted_life_revision IS NULL AND result_json IS NOT NULL",
			)
			.run(
				commit.expectedLifeRevision + 1,
				commit.world.worldId,
				commit.socialResolutionId,
			);
		if (changed.changes !== 1) throw Error("Social receipt already consumed");
	}
	audit(): void {
		const seeds = this.db
			.prepare("SELECT * FROM world_social_bootstraps")
			.all() as BootstrapRow[];
		const rows = this.db
			.prepare("SELECT * FROM world_social_resolutions")
			.all() as ResolutionRow[];
		for (const row of seeds) {
			this.seed(row.world_id);
			if (!rows.some((x) => x.world_id === row.world_id))
				throw Error("Orphan social bootstrap");
		}
		for (const row of rows) {
			const prepared = this.decode(row);
			if (prepared.acceptedLifeRevision !== null) {
				const accepted = this.db
					.prepare(
						"SELECT envelope_json FROM life_commits WHERE world_id = ? AND life_revision = ?",
					)
					.get(row.world_id, prepared.acceptedLifeRevision) as
					| { envelope_json: string }
					| undefined;
				if (!accepted) throw Error("Missing paired social commit");
				const value: unknown = JSON.parse(accepted.envelope_json);
				fields(value, ["version", "commit", "identity"]);
				const commit = parseLifeCommit(value.commit);
				if (
					value.version !== 1 ||
					commit.version !== 2 ||
					commit.socialResolutionId !== row.request_id
				)
					throw Error("Orphan accepted social result");
			}
		}
	}
}
