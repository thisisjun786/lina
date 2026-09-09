import type { WorldPackV3 } from "../src/world/authoring-types.ts";
import type {
	AutonomySource,
	LifeModelLane,
	LifeModelRecord,
	LifeStep,
	ReflectionProposal,
} from "../src/world/autonomy-types.ts";
import { initialLifeState } from "../src/world/life-transition.ts";
import { initialSnapshot } from "../src/world/transition.ts";
import { evaluation, literal, unconfigured } from "./life-authoring-fixture.ts";
import { identityPolicy, required } from "./life-fixture.ts";
import { socialPack } from "./life-social-pack-fixture.ts";

export function autonomyPack(): WorldPackV3 {
	return {
		...socialPack(),
		schemaVersion: 3,
		eventFamilies: [
			{
				id: "meet",
				description: "Meet someone",
				actorRoleIds: ["resident"],
				condition: literal(true),
				weight: 2,
				effects: [],
			},
		],
		autonomy: {
			version: 1,
			needs: [
				{
					id: "connection",
					label: "Connection",
					min: 0,
					max: 10,
					initial: 1,
					driftPerStep: 2,
				},
			],
			goals: [
				{
					id: "friend",
					agentId: "lina",
					description: "Private goal",
					priority: 3,
					familyIds: ["meet"],
				},
			],
			events: [
				{
					familyId: "meet",
					capabilityIds: ["socialize"],
					cooldownSteps: 2,
					noveltyPenalty: 0.5,
					goalWeight: 4,
					needWeights: [{ needId: "connection", multiplier: 2 }],
					traitWeights: [{ axisId: "axis", multiplier: 3 }],
					habitWeights: [{ habitId: "habit", when: true, weight: 5 }],
				},
			],
			quietWeight: 0,
			growth: { maxNumericDelta: 1, minHabitExperiences: 2 },
		},
	};
}
export function autonomySource(): AutonomySource & {
	config: import("../src/world/authoring-types.ts").LifeConfigV1;
} {
	const pack = autonomyPack(),
		world = initialSnapshot(pack.world),
		life = initialLifeState(world, pack.life);
	return {
		world,
		life,
		pack,
		config: {
			...unconfigured(),
			version: 1,
			worldId: pack.worldId,
			revision: 1,
			clock: { stepSize: 1, intervalMs: null, maxCatchUpSteps: 0 },
			run: { mode: "manual" },
			models: {
				director: { provider: "director", model: "director-model" },
				actor: { provider: "actor", model: "actor-model" },
			},
			limits: {
				maxActorActions: 8,
				maxCausalDepth: 2,
				maxModelCalls: 6,
				evaluation: evaluation().limits,
			},
			usage: {
				windowMs: 1000,
				maxInputTokens: 100000,
				maxOutputTokens: 100000,
				maxImages: 0,
			},
		},
		identity: identityPolicy(),
		profiles: pack.world.agents.map((id) => ({
			id,
			name: id,
			role: "Resident",
			personality: `Own ${id} anchor`,
			voice: "Calm",
			profile: "A fictional resident in the synthetic world",
			appearance: "A synthetic character wearing a plain coat",
			interests: [],
			avatarId: null,
			evolution: "adaptive",
			revision: 1,
		})),
		autonomy: {
			version: 1,
			worldId: pack.worldId,
			worldRevision: 0,
			lifeRevision: 0,
			packVersion: 1,
			stepNumber: 0,
			seed: 42,
			selectionIndex: 0,
			variables: { count: 1, flag: false, secret: "hidden-value" },
			needs: pack.world.agents.map((agentId) => ({
				agentId,
				needId: "connection",
				value: 1,
				lastStepId: null,
				experienceIds: [],
			})),
			goals: [
				{
					...required(pack.autonomy.goals[0]),
					progress: 0,
					status: "active",
					createdAtStepId: null,
					lastStepId: null,
					experienceIds: [],
				},
			],
			families: [],
			pendingEvents: [],
		},
		inputs: [
			{
				version: 1,
				worldId: pack.worldId,
				id: "raw-input",
				sourceRevision: 1,
				payloadDigest: "a".repeat(64),
				source: {
					kind: "application",
					sourceId: "inbox",
					text: "RAW_INBOX_CANARY",
				},
				consumedLifeRevision: null,
			},
		],
		modelSettingsRevision: 1,
	};
}
export function pureStep(source: AutonomySource = autonomySource()): LifeStep {
	return {
		version: 1,
		id: "step-1",
		worldId: source.pack.worldId,
		idempotencyKey: "step-key",
		status: "running",
		source,
		decision: {
			version: 1,
			stepId: "step-1",
			kind: "event",
			familyId: "meet",
			agentId: "lina",
			simulationTime: 1,
			candidates: [],
			random: { seed: 42, index: 0, value: 0.1 },
			parent: null,
			maxModelCalls: 6,
		},
		lease: {
			worldId: source.pack.worldId,
			owner: "test",
			generation: 1,
			token: 1,
			expiresAt: 1000,
		},
		models: [],
		intent: null,
		targetResponse: null,
		socialRequestId: null,
		reflectionAgentIds: null,
		outcome: null,
		receipt: null,
		error: null,
	};
}
export function completedModel(
	step: LifeStep,
	lane: LifeModelLane,
	agentId: string,
	text: string,
): LifeModelRecord {
	const request = {
		version: 1 as const,
		id: `${step.id}-${lane}-${agentId}`,
		worldId: step.worldId,
		stepId: step.id,
		lane,
		agentId,
		provider: "fixture",
		model: "fixture",
		modelSettingsRevision: 1,
		systemPrompt: "fixture",
		input: "{}",
		limits: {
			maxInputTokens: 1000,
			maxOutputTokens: 1000,
			maxInputBytes: 10000,
			maxOutputBytes: 10000,
			timeoutMs: 1000,
		},
	};
	return {
		prepared: {
			version: 1,
			request,
			inputDigest: "a".repeat(64),
			capabilityFingerprint: "b".repeat(64),
			nativeReference: "fixture",
		},
		status: "completed",
		preparedAt: 0,
		dispatchedAt: 0,
		result: {
			version: 1,
			requestId: request.id,
			inputDigest: "a".repeat(64),
			capabilityFingerprint: "b".repeat(64),
			nativeReference: "fixture",
			provider: "fixture",
			model: "fixture",
			threadId: request.id,
			turnId: request.id,
			text,
			usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
			upstreamAttempts: 1,
		},
		usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
		reservation: { inputTokens: 100, outputTokens: 100 },
		upstreamAttempts: 1,
		error: null,
	};
}
export function emptyReflection(): ReflectionProposal {
	return { claims: [], beliefs: [], growth: [], needs: [], goals: [] };
}

// Hand-written 030 history: three coins, six directed trust values; greeting writes only Lina -> Mira.
export function socialHistory(): {
	before: Record<string, unknown>[];
	after: Record<string, unknown>[];
} {
	const before: Record<string, unknown>[] = [];
	for (const first of ["lina", "mira", "sol"])
		before.push({
			category: "p_636f696e73",
			type: "value",
			first,
			second: undefined,
			origin: "lina-bootstrap",
			value: 5,
			id: before.length + 1,
			timeHappened: 0,
			duration: undefined,
		});
	for (const first of ["lina", "mira", "sol"])
		for (const second of ["lina", "mira", "sol"])
			if (first !== second)
				before.push({
					category: "p_7472757374",
					type: "value",
					first,
					second,
					origin: "lina-bootstrap",
					value: 0,
					id: before.length + 1,
					timeHappened: 0,
					duration: undefined,
				});
	const after = structuredClone(before);
	Object.assign(required(after[3]), { value: 1, id: 10, timeHappened: 1 });
	return { before, after };
}
