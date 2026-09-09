import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import type { AgentInput } from "../../lina-core/src/agents/types.ts";
import { visualIdentityDigest } from "../../lina-core/src/agents/visual-validation.ts";
import { acquireInstallationLock } from "../../lina-core/src/installation/lock.ts";
import { avatarPeriodicSource } from "../../lina-core/src/world/image-policy.ts";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import type {
	IdentityPolicySnapshot,
	LifeCommitV1 as LifeCommit,
	LifeInput,
	LifeReceipt,
	SideEffectIntent,
	WorldBinding,
} from "../../lina-core/src/world/life-types.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import {
	identityPolicy,
	lifeDefinition,
	socialCommit,
} from "../../lina-core/test/life-fixture.ts";
import { worldDefinition } from "../../lina-core/test/world-fixture.ts";
import type { ImageStoreLimits } from "../src/images/contracts.ts";
import {
	LifeImageAssets,
	lifeImageOwnerRoot,
} from "../src/images/life-assets.ts";
import { lifeImageJobInput } from "../src/images/life-authority.ts";
import { lifeImagePorts } from "../src/images/life-ports.ts";
import { ImageJobStore } from "../src/images/store.ts";

export const LIFE_CHECKPOINT_WORLD_ID = "test-world";
export const LIFE_CHECKPOINT_AGENT_ID = "lina";
export const LIFE_CHECKPOINT_OWNER = {
	kind: "life" as const,
	worldId: LIFE_CHECKPOINT_WORLD_ID,
	agentId: LIFE_CHECKPOINT_AGENT_ID,
};
export const LIFE_CHECKPOINT_LIMITS: ImageStoreLimits = {
	maxActiveJobs: 8,
	maxArchivedJobs: 32,
	maxActiveBytes: 1_000_000,
	maxArchiveBytes: 2_000_000,
	maxTotalBytes: 3_000_000,
};
export const LIFE_CHECKPOINT_PNG = new Uint8Array(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
		"base64",
	),
);

export type LifeCheckpointSnapshot = {
	worldId: string;
	eventId: string;
	worldRevision: number;
	lifeRevision: number;
	receipt: LifeReceipt;
	commit: LifeCommit;
	identity: IdentityPolicySnapshot;
	binding: WorldBinding | null;
	agents: Array<{ id: string; revision: number; name: string }>;
	image: {
		owner: typeof LIFE_CHECKPOINT_OWNER;
		jobId: string;
		sha256: string;
		size: number;
		receiptId: string;
		attemptId: string;
	};
	counts: {
		agents: number;
		worldRevision: number;
		lifeExperiences: number;
		lifeInputs: number;
		lifeEffects: number;
		imageJobs: number;
	};
};

export type LifeCheckpointOwners = {
	agents: AgentStore;
	world: WorldStore;
	images: ImageJobStore;
	assets: LifeImageAssets;
	close(): void;
};

function agentInput(id: string, name: string): AgentInput {
	return {
		id,
		name,
		role: "resident",
		personality: "curious",
		voice: "warm",
		profile: "Authored resident",
		appearance: "Synthetic appearance",
		interests: ["music"],
		avatarId: null,
		evolution: "adaptive",
	};
}

function workInput(): LifeInput {
	const source = {
		kind: "application" as const,
		sourceId: "work-1",
		text: "Synthetic work outcome",
	};
	return {
		version: 1,
		worldId: LIFE_CHECKPOINT_WORLD_ID,
		id: "work-1",
		sourceRevision: 1,
		payloadDigest: lifeDigest(source),
		source,
		consumedLifeRevision: null,
	};
}

function publicationIntent(): SideEffectIntent {
	const payload = {
		kind: "publication_candidate" as const,
		eventId: "test-world:1",
	};
	return {
		version: 1,
		worldId: LIFE_CHECKPOINT_WORLD_ID,
		id: "publish-1",
		lifeRevision: 1,
		payload,
		payloadDigest: lifeDigest(payload),
	};
}

function causalCommit(): LifeCommit {
	return {
		...socialCommit(),
		consumedInputIds: ["work-1"],
		effects: [publicationIntent()],
	};
}

function seedAgents(stateRoot: string): LifeCheckpointSnapshot["agents"] {
	const store = new AgentStore(join(stateRoot, "agents.sqlite"));
	try {
		store.create(agentInput("lina", "Lina"));
		store.create(agentInput("mira", "Mira"));
		store.create(agentInput("sol", "Sol"));
		return store.list().map((profile) => ({
			id: profile.id,
			revision: profile.revision,
			name: profile.name,
		}));
	} finally {
		store.close();
	}
}

async function seedImages(
	stateRoot: string,
	world: WorldStore,
): Promise<LifeCheckpointSnapshot["image"] & { jobCount: number }> {
	const owner = LIFE_CHECKPOINT_OWNER,
		worldId = owner.worldId;
	const agents = new AgentStore(join(stateRoot, "agents.sqlite"));
	try {
		const { worldId: _id, revision, ...config } = world.lifeConfig(worldId);
		world.setLifeConfig(worldId, revision, {
			...config,
			avatars: { mode: "manual", intervalMs: 1000, maxPerWindow: 2 },
			usage: {
				windowMs: 10000,
				maxInputTokens: 100,
				maxOutputTokens: 100,
				maxImages: 2,
			},
		});
		world.setImageSettings(worldId, 0, {
			version: 1,
			worldVersion: null,
			route: { provider: "fixture", model: "image-one" },
			eventRules: [],
			avatarEventRules: [],
			perAuthorCooldownSteps: 0,
			attachMode: "manual",
			maxJobsPerVisit: 1,
			storage: {
				maxActiveJobs: 8,
				maxArchivedJobs: 32,
				maxAssets: 8,
				maxTotalBytes: 3_000_000,
			},
		});
		const avatarPolicy = {
			worldId,
			applyMode: "manual" as const,
			whilePinned: "candidate" as const,
			schedule: { kind: "wall" as const, epochMs: 0 },
			eventFamilyIds: [],
		};
		const visual = agents.updateVisual(owner.agentId, 1, {
			anchors: ["approved silver hair"],
			textIdentity: "Approved identity",
			canonicalReferenceId: null,
			avatarPolicy,
			referenceLimits: { maxAssets: 1, maxTotalBytes: 10000 },
			maxHistoryRecords: 50,
		});
		agents.putVisualGrant(owner.agentId, visual.revision, {
			version: 1,
			id: "checkpoint-grant",
			agentId: owner.agentId,
			revision: 1,
			subject: {
				kind: "text_identity",
				identityDigest: visualIdentityDigest(visual),
			},
			providerUse: true,
			purposes: [{ kind: "avatar" }],
			revoked: false,
		});
		const policy = world.resolveImageAvatarPolicy(
			worldId,
			owner.agentId,
			visual.avatarPolicyRevision,
			avatarPolicy,
		);
		const source = avatarPeriodicSource(
			policy,
			1000,
			world.lifeSnapshot(worldId).revision,
		);
		if (!source) throw Error("Missing checkpoint avatar slot");
		const intent = world.freezeImageIntent({
			worldId,
			agentId: owner.agentId,
			source,
			visuals: [agents.freezeVisualIdentity(owner.agentId, { kind: "avatar" })],
			requestKey: "checkpoint-image",
		});
		const attempt = world.prepareImageAttempt(
			worldId,
			intent.intentId,
			"checkpoint-run",
		);
		const root = lifeImageOwnerRoot(stateRoot, owner, true),
			store = new ImageJobStore(root, owner, LIFE_CHECKPOINT_LIMITS);
		let job = store.create(lifeImageJobInput(intent, attempt));
		world.linkImageAttempt(worldId, attempt.attemptId, job.id);
		world.reserveImageAttempt(worldId, attempt.attemptId, {
			outputBytes: 1_000_000,
			metadataBytes: 65536,
			manifestBytes: 65536,
		});
		const ports = lifeImagePorts({
			world,
			agents,
			owner,
			root: stateRoot,
			assertLease() {},
			assertWorkCurrent() {},
			resolveReference() {
				throw Error("No reference expected");
			},
			onComplete() {},
		});
		// Synthetic completed provider fact; real world/manifest/artifact/accounting ports
		// enforce the same ownership and import receipts used by the runtime.
		world.dispatchImageAttempt(worldId, attempt.attemptId);
		job = store.update(job.id, {
			state: "post_processing",
			endpoint: "http://127.0.0.1:9",
			runtimeVersion: "3.14.0",
			resultFilename: "result.png",
		});
		ports.changed(job);
		const metadata = await ports.artifacts.importOutput(job, {
			bytes: LIFE_CHECKPOINT_PNG,
			mime: "image/png",
		});
		job = store.update(job.id, { state: "completed", artifact: metadata });
		const receipt = await ports.completion.complete(job);
		if (receipt.kind !== "life") throw Error("Missing LIFE completion receipt");
		job = store.update(job.id, { delivery: receipt });
		ports.changed(job);
		world.guardArchiveImageAttempt(
			worldId,
			attempt.attemptId,
			store.prepareArchiveReceipt(job.id),
		);
		store.archive(job.id);
		world.archiveImageAttempt(
			worldId,
			attempt.attemptId,
			store.archiveReceipt(job.id),
		);
		return {
			owner,
			jobId: job.id,
			sha256: metadata.sha256,
			size: metadata.size,
			receiptId: receipt.receiptId,
			attemptId: attempt.attemptId,
			jobCount: store.list().length,
		};
	} finally {
		agents.close();
	}
}

export async function seedLifeCheckpointState(stateRoot: string): Promise<{
	snapshot: LifeCheckpointSnapshot;
	world: WorldStore;
}> {
	mkdirSync(stateRoot, { recursive: true });
	const agents = seedAgents(stateRoot);
	mkdirSync(join(stateRoot, "life"), { recursive: true });
	const world = new WorldStore(
		join(stateRoot, "life", "world.sqlite"),
		() => 1000,
	);
	world.create(worldDefinition());
	world.prepareLife(lifeDefinition());
	world.admitLifeInput(workInput());
	const identity = identityPolicy();
	const commit = causalCommit();
	const receipt = world.acceptLife(commit, identity);
	const binding = world.setWorldBinding("lina", 0, {
		version: 2,
		worldId: LIFE_CHECKPOINT_WORLD_ID,
		projectionPolicyRevision: 1,
		conversationRecipientId: null,
	});
	const image = await seedImages(stateRoot, world);
	const life = world.lifeSnapshot(LIFE_CHECKPOINT_WORLD_ID);
	return {
		world,
		snapshot: {
			worldId: LIFE_CHECKPOINT_WORLD_ID,
			eventId: receipt.eventId,
			worldRevision: receipt.worldRevision,
			lifeRevision: receipt.lifeRevision,
			receipt,
			commit,
			identity,
			binding,
			agents,
			image: {
				owner: image.owner,
				jobId: image.jobId,
				sha256: image.sha256,
				size: image.size,
				receiptId: image.receiptId,
				attemptId: image.attemptId,
			},
			counts: {
				agents: agents.length,
				worldRevision: world.snapshot(LIFE_CHECKPOINT_WORLD_ID).revision,
				lifeExperiences: life.experiences.length,
				lifeInputs: world.lifeInputs(LIFE_CHECKPOINT_WORLD_ID).length,
				lifeEffects: world.lifeEffects(LIFE_CHECKPOINT_WORLD_ID).length,
				imageJobs: image.jobCount,
			},
		},
	};
}

export function openLifeCheckpointOwners(
	stateRoot: string,
): LifeCheckpointOwners {
	const agents = new AgentStore(join(stateRoot, "agents.sqlite"));
	try {
		const world = new WorldStore(
			join(stateRoot, "life", "world.sqlite"),
			() => 1000,
		);
		try {
			const images = ImageJobStore.openExisting(
				lifeImageOwnerRoot(stateRoot, LIFE_CHECKPOINT_OWNER, false),
				LIFE_CHECKPOINT_OWNER,
				LIFE_CHECKPOINT_LIMITS,
			);
			const assets = new LifeImageAssets(stateRoot, LIFE_CHECKPOINT_OWNER);
			return {
				agents,
				world,
				images,
				assets,
				close() {
					world.close();
					agents.close();
				},
			};
		} catch (error) {
			world.close();
			throw error;
		}
	} catch (error) {
		agents.close();
		throw error;
	}
}

async function main(): Promise<void> {
	const home = process.argv[2];
	const mode = process.argv[3];
	if (!home || (mode !== "seed" && mode !== "write" && mode !== "lease"))
		throw Error(
			"Usage: life-checkpoint-child.ts <absolute-home> <seed|write|lease>",
		);
	const stateRoot = join(home, "state");
	if (mode === "lease") {
		const lock = acquireInstallationLock(stateRoot);
		try {
			process.stdout.write(`${JSON.stringify({ mode: "lease" })}\n`);
			await Bun.stdin.text();
		} finally {
			lock.close();
		}
		return;
	}
	const { snapshot, world } = await seedLifeCheckpointState(stateRoot);
	try {
		process.stdout.write(`${JSON.stringify(snapshot)}\n`);
		if (mode === "write") await Bun.stdin.text();
	} finally {
		world.close();
	}
}

if (import.meta.main) await main();
